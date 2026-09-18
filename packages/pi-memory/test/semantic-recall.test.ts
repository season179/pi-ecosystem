import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import type { Fetch } from "@typesafe-ai/sdk";
import { createMemoryExtension } from "../src/extensions/memory.js";
import {
	initializeProjectSidecar,
	resolveProjectIdentity,
	type AvailableProjectIdentity,
} from "../src/identity.js";
import { legacyStorePaths, projectStorePaths, resolveMemoryRoot, storeContainment } from "../src/paths.js";
import {
	buildSemanticBatches,
	extractNoulProbability,
	parseTypesafeConfig,
	rankSemanticMatches,
	semanticQuestionInstructions,
	semanticRecall,
	type SemanticBatch,
} from "../src/semantic.js";
import { mutateMemoryStore, type Memory } from "../src/store.js";
import {
	ExtensionRegistrationHarness,
	makeExtensionContext,
	type HarnessContext,
} from "./helpers/extension-harness.js";

const temporaryDirectories = new Set<string>();

const BASE32 = "abcdefghijklmnopqrstuv234567";
/** Valid unique memory ids: m_ + 10 chars from [a-z2-7]. */
function memoryId(index: number): string {
	return `m_${"aaaaaaaa".slice(0, 8)}${BASE32[Math.floor(index / 32) % 32]}${BASE32[index % 32]}`;
}

function scopedMemory(index: number, overrides: Partial<Memory> = {}): { scope: "legacy-global"; memory: Memory } {
	return {
		scope: "legacy-global",
		memory: {
			id: memoryId(index),
			title: `Memory ${index}`,
			updated: `2026-08-0${(index % 9) + 1}T00:00:00.000Z`,
			tags: ["tag"],
			cue: `Cue ${index}`,
			body: `Body ${index}`,
			...overrides,
		},
	};
}

// ---------------------------------------------------------------------------
// Unit: config adapter
// ---------------------------------------------------------------------------

describe("parseTypesafeConfig", () => {
	it("parses the shared schema with defaults", () => {
		const loaded = parseTypesafeConfig(JSON.stringify({ memory: { enabled: true } }));
		assert.equal(loaded.state, "loaded");
		if (loaded.state !== "loaded") return;
		assert.equal(loaded.settings.model, "jev-1.13.0");
		assert.equal(loaded.settings.timeoutMs, 3000);
		assert.equal(loaded.settings.apiKeyFile, undefined);
		assert.equal(loaded.settings.memory.enabled, true);
		assert.equal(loaded.settings.memory.minRelevance, 0.5);
	});

	it("parses explicit values and ignores unrelated fields", () => {
		const loaded = parseTypesafeConfig(
			JSON.stringify({
				model: "jev-1.13.1",
				timeoutMs: 1500,
				apiKeyFile: "typesafe.key",
				memory: { enabled: true, minRelevance: 0.25 },
				buddy: { enabled: true, skipThreshold: 0.85, auditEvery: 5 },
				extra: [1, 2],
			}),
		);
		assert.equal(loaded.state, "loaded");
		if (loaded.state !== "loaded") return;
		assert.equal(loaded.settings.model, "jev-1.13.1");
		assert.equal(loaded.settings.timeoutMs, 1500);
		assert.equal(loaded.settings.apiKeyFile, "typesafe.key");
		assert.equal(loaded.settings.memory.minRelevance, 0.25);
	});

	it("treats an absent memory block, or absent enabled, as disabled", () => {
		for (const raw of [JSON.stringify({ timeoutMs: 1000 }), JSON.stringify({ memory: { minRelevance: 0.6 } })]) {
			const loaded = parseTypesafeConfig(raw);
			assert.equal(loaded.state, "loaded", raw);
			if (loaded.state !== "loaded") continue;
			assert.equal(loaded.settings.memory.enabled, false, raw);
			if (raw.includes("minRelevance")) assert.equal(loaded.settings.memory.minRelevance, 0.6);
		}
	});

	it("rejects malformed shapes deterministically", () => {
		const malformed = [
			"{",
			"[]",
			"null",
			JSON.stringify({ model: 123 }),
			JSON.stringify({ model: "" }),
			JSON.stringify({ model: "my model!" }),
			JSON.stringify({ timeoutMs: 0 }),
			JSON.stringify({ timeoutMs: "3000" }),
			JSON.stringify({ timeoutMs: 3000.5 }),
			JSON.stringify({ timeoutMs: 10001 }),
			JSON.stringify({ apiKeyFile: 7 }),
			JSON.stringify({ memory: "on" }),
			JSON.stringify({ memory: { enabled: "yes" } }),
			JSON.stringify({ memory: { enabled: true, minRelevance: 1.5 } }),
			JSON.stringify({ memory: { enabled: true, minRelevance: "0.5" } }),
		];
		for (const raw of malformed) {
			assert.equal(parseTypesafeConfig(raw).state, "malformed", raw);
		}
	});
});

