/**
 * Tests for the pure parts of the worker spawn layer: line-buffered JSON
 * event collection, usage accumulation, and final-output extraction.
 */

import { describe, expect, it } from "vitest";
import { createEventCollector, emptyUsage, getFinalOutput } from "../src/worker.js";

function assistantEvent(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			model: "zai/glm-5.2",
			stopReason: "end",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 165,
				cost: { total: 0.001 },
			},
			...overrides,
		},
	});
}

describe("createEventCollector", () => {
	it("accumulates usage across assistant messages", () => {
		const collector = createEventCollector();
		collector.push(`${assistantEvent()}\n${assistantEvent()}\n`);

		expect(collector.transcript.usage).toEqual({
			input: 200,
			output: 100,
			cacheRead: 20,
			cacheWrite: 10,
			cost: 0.002,
			contextTokens: 165,
			turns: 2,
		});
		expect(collector.transcript.messages).toHaveLength(2);
	});

	it("captures model, stopReason, and errorMessage", () => {
		const collector = createEventCollector();
		collector.push(`${assistantEvent({ stopReason: "error", errorMessage: "boom" })}\n`);

		expect(collector.transcript.model).toBe("zai/glm-5.2");
		expect(collector.transcript.stopReason).toBe("error");
		expect(collector.transcript.errorMessage).toBe("boom");
	});

	it("keeps the first model seen and the last stopReason", () => {
		const collector = createEventCollector();
		collector.push(`${assistantEvent({ model: "first/model" })}\n`);
		collector.push(`${assistantEvent({ model: "second/model", stopReason: "toolUse" })}\n`);

		expect(collector.transcript.model).toBe("first/model");
		expect(collector.transcript.stopReason).toBe("toolUse");
	});

	it("appends tool_result_end messages without counting turns", () => {
		const collector = createEventCollector();
		const toolResult = JSON.stringify({
			type: "tool_result_end",
			message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
		});
		collector.push(`${toolResult}\n`);

		expect(collector.transcript.messages).toHaveLength(1);
		expect(collector.transcript.usage.turns).toBe(0);
	});

	it("reassembles lines split across chunks", () => {
		const collector = createEventCollector();
		const line = assistantEvent();
		collector.push(line.slice(0, 20));
		collector.push(`${line.slice(20)}\n`);

		expect(collector.transcript.messages).toHaveLength(1);
		expect(collector.transcript.usage.turns).toBe(1);
	});

	it("processes a trailing line without newline on flush", () => {
		const collector = createEventCollector();
		collector.push(assistantEvent());
		expect(collector.transcript.messages).toHaveLength(0);

		collector.flush();
		expect(collector.transcript.messages).toHaveLength(1);
	});

	it("ignores malformed JSON, blank lines, and unknown events", () => {
		const collector = createEventCollector();
		collector.push('not json\n\n{"type":"turn_start"}\n{"type":"message_end"}\n');

		expect(collector.transcript.messages).toHaveLength(0);
		expect(collector.transcript.usage).toEqual(emptyUsage());
	});

	it("handles assistant messages without usage", () => {
		const collector = createEventCollector();
		const bare = JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		});
		collector.push(`${bare}\n`);

		expect(collector.transcript.usage.turns).toBe(1);
		expect(collector.transcript.usage.input).toBe(0);
	});

	it("emits stream events to the callback", () => {
		const events: string[] = [];
		const collector = createEventCollector((ev) => events.push(ev.type));
		const toolResult = JSON.stringify({
			type: "tool_result_end",
			message: { role: "toolResult", content: [] },
		});
		collector.push(`${assistantEvent()}\n${toolResult}\n`);

		expect(events).toEqual(["message", "tool_result"]);
	});
});

describe("getFinalOutput", () => {
	it("returns the last assistant text", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool" }] },
			{ role: "assistant", content: [{ type: "text", text: "last" }] },
		] as any;

		expect(getFinalOutput(messages)).toBe("last");
	});

	it("returns empty string when there is no assistant text", () => {
		expect(getFinalOutput([])).toBe("");
		expect(getFinalOutput([{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] }] as any)).toBe("");
	});
});
