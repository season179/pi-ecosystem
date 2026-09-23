import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import { afterEach, describe, it } from "vitest";
import {
	automationStatusLines,
	classifyUnit,
	MemoryAutomation,
	parseAutomationConfig,
	projectTag,
	recallTagGroups,
	TAG_PROJECT_FACT,
	TAG_TRANSFERABLE,
	TAG_USER_WIDE,
	type AutomationContext,
} from "../src/automation.js";
import { createMemoryExtension } from "../src/extensions/memory.js";
import type { HindsightFetch, TagGroup } from "../src/hindsight.js";
import type { UnitProbabilities } from "../src/jev-gate.js";
import { resolveMemoryRoot, storeContainment } from "../src/paths.js";
import { createSdkHarness, toolCall, type ProviderCapture, type SdkHarness } from "./helpers/sdk-harness.js";

const MEMORY_TEXT = "HS_MEMORY_7c1e: the user forbids AI attribution lines such as Co-authored-by in commits";
const PERIODIC_TEXT = "HS_PERIODIC_52aa: CalVer releases use YY.MM.PATCH";
const PROMPT = "Please commit the staged changes with a short message.";
const PROJECT_FACT: UnitProbabilities = { user_preference: 0.05, project_fact: 0.8, transferable_lesson: 0.05, not_durable: 0.1 };
const USER_PREFERENCE: UnitProbabilities = { user_preference: 0.9, project_fact: 0.04, transferable_lesson: 0.03, not_durable: 0.03 };
const NOT_DURABLE: UnitProbabilities = { user_preference: 0.02, project_fact: 0.03, transferable_lesson: 0.05, not_durable: 0.9 };

const temporary = new Set<string>();
const harnesses = new Set<SdkHarness>();

afterEach(async () => {
	for (const harness of harnesses) await harness.dispose();
	harnesses.clear();
	for (const path of temporary) await rm(path, { recursive: true, force: true });
	temporary.clear();
});

interface JevCall {
	questions: string[];
	state: {
		earlier_messages: Array<{ text: string }>;
		fresh_messages: Array<{ role: string; text: string }>;
		units: Array<{ message: number; text: string }>;
	};
}

type JudgedUnit = { role: string; text: string };

interface RetainBody {
	items: Array<{ content: string; metadata: Record<string, string>; tags: string[]; document_id?: string }>;
	async: boolean;
	operation_id: string;
}

interface Services {
	/** Mutable Jev answers for subsequent calls; `unit` may depend on the judged message. */
	answers: {
		unit: UnitProbabilities | ((unit: JudgedUnit) => UnitProbabilities);
		portable: number | ((unit: JudgedUnit) => number);
		recall: number;
	};
	jev: Fetch;
	hindsight: HindsightFetch;
	jevCalls: JevCall[];
	recalls: Array<{ query: string; tag_groups?: TagGroup[]; tags?: unknown; prefer_observations?: unknown }>;
	retains: RetainBody[];
}

function fakeServices(options: {
	unit?: Services["answers"]["unit"];
	portable?: Services["answers"]["portable"];
	recall?: number;
	jev?: (call: JevCall) => Promise<Response> | Response | undefined;
	recallResponse?: (index: number, body: { tag_groups?: TagGroup[] }) => Promise<Response> | Response;
	retainResponse?: () => Promise<Response> | Response;
} = {}): Services {
	const services: Services = {
		answers: { unit: options.unit ?? PROJECT_FACT, portable: options.portable ?? 0.9, recall: options.recall ?? 0.9 },
		jevCalls: [],
		recalls: [],
		retains: [],
		jev: async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: JevCall["state"] };
			const call = { questions: Object.keys(body.questions).sort(), state: body.state };
			services.jevCalls.push(call);
			const override = await options.jev?.(call);
			if (override !== undefined) return override;
			const answers: Record<string, unknown> = {};
			for (const key of Object.keys(body.questions).filter((name) => name.startsWith("unit_"))) {
				const index = Number(key.slice(5));
				const span = body.state.units[index];
				const judged = { role: body.state.fresh_messages[span.message].role, text: span.text };
				const { unit, portable } = services.answers;
				const probabilities = typeof unit === "function" ? unit(judged) : unit;
				const choice = Object.entries(probabilities).reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
				answers[key] = { type: "choice", choice, confidence: 0.9, probabilities };
				answers[`scope_${index}`] = { type: "noul", noul: typeof portable === "function" ? portable(judged) : portable };
			}
			if (body.questions.recall) answers.recall = { type: "noul", noul: services.answers.recall };
			return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } });
		},
		hindsight: async (input, init) => {
			const body = JSON.parse(String(init.body));
			if (input.endsWith("/memories/recall")) {
				services.recalls.push(body);
				if (options.recallResponse !== undefined) return options.recallResponse(services.recalls.length - 1, body);
				return Response.json({
					results: [
						{
							id: "f1",
							text: MEMORY_TEXT,
							type: "world",
							mentioned_at: "2026-09-01T00:00:00Z",
							tags: [TAG_USER_WIDE],
							metadata: { source_project: "other-repo" },
						},
					],
				});
			}
			services.retains.push(body);
			if (options.retainResponse !== undefined) return options.retainResponse();
			return Response.json({ success: true, bank_id: "test-bank", items_count: 1, async: true, operation_id: body.operation_id });
		},
	};
	return services;
}