// ---------------------------------------------------------------------------
// Unit: answer validation
// ---------------------------------------------------------------------------

describe("extractNoulProbability", () => {
	it("accepts a finite probability in [0,1] and rejects everything else", () => {
		const answers = {
			ok: { type: "noul", noul: 0.42 },
			noType: { noul: 0.9 },
			missing: { type: "noul" },
			nan: { type: "noul", noul: Number.NaN },
			high: { type: "noul", noul: 1.5 },
			negative: { type: "noul", noul: -0.1 },
			string: { type: "noul", noul: "0.8" },
			wrongType: { type: "choice", choice: "yes", confidence: 1, probabilities: {} },
			notObject: 3,
		};
		assert.equal(extractNoulProbability(answers, "ok"), 0.42);
		assert.equal(extractNoulProbability(answers, "noType"), 0.9);
		assert.equal(extractNoulProbability(answers, "missing"), undefined);
		assert.equal(extractNoulProbability(answers, "nan"), undefined);
		assert.equal(extractNoulProbability(answers, "high"), undefined);
		assert.equal(extractNoulProbability(answers, "negative"), undefined);
		assert.equal(extractNoulProbability(answers, "string"), undefined);
		assert.equal(extractNoulProbability(answers, "wrongType"), undefined);
		assert.equal(extractNoulProbability(answers, "notObject"), undefined);
		assert.equal(extractNoulProbability(answers, "absent"), undefined);
		assert.equal(extractNoulProbability(null, "ok"), undefined);
	});
});

// ---------------------------------------------------------------------------
// Unit: ranking
// ---------------------------------------------------------------------------

describe("rankSemanticMatches", () => {
	it("ranks by relevance desc with threshold, then recency, then id, scope last", () => {
		const project = { scope: "project" as const, memory: scopedMemory(0).memory };
		const legacy = { scope: "legacy-global" as const, memory: scopedMemory(1).memory };
		const candidates = [legacy, project];
		// canonicalScopeOrder([legacy, project]) is [project, legacy]; scores align to that.
		const matches = rankSemanticMatches(candidates, [0.9, 0.6], 0.5, 5);
		assert.deepEqual(
			matches.map((match) => match.scope),
			["project", "legacy-global"],
		);
	});

	it("keeps the threshold inclusive and drops everything below it without lexical backfill", () => {
		const candidates = [scopedMemory(0), scopedMemory(1), scopedMemory(2)];
		const matches = rankSemanticMatches(candidates, [0.49, 0.5, 0.51], 0.5, 5);
		assert.deepEqual(
			matches.map((match) => match.memory.id),
			[memoryId(2), memoryId(1)],
		);
	});

	it("breaks score ties by recency desc then id asc; scope only after every ranking key", () => {
		const older = scopedMemory(0, { updated: "2026-08-01T00:00:00.000Z" });
		const newer = scopedMemory(1, { updated: "2026-08-02T00:00:00.000Z" });
		// Different ids at equal score and recency: id asc decides before scope.
		const projectTwin = { scope: "project" as const, memory: { ...newer.memory, id: memoryId(5) } };
		const candidates = [older, newer, projectTwin];
		const byId = rankSemanticMatches(candidates, [1, 1, 1], 0.5, 5);
		assert.deepEqual(
			byId.map((match) => [match.memory.id, match.scope]),
			[
				[memoryId(1), "legacy-global"],
				[memoryId(5), "project"],
				[memoryId(0), "legacy-global"],
			],
		);
		// Same id in both scopes at equal score and recency: only the stable
		// project-first input order remains, so scope is the final tie-break.
		const duplicate = scopedMemory(2, { updated: "2026-08-02T00:00:00.000Z" }).memory;
		const duplicated = [
			{ scope: "legacy-global" as const, memory: duplicate },
			{ scope: "project" as const, memory: duplicate },
		];
		const byScope = rankSemanticMatches(duplicated, [1, 1], 0.5, 5);
		assert.deepEqual(
			byScope.map((match) => match.scope),
			["project", "legacy-global"],
		);
	});

	it("clamps the limit to 1..10 and excludes invalid scores", () => {
		const candidates = Array.from({ length: 14 }, (_unused, index) => scopedMemory(index));
		const scores = candidates.map((_candidate, index) => (index === 3 ? Number.NaN : 0.9));
		assert.equal(rankSemanticMatches(candidates, scores, 0.5, 99).length, 10);
		assert.equal(rankSemanticMatches(candidates, scores, 0.5, 0).length, 5);
		const ids = rankSemanticMatches(candidates, scores, 0.5, 10).map((match) => match.memory.id);
		assert.ok(!ids.includes(memoryId(3)));
	});
});

