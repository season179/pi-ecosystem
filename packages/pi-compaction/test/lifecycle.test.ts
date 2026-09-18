import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PASS_ENTRY, PIN_ENTRY, SCOPE_ENTRY, type PassRecord } from "../src/adapter/state.js";
import { PLACEHOLDER_MARKER } from "../src/engine/transform.js";
import { ScoringError } from "../src/scoring/client.js";
import { PREVIEW_SUBDIR, REPORT_ENTRY, TELEMETRY_SUBDIR } from "../src/extensions/compaction.js";
import { BIG_RESULT_CHARS, BIG_TOOL, call, createHarness, fakeScorer, longTask, toolResultTexts, type Harness } from "./helpers/harness.js";

const PRESSURE = 30_000; // > contextWindow - reserve (24_768)
const CONFIG = { enabled: true, protectRecentGroups: 2, savingsFactor: 1, marginTokens: 0, marginFraction: 0, pairDroppableTools: [BIG_TOOL], scoringCooldownMs: 0 };

let root: string;
const harnesses: Harness[] = [];

async function setup(options: { scorerAnswer?: (key: string) => number; config?: Record<string, unknown>; persist?: boolean; compactionEnabled?: boolean } = {}) {
	root = await mkdtemp(join(tmpdir(), "pi-compaction-"));
	const scorer = fakeScorer(options.scorerAnswer);
	const harness = await createHarness({ cwd: join(root, "cwd"), agentDir: join(root, "agent"), scorer, persistSession: options.persist, compactionEnabled: options.compactionEnabled, config: options.config ?? CONFIG });
	harnesses.push(harness);
	return { harness, scorer, agentDir: join(root, "agent") };
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.dispose();
	if (root) await rm(root, { recursive: true, force: true });
});

