import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import {
	MEMORY_INJECTION_BUDGETS,
	measureAlwaysBlock,
	renderAlwaysBlock,
	type InjectionScope,
} from "../src/injection.js";
import { formatMemoryError } from "../src/errors.js";
import {
	applyMemoryMutation,
	estimateTokens,
	mutateMemoryStore,
	parseDetails,
	readMemorySnapshot,
	serializeDetails,
	serializeIndex,
	type Memory,
	type MemoryMutation,
} from "../src/store.js";

const NOW = "2026-08-05T10:00:00.000Z";
const ID = "m_aaaaaaaaaa";
const SECOND_ID = "m_bbbbbbbbbb";
const fixtureRoot = fileURLToPath(new URL("fixtures/v1/", import.meta.url));
const directories = new Set<string>();

async function temporaryStore(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-memory-injection-store-"));
	directories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

function memory(overrides: Partial<Memory> = {}): Memory {
	return { id: ID, title: "Pinned fact", updated: NOW, tags: ["type:project"], cue: "Every request", body: "Remember this.", injection: "on-demand", ...overrides };
}

async function seed(directory: string, memories: readonly Memory[]): Promise<void> {
	await writeFile(join(directory, "details.md"), serializeDetails(memories));
	await writeFile(join(directory, "index.md"), serializeIndex(memories));
}

async function diskBytes(directory: string): Promise<{ details: Buffer; index: Buffer }> {
	return { details: await readFile(join(directory, "details.md")), index: await readFile(join(directory, "index.md")) };
}

async function rejectUnchanged(directory: string, mutation: MemoryMutation, code: string,
	options: Parameters<typeof mutateMemoryStore>[2] = {}): Promise<Error> {
	const before = await diskBytes(directory);
	let checkpoints = 0;
	let caught: unknown;
	try {
		await mutateMemoryStore(directory, mutation, {
			...options,
			now: NOW,
			hooks: { checkpoint: () => { checkpoints += 1; } },
		});
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error, `expected ${code}`);
	assert.equal((caught as Error & { code: string }).code, code);
	assert.equal((caught as Error & { committed: boolean }).committed, false);
	assert.equal(checkpoints, 0, "rejection must precede transaction temp creation");
	assert.deepEqual(await diskBytes(directory), before);
	assert.deepEqual((await readdir(directory)).sort(), ["details.md", "index.md"]);
	return caught;
}

describe("store injection policy format and mutation", () => {
	it.each(["empty", "complex-single", "multi-unicode", "near-cap", "over-cap"])(
		"preserves canonical legacy %s details/index bytes with absent or explicit default policy", async (fixture) => {
			const details = await readFile(join(fixtureRoot, fixture, "details.md"), "utf8");
			const index = await readFile(join(fixtureRoot, fixture, "index.md"), "utf8");
			const parsed = parseDetails(details);
			assert.ok(parsed.every((entry) => (entry.injection ?? "on-demand") === "on-demand"));
			assert.equal(serializeDetails(parsed), details);
			assert.equal(serializeDetails(parsed.map((entry) => ({ ...entry, injection: "on-demand" }))), details);
			assert.equal(serializeIndex(parsed.map((entry) => ({ ...entry, injection: "always" }))), index);
			const directory = await temporaryStore();
			await writeFile(join(directory, "details.md"), details);
			await writeFile(join(directory, "index.md"), index);
			const before = await diskBytes(directory);
			const snapshot = await readMemorySnapshot(directory);
			assert.equal(snapshot.generation, `sha256:${createHash("sha256").update(before.details).digest("hex")}`);
			assert.deepEqual(await diskBytes(directory), before);
		},
	);

	it("accepts explicit on-demand metadata but canonically omits it; always appears after Cue only", () => {
		const legacy = serializeDetails([memory({ body: "Injection: invalid is ordinary body text\n\n## m_bbbbbbbbbb — escaped heading\n尾 🧠" })]);
		const explicitDefault = legacy.replace("Cue: Every request\n", "Cue: Every request\nInjection: on-demand\n");
		assert.equal(serializeDetails(parseDetails(explicitDefault)), legacy);
		const always = memory({ ...parseDetails(legacy)[0], injection: "always" });
		const encoded = serializeDetails([always]);
		assert.equal(encoded, legacy.replace("Cue: Every request\n", "Cue: Every request\nInjection: always\n"));
		assert.deepEqual(parseDetails(encoded), [always]);
	});

	it("creates default/on-demand and always policies and supports same-ID policy-only promotion/demotion", async () => {
		const directory = await temporaryStore();
		const created = await mutateMemoryStore(directory, { action: "create", title: "Pinned fact", cue: "Every request", body: "Remember this.", tags: ["type:project"] }, { now: NOW, idFactory: () => ID });
		assert.equal(created.memory?.injection ?? "on-demand", "on-demand");
		const legacy = await diskBytes(directory);
		const promoted = await mutateMemoryStore(directory, { action: "update", id: ID, injection: "always" }, { now: NOW });
		assert.deepEqual(promoted.memory, { ...created.memory, injection: "always" });
		assert.deepEqual((await diskBytes(directory)).index, legacy.index);
		const edited = await mutateMemoryStore(directory, { action: "update", id: ID, title: "Edited", cue: "New cue", body: "New body", tags: ["type:user"] }, { now: NOW });
		assert.deepEqual(edited.memory, { ...promoted.memory, title: "Edited", cue: "New cue", body: "New body", tags: ["type:user"] });
		const demoted = await mutateMemoryStore(directory, { action: "update", id: ID, injection: "on-demand" }, { now: NOW });
		assert.equal(demoted.memory?.id, ID);
		assert.equal(demoted.memory?.injection ?? "on-demand", "on-demand");
		assert.equal((await readMemorySnapshot(directory)).memories.length, 1);
		assert.doesNotMatch((await diskBytes(directory)).details.toString(), /^Injection:/m);
		const newAlways = await mutateMemoryStore(directory, { action: "create", title: "Second", cue: "Always", body: "Selected", injection: "always" }, { now: NOW, idFactory: () => SECOND_ID });
		assert.equal(newAlways.memory?.injection, "always");
		assert.equal((await readMemorySnapshot(directory)).memories.find((entry) => entry.id === SECOND_ID)?.injection, "always");
	});

	it("policy-only promote then demote restores exact legacy bytes when timestamp is unchanged", async () => {
		const directory = await temporaryStore();
		await seed(directory, [memory()]);
		const before = await diskBytes(directory);
		await mutateMemoryStore(directory, { action: "update", id: ID, injection: "always" }, { now: NOW });
		await mutateMemoryStore(directory, { action: "update", id: ID, injection: "on-demand" }, { now: NOW });
		assert.deepEqual(await diskBytes(directory), before);
	});

	it.each(["sometimes", "ALWAYS", "", "always ", "on-demand\nInjection: always"])("fails closed on invalid persisted policy %j", async (policy) => {
		const directory = await temporaryStore();
		await seed(directory, [memory()]);
		const invalid = serializeDetails([memory()]).replace("Cue: Every request\n", `Cue: Every request\nInjection: ${policy}\n`);
		assert.throws(() => parseDetails(invalid));
		await writeFile(join(directory, "details.md"), invalid);
		await assert.rejects(readMemorySnapshot(directory), { code: "STORE_CORRUPT" });
		await rejectUnchanged(directory, { action: "delete", id: ID }, "STORE_CORRUPT");
	});

	describe.each(["create", "update"] as const)("invalid %s policy", (action) => {
		const invalidPolicies = ["sometimes", "ALWAYS", "", null, 1, true];
		function invalidMutation(policy: unknown): MemoryMutation {
			return (action === "create"
				? { action, title: "Bad", cue: "Bad", body: "Bad", injection: policy }
				: { action, id: ID, body: "Must not change", injection: policy }) as MemoryMutation;
		}
		it.each(invalidPolicies)("pure mutation rejects %j", (policy) => {
			assert.throws(() => applyMemoryMutation([memory()], invalidMutation(policy), NOW, () => SECOND_ID));
		});
		it.each(invalidPolicies)("standalone mutation rejects %j before writing", async (policy) => {
			const directory = await temporaryStore();
			await seed(directory, [memory()]);
			await rejectUnchanged(directory, invalidMutation(policy), "INVALID_ARGUMENT", { idFactory: () => SECOND_ID });
		});
	});
});

// Fixed contract values are independent of the production budget constants.
const LIMITS = {
	project: { bytes: 7_680, tokens: 1_872 },
	"legacy-global": { bytes: 3_584, tokens: 872 },
} as const;
const SCOPES = ["project", "legacy-global"] as const;
const GENERATION = `sha256:${"0".repeat(64)}` as const;

function fullContent(scope: InjectionScope, entries: readonly Memory[]): string {
	// Render without admission filtering so the test counts the complete would-be
	// block, not the overflow diagnostic. No SDK/context behavior is tested here.
	const rendered = renderAlwaysBlock({ memories: entries, generation: GENERATION }, {
		scope,
		budget: { ...MEMORY_INJECTION_BUDGETS[scope], maxBytes: 100_000, maxEstimatedTokens: 100_000 },
	});
	assert.equal(rendered?.state, "ready");
	return rendered!.content;
}

function usage(scope: InjectionScope, entries: readonly Memory[]): { bytes: number; tokens: number } {
	if (!entries.some((entry) => entry.injection === "always")) return { bytes: 0, tokens: 0 };
	const content = fullContent(scope, entries);
	return { bytes: Buffer.byteLength(content, "utf8"), tokens: Math.ceil(content.length / 4) };
}

function fits(scope: InjectionScope, entries: readonly Memory[]): boolean {
	const used = usage(scope, entries);
	return used.bytes <= LIMITS[scope].bytes && used.tokens <= LIMITS[scope].tokens;
}

function boundaryMemory(scope: InjectionScope, dimension: "bytes" | "tokens", escaped = false): Memory {
	const prefix = escaped ? "\u0000\\</pi_memory_always>\n🧠" : "";
	const entry = memory({ injection: "always", body: prefix });
	const empty = fullContent(scope, [entry]);
	const remaining = dimension === "bytes"
		? LIMITS[scope].bytes - Buffer.byteLength(empty, "utf8")
		: LIMITS[scope].tokens * 4 - empty.length;
	assert.ok(remaining > 0);
	entry.body += dimension === "bytes"
		? "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3)
		: "x".repeat(remaining);
	assert.equal(usage(scope, [entry])[dimension], LIMITS[scope][dimension]);
	assert.ok(fits(scope, [entry]));
	return entry;
}

describe.each(SCOPES)("%s store reserved full-render budget", (scope) => {
	const options = { now: NOW, injectionBudget: MEMORY_INJECTION_BUDGETS[scope] };

	it("pins the independent per-scope limits and diagnostic reservation", () => {
		assert.deepEqual(MEMORY_INJECTION_BUDGETS[scope], {
			scope,
			maxBytes: scope === "project" ? 8_192 : 4_096,
			maxEstimatedTokens: scope === "project" ? 2_000 : 1_000,
			reservedBytes: 512,
			reservedEstimatedTokens: 128,
		});
	});

	it.each(["bytes", "tokens"] as const)("admits exact %s capacity and rejects one over before temp/commit work", async (dimension) => {
		const directory = await temporaryStore();
		const entry = boundaryMemory(scope, dimension);
		const rendered = fullContent(scope, [entry]);
		assert.ok(rendered.includes(ID) && rendered.includes(entry.title) && rendered.includes(entry.cue));
		assert.ok(rendered.includes(NOW) && rendered.includes("type:project"));
		assert.match(rendered, /advisory="untrusted"/);
		assert.match(rendered, /<\/pi_memory_always>$/);
		assert.ok(rendered.length > entry.body.length, "wrappers, advisory and metadata consume capacity");
		const created = await mutateMemoryStore(directory, { action: "create", title: entry.title, cue: entry.cue, body: entry.body, tags: entry.tags, injection: "always" }, { ...options, idFactory: () => ID });
		assert.ok(fits(scope, created.memories));
		const measured = measureAlwaysBlock(created.memories, MEMORY_INJECTION_BUDGETS[scope]);
		assert.equal(measured.bytes, Buffer.byteLength(rendered, "utf8"));
		assert.equal(measured.estimatedTokens, Math.ceil(rendered.length / 4));
		assert.equal(measured.overBudget, false);
		const before = await readMemorySnapshot(directory);
		const projected = [{ ...entry, body: entry.body + "x" }];
		assert.equal(usage(scope, projected)[dimension], LIMITS[scope][dimension] + 1);
		assert.ok(Buffer.byteLength(projected[0].body, "utf8") < LIMITS[scope].bytes);
		assert.ok(estimateTokens(serializeDetails(projected)) < 4_000, "isolate injection, not storage cap");
		const error = await rejectUnchanged(directory, { action: "update", id: ID, body: projected[0].body }, "INJECTION_BUDGET_EXCEEDED", options);
		assert.match(error.message, new RegExp(scope));
		assert.match(formatMemoryError(error), /on-demand|demot|shrink|delet/i);
		assert.equal((await readMemorySnapshot(directory)).generation, before.generation);
		await rejectUnchanged(directory, { action: "create", title: "Another", cue: "Always", body: "x", injection: "always" }, "INJECTION_BUDGET_EXCEEDED", { ...options, idFactory: () => SECOND_ID });
	});

	it("charges reversible escaping and multibyte text before admitting an exact token boundary", async () => {
		const directory = await temporaryStore();
		const entry = boundaryMemory(scope, "tokens", true);
		const rendered = fullContent(scope, [entry]);
		assert.ok(rendered.includes("\\u0000"));
		assert.ok(rendered.includes("<\\/pi_memory_always>"));
		assert.ok(rendered.includes("🧠"));
		assert.ok(Buffer.byteLength(rendered, "utf8") > rendered.length);
		assert.ok(rendered.length - fullContent(scope, [memory({ injection: "always", body: "" })]).length > entry.body.length);
		await seed(directory, [{ ...entry, injection: "on-demand" }]);
		await mutateMemoryStore(directory, { action: "update", id: ID, injection: "always" }, options);
		assert.equal((await readMemorySnapshot(directory)).memories[0].body, entry.body);
		await rejectUnchanged(directory, { action: "update", id: ID, body: entry.body + "x" }, "INJECTION_BUDGET_EXCEEDED", options);
	});

	it("does not charge on-demand bodies against the always reservation", async () => {
		const directory = await temporaryStore();
		const entry = boundaryMemory(scope, "tokens");
		await seed(directory, [entry]);
		const result = await mutateMemoryStore(directory, { action: "create", title: "Reference", cue: "Explicit lookup", body: "r".repeat(1_000), injection: "on-demand" }, { ...options, idFactory: () => SECOND_ID });
		assert.deepEqual(usage(scope, result.memories), usage(scope, [entry]));
	});

	it.each(["demote", "delete", "shrink"] as const)("permits %s recovery even when the externally oversized set remains over budget", async (recovery) => {
		const directory = await temporaryStore();
		const oversized = { ...boundaryMemory(scope, "tokens"), body: boundaryMemory(scope, "tokens").body + "x".repeat(100) };
		const entries = [oversized, memory({ id: SECOND_ID, injection: "always", body: "Small" })];
		assert.ok(!fits(scope, entries));
		assert.ok(estimateTokens(serializeDetails(entries)) < 4_000);
		await seed(directory, entries);
		const mutation: MemoryMutation = recovery === "demote"
			? { action: "update", id: SECOND_ID, injection: "on-demand" }
			: recovery === "delete" ? { action: "delete", id: SECOND_ID }
			: { action: "update", id: ID, body: oversized.body.slice(0, -4) };
		const result = await mutateMemoryStore(directory, mutation, options);
		const before = usage(scope, entries);
		const after = usage(scope, result.memories);
		assert.ok(after.bytes <= before.bytes && after.tokens <= before.tokens);
		assert.ok(after.bytes < before.bytes || after.tokens < before.tokens);
		assert.ok(!fits(scope, result.memories));
		assert.equal(await readFile(join(directory, "details.md"), "utf8"), serializeDetails(result.memories));
		assert.equal(await readFile(join(directory, "index.md"), "utf8"), serializeIndex(result.memories));
		await mutateMemoryStore(directory, { action: "update", id: ID, body: "Recovered" }, options);
		assert.ok(fits(scope, (await readMemorySnapshot(directory)).memories));
	});

	it("allows one-byte shrink while estimated token usage remains unchanged and over cap", async () => {
		const directory = await temporaryStore();
		const boundary = boundaryMemory(scope, "tokens");
		const oversized = { ...boundary, body: boundary.body + "x".repeat(100) };
		await seed(directory, [oversized]);
		const before = usage(scope, [oversized]);
		const result = await mutateMemoryStore(directory, { action: "update", id: ID, body: oversized.body.slice(0, -1) }, options);
		const after = usage(scope, result.memories);
		assert.equal(after.bytes, before.bytes - 1);
		assert.equal(after.tokens, before.tokens);
		assert.ok(!fits(scope, result.memories));
	});

	it("rejects no-op, growth, and shrink-in-only-one-dimension recovery while over cap", async () => {
		const directory = await temporaryStore();
		const oversized = { ...boundaryMemory(scope, "tokens"), body: "界".repeat(8) + boundaryMemory(scope, "tokens").body + "x".repeat(100) };
		await seed(directory, [oversized]);
		const before = usage(scope, [oversized]);
		const candidates = [
			oversized.body,
			oversized.body + "x",
			oversized.body.replace("x".repeat(8), "界".repeat(4)), // fewer UTF-16 units, more bytes
			oversized.body.replace("界".repeat(8), "x".repeat(16)), // fewer bytes, more UTF-16 units
		];
		const byteGrowth = usage(scope, [{ ...oversized, body: candidates[2] }]);
		const tokenGrowth = usage(scope, [{ ...oversized, body: candidates[3] }]);
		assert.ok(byteGrowth.bytes > before.bytes && byteGrowth.tokens < before.tokens);
		assert.ok(tokenGrowth.bytes < before.bytes && tokenGrowth.tokens > before.tokens);
		for (const body of candidates) {
			await rejectUnchanged(directory, { action: "update", id: ID, body }, "INJECTION_BUDGET_EXCEEDED", options);
		}
	});

	it("checks capacity against the authoritative snapshot read under the held lock, not stale preflight state", async () => {
		const directory = await temporaryStore();
		const first = boundaryMemory(scope, "tokens");
		const second = { ...first, id: SECOND_ID, injection: "on-demand" as const };
		await seed(directory, [{ ...first, injection: "on-demand" }, second]);
		let guardedBytes: Awaited<ReturnType<typeof diskBytes>> | undefined;
		let checkpoints = 0;
		await assert.rejects(mutateMemoryStore(directory, { action: "update", id: SECOND_ID, injection: "always" }, {
			...options,
			guard: async ({ lock }) => {
				assert.equal(await lock.isOwned(), true);
				// Deterministically simulate a preceding writer between a hypothetical
				// preflight read and the real under-lock authoritative snapshot.
				await seed(directory, [first, second]);
				guardedBytes = await diskBytes(directory);
			},
			hooks: { checkpoint: () => { checkpoints += 1; } },
		}), { code: "INJECTION_BUDGET_EXCEEDED", committed: false });
		assert.ok(guardedBytes);
		assert.equal(checkpoints, 0);
		assert.deepEqual(await diskBytes(directory), guardedBytes);
		assert.ok(fits(scope, (await readMemorySnapshot(directory)).memories));
	});

	it.each(["in-process", "multiprocess"] as const)("serializes %s competing promotions: exactly one admitted, every commit within capacity", async (concurrency) => {
		const directory = await temporaryStore();
		const first = boundaryMemory(scope, "tokens");
		const second = { ...first, id: SECOND_ID };
		assert.ok(fits(scope, [first]) && fits(scope, [second]));
		assert.ok(!fits(scope, [first, second]));
		const initial = [first, second].map((entry) => ({ ...entry, injection: "on-demand" as const }));
		assert.ok(estimateTokens(serializeDetails(initial)) < 4_000, "race must not hit storage cap");
		await seed(directory, initial);
		const commits: Array<{ ids: string[]; bytes: number; tokens: number }> = [];
		let outcomes: Array<{ id: string; code?: string }>;
		if (concurrency === "multiprocess") {
			const results = await concurrentPromotions(directory, scope);
			outcomes = results.map(({ id, code }) => ({ id, ...(code ? { code } : {}) }));
			for (const result of results) if (result.commit) commits.push(result.commit);
		} else {
			outcomes = await Promise.all([ID, SECOND_ID].map(async (id) => {
				try {
					await mutateMemoryStore(directory, { action: "update", id, injection: "always" }, {
						...options,
						guard: async ({ lock }) => { assert.equal(await lock.isOwned(), true); },
						hooks: { checkpoint: async (name) => {
							if (name !== "after-details-rename") return;
							const snapshot = await readMemorySnapshot(directory);
							commits.push({ ids: snapshot.memories.filter((entry) => entry.injection === "always").map((entry) => entry.id), ...usage(scope, snapshot.memories) });
						} },
					});
					return { id };
				} catch (error) {
					assert.ok(error instanceof Error);
					return { id, code: (error as Error & { code?: string }).code ?? "UNEXPECTED" };
				}
			}));
		}
		const winners = outcomes.filter((outcome) => outcome.code === undefined);
		const losers = outcomes.filter((outcome) => outcome.code !== undefined);
		assert.equal(winners.length, 1, JSON.stringify(outcomes));
		assert.equal(losers.length, 1, JSON.stringify(outcomes));
		assert.equal(losers[0].code, "INJECTION_BUDGET_EXCEEDED");
		assert.equal(commits.length, 1);
		for (const commit of commits) {
			assert.deepEqual(commit.ids, [winners[0].id]);
			assert.ok(commit.bytes <= LIMITS[scope].bytes && commit.tokens <= LIMITS[scope].tokens);
		}
		const snapshot = await readMemorySnapshot(directory);
		assert.deepEqual(snapshot.memories.map((entry) => entry.id).sort(), [ID, SECOND_ID]);
		assert.deepEqual(snapshot.memories.filter((entry) => entry.injection === "always").map((entry) => entry.id), [winners[0].id]);
		assert.equal(snapshot.memories.find((entry) => entry.id === losers[0].id)?.injection ?? "on-demand", "on-demand");
		assert.ok(snapshot.memories.every((entry) => entry.body === first.body));
		assert.ok(fits(scope, snapshot.memories));
		assert.equal(await readFile(join(directory, "index.md"), "utf8"), serializeIndex(snapshot.memories));
		assert.deepEqual((await readdir(directory)).sort(), ["details.md", "index.md"]);
	}, 20_000);
});

interface PromotionOutcome {
	id: string;
	code?: string;
	commit?: { ids: string[]; bytes: number; tokens: number };
}

async function concurrentPromotions(directory: string, scope: InjectionScope): Promise<PromotionOutcome[]> {
	// Inline child program keeps this regression self-contained: no helper file,
	// real separate process queues, real cross-process store lock, built source.
	const program = `
		import assert from "node:assert/strict";
		const [storeUrl, injectionUrl, directory, scope, id, now] = JSON.parse(process.argv[1]);
		const { mutateMemoryStore, readMemorySnapshot } = await import(storeUrl);
		const { MEMORY_INJECTION_BUDGETS, renderAlwaysBlock } = await import(injectionUrl);
		process.once("message", async () => {
			let commit;
			let hookFailure;
			let held;
			let result;
			try {
				await mutateMemoryStore(directory, { action: "update", id, injection: "always" }, {
					now, injectionBudget: MEMORY_INJECTION_BUDGETS[scope],
					guard: async ({ lock }) => { assert.equal(await lock.isOwned(), true); held = lock; },
					hooks: { checkpoint: async (name) => {
						if (name !== "after-details-rename") return;
						try {
							assert.equal(await held.isOwned(), true);
							const snapshot = await readMemorySnapshot(directory);
							const rendered = renderAlwaysBlock(snapshot, { scope });
							assert.equal(rendered?.state, "ready");
							commit = { ids: rendered.ids, bytes: Buffer.byteLength(rendered.content, "utf8"), tokens: Math.ceil(rendered.content.length / 4) };
						} catch (error) { hookFailure = String(error.stack ?? error); }
					} },
				});
				if (hookFailure) throw new Error(hookFailure);
				result = { id, commit };
			} catch (error) { result = { id, code: error.code ?? "UNEXPECTED", error: String(error.stack ?? error) }; }
			process.send({ type: "done", result }, () => process.disconnect());
		});
		process.send({ type: "ready" });
	`;
	const storeUrl = new URL("../dist/store.js", import.meta.url).href;
	const injectionUrl = new URL("../dist/injection.js", import.meta.url).href;
	const states: Array<{ child: ChildProcess; exited: Promise<void>; ready: Promise<void>; done: Promise<PromotionOutcome> }> = [];
	try {
		for (const id of [ID, SECOND_ID]) {
			const child = spawn(process.execPath, ["--input-type=module", "--eval", program,
				JSON.stringify([storeUrl, injectionUrl, directory, scope, id, NOW])], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
			let diagnostics = "";
			child.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
			child.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
			let readyResolve!: () => void;
			let readyReject!: (error: Error) => void;
			let doneResolve!: (result: PromotionOutcome) => void;
			let doneReject!: (error: Error) => void;
			const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
			const done = new Promise<PromotionOutcome>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
			void ready.catch(() => undefined);
			void done.catch(() => undefined);
			let outcome: PromotionOutcome | undefined;
			child.on("message", (message: unknown) => {
				const event = message as { type?: string; result?: PromotionOutcome };
				if (event.type === "ready") readyResolve();
				if (event.type === "done") outcome = event.result;
			});
			const fail = (error: Error) => { readyReject(error); doneReject(error); };
			child.once("error", fail);
			const exited = new Promise<void>((resolve) => child.once("close", (code, signal) => {
				if (code !== 0 || !outcome) fail(new Error(`promotion ${id} exited ${code}/${signal}: ${diagnostics}`));
				else doneResolve(outcome);
				resolve();
			}));
			states.push({ child, exited, ready, done });
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				(async () => {
					await Promise.all(states.map((state) => state.ready));
					for (const state of states) state.child.send({ type: "go" });
					return Promise.all(states.map((state) => state.done));
				})(),
				new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("promotion barrier timed out")), 15_000); }),
			]);
		} finally { clearTimeout(timeout); }
	} finally {
		for (const { child } of states) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await Promise.all(states.map((state) => state.exited));
	}
}