// ---------------------------------------------------------------------------
// Unit: request formation
// ---------------------------------------------------------------------------

describe("buildSemanticBatches", () => {
	it("packs every candidate, 16 per batch, with q-keys and bounded bodies", () => {
		const long = "x".repeat(5000);
		const candidates = Array.from({ length: 20 }, (_unused, index) =>
			scopedMemory(index, { body: long, title: `Title ${index}` }),
		);
		const batches: SemanticBatch[] = buildSemanticBatches("find deployments", candidates);
		assert.equal(batches.length, 2);
		assert.equal(batches[0].state.candidates.length, 16);
		assert.equal(batches[1].state.candidates.length, 4);
		assert.equal(batches[0].base, 0);
		assert.equal(batches[1].base, 16);
		assert.deepEqual(batches[0].keys, Array.from({ length: 16 }, (_unused, index) => `q${index}`));
		for (const batch of batches) {
			for (const view of batch.state.candidates) {
				assert.ok(view.body.length < 5000);
				assert.ok(view.body.includes("[truncated]"));
			}
		}
		assert.equal(batches[0].state.query, "find deployments");
		assert.ok(batches[0].state.task.includes("independently"));
	});

	it("names the explicit state path and index in every question", () => {
		for (const index of [0, 3]) {
			const instructions = semanticQuestionInstructions(index);
			assert.ok(instructions.includes(`state.candidates[${index}]`));
			assert.ok(instructions.includes("state.query"));
		}
	});
});

// ---------------------------------------------------------------------------
// semanticRecall orchestration (mock transport at the real SDK boundary)
// ---------------------------------------------------------------------------

interface SystemOneCall {
	url: string;
	body: {
		model: string;
		state: { query: string; candidates: Array<{ title: string }> };
		questions: Record<string, { type: string }>;
	};
	init?: RequestInit;
}

function mockSystemOneFetch(handler: (call: SystemOneCall) => Promise<unknown> | unknown): {
	fetch: Fetch;
	calls: SystemOneCall[];
} {
	const calls: SystemOneCall[] = [];
	const fetch: Fetch = async (input, init) => {
		const call: SystemOneCall = {
			url: String(input),
			body: JSON.parse(String(init?.body)) as SystemOneCall["body"],
			init,
		};
		calls.push(call);
		const answers = await handler(call);
		if (answers instanceof Response) return answers;
		return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, calls };
}

function answerAll(call: SystemOneCall, noulOf: (title: string) => number): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	call.body.state.candidates.forEach((candidate, index) => {
		answers[`q${index}`] = { type: "noul", noul: noulOf(candidate.title) };
	});
	return answers;
}

function hangUntilAbort(): { fetch: Fetch; calls: SystemOneCall[]; aborted: number } {
	const calls: SystemOneCall[] = [];
	let aborted = 0;
	const fetch: Fetch = (_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const onAbort = () => {
				aborted += 1;
				reject(new DOMException("This operation was aborted", "AbortError"));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		}).catch((error: unknown) => {
			// Surface like real fetch: rejection rethrown to the SDK.
			throw error;
		}) as Promise<Response>;
	return { fetch, calls, get aborted() { return aborted; } };
}

async function createAgentRig(options: {
	typesafe?: unknown;
	keyFileContent?: string;
	env?: Record<string, string | undefined>;
}): Promise<{ agentDir: string }> {
	const temporary = await mkdtemp(join(tmpdir(), "pi-memory-semantic-agent-"));
	temporaryDirectories.add(temporary);
	const agentDir = join(temporary, "agent");
	await mkdir(agentDir, { recursive: true });
	if (options.typesafe !== undefined) {
		await writeFile(
			join(agentDir, "typesafe.json"),
			typeof options.typesafe === "string" ? options.typesafe : JSON.stringify(options.typesafe),
		);
	}
	if (options.keyFileContent !== undefined) {
		await writeFile(join(agentDir, "typesafe.key"), options.keyFileContent);
	}
	return { agentDir };
}

