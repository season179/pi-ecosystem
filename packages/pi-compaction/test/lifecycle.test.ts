import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PASS_ENTRY, PIN_ENTRY } from "../src/adapter/state.js";
import { PLACEHOLDER_MARKER } from "../src/engine/transform.js";
import { TELEMETRY_SUBDIR } from "../src/extensions/compaction.js";
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

	it("supports on/off/status/restore/report/feedback commands", async () => {
		const { harness, scorer } = await setup({ config: { ...CONFIG, enabled: false } });
		await harness.prompt("/compaction on");
		await harness.prompt("Refactor.", ...longTask(8, PRESSURE));
		expect(scorer.calls).toBe(1);
		expect(toolResultTexts(harness.captures[8]).map((item) => item.id)).toEqual(["c6", "c7"]);

		await harness.prompt("/compaction status");
		await harness.prompt("/compaction report 7");
		await harness.prompt("/compaction feedback bad-prune");

		await harness.prompt("/compaction off");
		await harness.prompt("Continue.", { kind: "text", text: "ok" });
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
		const archiveId = harness.entries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "c0")!.id;

		await harness.prompt(
			"What was in file0?",
			{ kind: "tools", calls: [{ type: "toolCall", id: "r1", name: "compaction_recall", arguments: { action: "list" } }] },
			{ kind: "tools", calls: [{ type: "toolCall", id: "r2", name: "compaction_recall", arguments: { action: "search", query: "file3" } }] },
			{ kind: "tools", calls: [{ type: "toolCall", id: "r3", name: "compaction_recall", arguments: { action: "read", id: archiveId, limit: 100, restore: true } }] },
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
		// After restore, the original c0 result is sent in full again while the others stay shortened.
		const c0 = results.find((item) => item.id === "c0")!;
		expect(c0.text.length).toBeGreaterThanOrEqual(BIG_RESULT_CHARS);
		expect(results.find((item) => item.id === "c1")!.text).toContain(PLACEHOLDER_MARKER);
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
