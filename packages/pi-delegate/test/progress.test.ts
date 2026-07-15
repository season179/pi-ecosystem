/**
 * Tests for the state-shaped progress tracker: activity transitions from the
 * worker event stream, label sanitization, and the running-view rendering.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createProgressTracker,
	describeToolCall,
	formatDuration,
	formatProgressLines,
	LABEL_MAX_CHARS,
	RECENT_MAX,
	sanitizeLabel,
} from "../src/progress.js";

function assistantWithTools(calls: { id: string; name: string; args?: Record<string, unknown> }[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} })),
	} as AssistantMessage;
}

function assistantText(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as AssistantMessage;
}

function toolResult(toolCallId: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "any", content: [], isError: false } as unknown as ToolResultMessage;
}

describe("sanitizeLabel", () => {
	it("keeps only the first line and trims", () => {
		expect(sanitizeLabel("  npm test \nsecond line")).toBe("npm test");
	});

	it("redacts secret-bearing assignments", () => {
		expect(sanitizeLabel("API_KEY=sk-123 npm run deploy")).toBe("API_KEY=*** npm run deploy");
		expect(sanitizeLabel("export MY_TOKEN=abc && curl")).toBe("export MY_TOKEN=*** && curl");
	});

	it("redacts quoted assignment values through their closing quote", () => {
		expect(sanitizeLabel(`DB_PASSWORD="hunter two words" ./deploy.sh`)).toBe("DB_PASSWORD=*** ./deploy.sh");
		expect(sanitizeLabel("SECRET='multi word value' run")).toBe("SECRET=*** run");
	});

	it("redacts space-separated flag values and bearer credentials", () => {
		expect(sanitizeLabel("curl --token abc123 https://x.test")).toBe("curl --token *** https://x.test");
		expect(sanitizeLabel("curl -H 'Authorization: Bearer sk-live-42' https://x.test")).toContain("Bearer ***");
		// A following flag is not a value; nothing to redact.
		expect(sanitizeLabel("cmd --token --verbose")).toBe("cmd --token --verbose");
	});

	it("caps at LABEL_MAX_CHARS with an ellipsis", () => {
		const label = sanitizeLabel("x".repeat(200));
		expect(label.length).toBe(LABEL_MAX_CHARS);
		expect(label.endsWith("…")).toBe(true);
	});
});

describe("describeToolCall", () => {
	it("uses bash command, file path, and grep pattern details", () => {
		expect(describeToolCall("bash", { command: "npm run build" })).toBe("bash: npm run build");
		expect(describeToolCall("edit", { path: "src/worker.ts" })).toBe("edit: src/worker.ts");
		expect(describeToolCall("grep", { pattern: "TODO" })).toBe("grep: TODO");
	});

	it("falls back to the bare tool name", () => {
		expect(describeToolCall("mystery", { count: 3 })).toBe("mystery");
	});
});

describe("formatDuration", () => {
	it("formats seconds and minute+second combinations", () => {
		expect(formatDuration(3000)).toBe("3s");
		expect(formatDuration(272_000)).toBe("4m32s");
		expect(formatDuration(600_000)).toBe("10m00s");
		expect(formatDuration(-50)).toBe("0s");
	});
});

describe("createProgressTracker", () => {
	it("starts the first tool call as current and completes it with a duration", () => {
		const tracker = createProgressTracker(0, 600_000);
		tracker.onAssistantMessage(assistantWithTools([{ id: "t1", name: "bash", args: { command: "npm test" } }]), 1000);

		expect(tracker.state.turns).toBe(1);
		expect(tracker.state.current).toEqual({ label: "bash: npm test", startedAt: 1000 });

		tracker.onToolResult(toolResult("t1"), 4000);
		expect(tracker.state.current).toBeUndefined();
		expect(tracker.state.recent).toEqual([{ label: "bash: npm test", durationMs: 3000 }]);
	});

	it("queues multiple tool calls and advances through them", () => {
		const tracker = createProgressTracker(0, 600_000);
		tracker.onAssistantMessage(
			assistantWithTools([
				{ id: "t1", name: "read", args: { path: "a.ts" } },
				{ id: "t2", name: "edit", args: { path: "b.ts" } },
			]),
			1000,
		);

		expect(tracker.state.current?.label).toBe("read: a.ts");
		tracker.onToolResult(toolResult("t1"), 2000);
		expect(tracker.state.current).toEqual({ label: "edit: b.ts", startedAt: 2000 });
	});

	it("surfaces tool-less assistant text as capped narration without duration", () => {
		const tracker = createProgressTracker(0, 600_000);
		tracker.onAssistantMessage(assistantText("Implementing the retry logic now.\nMore detail."), 1000);

		expect(tracker.state.recent).toEqual([{ label: "worker: Implementing the retry logic now." }]);
		expect(tracker.state.current).toBeUndefined();
	});

	it("drops out-of-order tool results from the queue", () => {
		const tracker = createProgressTracker(0, 600_000);
		tracker.onAssistantMessage(
			assistantWithTools([
				{ id: "t1", name: "read", args: { path: "a.ts" } },
				{ id: "t2", name: "read", args: { path: "b.ts" } },
			]),
			1000,
		);

		tracker.onToolResult(toolResult("t2"), 2000);
		expect(tracker.state.recent).toEqual([]);
		tracker.onToolResult(toolResult("t1"), 3000);
		// t2 was dropped from the queue, so nothing further is current.
		expect(tracker.state.current).toBeUndefined();
	});

	it("caps recent at RECENT_MAX keeping the newest", () => {
		const tracker = createProgressTracker(0, 600_000);
		for (let i = 0; i < RECENT_MAX + 2; i++) tracker.note(`note ${i}`);

		expect(tracker.state.recent).toHaveLength(RECENT_MAX);
		expect(tracker.state.recent.at(-1)?.label).toBe(`note ${RECENT_MAX + 1}`);
	});

	it("setPhase replaces the current activity and clears the queue", () => {
		const tracker = createProgressTracker(0, 600_000);
		tracker.onAssistantMessage(
			assistantWithTools([
				{ id: "t1", name: "bash", args: { command: "ls" } },
				{ id: "t2", name: "bash", args: { command: "pwd" } },
			]),
			1000,
		);
		tracker.setPhase("verify: npm test", 5000);

		expect(tracker.state.current).toEqual({ label: "verify: npm test", startedAt: 5000 });
		tracker.onToolResult(toolResult("t2"), 6000);
		expect(tracker.state.current?.label).toBe("verify: npm test");
	});

	it("snapshot returns an independent deep copy", () => {
		const tracker = createProgressTracker(0, 600_000);
		tracker.onAssistantMessage(assistantWithTools([{ id: "t1", name: "bash", args: { command: "ls" } }]), 1000);
		const snap = tracker.snapshot();

		tracker.onToolResult(toolResult("t1"), 2000);
		expect(snap.current?.label).toBe("bash: ls");
		expect(snap.recent).toHaveLength(0);
	});
});

describe("formatProgressLines", () => {
	it("renders head, recent (newest first), and the interrupt hint", () => {
		const tracker = createProgressTracker(0, 600_000);
		tracker.note("checkpoint abc123def456");
		tracker.onAssistantMessage(assistantWithTools([{ id: "t1", name: "read", args: { path: "a.ts" } }]), 10_000);
		tracker.onToolResult(toolResult("t1"), 13_000);
		tracker.onAssistantMessage(assistantWithTools([{ id: "t2", name: "bash", args: { command: "npm run build" } }]), 14_000);

		const lines = formatProgressLines(tracker.state, 272_000, "abc123def456");

		expect(lines[0]).toBe("turn 2 · 4m32s / 10m00s · bash: npm run build (4m18s)");
		expect(lines[1]).toBe("✓ read: a.ts (3s)");
		expect(lines[2]).toBe("checkpoint abc123def456");
		expect(lines.at(-1)).toBe("esc stops worker · partial work preserved · reset point abc123def456");
	});

	it("shows waiting state before the first worker event and omits the hint without a sha", () => {
		const tracker = createProgressTracker(0, 600_000);
		const lines = formatProgressLines(tracker.state, 5000);

		expect(lines).toEqual(["turn 0 · 5s / 10m00s · waiting for worker"]);
	});
});
