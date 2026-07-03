/**
 * Tests for pi-buddy's pure logic: transcript serialization, budget trimming,
 * watchdog PASS detection, and telemetry records.
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	branchToBlocks,
	entryToBlock,
	estimateTokens,
	renderTranscript,
	TRIM_MARKER,
} from "../src/extensions/transcript.js";
import {
	buildStanceSystemPrompt,
	buildWatchdogSystemPrompt,
	isWatchdogPass,
	WATCHDOG_PASS_TOKEN,
} from "../src/extensions/stances.js";
import {
	__setTelemetryPathForTests,
	recordConsultation,
	telemetryPath,
} from "../src/extensions/telemetry.js";
import { BuddyRunTracker } from "../src/extensions/policy.js";
import {
	BUDDY_BROWSER_SESSION,
	createWebTools,
	extractDeepwikiText,
	type ExecFn,
	parseDeepwikiBody,
	truncateHead,
} from "../src/extensions/web-tools.js";
import { harvestDirectives, harvestNotice } from "../src/extensions/harvest.js";
import {
	delayWithAbort,
	isRetriableBuddyError,
	RETRY_BASE_DELAY_MS,
	RETRY_JITTER_MS,
	retryDelayMs,
} from "../src/extensions/retry.js";
import {
	deriveSlug,
	evictForBudget,
	MemoryStore,
	parseMemoryFile,
	retractEntry,
	serializeMemory,
	splitExpired,
} from "../src/extensions/memory.js";

function messageEntry(message: unknown, id = "e1"): any {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

describe("entryToBlock", () => {
	it("renders user messages with string content", () => {
		const block = entryToBlock(
			messageEntry({ role: "user", content: "hello", timestamp: 1 }),
		);
		assert.ok(block);
		assert.match(block.text, /## USER\nhello/);
		assert.equal(block.isToolOutput, false);
	});

	it("renders assistant text and tool calls, omitting thinking", () => {
		const block = entryToBlock(
			messageEntry({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET SCRATCH WORK" },
					{ type: "text", text: "I will read the file." },
					{
						type: "toolCall",
						id: "t1",
						name: "read",
						arguments: { path: "src/a.ts" },
					},
				],
				timestamp: 1,
			}),
		);
		assert.ok(block);
		assert.match(block.text, /## AGENT/);
		assert.match(block.text, /I will read the file\./);
		assert.match(block.text, /\[tool call: read\(.*src\/a\.ts.*\)\]/);
		assert.doesNotMatch(block.text, /SECRET SCRATCH WORK/);
	});

	it("marks tool results as trimmable and flags errors", () => {
		const block = entryToBlock(
			messageEntry({
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: true,
				timestamp: 1,
			}),
		);
		assert.ok(block);
		assert.equal(block.isToolOutput, true);
		assert.match(block.text, /## TOOL RESULT: read \(ERROR\)/);
	});

	it("renders compaction summaries", () => {
		const block = entryToBlock({
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "Earlier we set up the project.",
			firstKeptEntryId: "e0",
			tokensBefore: 1000,
		} as any);
		assert.ok(block);
		assert.match(block.text, /compacted summary/);
		assert.match(block.text, /Earlier we set up the project\./);
	});

	it("skips non-conversational entries", () => {
		assert.equal(
			entryToBlock({
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				provider: "zai",
				modelId: "glm-5.2",
			} as any),
			undefined,
		);
	});
});

describe("renderTranscript budget guard", () => {
	const mkBlock = (text: string, isToolOutput: boolean) => ({
		text,
		isToolOutput,
	});

	it("returns the full transcript when under budget", () => {
		const blocks = [
			mkBlock("## USER\nhi", false),
			mkBlock("## AGENT\nhello", false),
		];
		const out = renderTranscript(blocks, {
			maxTokens: 10_000,
			keepHeadBlocks: 1,
			keepTailBlocks: 1,
		});
		assert.equal(out.includes(TRIM_MARKER), false);
		assert.match(out, /hi/);
		assert.match(out, /hello/);
	});

	it("trims oldest tool outputs first and inserts the marker", () => {
		const big = "x".repeat(4000); // ~1000 tokens each
		const blocks = [
			mkBlock("## USER\nhead", false),
			mkBlock(`## TOOL RESULT: read\n${big}-OLD-TOOL`, true),
			mkBlock("## AGENT\nmiddle-agent-text", false),
			mkBlock(`## TOOL RESULT: read\n${big}-NEW-TOOL`, true),
			mkBlock("## AGENT\ntail", false),
		];
		const out = renderTranscript(blocks, {
			maxTokens: estimateTokens(big) * 2, // room for roughly one big block
			keepHeadBlocks: 1,
			keepTailBlocks: 1,
		});
		assert.match(out, /head/);
		assert.match(out, /tail/);
		assert.ok(out.includes(TRIM_MARKER));
		assert.doesNotMatch(out, /-OLD-TOOL/);
	});

	it("never trims head or tail blocks", () => {
		const big = "y".repeat(8000);
		const blocks = [
			mkBlock("## USER\nprotected-head", false),
			mkBlock(`## TOOL RESULT: read\n${big}`, true),
			mkBlock("## AGENT\nprotected-tail", false),
		];
		const out = renderTranscript(blocks, {
			maxTokens: 50,
			keepHeadBlocks: 1,
			keepTailBlocks: 1,
		});
		assert.match(out, /protected-head/);
		assert.match(out, /protected-tail/);
	});
});

describe("branchToBlocks", () => {
	it("preserves order and drops empty assistant messages", () => {
		const blocks = branchToBlocks([
			messageEntry({ role: "user", content: "first", timestamp: 1 }, "e1"),
			messageEntry(
				{ role: "assistant", content: [], timestamp: 2 },
				"e2",
			),
			messageEntry({ role: "user", content: "second", timestamp: 3 }, "e3"),
		]);
		assert.equal(blocks.length, 2);
		assert.match(blocks[0].text, /first/);
		assert.match(blocks[1].text, /second/);
	});
});

describe("stances", () => {
	it("every stance prompt includes the base persona", () => {
		for (const stance of ["discuss", "debate", "fact_check", "review"] as const) {
			const prompt = buildStanceSystemPrompt(stance);
			assert.match(prompt, /sparring partner/);
			assert.match(prompt, /Stance:/);
		}
	});

	it("watchdog prompt demands the PASS token", () => {
		assert.ok(buildWatchdogSystemPrompt().includes(WATCHDOG_PASS_TOKEN));
	});
});

describe("telemetry", () => {
	afterEach(() => {
		__setTelemetryPathForTests(undefined);
	});

	it("appends one JSONL record per consultation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buddy-telemetry-"));
		const path = join(dir, "nested", "buddy-telemetry.jsonl");
		__setTelemetryPathForTests(path);

		await recordConsultation({
			source: "watchdog",
			stance: "watchdog",
			outcome: "pass",
			model: "zai/glm-5.2",
			totalMs: 1234,
			rounds: 2,
			toolCalls: 3,
		});
		await recordConsultation({
			source: "tool",
			stance: "fact_check",
			outcome: "error",
			model: "zai/glm-5.2",
			totalMs: 42,
			error: "boom",
		});

		const lines = (await readFile(path, "utf8")).trim().split("\n");
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]);
		assert.equal(first.v, 1);
		assert.equal(first.outcome, "pass");
		assert.equal(first.toolCalls, 3);
		assert.ok(typeof first.ts === "string");
		const second = JSON.parse(lines[1]);
		assert.equal(second.outcome, "error");
		assert.equal(second.error, "boom");
	});

	it("never throws when the path is unwritable", async () => {
		__setTelemetryPathForTests("/dev/null/impossible/file.jsonl");
		await recordConsultation({
			source: "command",
			stance: "discuss",
			outcome: "ok",
			model: "zai/glm-5.2",
			totalMs: 1,
		});
		assert.ok(telemetryPath().includes("impossible"));
	});
});

describe("isWatchdogPass", () => {
	it("accepts bare and decorated PASS", () => {
		assert.equal(isWatchdogPass("PASS"), true);
		assert.equal(isWatchdogPass("  PASS  "), true);
		assert.equal(isWatchdogPass("PASS."), true);
		assert.equal(isWatchdogPass("**PASS**"), true);
	});

	it("rejects substantive replies mentioning PASS", () => {
		assert.equal(isWatchdogPass("I cannot PASS on this: the loop is wrong"), false);
		assert.equal(isWatchdogPass("PASS, but one concern: the API is misused"), false);
		assert.equal(isWatchdogPass("The tests fail"), false);
		assert.equal(isWatchdogPass(""), false);
	});
});

describe("BuddyRunTracker", () => {
	const mkTracker = () => new BuddyRunTracker(3, 2);

	it("launches a watchdog after the threshold of unconsulted turns", () => {
		const t = mkTracker();
		t.onAgentStart();
		assert.equal(t.onTurnEnd(), false);
		assert.equal(t.onTurnEnd(), false);
		assert.equal(t.onTurnEnd(), true);
	});

	it("pull resets the counter", () => {
		const t = mkTracker();
		t.onAgentStart();
		t.onTurnEnd();
		t.onTurnEnd();
		t.onPull();
		assert.equal(t.onTurnEnd(), false);
		assert.equal(t.onTurnEnd(), false);
		assert.equal(t.onTurnEnd(), true);
	});

	it("does not count turns outside an agent run", () => {
		const t = mkTracker();
		assert.equal(t.onTurnEnd(), false);
		assert.equal(t.onTurnEnd(), false);
		assert.equal(t.onTurnEnd(), false);
		t.onAgentStart();
		assert.equal(t.onTurnEnd(), false);
	});

	it("suppresses new launches while a background review is in flight", () => {
		const t = mkTracker();
		t.onAgentStart();
		t.onTurnEnd();
		t.onTurnEnd();
		assert.equal(t.onTurnEnd(), true);
		t.launchBackground("turns");
		assert.equal(t.onTurnEnd(), false);
		assert.equal(t.onTurnEnd(), false);
		assert.equal(t.onTurnEnd(), false);
		t.settleBackground();
		t.onTurnEnd();
		t.onTurnEnd();
		assert.equal(t.onTurnEnd(), true);
	});

	it("fires end-of-run review only for >= min turns with no consultation", () => {
		// Long run, no consult: fires.
		const a = mkTracker();
		a.onAgentStart();
		a.onTurnEnd();
		a.onTurnEnd();
		assert.equal(a.onAgentEnd(), true);
		// Trivial 1-turn run: does not fire.
		const b = mkTracker();
		b.onAgentStart();
		b.onTurnEnd();
		assert.equal(b.onAgentEnd(), false);
		// Consulted run: does not fire.
		const c = mkTracker();
		c.onAgentStart();
		c.onTurnEnd();
		c.onPull();
		c.onTurnEnd();
		assert.equal(c.onAgentEnd(), false);
	});

	it("a fired watchdog counts as consultation for run-end purposes", () => {
		const t = mkTracker();
		t.onAgentStart();
		t.onTurnEnd();
		t.onTurnEnd();
		assert.equal(t.onTurnEnd(), true);
		t.launchBackground("turns");
		t.settleBackground();
		assert.equal(t.onAgentEnd(), false);
	});

	it("delivery mode: steer during a run, nextTurn when idle", () => {
		const t = mkTracker();
		t.onAgentStart();
		assert.equal(t.deliveryMode(), "steer");
		t.onAgentEnd();
		assert.equal(t.deliveryMode(), "nextTurn");
	});

	it("invalidate discards in-flight launches; staleness counts turns", () => {
		const t = mkTracker();
		t.onAgentStart();
		t.onTurnEnd();
		t.onTurnEnd();
		t.onTurnEnd();
		const launch = t.launchBackground("turns");
		assert.equal(t.isCurrent(launch), true);
		assert.equal(t.turnsElapsedSince(launch), 0);
		t.onTurnEnd();
		t.onTurnEnd();
		assert.equal(t.turnsElapsedSince(launch), 2);
		t.invalidate();
		assert.equal(t.isCurrent(launch), false);
	});
});

describe("retry helpers", () => {
	it("classifies transient provider errors as retriable", () => {
		assert.equal(
			isRetriableBuddyError(
				new Error('429: {"code":"1305","message":"service temporarily overloaded"}'),
			),
			true,
		);
		assert.equal(isRetriableBuddyError(new Error("503 service unavailable")), true);
		assert.equal(isRetriableBuddyError(new Error("request timed out")), true);
	});

	it("does not retry deterministic errors", () => {
		assert.equal(isRetriableBuddyError(new Error("401 unauthorized")), false);
		assert.equal(isRetriableBuddyError(new Error("Buddy authentication failed")), false);
		assert.equal(isRetriableBuddyError(new Error("409 conflict")), false);
		assert.equal(isRetriableBuddyError(new Error("Buddy produced no answer text")), false);
	});

	it("keeps retry delay within the configured jitter window", () => {
		assert.equal(retryDelayMs(() => 0), RETRY_BASE_DELAY_MS);
		assert.equal(
			retryDelayMs(() => 0.999),
			RETRY_BASE_DELAY_MS + RETRY_JITTER_MS - 1,
		);
	});

	it("respects an already-aborted retry signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(delayWithAbort(100, controller.signal), /aborted/);
	});
});

describe("harvest directives", () => {
	it("strips directives and caps harvested lessons/retractions", () => {
		const answer = [
			"Here is my review.",
			"LESSON[global]: Season prefers concise answers.",
			"LESSON[project]: Build before declaring fixes live.",
			"LESSON[project]: Build before declaring fixes live.",
			"LESSON[project]: Third lesson.",
			"LESSON[global]: Fourth lesson should be stripped but not applied.",
			"RETRACT: old bad rule",
			"RETRACT: another old rule",
			"RETRACT: excess retract",
			"Done.",
		].join("\n");
		const h = harvestDirectives(answer);
		assert.equal(h.lessons.length, 3);
		assert.deepEqual(h.lessons.map((l) => l.scope), ["global", "project", "project"]);
		assert.equal(h.retractions.length, 2);
		assert.doesNotMatch(h.stripped, /LESSON|RETRACT|Fourth lesson/);
		assert.match(h.stripped, /Here is my review/);
		assert.match(h.stripped, /Done/);
	});

	it("formats a visible learning notice", () => {
		assert.equal(harvestNotice({ lessons: 2, retractions: 1 }), "buddy: remembered 2 lesson(s), retracted 1");
		assert.equal(harvestNotice({ lessons: 0, retractions: 0 }), undefined);
	});
});

describe("memory store", () => {
	it("parses, serializes, expires, evicts, and retracts entries", () => {
		const lines = parseMemoryFile([
			"# hand edited heading",
			"- [2026-01-01] Old thing.",
			"- [2026-07-03] New thing.",
		].join("\n"));
		assert.equal(lines.length, 3);
		assert.match(serializeMemory(lines), /hand edited heading/);
		const split = splitExpired(lines, new Date("2026-07-03T00:00:00Z"));
		assert.equal(split.expired.length, 1);
		const retracted = retractEntry(lines, "new thing");
		assert.ok(retracted.removed);
		assert.doesNotMatch(serializeMemory(retracted.lines), /New thing/);
		const evicted = evictForBudget(lines, 35);
		assert.equal(evicted.evicted.length, 2);
		assert.match(serializeMemory(evicted.kept), /hand edited heading/);
	});

	it("derives a project slug from git root instead of cwd", () => {
		const slug = deriveSlug("/Users/season/proj/packages/pi-buddy", (p) =>
			p === "/Users/season/proj/.git",
		);
		assert.equal(slug, "Users-season-proj");
	});

	it("applies lessons, duplicate suppression, retractions, and archive writes", () => {
		const dir = mkdtempSync(join(tmpdir(), "buddy-memory-"));
		const store = new MemoryStore(dir);
		const slug = "Project";
		const applied = store.applyDirectives(
			slug,
			[
				{ scope: "global", text: "Season prefers short answers." },
				{ scope: "global", text: "Season prefers short answers." },
				{ scope: "project", text: "Build before declaring fixes live." },
			],
			[],
			new Date("2026-07-03T00:00:00Z"),
		);
		assert.equal(applied.lessons, 2);
		assert.match(readFileSync(store.globalPath(), "utf8"), /short answers/);
		assert.match(readFileSync(store.projectPath(slug), "utf8"), /Build before/);

		const retracted = store.applyDirectives(slug, [], ["Build before", "missing"]);
		assert.equal(retracted.retractions, 1);
		assert.equal(retracted.retractMisses, 1);
		assert.equal(existsSync(store.projectPath(slug)), false);
		assert.match(readFileSync(join(dir, "archive", "projects", "Project.md"), "utf8"), /Build before/);
	});

	it("retracts project entries before matching global entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "buddy-memory-retract-scope-"));
		const store = new MemoryStore(dir);
		store.applyDirectives(
			"Project",
			[
				{ scope: "global", text: "Shared lesson should survive." },
				{ scope: "project", text: "Shared lesson should go first." },
			],
			[],
		);

		const retracted = store.applyDirectives("Project", [], ["Shared lesson"]);
		assert.equal(retracted.retractions, 1);
		assert.match(readFileSync(store.globalPath(), "utf8"), /Shared lesson should survive/);
		assert.equal(existsSync(store.projectPath("Project")), false);
		assert.match(readFileSync(join(dir, "archive", "projects", "Project.md"), "utf8"), /Shared lesson should go first/);
	});

	it("curates expired entries to archive and skips while locked", () => {
		const dir = mkdtempSync(join(tmpdir(), "buddy-memory-curate-"));
		const store = new MemoryStore(dir);
		mkdirSync(join(dir, "projects"), { recursive: true });
		writeFileSync(store.globalPath(), "- [2026-01-01] Expired.\n- [2026-07-03] Fresh.\n");
		assert.equal(store.curate("Project", new Date("2026-07-03T00:00:00Z")), true);
		assert.doesNotMatch(readFileSync(store.globalPath(), "utf8"), /Expired/);
		assert.match(readFileSync(join(dir, "archive", "global.md"), "utf8"), /Expired/);
		mkdirSync(join(dir, ".lock"));
		assert.equal(store.curate("Project", new Date("2026-07-03T00:00:00Z")), false);
	});

	it("clears a scope by backing up and archiving it", () => {
		const dir = mkdtempSync(join(tmpdir(), "buddy-memory-clear-"));
		const store = new MemoryStore(dir);
		store.applyDirectives("Project", [{ scope: "global", text: "Remember me." }], []);
		assert.equal(store.clear("global", "Project"), true);
		assert.equal(existsSync(store.globalPath()), false);
		assert.match(readFileSync(join(dir, "archive", "global.md"), "utf8"), /Remember me/);
		const backups = readdirSync(dir).filter((name) => name.startsWith("global.md.bak."));
		assert.equal(backups.length, 1);
		assert.match(readFileSync(join(dir, backups[0]), "utf8"), /Remember me/);
	});
});

describe("web tools", () => {
	it("truncateHead caps output and marks the cut", () => {
		const long = "a".repeat(60_000);
		const out = truncateHead(long, 50_000);
		assert.ok(out.length < 60_000);
		assert.match(out, /output truncated at 50000 characters/);
		assert.equal(truncateHead("short"), "short");
	});

	it("parses SSE-framed deepwiki responses", () => {
		const body =
			'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Answer here"}]}}\n';
		assert.equal(extractDeepwikiText(parseDeepwikiBody(body)), "Answer here");
	});

	it("parses plain JSON deepwiki responses", () => {
		const body = '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Plain"}]}}';
		assert.equal(extractDeepwikiText(parseDeepwikiBody(body)), "Plain");
	});

	it("surfaces JSON-RPC and tool errors", () => {
		assert.throws(
			() => extractDeepwikiText(parseDeepwikiBody('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad repo"}}')),
			/bad repo/,
		);
		assert.throws(
			() => extractDeepwikiText(parseDeepwikiBody('{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"repo not found"}]}}')),
			/repo not found/,
		);
	});

	it("read_webpage only ever invokes read verbs with the isolated session", async () => {
		const invoked: string[][] = [];
		const exec: ExecFn = async (_cmd, args) => {
			invoked.push(args);
			return { stdout: "page text", stderr: "", code: 0 };
		};
		const tools = createWebTools(exec);
		const readWebpageTool = tools.find((t) => t.name === "read_webpage");
		assert.ok(readWebpageTool);
		await readWebpageTool.execute("t1", { url: "https://example.com" });
		const verbs = invoked.map((args) => args[0]);
		assert.deepEqual(verbs, ["open", "wait", "get"]);
		const allowed = new Set(["open", "wait", "snapshot", "get"]);
		for (const verb of verbs) assert.ok(allowed.has(verb), `forbidden verb: ${verb}`);
		for (const args of invoked) {
			const idx = args.indexOf("--session");
			assert.ok(idx >= 0 && args[idx + 1] === BUDDY_BROWSER_SESSION);
		}
	});

	it("read_webpage snapshot mode uses the snapshot verb", async () => {
		const invoked: string[][] = [];
		const exec: ExecFn = async (_cmd, args) => {
			invoked.push(args);
			return { stdout: "tree", stderr: "", code: 0 };
		};
		const tools = createWebTools(exec);
		const tool = tools.find((t) => t.name === "read_webpage");
		assert.ok(tool);
		await tool.execute("t1", { url: "example.com", mode: "snapshot" });
		assert.deepEqual(invoked.map((a) => a[0]), ["open", "wait", "snapshot"]);
	});

	it("read_webpage surfaces CLI failures", async () => {
		const exec: ExecFn = async () => ({ stdout: "", stderr: "no browser", code: 1 });
		const tools = createWebTools(exec);
		const tool = tools.find((t) => t.name === "read_webpage");
		assert.ok(tool);
		await assert.rejects(
			() => tool.execute("t1", { url: "example.com" }),
			/no browser/,
		);
	});
});