describe("semanticRecall", () => {
	it("scores, thresholds, and ranks through the real SDK transport", async () => {
		const { agentDir } = await createAgentRig({
			typesafe: { memory: { enabled: true, minRelevance: 0.5 }, apiKeyFile: "typesafe.key" },
			env: { TYPESAFE_API_KEY: "unit-env-key" },
		});
		const candidates = [
			scopedMemory(0, { title: "Deploying the payment service" }),
			scopedMemory(1, { title: "Cooking recipes" }),
			scopedMemory(2, { title: "Release runbook" }),
		];
		const { fetch, calls } = mockSystemOneFetch((call) =>
			answerAll(call, (title) => (title === "Cooking recipes" ? 0.1 : title === "Release runbook" ? 0.7 : 0.95)),
		);
		const outcome = await semanticRecall("ship the checkout system", candidates, {
			agentDir,
			env: { TYPESAFE_API_KEY: "unit-env-key" },
			fetch,
		});
		assert.equal(outcome.kind, "matches");
		if (outcome.kind !== "matches") return;
		assert.deepEqual(
			outcome.matches.map((match) => match.memory.title),
			["Deploying the payment service", "Release runbook"],
		);
		assert.equal(outcome.model, "jev-1.13.0");
		assert.equal(outcome.scored, 3);
		assert.equal(outcome.batches, 1);
		assert.equal(outcome.minRelevance, 0.5);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
		assert.equal(calls[0].body.model, "jev-1.13.0");
		assert.ok(calls[0].body.state.candidates[0].title);
	});

	it("falls back without network for absent, disabled, malformed, and keyless configs", async () => {
		const candidates = [scopedMemory(0)];
		for (const [typesafe, env, reason] of [
			[undefined, {}, "config-absent"],
			[{ memory: { enabled: false } }, {}, "disabled"],
			["{broken", {}, "malformed-config"],
			[{ memory: { enabled: true } }, {}, "missing-key"],
		] as const) {
			const { agentDir } = await createAgentRig({ typesafe, env });
			const { fetch, calls } = mockSystemOneFetch(() => ({}));
			const outcome = await semanticRecall("anything", candidates, { agentDir, env, fetch });
			assert.equal(outcome.kind, "fallback");
			if (outcome.kind === "fallback") assert.equal(outcome.reason, reason);
			assert.equal(calls.length, 0);
		}
	});

	it("prefers the env key over apiKeyFile and activates a key file without env", async () => {
		const typesafe = { memory: { enabled: true }, apiKeyFile: "typesafe.key" };
		const candidates = [scopedMemory(0)];

		const envRig = await createAgentRig({ typesafe, keyFileContent: "file-key-secret\n" });
		const envFetch = mockSystemOneFetch((call) => answerAll(call, () => 0.9));
		const envOutcome = await semanticRecall("query", candidates, {
			agentDir: envRig.agentDir,
			env: { TYPESAFE_API_KEY: "env-key-secret" },
			fetch: envFetch.fetch,
		});
		assert.equal(envOutcome.kind, "matches");
		const header = JSON.stringify(envFetch.calls[0].init?.headers ?? {});
		assert.ok(header.includes("env-key-secret"), header);
		assert.ok(!header.includes("file-key-secret"));

		const fileRig = await createAgentRig({ typesafe, keyFileContent: "file-key-secret\n" });
		const fileFetch = mockSystemOneFetch((call) => answerAll(call, () => 0.9));
		const fileOutcome = await semanticRecall("query", candidates, {
			agentDir: fileRig.agentDir,
			env: {},
			fetch: fileFetch.fetch,
		});
		assert.equal(fileOutcome.kind, "matches");
	
		// An absolute apiKeyFile resolves outside the agent directory.
		const absoluteRig = await createAgentRig({ typesafe: { ...typesafe, apiKeyFile: undefined } });
		const absoluteKeyPath = join(absoluteRig.agentDir, "elsewhere.key");
		await writeFile(absoluteKeyPath, "absolute-key-secret\n");
		await writeFile(join(absoluteRig.agentDir, "typesafe.json"), JSON.stringify({ ...typesafe, apiKeyFile: absoluteKeyPath }));
		const absoluteFetch = mockSystemOneFetch((call) => answerAll(call, () => 0.9));
		const absoluteOutcome = await semanticRecall("query", candidates, {
			agentDir: absoluteRig.agentDir,
			env: {},
			fetch: absoluteFetch.fetch,
		});
		assert.equal(absoluteOutcome.kind, "matches");
	});

	it("falls back to deterministic handling on provider errors with bounded classification", async () => {
		const { agentDir } = await createAgentRig({ typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" }, env: {} });
		const { fetch } = mockSystemOneFetch(() => new Response("provider exploded with secret details", { status: 500 }));
		const outcome = await semanticRecall("query", [scopedMemory(0)], {
			agentDir,
			env: { TYPESAFE_API_KEY: "k" },
			fetch,
		});
		assert.equal(outcome.kind, "fallback");
		if (outcome.kind === "fallback") {
			assert.equal(outcome.reason, "api-error");
			assert.equal(outcome.detail, "APIError 500");
		}
	});

	it("enforces the whole-operation deadline across all batches", async () => {
		const { agentDir } = await createAgentRig({
			typesafe: { memory: { enabled: true }, timeoutMs: 60, apiKeyFile: "typesafe.key" },
			env: {},
		});
		const candidates = Array.from({ length: 40 }, (_unused, index) => scopedMemory(index));
		const { fetch, calls } = mockSystemOneFetch(
			() => new Promise((resolve) => setTimeout(() => resolve({}), 500)),
		);
		const startedAt = Date.now();
		const outcome = await semanticRecall("query", candidates, { agentDir, env: { TYPESAFE_API_KEY: "k" }, fetch });
		assert.ok(Date.now() - startedAt < 2000, "deadline must bound the whole operation");
		assert.equal(outcome.kind, "fallback");
		if (outcome.kind === "fallback") assert.equal(outcome.reason, "timeout");
		assert.equal(calls.length, 3, "three bounded batches, never partial semantic results");
	});

	it("completes multi-batch scoring with bounded concurrency and a global ranking", async () => {
		const { agentDir } = await createAgentRig({ typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" }, env: {} });
		const candidates = Array.from({ length: 40 }, (_unused, index) =>
			scopedMemory(index, { title: index % 8 === 0 ? "target hit" : `filler ${index}` }),
		);
		const { fetch, calls } = mockSystemOneFetch((call) => answerAll(call, (title) => (title === "target hit" ? 0.9 : 0.05)));
		const outcome = await semanticRecall("query", candidates, {
			agentDir,
			env: { TYPESAFE_API_KEY: "k" },
			fetch,
			limit: 10,
		});
		assert.equal(outcome.kind, "matches");
		if (outcome.kind !== "matches") return;
		assert.equal(calls.length, 3);
		assert.equal(outcome.scored, 40);
		const hitCount = outcome.matches.filter((match) => match.memory.title === "target hit").length;
		assert.equal(hitCount, 5, "all above-threshold candidates across batches, no silent drops");
	});

	it("treats an incomplete answer set as a whole-call fallback", async () => {
		const { agentDir } = await createAgentRig({ typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" }, env: {} });
		const { fetch } = mockSystemOneFetch((call) => {
			const answers = answerAll(call, () => 0.9);
			delete answers.q1;
			return answers;
		});
		const outcome = await semanticRecall("query", [scopedMemory(0), scopedMemory(1), scopedMemory(2)], {
			agentDir,
			env: { TYPESAFE_API_KEY: "k" },
			fetch,
		});
		assert.equal(outcome.kind, "fallback");
		if (outcome.kind === "fallback") assert.equal(outcome.reason, "incomplete-response");
	});

	it("reports aborted without publishing when the caller cancels mid-flight", async () => {
		const { agentDir } = await createAgentRig({ typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" }, env: {} });
		const hanging = hangUntilAbort();
		const controller = new AbortController();
		const pending = semanticRecall("query", [scopedMemory(0)], {
			agentDir,
			env: { TYPESAFE_API_KEY: "k" },
			fetch: hanging.fetch,
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		const outcome = await pending;
		assert.equal(outcome.kind, "aborted");
		assert.ok(hanging.aborted >= 1, "transport observed the abort");
	});

	it("reports aborted before starting any request when the signal is already aborted", async () => {
		const { agentDir } = await createAgentRig({ typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" }, env: {} });
		const { fetch, calls } = mockSystemOneFetch(() => ({}));
		const controller = new AbortController();
		controller.abort();
		const outcome = await semanticRecall("query", [scopedMemory(0)], {
			agentDir,
			env: { TYPESAFE_API_KEY: "k" },
			fetch,
			signal: controller.signal,
		});
		assert.equal(outcome.kind, "aborted");
		assert.equal(calls.length, 0);
	});

	it("suppresses SDK logging even with TYPESAFE_LOG_LEVEL=debug", async () => {
		const { agentDir } = await createAgentRig({ typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" }, env: {} });
		const { fetch } = mockSystemOneFetch((call) => answerAll(call, () => 0.9));
		const spies = ["debug", "info", "warn", "error", "log"].map((method) =>
			vi.spyOn(console, method as keyof Console).mockImplementation(() => undefined),
		);
		try {
			const outcome = await semanticRecall("query", [scopedMemory(0, { body: "SECRET-BODY-CONTENT" })], {
				agentDir,
				env: { TYPESAFE_API_KEY: "SECRET-KEY-VALUE", TYPESAFE_LOG_LEVEL: "debug" },
				fetch,
			});
			assert.equal(outcome.kind, "matches");
			for (const spy of spies) {
				for (const callArgs of spy.mock.calls) {
					const text = JSON.stringify(callArgs);
					assert.ok(!text.includes("SECRET-KEY-VALUE"), "key leaked to console");
					assert.ok(!text.includes("SECRET-BODY-CONTENT"), "body leaked to console");
				}
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Tool-level behavior through the registered recall tool
// ---------------------------------------------------------------------------

interface Rig {
	agentDir: string;
	cwd: string;
	harness: ExtensionRegistrationHarness;
	ctx: HarnessContext;
}

async function createToolRig(options: {
	typesafe?: unknown;
	keyFileContent?: string;
	env?: Record<string, string | undefined>;
	fetch?: Fetch;
}): Promise<Rig> {
	const temporary = await mkdtemp(join(tmpdir(), "pi-memory-semantic-tool-"));
	temporaryDirectories.add(temporary);
	const agentDir = join(temporary, "agent");
	const cwd = join(temporary, "project");
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
	if (options.typesafe !== undefined) {
		await writeFile(
			join(agentDir, "typesafe.json"),
			typeof options.typesafe === "string" ? options.typesafe : JSON.stringify(options.typesafe),
		);
	}
	if (options.keyFileContent !== undefined) {
		await writeFile(join(agentDir, "typesafe.key"), options.keyFileContent);
	}
	const harness = new ExtensionRegistrationHarness();
	createMemoryExtension({ agentDir, env: options.env ?? {}, fetch: options.fetch })(harness.api);
	const ctx = makeExtensionContext(cwd);
	await harness.emit("session_start", { reason: "startup" }, ctx.context);
	return { agentDir, cwd, harness, ctx };
}

async function storePathsFor(rig: Rig) {
	const root = await resolveMemoryRoot(rig.agentDir);
	const resolved = await resolveProjectIdentity(rig.cwd);
	assert.equal(resolved.status, "ok");
	const identity = resolved as AvailableProjectIdentity;
	return {
		root,
		identity,
		project: projectStorePaths(root, identity.directoryName),
		legacy: legacyStorePaths(root),
	};
}

async function seedMemory(
	directory: string,
	id: string,
	updated: string,
	title: string,
	body: string,
	extra: { tags?: string[]; cue?: string; containment?: unknown; guard?: unknown } = {},
): Promise<void> {
	await mutateMemoryStore(
		directory,
		{
			action: "create",
			title,
			cue: extra.cue ?? `Cue for ${title}`,
			body,
			tags: extra.tags ?? [title.toLowerCase()],
		},
		{
			now: updated,
			idFactory: () => id,
			...(extra.containment !== undefined ? { containment: extra.containment as never } : {}),
			...(extra.guard !== undefined ? { guard: extra.guard as never } : {}),
		},
	);
}

async function executeRecall(rig: Rig, params: Record<string, unknown>, signal?: AbortSignal) {
	return rig.harness.tool("recall").execute("semantic-test", params, signal, undefined, rig.ctx.context);
}

describe("recall tool semantic integration", () => {
	it("finds a synonym match with zero lexical overlap that deterministic ranking cannot", async () => {
		const { fetch, calls } = mockSystemOneFetch((call) =>
			answerAll(call, (title) => (title === "Deploying the payment service" ? 0.95 : 0.05)),
		);
		const rig = await createToolRig({
			typesafe: { memory: { enabled: true, minRelevance: 0.5 }, apiKeyFile: "typesafe.key" },
			keyFileContent: "tool-key\n",
			fetch,
		});
		const paths = await storePathsFor(rig);
		await seedMemory(
			paths.legacy.directory,
			memoryId(0),
			"2026-09-01T00:00:00.000Z",
			"Deploying the payment service",
			"Run canary then full rollout for payment deploys.",
			{ containment: storeContainment(paths.root) },
		);
		await seedMemory(
			paths.legacy.directory,
			memoryId(1),
			"2026-09-02T00:00:00.000Z",
			"Cooking recipes index",
			"Pasta and bread basics.",
			{ containment: storeContainment(paths.root) },
		);

		const query = "ship checkout system";
		const result = await executeRecall(rig, { scope: "legacy-global", query, limit: 5 });
		assert.equal(calls.length, 1);
		assert.equal(result.details.retrieval.method, "semantic");
		assert.equal(result.details.retrieval.model, "jev-1.13.0");
		assert.equal(result.details.retrieval.scored, 2);
		assert.deepEqual(
			result.details.matches.map((match: { id: string }) => match.id),
			[memoryId(0)],
		);
		const text = result.content[0].text as string;
		assert.match(text, /Scope: legacy-global/);
		assert.match(text, /Run canary then full rollout/);

		// Sanity: the deterministic lexical path alone finds nothing for this query.
		const { recallScoped } = await import("../src/runtime.js");
		const { readMemorySnapshot } = await import("../src/store.js");
		const snapshot = await readMemorySnapshot(paths.legacy.directory);
		const lexical = recallScoped(
		snapshot.memories.map((memory) => ({ scope: "legacy-global" as const, memory })),
			query,
			5,
		);
		assert.deepEqual(lexical, [], "zero word overlap must defeat the lexical ranking");
	});

	it("resolves exact id, exact title, and empty queries locally without any network", async () => {
		const { fetch, calls } = mockSystemOneFetch(() => ({}));
		const rig = await createToolRig({
			typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" },
			keyFileContent: "tool-key\n",
			fetch,
		});
		const paths = await storePathsFor(rig);
		await seedMemory(
			paths.legacy.directory,
			memoryId(0),
			"2026-09-01T00:00:00.000Z",
			"Exact Title Match",
			"Body text",
			{ containment: storeContainment(paths.root) },
		);

		const byTitle = await executeRecall(rig, { scope: "legacy-global", query: "exact title match", limit: 5 });
		assert.equal(byTitle.details.retrieval.method, "deterministic");
		assert.equal(byTitle.details.retrieval.reason, "exact");
		const byId = await executeRecall(rig, { scope: "legacy-global", query: memoryId(0), limit: 5 });
		assert.equal(byId.details.retrieval.reason, "exact");
		assert.deepEqual(byId.details.matches.map((match: { id: string }) => match.id), [memoryId(0)]);
		const byEmpty = await executeRecall(rig, { scope: "legacy-global", query: "", limit: 5 });
		assert.equal(byEmpty.details.retrieval.reason, "empty-query");
		assert.deepEqual(byEmpty.details.matches.map((match: { id: string }) => match.id), [memoryId(0)]);
		assert.equal(calls.length, 0, "exact and empty lookups must never hit the network");
	});

	it("scores duplicate ids across scopes independently with correct labels", async () => {
		const { fetch } = mockSystemOneFetch((call) =>
			answerAll(call, (title) => (title === "Project twin" ? 0.9 : title === "Global twin" ? 0.7 : 0.05)),
		);
		const rig = await createToolRig({
			typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" },
			keyFileContent: "tool-key\n",
			fetch,
		});
		const paths = await storePathsFor(rig);
		const duplicate = memoryId(2);
		await seedMemory(
			paths.project.directory,
			duplicate,
			"2026-09-01T00:00:00.000Z",
			"Project twin",
			"PROJECT BODY",
			{
				containment: storeContainment(paths.root),
				guard: async ({ directory, lock }: { directory: string; lock: never }) =>
					initializeProjectSidecar(directory, paths.identity, lock as never, "2026-09-01T00:00:00.000Z"),
			},
		);
		await seedMemory(
			paths.legacy.directory,
			duplicate,
			"2026-09-02T00:00:00.000Z",
			"Global twin",
			"GLOBAL BODY",
			{ containment: storeContainment(paths.root) },
		);

		const result = await executeRecall(rig, { scope: "all", query: "duplicate handling", limit: 5 });
		assert.equal(result.details.retrieval.method, "semantic");
		assert.deepEqual(
			result.details.matches.map((match: { id: string; scope: string; title: string }) => [
				match.id,
				match.scope,
				match.title,
			]),
			[
				[duplicate, "project", "Project twin"],
				[duplicate, "legacy-global", "Global twin"],
			],
		);
		const text = result.content[0].text as string;
		assert.ok(text.indexOf("PROJECT BODY") < text.indexOf("GLOBAL BODY"));
	});

	it("falls back to deterministic matching once per session with bounded diagnostics", async () => {
		const { fetch } = mockSystemOneFetch(() => new Response("secret provider body", { status: 500 }));
		const rig = await createToolRig({
			typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" },
			keyFileContent: "tool-key\n",
			fetch,
		});
		const paths = await storePathsFor(rig);
		await seedMemory(
			paths.legacy.directory,
			memoryId(0),
			"2026-09-01T00:00:00.000Z",
			"Payment deploy notes",
			"Body",
			{ tags: ["deploy", "payment"], containment: storeContainment(paths.root) },
		);

		const first = await executeRecall(rig, { scope: "legacy-global", query: "payment deploy", limit: 5 });
		assert.equal(first.details.retrieval.method, "deterministic");
		assert.equal(first.details.retrieval.reason, "api-error");
		assert.deepEqual(first.details.matches.map((match: { id: string }) => match.id), [memoryId(0)]);
		assert.match(first.content[0].text, /Note: semantic recall was unavailable/);
		const fallbackWarnings = rig.ctx.notifications.filter((note) => note.message.includes("semantic recall unavailable"));
		assert.equal(fallbackWarnings.length, 1, "diagnostic emitted once");
		assert.ok(!fallbackWarnings[0].message.includes("secret provider body"), "no provider body leaked");

		await executeRecall(rig, { scope: "legacy-global", query: "payment deploy", limit: 5 });
		assert.equal(
			rig.ctx.notifications.filter((note) => note.message.includes("semantic recall unavailable")).length,
			1,
			"once per session",
		);
	});

	it("stays quiet and deterministic without any typesafe.json", async () => {
		const { fetch, calls } = mockSystemOneFetch(() => ({}));
		const rig = await createToolRig({ env: {}, fetch });
		const paths = await storePathsFor(rig);
		await seedMemory(
			paths.legacy.directory,
			memoryId(0),
			"2026-09-01T00:00:00.000Z",
			"Payment deploy notes",
			"Body",
			{ tags: ["deploy"], containment: storeContainment(paths.root) },
		);
		const result = await executeRecall(rig, { scope: "legacy-global", query: "payment deploy", limit: 5 });
		assert.equal(result.details.retrieval.method, "deterministic");
		assert.equal(result.details.retrieval.reason, "config-absent");
		assert.deepEqual(result.details.matches.map((match: { id: string }) => match.id), [memoryId(0)]);
		assert.equal(calls.length, 0);
		assert.equal(rig.ctx.notifications.filter((note) => note.message.includes("semantic")).length, 0);
	});

	it("aborts on user cancellation instead of publishing deterministic fallback", async () => {
		const hanging = hangUntilAbort();
		const rig = await createToolRig({
			typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" },
			keyFileContent: "tool-key\n",
			fetch: hanging.fetch,
		});
		const paths = await storePathsFor(rig);
		await seedMemory(
			paths.legacy.directory,
			memoryId(0),
			"2026-09-01T00:00:00.000Z",
			"Payment deploy notes",
			"Body",
			{ tags: ["deploy", "payment"], containment: storeContainment(paths.root) },
		);
		const controller = new AbortController();
		const pending = executeRecall(rig, { scope: "legacy-global", query: "payment deploy", limit: 5 }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		await assert.rejects(pending, /PI_MEMORY_RECALL_ABORTED/);
		assert.ok(hanging.aborted >= 1);
		assert.equal(
			rig.ctx.notifications.filter((note) => note.message.includes("semantic recall unavailable")).length,
			0,
			"cancellation is not a fallback",
		);
	});

	it("applies limit and includeDetails to semantic results", async () => {
		const { fetch } = mockSystemOneFetch((call) => answerAll(call, () => 0.9));
		const rig = await createToolRig({
			typesafe: { memory: { enabled: true }, apiKeyFile: "typesafe.key" },
			keyFileContent: "tool-key\n",
			fetch,
		});
		const paths = await storePathsFor(rig);
		for (let index = 0; index < 3; index += 1) {
			await seedMemory(
				paths.legacy.directory,
				memoryId(index),
				`2026-09-0${index + 1}T00:00:00.000Z`,
				`Topic ${index}`,
				`Body ${index} contents`,
				{ containment: storeContainment(paths.root) },
			);
		}
		const limited = await executeRecall(rig, { scope: "legacy-global", query: "anything relevant", limit: 2 });
		assert.equal(limited.details.matches.length, 2);
		assert.equal(limited.details.retrieval.method, "semantic");
		const terse = await executeRecall(rig, {
			scope: "legacy-global",
			query: "anything relevant",
			limit: 2,
			includeDetails: false,
		});
		assert.equal(terse.details.matches.length, 2);
		assert.ok(terse.details.matches.every((match: { body?: string }) => match.body === undefined));
		assert.ok(!(terse.content[0].text as string).includes("contents"));
	});

	it("reports semantic availability in /pi-memory status", async () => {
		const { fetch } = mockSystemOneFetch(() => ({}));
		const rig = await createToolRig({
			typesafe: { memory: { enabled: true, minRelevance: 0.5 }, apiKeyFile: "typesafe.key" },
			keyFileContent: "tool-key\n",
			fetch,
		});
		await rig.harness.command("pi-memory").handler("status", rig.ctx.context);
		const status = rig.ctx.notifications.map((note) => note.message).find((message) => message.includes("Semantic recall:"));
		assert.ok(status?.includes("Semantic recall: active (model jev-1.13.0, min relevance 0.5)"), status);

		const bare = await createToolRig({ env: {}, fetch });
		await bare.harness.command("pi-memory").handler("status", bare.ctx.context);
		const bareStatus = bare.ctx.notifications.map((note) => note.message).find((message) => message.includes("Semantic recall:"));
		assert.ok(bareStatus?.includes("Semantic recall: off (no typesafe.json)"), bareStatus);
	});
});

afterEach(async () => {
	await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryDirectories.clear();
});