async function workspace(automation: unknown | undefined, typesafe: unknown = { timeoutMs: 1000 }) {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-automation-"));
	temporary.add(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(join(agentDir, "pi-memory"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	if (automation !== undefined) await writeFile(join(agentDir, "pi-memory", "automation.json"), JSON.stringify(automation));
	await writeFile(join(agentDir, "typesafe.json"), JSON.stringify(typesafe));
	return { agentDir, cwd };
}

async function session(
	services: Services,
	options: { automation?: unknown; env?: NodeJS.ProcessEnv; now?: () => number; responses?: SdkHarness extends never ? never : Parameters<typeof createSdkHarness>[0]["responses"] } = {},
) {
	const { agentDir, cwd } = await workspace(
		"automation" in options ? options.automation : { version: 1, bank: "test-bank", periodicEveryRequests: 2 },
	);
	const automations: MemoryAutomation[] = [];
	const diagnostics: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	const harness = await createSdkHarness({
		cwd,
		agentDir,
		responses: options.responses ?? [],
		memoryExtension: createMemoryExtension({
			agentDir,
			env: { TYPESAFE_API_KEY: "test-key", ...options.env },
			fetch: services.jev,
			hindsightFetch: services.hindsight,
			...(options.now !== undefined ? { now: options.now } : {}),
			onAutomation: (automation) => automations.push(automation),
		}),
	});
	harnesses.add(harness);
	return {
		harness,
		diagnostics,
		automation: () => automations[automations.length - 1],
		async prompt(text: string) {
			process.stderr.write = ((chunk: string | Uint8Array) => {
				diagnostics.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;
			try {
				await harness.prompt(text);
				await automations[automations.length - 1]?.idle();
			} finally {
				process.stderr.write = originalWrite;
			}
		},
	};
}

function requestText(capture: ProviderCapture): string {
	return JSON.stringify(capture.context.messages);
}

/** MemoryAutomation driven directly, with a fake project identity. */
async function unitRig(
	hindsight: HindsightFetch,
	jev: Fetch,
	options: { identityHash?: string; name?: string; mode?: "read-only" | "read-write"; diagnostics?: string[] } = {},
) {
	const { agentDir } = await workspace({ version: 1, bank: "test-bank", periodicEveryRequests: 1 });
	const root = await resolveMemoryRoot(agentDir);
	const automation = new MemoryAutomation({
		agentDir,
		env: { TYPESAFE_API_KEY: "k" },
		jevFetch: jev,
		hindsightFetch: hindsight,
		now: Date.now,
		diagnose: (_key, message) => options.diagnostics?.push(message),
	});
	const mode = options.mode ?? "read-only";
	const context = (signal?: AbortSignal): AutomationContext => ({
		mode,
		identity: {
			status: "ok",
			kind: "directory",
			canonicalIdentity: "/p",
			identityHash: options.identityHash ?? "h".repeat(64),
			displayName: options.name ?? "p",
			directoryName: "p-1",
		} as never,
		memoryRoot: root.root,
		containment: storeContainment(root),
		signal,
		currentMode: async () => mode,
		sessionId: "session-1",
	});
	return { automation, context };
}

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp }) as never;
const assistant = (text: string, timestamp: number) =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp, stopReason: "stop" }) as never;

describe("automatic memory through a real Pi SDK session", () => {
	it("recalls into the prompt request and retains the exchange without any memory tool call", async () => {
		// The final reply is judged at run end; chatter is not durable, so only the prompt is stored.
		const services = fakeServices({ unit: (unit) => (unit.role === "assistant" ? NOT_DURABLE : PROJECT_FACT) });
		const rig = await session(services, { responses: [{ kind: "text", text: "Committed." }] });
		await rig.prompt(PROMPT);

		assert.equal(rig.harness.captures.length, 1);
		const context = requestText(rig.harness.captures[0]);
		assert.ok(context.includes(MEMORY_TEXT), "recalled memory reaches the very first request");
		assert.ok(context.includes("pi_memory_recalled advisory=\\\"untrusted\\\""));
		assert.ok(context.includes("(user-wide preference; stated in project other-repo)"));
		assert.ok(!JSON.stringify(rig.harness.captures[0].context.systemPrompt).includes(MEMORY_TEXT));
		assert.deepEqual(services.recalls.map((recall) => recall.query), [PROMPT]);
		// Duplication guard: the server must drop raw facts superseded by observations.
		assert.equal(services.recalls[0].prefer_observations, true, "recall must ask the server to prefer observations");
		assert.deepEqual(services.jevCalls[0].questions, ["recall", "scope_0", "unit_0"]);

		assert.equal(services.retains.length, 1);
		const [retain] = services.retains;
		assert.equal(retain.async, true);
		assert.match(retain.operation_id, /^[0-9a-f-]{36}$/u);
		assert.equal(retain.items[0].content, `User: ${PROMPT}`);
		assert.match(retain.items[0].document_id ?? "", /^pi-memory-auto-[0-9a-f-]{36}$/u, "fresh id: no document can be replaced");
		assert.equal(retain.items[0].metadata.source, "pi-memory-auto");
		assert.equal(retain.items[0].tags[0], TAG_PROJECT_FACT);
		assert.match(retain.items[0].tags[1] ?? "", /^pi-memory:project:[0-9a-f]{16}$/u);
		const status = rig.automation()?.status();
		assert.equal(status?.retain.queued, 1);
		assert.match(status?.retain.last ?? "", /not yet confirmed stored/u);
		// Transient only: nothing recalled is persisted into the session.
		assert.ok(!JSON.stringify(rig.harness.entries()).includes("HS_MEMORY_7c1e"));
	});

	it("does not re-retain recalled memory that the assistant echoed back", async () => {
		const services = fakeServices();
		const rig = await session(services, {
			responses: [{ kind: "text", text: `Noted: ${MEMORY_TEXT}. Committed the staged changes as asked.` }, { kind: "text", text: "ok" }],
		});
		await rig.prompt(PROMPT);
		await rig.prompt("Next, tag the release.");
		// prompt 1, run-end 1 (assistant reply), prompt 2; run-end 2 ("ok") has nothing substantive.
		assert.equal(services.retains.length, 3);
		const second = services.retains.slice(1).flatMap((retain) => retain.items.map((item) => item.content)).join("\n");
		assert.ok(second.includes("Assistant: Noted: [recalled memory omitted]. Committed the staged changes as asked."));
		assert.ok(!second.includes("HS_MEMORY_7c1e"));
		assert.ok(!second.includes(PROMPT), "already-evaluated messages are not retained twice");
	});

	it("runs periodic checks during a long tool loop and never re-judges already evaluated messages", async () => {
		const services = fakeServices({
			recallResponse: (index) =>
				Response.json({ results: [{ id: index === 0 ? "f1" : "f2", text: index === 0 ? MEMORY_TEXT : PERIODIC_TEXT, tags: [TAG_USER_WIDE] }] }),
		});
		const loop = Array.from({ length: 4 }, (_, index) => ({
			kind: "tools" as const,
			calls: [toolCall(`r${index}`, "recall", { scope: "project", query: "" })],
		}));
		const rig = await session(services, {
			responses: [
				{ kind: "tools", calls: [toolCall("r-a", "recall", { scope: "project", query: "" })] },
				...loop,
				{ kind: "text", text: "Done." },
			],
		});
		await rig.prompt(PROMPT);

		const captures = rig.harness.captures.map(requestText);
		assert.equal(captures.length, 6);
		// periodicEveryRequests=2: prompt check at request 1, periodic launches at 3 and 5, then run end.
		assert.equal(services.jevCalls.length, 4);
		assert.ok(!services.jevCalls[3].questions.includes("recall"), "the run-end judgment never recalls");
		const firstPeriodic = captures.findIndex((text) => text.includes("HS_PERIODIC_52aa"));
		assert.ok(firstPeriodic >= 3, `periodic recall reaches a later request (got ${firstPeriodic})`);
		assert.ok(captures.every((text) => text.includes("HS_MEMORY_7c1e")), "run-scoped recall stays for the whole run");
		for (const text of captures) assert.equal(text.split("HS_MEMORY_7c1e").length - 1, 1, "one copy per request");
		// The prompt is judged once; periodic checks have no fresh text; "Done." is too short to store.
		assert.equal(services.retains.length, 1);
		assert.ok(services.jevCalls.slice(1, 3).every((call) => call.questions.every((question) => !question.startsWith("unit_"))));
	});

	it("captures a settled run's final assistant completion with no later prompt, retain-only", async () => {
		const CORRECTION = "Stop using npm here; always use pnpm in every project from now on.";
		const FINAL = "Switched every script to pnpm and verified that the build passes.";
		const services = fakeServices({ unit: (unit) => (unit.text === CORRECTION ? USER_PREFERENCE : PROJECT_FACT) });
		const rig = await session(services, { responses: [{ kind: "text", text: FINAL }] });
		await rig.prompt(CORRECTION);

		assert.equal(rig.harness.captures.length, 1, "no forced continuation or extra provider request");
		assert.equal(services.jevCalls.length, 2);
		assert.ok(!services.jevCalls[1].questions.includes("recall"), "run end never recalls");
		assert.deepEqual(services.jevCalls[1].state.units.map((unit) => unit.text), [FINAL], "only the not-yet-judged final message");
		assert.equal(services.recalls.length, 1);
		const contents = services.retains.flatMap((retain) => retain.items.map((item) => item.content));
		assert.deepEqual(contents, [`User: ${CORRECTION}`, `Assistant: ${FINAL}`]);
		assert.match(rig.automation()?.status().lastCheck?.result ?? "", /retain 1\/1 units/u);
		assert.equal(rig.automation()?.status().lastCheck?.trigger, "run-end");
	});

	it("drops the previous run's recall at the next prompt when recall is not needed", async () => {
		const services = fakeServices();
		const rig = await session(services, { responses: [{ kind: "text", text: "Committed." }, { kind: "text", text: "Hi." }] });
		await rig.prompt(PROMPT);
		services.answers = { ...services.answers, unit: NOT_DURABLE, recall: 0.1 };
		await rig.prompt("thanks, that is all");
		assert.ok(requestText(rig.harness.captures[0]).includes("HS_MEMORY_7c1e"));
		assert.ok(!requestText(rig.harness.captures[1]).includes("HS_MEMORY_7c1e"), "no stale injection from the previous run");
		assert.equal(services.recalls.length, 1);
		assert.equal(services.retains.length, 1, "non-durable messages write nothing");
	});
});

describe("shared bank: applicability, provenance, and recall scope", () => {
	const HASH_A = "a".repeat(64);
	const HASH_B = "b".repeat(64);

	it("classifies conservatively: broad needs a narrow, portable, marker-free span with confidence; user-wide needs the user", () => {
		const span = (text: string, role: "user" | "assistant" = "user", narrow = true) => ({ text, role, narrow });
		const judged = (probabilities: UnitProbabilities, portable = 0.95) => ({ probabilities, portable });
		const classify = (unit: ReturnType<typeof span>, judgment: ReturnType<typeof judged>) =>
			classifyUnit(unit, judgment, 0.6, "repo-a")?.applicability;
		const pref = "Never add Co-authored-by lines to commits.";
		assert.equal(classify(span(pref), judged(USER_PREFERENCE)), "user-wide");
		assert.deepEqual(
			classifyUnit(span(pref, "assistant"), judged(USER_PREFERENCE), 0.6, "repo-a"),
			{ applicability: "project", jevLabel: "user_preference" },
			"an assistant cannot state a user-wide preference; the original label is kept",
		);
		assert.equal(classify(span(pref), judged(USER_PREFERENCE, 0.5)), "project", "not verified portable");
		assert.equal(classify(span(pref, "user", false), judged(USER_PREFERENCE)), "project", "truncated/whole/qualified spans are never broad");
		for (const marked of ["Always run scripts/release.sh first.", "Use https://ci.example.test for builds.", "In repo-a, never squash.", "Use token [REDACTED]."]) {
			assert.equal(classify(span(marked), judged(USER_PREFERENCE)), "project", marked);
		}
		const unsure = { user_preference: 0.55, project_fact: 0.2, transferable_lesson: 0.15, not_durable: 0.1 };
		assert.equal(classify(span(pref), judged(unsure)), "project", "uncertain scope stays project-local");
		const lesson = { user_preference: 0.05, project_fact: 0.1, transferable_lesson: 0.8, not_durable: 0.05 };
		assert.equal(classify(span("Vitest fake timers stall fetch; use real timers.", "assistant"), judged(lesson)), "transferable");
		assert.equal(classify(span(pref), judged(NOT_DURABLE)), undefined);
	});

	it("splits a SINGLE mixed message: only the portable preference is user-wide, project detail stays local", async () => {
		const PREF = "From now on, never add Co-authored-by lines to any commit.";
		const SECRET = "Our staging deploy host is db-7.internal and its admin password is swordfish.";
		const services = fakeServices({
			recall: 0.1,
			// Adversarial labels: Jev calls BOTH spans user preferences; only the scope check tells them apart.
			unit: () => USER_PREFERENCE,
			portable: (unit) => (unit.text === PREF ? 0.95 : 0.1),
		});
		const { automation, context } = await unitRig(services.hindsight, services.jev, { identityHash: HASH_A, name: "repo-a", mode: "read-write" });
		await automation.onContext([user(`${PREF} ${SECRET}`, 1)], context());
		await automation.idle();

		assert.deepEqual(services.jevCalls[0].state.units.map((unit) => unit.text), [PREF, SECRET], "verbatim spans, judged with the whole message as context");
		assert.equal(services.jevCalls[0].state.fresh_messages[0].text, `${PREF} ${SECRET}`);
		const items = services.retains[0].items;
		const broad = items.filter((item) => item.tags.includes(TAG_USER_WIDE));
		assert.deepEqual(broad.map((item) => item.content), [`User: ${PREF}`]);
		assert.ok(broad.every((item) => !item.content.includes("swordfish") && !item.content.includes("db-7")), "user-wide carries no project-only fact");
		const local = items.filter((item) => item.tags.includes(TAG_PROJECT_FACT));
		assert.deepEqual(local.map((item) => item.content), [`User: ${SECRET}`]);
		assert.deepEqual(local[0].tags, [TAG_PROJECT_FACT, projectTag(HASH_A)]);
		assert.equal(local[0].metadata.jev_label, "user_preference", "original qualification is preserved");
		assert.notEqual(broad[0].document_id, local[0].document_id, "items never share a document");
	});

	it("never splits an exception away from its rule: a qualified preference stays whole and project-local", async () => {
		const RULE = "Always use tabs for indentation.";
		const EXCEPTION = "Except in YAML files, where spaces are required.";
		// Even with Jev wrongly confirming the rule alone as portable, the qualifier guard keeps it local.
		const services = fakeServices({ recall: 0.1, unit: () => USER_PREFERENCE, portable: 0.95 });
		const { automation, context } = await unitRig(services.hindsight, services.jev, { identityHash: HASH_A, name: "repo-a", mode: "read-write" });
		await automation.onContext([user(`${RULE} ${EXCEPTION}`, 1)], context());
		await automation.idle();
		const items = services.retains[0].items;
		assert.equal(items.filter((item) => item.tags.includes(TAG_USER_WIDE)).length, 0, "the bare rule is not stored user-wide");
		assert.deepEqual(items.map((item) => item.content), [`User: ${RULE} ${EXCEPTION}`], "verbatim, exception kept with its rule");
	});

	it("stores each source unit as its own item, so one preference never widens a mixed exchange", async () => {
		const PREF = "From now on, never add Co-authored-by lines to any commit.";
		const services = fakeServices({
			recall: 0.1,
			unit: (unit) => (unit.text === PREF ? USER_PREFERENCE : unit.role === "assistant" ? USER_PREFERENCE : NOT_DURABLE),
		});
		const { automation, context } = await unitRig(services.hindsight, services.jev, { identityHash: HASH_A, name: "repo-a", mode: "read-write" });
		await automation.onContext(
			[user(PREF, 1), assistant("Understood. This repo builds with pnpm workspaces and Node 24.", 2), user("Now bump the version.", 3)],
			context(),
		);
		await automation.idle();

		assert.equal(services.retains.length, 1);
		const items = services.retains[0].items;
		assert.equal(items.length, 2, "the non-durable message is not stored");
		const [preference, fact] = items;
		assert.equal(preference.content, `User: ${PREF}`, "the user-wide item carries only its own unit");
		assert.deepEqual(preference.tags, [TAG_USER_WIDE]);
		assert.equal(preference.metadata.applicability, "user-wide");
		assert.equal(preference.metadata.source_project, "repo-a");
		assert.equal(preference.metadata.source_session, "session-1");
		assert.match(preference.metadata.jev_probabilities, /user_preference=0\.90.*portable=0\.90/u);
		// The assistant unit was labelled a user preference by Jev; policy keeps it project-local.
		assert.deepEqual(fact.tags, [TAG_PROJECT_FACT, projectTag(HASH_A)]);
		assert.equal(fact.metadata.applicability, "project");
		assert.equal(fact.content, "Assistant: Understood. This repo builds with pnpm workspaces and Node 24.", "adjacent spans merge verbatim");
		assert.equal(fact.metadata.jev_label, "user_preference;user_preference", "original qualification is preserved per span");
		assert.notEqual(preference.document_id, fact.document_id, "items never share a document");
	});

	it("a missing unit judgment voids the decision: nothing retained or recalled", async () => {
		const services = fakeServices({
			jev: () =>
				Response.json({
					model: "jev-1.13.0",
					answers: { recall: { type: "noul", noul: 0.9 }, unit_0: { type: "choice", choice: "user_preference", confidence: 0.9, probabilities: USER_PREFERENCE } },
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
		});
		const { automation, context } = await unitRig(services.hindsight, services.jev, { mode: "read-write" });
		await automation.onContext([user("Always use tabs.", 1), assistant("Noted, I will use tabs from now on.", 2), user("Go.", 3)], context());
		await automation.idle();
		assert.deepEqual(services.jevCalls[0].questions, ["recall", "scope_0", "scope_1", "scope_2", "unit_0", "unit_1", "unit_2"]);
		assert.equal(services.retains.length + services.recalls.length, 0);
		assert.match(automation.status().lastCheck?.result ?? "", /incomplete-response/u);
	});

	// Store + evaluator mirroring Hindsight 0.10.1 tag_groups semantics
	// (strict modes exclude untagged; any_strict = overlap, all_strict = contains).
	const store = [
		{ id: "a-fact", text: "A_FACT: repo-a deploys with fly.io", tags: [TAG_PROJECT_FACT, projectTag(HASH_A)], metadata: { source_project: "repo-a" } },
		{ id: "pref", text: "PREF: keep commit messages short", tags: [TAG_USER_WIDE] },
		{ id: "lesson", text: "LESSON: vitest fake timers stall fetch", tags: [TAG_TRANSFERABLE, projectTag(HASH_A)], metadata: { source_project: "repo-a" } },
		{ id: "lesson-obs", text: "LESSON_OBS: retry flaky ports", type: "observation", tags: [TAG_TRANSFERABLE, projectTag("c".repeat(64))] },
		{ id: "untagged", text: "UNTAGGED: legacy note", tags: [] as string[] },
	];
	const matches = (tags: readonly string[], group: TagGroup): boolean => {
		if ("or" in group) return group.or.some((child) => matches(tags, child));
		if ("and" in group) return group.and.every((child) => matches(tags, child));
		if (group.match === "any_strict") return tags.length > 0 && group.tags.some((tag) => tags.includes(tag));
		if (group.match === "all_strict") return tags.length > 0 && group.tags.every((tag) => tags.includes(tag));
		throw new Error(`unexpected match ${group.match}`);
	};
	const filteringHindsight = (respectFilter: boolean) =>
		fakeServices({
			unit: NOT_DURABLE,
			recallResponse: (_index, body) =>
				Response.json({
					results: store.filter((item) => !respectFilter || (body.tag_groups ?? []).every((group) => matches(item.tags, group))),
				}),
		});

	it("recalls user-wide, transferable (with provenance), and only the current project's facts", async () => {
		const inB = filteringHindsight(true);
		const b = await unitRig(inB.hindsight, inB.jev, { identityHash: HASH_B, name: "repo-b" });
		const blockB = (await b.automation.onContext([user("Set up the deploy pipeline.", 1)], b.context()))?.text ?? "";
		assert.deepEqual(inB.recalls[0].tag_groups, recallTagGroups(HASH_B));
		assert.equal(inB.recalls[0].tags, undefined, "tag_groups only (tags is mutually exclusive)");
		assert.ok(!blockB.includes("A_FACT"), "project A facts are excluded in project B");
		assert.ok(!blockB.includes("UNTAGGED"), "untagged memories never match");
		assert.ok(blockB.includes("(user-wide preference; stated in an earlier session) PREF"));
		assert.ok(blockB.includes("(lesson from project repo-a; may apply here only if the situation matches) LESSON: vitest"));
		assert.ok(blockB.includes("(lesson from another project; may apply here only if the situation matches) LESSON_OBS"));

		const inA = filteringHindsight(true);
		const a = await unitRig(inA.hindsight, inA.jev, { identityHash: HASH_A, name: "repo-a" });
		const blockA = (await a.automation.onContext([user("Set up the deploy pipeline.", 1)], a.context()))?.text ?? "";
		assert.ok(blockA.includes("(fact about this project) A_FACT"));
	});

	it("fails closed when the server returns anything outside the requested scope", async () => {
		const services = filteringHindsight(false);
		const diagnostics: string[] = [];
		const { automation, context } = await unitRig(services.hindsight, services.jev, { identityHash: HASH_B, diagnostics });
		assert.equal(await automation.onContext([user("Set up the deploy pipeline.", 1)], context()), undefined, "nothing is injected");
		assert.match(automation.status().lastCheck?.result ?? "", /scope unverified/u);
		assert.ok(diagnostics.some((line) => line.includes("outside the requested scope")));
	});
});

describe("automatic memory outages, modes, and scope", () => {
	it("fails open when Hindsight is down, stays quiet during cooldown, and recovers without restart", async () => {
		let clock = 1_900_000_000_000;
		let down = true;
		const healthy = fakeServices();
		const services: Services = {
			...healthy,
			hindsight: async (input, init) => {
				if (down) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
				return healthy.hindsight(input, init);
			},
		};
		const rig = await session(services, {
			now: () => clock,
			responses: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }, { kind: "text", text: "c" }],
		});
		await rig.prompt(PROMPT);
		assert.equal(rig.harness.captures.length, 1, "the task still ran");
		assert.ok(!requestText(rig.harness.captures[0]).includes("pi_memory_recalled"));
		assert.equal(rig.diagnostics.filter((line) => line.includes("Hindsight unavailable")).length, 1);
		const jevBefore = healthy.jevCalls.length;

		await rig.prompt("second request during the outage");
		assert.equal(healthy.jevCalls.length, jevBefore, "no Jev call while Hindsight cools down");
		assert.equal(rig.diagnostics.filter((line) => line.includes("Hindsight unavailable")).length, 1, "no diagnostic spam");

		down = false;
		clock += 31_000;
		await rig.prompt("third request after recovery");
		assert.ok(requestText(rig.harness.captures[2]).includes("HS_MEMORY_7c1e"));
		assert.ok(rig.diagnostics.some((line) => line.includes("reachable again")));
	});

	it("bounds a hanging Jev gate and makes no decision or write after its failure", async () => {
		const services = fakeServices({ jev: () => new Promise<Response>(() => undefined) });
		const { agentDir, cwd } = await workspace({ version: 1, bank: "test-bank" }, { timeoutMs: 150 });
		const harness = await createSdkHarness({
			cwd,
			agentDir,
			responses: [{ kind: "text", text: "ok" }],
			memoryExtension: createMemoryExtension({
				agentDir,
				env: { TYPESAFE_API_KEY: "test-key" },
				fetch: services.jev,
				hindsightFetch: services.hindsight,
			}),
		});
		harnesses.add(harness);
		const started = Date.now();
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			await harness.prompt(PROMPT);
		} finally {
			process.stderr.write = originalWrite;
		}
		assert.ok(Date.now() - started < 2_000, "prompt latency stays bounded");
		assert.equal(harness.captures.length, 1);
		assert.ok(!requestText(harness.captures[0]).includes("pi_memory_recalled"));
		assert.equal(services.recalls.length + services.retains.length, 0, "no fabricated decision after provider failure");
	});

	it("read-only recalls but never writes; off, disabled, and invalid configs make no service calls", async () => {
		const readOnly = fakeServices();
		const ro = await session(readOnly, { env: { PI_MEMORY_MODE: "read-only" }, responses: [{ kind: "text", text: "ok" }] });
		await ro.prompt(PROMPT);
		assert.ok(requestText(ro.harness.captures[0]).includes("HS_MEMORY_7c1e"));
		assert.deepEqual(readOnly.jevCalls[0].questions, ["recall"]);
		assert.equal(readOnly.retains.length, 0);

		for (const variant of [
			{ env: { PI_MEMORY_MODE: "off" }, automation: { version: 1, bank: "test-bank" } },
			{ env: {}, automation: { version: 1, enabled: false } },
			{ env: {}, automation: { version: 1, bank: "test-bank", hindsightUrl: "https://memory.example.com" } },
			{ env: {}, automation: undefined },
		]) {
			const services = fakeServices();
			const rig = await session(services, { env: variant.env, automation: variant.automation, responses: [{ kind: "text", text: "ok" }] });
			await rig.prompt(PROMPT);
			assert.equal(rig.harness.captures.length, 1);
			assert.equal(services.jevCalls.length + services.recalls.length + services.retains.length, 0, JSON.stringify(variant));
		}
	});

	it("treats a not-yet-created bank (recall 404) as empty so the first retain still creates it", async () => {
		const services = fakeServices({ recallResponse: () => Response.json({ detail: "Bank not found" }, { status: 404 }) });
		const rig = await session(services, { responses: [{ kind: "text", text: "Committed." }] });
		await rig.prompt(PROMPT);
		assert.equal(services.retains.length, 1);
		assert.equal(rig.automation()?.status().hindsight, "ok");
		assert.ok(!rig.diagnostics.some((line) => line.includes("Hindsight unavailable")));
	});

	it("never resubmits an ambiguous retain and reports it as unknown, not saved", async () => {
		const services = fakeServices({ retainResponse: () => new Response("boom", { status: 503 }) });
		let clock = 1_900_000_000_000;
		const rig = await session(services, { now: () => clock, responses: [{ kind: "text", text: "Committed." }, { kind: "text", text: "ok" }] });
		await rig.prompt(PROMPT);
		assert.equal(rig.automation()?.status().retain.unknown, 1);
		assert.equal(rig.automation()?.status().retain.queued, 0);
		clock += 31_000;
		await rig.prompt("Also remember to keep release notes short.");
		assert.equal(services.retains.length, 2);
		assert.ok(services.retains[1].items.every((item) => !item.content.includes(PROMPT)), "the ambiguous batch is not resent");
	});
});