describe("pi-compaction lifecycle (real AgentSession)", () => {
	it("prunes a long single-task run at threshold instead of summarizing, and the next request carries the pruned payload", async () => {
		const { harness, scorer, agentDir } = await setup();
		await harness.prompt("Refactor the payment module.", ...longTask(8, PRESSURE));

		expect(harness.events).toContain("before_compact:threshold");
		expect(harness.events).not.toContain("compact:threshold");
		expect(harness.events.some((event) => event.startsWith("compact_failed:threshold:aborted"))).toBe(true);
		expect(scorer.calls).toBe(1);
		// Scoring saw the skeleton, never the tool bodies.
		expect(JSON.stringify(scorer.lastState)).not.toContain("content of src/file0.ts\ncontent of src/file0.ts");
		expect(Object.keys(scorer.lastQuestions ?? {})).toHaveLength(12); // 6 candidates × 2 questions

		const passEntries = harness.entries().filter((entry) => entry.type === "custom" && entry.customType === PASS_ENTRY);
		expect(passEntries).toHaveLength(1);
		expect(harness.entries().some((entry) => entry.type === "compaction")).toBe(false);

		// Request after the cancelled compaction: 6 oldest pairs removed, 2 newest intact, originals preserved before it.
		const before = harness.captures[7];
		const after = harness.captures[8];
		expect(toolResultTexts(before).map((item) => item.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
		expect(toolResultTexts(after).map((item) => item.id)).toEqual(["c6", "c7"]);
		// 8 assistant tool-call messages in the original; 6 pairs removed leaves 2.
		expect(after.messages.filter((message) => message.role === "assistant").length).toBe(2);
		for (const item of toolResultTexts(after)) expect(item.text.length).toBeGreaterThanOrEqual(BIG_RESULT_CHARS);
		// The turn finished normally.
		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" && last.content.some((block) => block.type === "text" && block.text === "All done.")).toBe(true);
		// The archive is intact on disk / in the session: originals remain message entries.
		const originals = harness.entries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(originals).toHaveLength(8);

		const files = await readdir(join(agentDir, TELEMETRY_SUBDIR));
		expect(files.length).toBeGreaterThan(0);
		const raw = (await Promise.all(files.map((file) => readFile(join(agentDir, TELEMETRY_SUBDIR, file), "utf8")))).join("\n");
		expect(raw).toContain('"kind":"pass"');
		expect(raw).toContain('"outcome":"committed"');
		expect(raw).toContain('"kind":"summary"');
		expect(raw).toContain('"outcome":"cancelled"');
		expect(raw).not.toContain(harness.session.sessionManager.getSessionId());
		expect(raw).not.toContain("content of src");
	});

	it("shortens results instead of removing pairs when the call must stay as evidence", async () => {
		const { harness } = await setup({ scorerAnswer: (key) => (key.startsWith("call_") ? 0.9 : 0.1) });
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE));
		const after = harness.captures[8];
		const results = toolResultTexts(after);
		expect(results.map((item) => item.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
		for (const item of results.slice(0, 6)) {
			expect(item.text).toContain(PLACEHOLDER_MARKER);
			expect(item.text).toContain("compaction_recall");
			expect(item.text.length).toBeLessThan(400);
		}
		for (const item of results.slice(6)) expect(item.text.length).toBeGreaterThanOrEqual(BIG_RESULT_CHARS);
	});

	it("lets Pi summarize over the originals when pruning cannot free enough", async () => {
		const { harness, scorer } = await setup({ scorerAnswer: () => 0.95 });
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE), { kind: "text", text: "SUMMARY TEXT" });
		expect(scorer.calls).toBe(1);
		expect(harness.events).toContain("compact:threshold");
		// Exactly one fallback event for the declining hook, with the concrete reason, visible in the report.
		const fallbacks = harness.telemetry.inputs.filter((input) => input.fallback === true);
		expect(fallbacks).toHaveLength(1);
		expect(fallbacks[0]).toMatchObject({ kind: "pass", outcome: "skipped", reason: "insufficient_reduction" });
		expect(await harness.telemetry.report(7)).toMatch(/fallbacks: insufficient_reduction=1/);
		// The summary request (Pi serializes the transcript into one prompt) saw the untouched originals, not placeholders.
		const summaryRequest = harness.captures.find((capture) => capture.systemPrompt?.startsWith("You are a context summarization"));
		expect(summaryRequest).toBeDefined();
		const serialized = JSON.stringify(summaryRequest!.messages);
		expect(serialized).toContain("content of src/file0.ts");
		expect(serialized).not.toContain(PLACEHOLDER_MARKER);
		expect(harness.entries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("never intercepts manual compaction", async () => {
		const { harness, scorer } = await setup();
		await harness.prompt("Read things.", ...longTask(6, 500));
		harness.enqueue({ kind: "text", text: "MANUAL SUMMARY" });
		await harness.session.compact();
		expect(harness.events).toContain("before_compact:manual");
		expect(harness.events).toContain("compact:manual");
		expect(scorer.calls).toBe(0);
	});

	it("stays passive when disabled but still records baseline telemetry", async () => {
		const { harness, scorer, agentDir } = await setup({ config: { ...CONFIG, enabled: false } });
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE), { kind: "text", text: "SUMMARY" });
		expect(scorer.calls).toBe(0);
		expect(harness.events).toContain("compact:threshold");
		const files = await readdir(join(agentDir, TELEMETRY_SUBDIR));
		const raw = (await Promise.all(files.map((file) => readFile(join(agentDir, TELEMETRY_SUBDIR, file), "utf8")))).join("\n");
		expect(raw).toContain('"kind":"request"');
		expect(raw).toContain('"mode":"off"');
		expect(raw).toContain('"kind":"summary"');
		expect(raw).not.toContain('"kind":"pass"');
	});

	it("supports on/off/status/restore/report/preview/feedback commands without feeding the model", async () => {
		const { harness, scorer, agentDir } = await setup({ config: { ...CONFIG, enabled: false } });
		await harness.prompt("/compaction on");
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE));
		expect(scorer.calls).toBe(1);
		expect(toolResultTexts(harness.captures[8]).map((item) => item.id)).toEqual(["c6", "c7"]);

		await harness.prompt("/compaction status");
		await harness.prompt("/compaction report 7d");
		await harness.prompt("/compaction preview");
		await harness.prompt("/compaction feedback bad-prune");
		// Without a UI the command output is not lost, and the report is a custom entry, never a message.
		const report = harness.outputs.find((text) => text.startsWith("pi-compaction report (7d)"));
		expect(report).toBeDefined();
		expect(report).toContain("Compaction telemetry");
		expect(harness.entries().filter((entry) => entry.type === "custom" && entry.customType === REPORT_ENTRY)).toHaveLength(1);
		const previewOut = harness.outputs.find((text) => text.startsWith("pi-compaction preview:"));
		expect(previewOut).toContain("nothing was sent");
		const previewDir = join(agentDir, PREVIEW_SUBDIR);
		const previewFiles = await readdir(previewDir);
		expect(previewFiles).toHaveLength(1);
		expect((await stat(join(previewDir, previewFiles[0]))).mode & 0o777).toBe(0o600);
		const previewJson = JSON.parse(await readFile(join(previewDir, previewFiles[0]), "utf8"));
		expect(previewJson.state).toBeDefined();
		expect(Array.isArray(previewJson.requests)).toBe(true);
		expect(JSON.stringify(previewJson)).not.toContain("content of src/file0.ts\ncontent of src/file0.ts");
		const beforeCommands = harness.captures.length;

		await harness.prompt("/compaction off");
		await harness.prompt("Continue.", { kind: "text", text: "ok" });
		expect(harness.captures.length).toBe(beforeCommands + 1); // commands made no model calls
		const nextRequest = JSON.stringify(harness.captures.at(-1)!.messages);
		expect(nextRequest).not.toContain("pi-compaction report");
		expect(nextRequest).not.toContain("pi-compaction preview");
		expect(toolResultTexts(harness.captures.at(-1)!).map((item) => item.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);

		await harness.prompt("/compaction on");
		await harness.prompt("Continue.", { kind: "text", text: "ok" });
		expect(toolResultTexts(harness.captures.at(-1)!).map((item) => item.id)).toEqual(["c6", "c7"]);

		await harness.prompt("/compaction restore all");
		expect(harness.entries().filter((entry) => entry.type === "custom" && entry.customType === PIN_ENTRY)).toHaveLength(6);
		await harness.prompt("Continue.", { kind: "text", text: "ok" });
		expect(toolResultTexts(harness.captures.at(-1)!).map((item) => item.id)).toHaveLength(8);
	});

	it("serves originals through compaction_recall and pins on restore", async () => {
		const { harness } = await setup({ scorerAnswer: (key) => (key.startsWith("call_") ? 0.9 : 0.1) });
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE));
		const archiveIdOf = (toolCallId: string) => harness.entries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId)!.id;
		const archiveId = archiveIdOf("c0");

		await harness.prompt(
			"What was in file0?",
			{ kind: "tools", calls: [{ type: "toolCall", id: "r1", name: "compaction_recall", arguments: { action: "list" } }] },
			{ kind: "tools", calls: [{ type: "toolCall", id: "r2", name: "compaction_recall", arguments: { action: "search", query: "file3" } }] },
			{ kind: "tools", calls: [{ type: "toolCall", id: "r3", name: "compaction_recall", arguments: { action: "read", id: archiveId, limit: 100 } }] },
			{ kind: "tools", calls: [{ type: "toolCall", id: "r4", name: "compaction_recall", arguments: { action: "read", id: archiveIdOf("c1"), limit: 100, restore: false } }] },
			{ kind: "text", text: "found it" },
		);
		const results = toolResultTexts(harness.captures.at(-1)!);
		const list = results.find((item) => item.id === "r1")!.text;
		expect(list).toContain("6 archived result(s) currently shortened or omitted");
		expect(list).toContain(archiveId);
		const search = results.find((item) => item.id === "r2")!.text;
		expect(search).toMatch(/match\(es\)/);
		expect(search).toContain("file3");
		const read = results.find((item) => item.id === "r3")!.text;
		expect(read).toContain("content of src/file0.ts");
		expect(read).toContain("continue with offset=100");
		expect(read).toContain("restored");
		// read pins by default: the original c0 result is sent in full again; restore=false left c1 shortened.
		const c0 = results.find((item) => item.id === "c0")!;
		expect(c0.text.length).toBeGreaterThanOrEqual(BIG_RESULT_CHARS);
		const readNoRestore = results.find((item) => item.id === "r4")!.text;
		expect(readNoRestore).toContain("content of src/file1.ts");
		expect(readNoRestore).not.toContain("restored");
		expect(results.find((item) => item.id === "c1")!.text).toContain(PLACEHOLDER_MARKER);
		expect(harness.entries().filter((entry) => entry.type === "custom" && entry.customType === PIN_ENTRY)).toHaveLength(1);
	});

	it("persists decisions across resume and isolates forks made before the pass", async () => {
		const { harness } = await setup({ persist: true });
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE));
		const sessionFile = harness.session.sessionFile!;
		const firstResultEntry = harness.entries().find((entry) => entry.type === "message" && entry.message.role === "toolResult")!;

		await harness.resume(sessionFile);
		await harness.prompt("Continue.", { kind: "text", text: "ok" });
		expect(toolResultTexts(harness.captures.at(-1)!).map((item) => item.id)).toEqual(["c6", "c7"]);

		await harness.fork(firstResultEntry.id);
		await harness.prompt("Fork continue.", { kind: "text", text: "ok" });
		const forked = toolResultTexts(harness.captures.at(-1)!);
		expect(forked.map((item) => item.id)).toEqual(["c0"]);
		expect(forked[0].text.length).toBeGreaterThanOrEqual(BIG_RESULT_CHARS);
	});

	it("does not cancel a repeated check on old savings after the pruned results were restored", async () => {
		const { harness, scorer } = await setup();
		// The final response carries no usage, so Pi's post-run check still rests on the pressure observation.
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE).slice(0, -1), { kind: "text", text: "All done.", usage: "none" });
		expect(scorer.calls).toBe(1);
		expect(harness.events.filter((event) => event === "before_compact:threshold")).toHaveLength(2);
		expect(harness.events).not.toContain("compact:threshold");
		// Second check under the same observation: the pruned payload still fits, so it is cancelled again.
		const skipped = harness.telemetry.inputs.filter((input) => input.kind === "pass" && input.reason === "duplicate_observation");
		expect(skipped).toHaveLength(1);
		expect(harness.telemetry.inputs.filter((input) => input.kind === "summary" && input.outcome === "cancelled")).toHaveLength(2);

		await harness.prompt("/compaction restore all");
		expect(harness.entries().filter((entry) => entry.type === "custom" && entry.customType === PIN_ENTRY)).toHaveLength(6);
		// Same observation, nothing pruned any more: the old estimatedSavings must not be credited.
		await harness.prompt("Continue.", { kind: "text", text: "SUMMARY" }, { kind: "text", text: "ok" });
		expect(scorer.calls).toBe(1);
		expect(harness.events).toContain("compact:threshold");
		expect(harness.entries().some((entry) => entry.type === "compaction")).toBe(true);
		expect(harness.telemetry.inputs.filter((input) => input.kind === "summary" && input.outcome === "cancelled")).toHaveLength(2);
		expect(harness.telemetry.inputs.filter((input) => input.kind === "summary" && input.outcome === "completed")).toHaveLength(1);
		const fallbacks = harness.telemetry.inputs.filter((input) => input.fallback === true);
		expect(fallbacks).toHaveLength(1);
		expect(fallbacks[0]).toMatchObject({ reason: "duplicate_observation" });
	});

	it("records monotone turns, unclamped context fractions, applied pass links, prices and real scoring metrics", async () => {
		const { harness, scorer } = await setup();
		const OVERFLOW = 34_000; // > contextWindow, yet pruning six pairs still fits under the threshold
		await harness.prompt("Refactor.", ...longTask(8, OVERFLOW));
		expect(scorer.calls).toBe(1);
		const pass = harness.entries().find((entry) => entry.type === "custom" && entry.customType === PASS_ENTRY)!;
		const passId = (pass.type === "custom" ? (pass.data as PassRecord) : undefined)!.passId;
		const coding = () => harness.telemetry.inputs.filter((input) => input.kind === "request" && input.role === "coding");
		const first = coding();
		expect(first).toHaveLength(9);
		expect(first.every((input) => input.measures?.turn === 1)).toBe(true);
		expect(first.every((input) => typeof input.configFingerprint === "string" && input.configFingerprint.length > 0)).toBe(true);
		expect(first.every((input) => input.provider === "pi-compaction-fake" && input.model === "compaction-lifecycle")).toBe(true);
		expect(first.some((input) => (input.measures?.contextFractionMeasured ?? 0) > 1)).toBe(true);
		// Only the request that actually carried the pruned payload links to the pass; earlier ones do not.
		expect(first.slice(0, 8).every((input) => input.passId === undefined)).toBe(true);
		expect(first[8].passId).toBe(passId);
		expect(first[8].measures?.contextAfterTokensEstimate).toBeLessThan(first[8].measures?.contextBeforeTokensEstimate ?? 0);
		expect(first.every((input) => input.prices === undefined)).toBe(true); // fake model has no catalog price
		// Scoring requests come from measured attempts and name the scoring provider/model, not the coding model.
		const scoring = harness.telemetry.inputs.filter((input) => input.kind === "request" && input.role === "scoring");
		expect(scoring).toHaveLength(1);
		expect(scoring[0]).toMatchObject({ provider: "typesafe", model: "jev-latest", passId, outcome: "completed" });
		expect(typeof scoring[0].measures?.latencyMs).toBe("number");
		expect(scoring[0].measures?.inputTokens).toBeUndefined(); // fake scorer reports no usage; nothing is invented
		const committed = harness.telemetry.inputs.find((input) => input.kind === "pass" && input.outcome === "committed")!;
		expect(committed.fallback).toBeUndefined();
		expect(committed.reason).toBe("threshold");
		// A successful cancellation is not a fallback.
		expect(harness.telemetry.inputs.some((input) => input.fallback === true)).toBe(false);
		expect(await harness.telemetry.report(7)).toMatch(/fallbacks: none/);

		await harness.prompt("Continue.", { kind: "text", text: "ok" });
		expect(coding().at(-1)).toMatchObject({ passId, measures: expect.objectContaining({ turn: 2 }) });
		await harness.prompt("/compaction off");
		await harness.prompt("Continue.", { kind: "text", text: "ok" });
		const off = coding().at(-1)!;
		expect(off.passId).toBeUndefined();
		expect(off.mode).toBe("off");
		expect(off.measures?.turn).toBe(3);
		expect(off.measures?.contextBeforeTokensEstimate).toBeUndefined();
	});

	it("scopes telemetry per tree branch: continuing from an interior node gets its own scope, returning adopts the old one", async () => {
		const { harness } = await setup();
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE));
		const originalLeaf = harness.session.sessionManager.getLeafId()!;
		const keyOf = (input: { sessionId: string }) => input.sessionId;
		const committed = harness.telemetry.inputs.find((input) => input.kind === "pass" && input.outcome === "committed")!;
		const key1 = keyOf(committed);
		expect(harness.telemetry.inputs.every((input) => keyOf(input) === key1)).toBe(true);

		const interior = harness.entries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "c2")!;
		await harness.navigate(interior.id);
		const scopes = () => harness.entries().filter((entry) => entry.type === "custom" && entry.customType === SCOPE_ENTRY);
		expect(scopes()).toHaveLength(1);
		const mark = harness.telemetry.inputs.length;
		await harness.prompt("Sibling branch.", { kind: "text", text: "ok" });
		const sibling = harness.telemetry.inputs.slice(mark);
		expect(sibling.length).toBeGreaterThan(0);
		const key2 = keyOf(sibling[0]);
		expect(key2).not.toBe(key1);
		expect(sibling.every((input) => keyOf(input) === key2)).toBe(true);
		// Sibling traffic carries no link to the pass committed on the other branch.
		expect(sibling.every((input) => input.passId === undefined)).toBe(true);

		// Moving to the existing tip adopts its scope instead of rotating again.
		await harness.navigate(originalLeaf);
		expect(scopes()).toHaveLength(1);
		const mark2 = harness.telemetry.inputs.length;
		await harness.prompt("Back on the first branch.", { kind: "text", text: "ok" });
		const back = harness.telemetry.inputs.slice(mark2);
		expect(back.every((input) => keyOf(input) === key1)).toBe(true);
		expect(toolResultTexts(harness.captures.at(-1)!).map((item) => item.id)).toEqual(["c6", "c7"]);
	});

	it("asks again about results kept before a summary once Pi has summarized", async () => {
		const { harness, scorer } = await setup({ scorerAnswer: () => 0.95 });
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE), { kind: "text", text: "SUMMARY" });
		expect(scorer.calls).toBe(1);
		expect(harness.entries().some((entry) => entry.type === "compaction")).toBe(true);
		const firstKeys = Object.keys(scorer.lastQuestions ?? {});
		expect(firstKeys.length).toBeGreaterThan(0);
		// Two new groups only, both protected as recent: any candidate must come from the retained pre-summary suffix.
		await harness.prompt("Continue.", { kind: "tools", calls: [call("n0", "src/next0.ts")] }, { kind: "tools", calls: [call("n1", "src/next1.ts")], inputTokens: PRESSURE }, { kind: "text", text: "SUMMARY 2" }, { kind: "text", text: "ok" });
		expect(scorer.calls).toBe(2);
		expect(Object.keys(scorer.lastQuestions ?? {}).length).toBeGreaterThan(0);
	});

	it("marks a terminal scorer failure as one fallback with its reason and lets Pi summarize", async () => {
		const { harness, scorer } = await setup();
		scorer.score = async () => {
			throw new ScoringError("network", "boom");
		};
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE), { kind: "text", text: "SUMMARY" });
		expect(harness.events).toContain("compact:threshold");
		const fallbacks = harness.telemetry.inputs.filter((input) => input.fallback === true);
		expect(fallbacks).toHaveLength(1);
		expect(fallbacks[0]).toMatchObject({ kind: "pass", outcome: "failed", reason: "network" });
		expect(harness.telemetry.inputs.filter((input) => input.kind === "request" && input.role === "scoring")).toEqual([expect.objectContaining({ outcome: "failed", reason: "network" })]);
		expect(await harness.telemetry.report(7)).toMatch(/fallbacks: network=1/);
	});

	it("keeps thinking-bearing tool groups atomic when only part of them is droppable", async () => {
		const { harness } = await setup({ scorerAnswer: (key) => (key === "call_t1" || key === "result_t1" ? 0.9 : 0.1) });
		// One thinking-bearing group with two calls (t1 keep, t2 drop) followed by plain groups.
		const responses = [
			{ kind: "tools" as const, thinking: "reasoning", calls: [call("k0", "src/keep.ts"), call("d0", "src/drop.ts")], inputTokens: 500 },
			...longTask(7, PRESSURE),
		];
		await harness.prompt("Refactor.", ...responses);
		const after = harness.captures.at(-1)!;
		const results = toolResultTexts(after);
		// d0 could not be removed without orphaning the reasoning item: it is shortened instead, k0 stays.
		expect(results.find((item) => item.id === "d0")!.text).toContain(PLACEHOLDER_MARKER);
		expect(results.find((item) => item.id === "k0")!.text.length).toBeGreaterThanOrEqual(BIG_RESULT_CHARS);
		const thinkingMessage = after.messages.find((message) => message.role === "assistant" && message.content.some((block) => block.type === "thinking"));
		expect(thinkingMessage && thinkingMessage.role === "assistant" ? thinkingMessage.content.filter((block) => block.type === "toolCall").length : 0).toBe(2);
	});
});
