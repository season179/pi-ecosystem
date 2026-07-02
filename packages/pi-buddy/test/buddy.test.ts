/**
 * Tests for pi-buddy's pure logic: transcript serialization, budget trimming,
 * watchdog PASS detection, and telemetry records.
 */

import assert from "node:assert/strict";
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