describe("MemoryAutomation stale work and cancellation", () => {
	it("discards a recall that completes after a new run started", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const services = fakeServices();
		const { automation, context } = await unitRig(async (input, init) => {
			await gate;
			return services.hindsight(input, init);
		}, services.jev);
		const pending = automation.onContext([user(PROMPT, 1)], context());
		// Wait for the recall request to be in flight, then start a new run.
		while (services.jevCalls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		await new Promise((resolve) => setTimeout(resolve, 10));
		automation.beginRun();
		release();
		assert.equal(await pending, undefined);
		assert.equal(await automation.onContext([user(PROMPT, 1)], context()), undefined, "no stale block in the new run");
		assert.equal(automation.status().recalled, undefined);
	});

	it("catches up a backlog beyond one check's unit cap and counts messages that leave the window unjudged", async () => {
		// 5 messages x 3 spans = 15 units > the cap of 12: the oldest 4 messages are judged first.
		const backlog = [1, 2, 3, 4, 5].map((n) => user(`Note ${n} alpha line.\nNote ${n} beta line.\nNote ${n} gamma line.`, n));
		const services = fakeServices({ recall: 0.1 });
		const { automation, context } = await unitRig(services.hindsight, services.jev, { mode: "read-write" });
		await automation.onContext(backlog, context());
		await automation.idle();
		assert.deepEqual(services.jevCalls[0].state.fresh_messages.map((message) => message.text.slice(0, 6)), ["Note 1", "Note 2", "Note 3", "Note 4"]);
		await automation.onContext([...backlog, user("Next task please.", 6)], context());
		await automation.idle();
		assert.deepEqual(services.jevCalls[1].state.fresh_messages.map((message) => message.text.slice(0, 6)), ["Note 5", "Next t"], "the deferred message is judged, not lost");
		assert.equal(automation.status().retain.dropped, 0);

		const other = fakeServices({ recall: 0.1 });
		const rig = await unitRig(other.hindsight, other.jev, { mode: "read-write" });
		await rig.automation.onContext(backlog, rig.context());
		await rig.automation.idle();
		// Note 5 falls out of the transcript window before any check could judge it.
		await rig.automation.onContext([user("Unrelated fresh prompt.", 7)], rig.context());
		await rig.automation.idle();
		assert.equal(rig.automation.status().retain.dropped, 1, "an unjudged message is counted, never silently skipped");
		assert.match(automationStatusLines(rig.automation.status(), Date.now()).join("\n"), /1 dropped unjudged/u);
	});

	it("read-only messages give recall context once and are never retained after switching to read-write", async () => {
		const READ_ONLY = "Remember that the release branch is frozen this week.";
		const services = fakeServices();
		const { automation, context } = await unitRig(services.hindsight, services.jev, { mode: "read-only" });
		await automation.onContext([user(READ_ONLY, 1)], context());
		await automation.idle();
		assert.deepEqual(services.jevCalls[0].questions, ["recall"], "read-only judges no units");
		const writable = { ...context(), mode: "read-write" as const, currentMode: async () => "read-write" as const };
		await automation.onContext([user(READ_ONLY, 1), assistant("Noted.", 2), user("Now ship the patch release.", 3)], writable);
		await automation.idle();
		assert.deepEqual(services.jevCalls[1].state.earlier_messages.map((message) => message.text), [READ_ONLY], "read-only content stays recall context");
		assert.ok(!services.jevCalls[1].state.units.some((unit) => unit.text === READ_ONLY), "never judged for retention later");
		assert.ok(services.retains.every((retain) => retain.items.every((item) => !item.content.includes(READ_ONLY))));
	});

	it("shutdown flush drains the coalesced pending retain and reports honestly what it could not send", async () => {
		const services = fakeServices();
		// Every retain takes a while, so only a real drain sees the second one sent.
		const slow: HindsightFetch = async (input, init) => {
			if (input.endsWith("/memories")) await new Promise((resolve) => setTimeout(resolve, 30));
			return services.hindsight(input, init);
		};
		const { automation, context } = await unitRig(slow, services.jev, { mode: "read-write" });
		await automation.onContext([user(PROMPT, 1)], context());
		void automation.onRunSettled([user(PROMPT, 1), assistant("Committed the staged changes with message 'fix'.", 2)], context());
		await automation.flush(2_000);
		assert.deepEqual(
			services.retains.map((retain) => retain.items.map((item) => item.content)),
			[[`User: ${PROMPT}`], ["Assistant: Committed the staged changes with message 'fix'."]],
			"the pending job behind the in-flight retain is sent too",
		);

		const hung = fakeServices();
		const diagnostics: string[] = [];
		const hanging: HindsightFetch = (input, init) =>
			input.endsWith("/memories") ? new Promise<Response>(() => undefined) : hung.hindsight(input, init);
		const rig = await unitRig(hanging, hung.jev, { mode: "read-write", diagnostics });
		await rig.automation.onContext([user(PROMPT, 1)], rig.context());
		void rig.automation.onRunSettled([user(PROMPT, 1), assistant("Committed the staged changes with message 'fix'.", 2)], rig.context());
		const started = Date.now();
		await rig.automation.flush(100);
		assert.ok(Date.now() - started < 600, "flush returns at its bound");
		rig.automation.dispose();
		assert.match(diagnostics.join("\n"), /1 judged unit\(s\) never sent; 1 retain cancelled in flight/u);
	});

	it("cancellation stops the prompt check without injecting or recalling", async () => {
		const services = fakeServices({ jev: () => new Promise<Response>(() => undefined) });
		const { automation, context } = await unitRig(services.hindsight, services.jev);
		const controller = new AbortController();
		const pending = automation.onContext([user(PROMPT, 1)], context(controller.signal));
		setTimeout(() => controller.abort(), 20);
		assert.equal(await pending, undefined);
		assert.equal(services.recalls.length, 0);
		assert.match(automation.status().lastCheck?.result ?? "", /cancelled/u);
	});
});

describe("automation config", () => {
	it("uses one shared bank (default pi-memory), allows only per-project opt-out, and rejects non-loopback URLs", () => {
		const defaulted = parseAutomationConfig(JSON.stringify({ version: 1 }), "h");
		assert.equal(defaulted.state === "configured" && defaulted.settings.bank, "pi-memory");
		assert.equal(parseAutomationConfig(JSON.stringify({ version: 1, projects: { h: { bank: "p-bank" } } }), "h").state, "malformed");
		assert.equal(parseAutomationConfig(JSON.stringify({ version: 1, bank: "b", projects: { h: { enabled: false } } }), "h").state, "disabled");
		assert.equal(parseAutomationConfig(JSON.stringify({ version: 1, bank: "b", hindsightUrl: "http://10.0.0.5:8888" }), "h").state, "malformed");
		assert.equal(parseAutomationConfig(JSON.stringify({ version: 1, bank: "../x" }), "h").state, "malformed");
	});
});
