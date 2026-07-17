import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import setupBuddy from "../src/extensions/buddy.js";
import { __setTelemetryPathForTests } from "../src/extensions/telemetry.js";

function createHarness(branch: unknown[]) {
	let currentBranch = branch;
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	let activeTools = ["consult_buddy", "give_buddy_feedback"];
	const pi: any = {
		registerFlag() {},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		getFlag(name: string) {
			return name === "buddy-disabled" ? false : undefined;
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		exec() {
			throw new Error("not used");
		},
		sendMessage() {},
	};
	setupBuddy(pi);
	const ctx: any = {
		hasUI: false,
		cwd: "/tmp/project",
		sessionManager: { getBranch: () => currentBranch },
		ui: {},
	};
	return {
		tools,
		handlers,
		ctx,
		setBranch(next: unknown[]) {
			currentBranch = next;
		},
	};
}

afterEach(() => {
	__setTelemetryPathForTests(undefined);
});

describe("Buddy concern disposition integration", () => {
	it("restores a delivered concern and persists the exact target in feedback details", async () => {
		const branch = [
			{
				type: "custom_message",
				id: "entry1",
				timestamp: "2026-07-17T01:00:00.000Z",
				customType: "buddy-review",
				content: "Concern #wd-a81f:\nThe test is missing",
				details: {
					source: "watchdog",
					trigger: "turns",
					concernId: "wd-a81f",
					headline: "The test is missing",
				},
			},
		];
		const { tools, handlers, ctx } = createHarness(branch);
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ reason: "resume" }, ctx);
		}
		const telemetryPath = join(
			mkdtempSync(join(tmpdir(), "buddy-integration-")),
			"telemetry.jsonl",
		);
		__setTelemetryPathForTests(telemetryPath);
		const feedbackTool = tools.get("give_buddy_feedback");
		const result = await feedbackTool.execute(
			"call-1",
			{
				feedback: "same",
				concernDisposition: "fixed",
				reason: "Added the missing regression test",
			},
			undefined,
			undefined,
			ctx,
		);

		assert.equal(result.details.concernId, "wd-a81f");
		assert.equal(result.details.concernDisposition, "fixed");
		assert.equal(result.details.concernHeadline, "The test is missing");
		assert.match(result.content[0].text, /Concern #wd-a81f marked fixed/);
	});

	it("rebuilds concern state from the newly active branch after tree navigation", async () => {
		const advisory = (id: string) => ({
			type: "custom_message",
			id: `entry-${id}`,
			timestamp: "2026-07-17T01:00:00.000Z",
			customType: "buddy-review",
			content: `Concern #${id}:\n${id} headline`,
			details: {
				source: "watchdog",
				trigger: "turns",
				concernId: id,
				headline: `${id} headline`,
			},
		});
		const harness = createHarness([advisory("wd-old")]);
		for (const handler of harness.handlers.get("session_start") ?? []) {
			await handler({ reason: "startup" }, harness.ctx);
		}
		harness.setBranch([advisory("wd-new")]);
		for (const handler of harness.handlers.get("session_tree") ?? []) {
			await handler({}, harness.ctx);
		}
		__setTelemetryPathForTests(
			join(mkdtempSync(join(tmpdir(), "buddy-tree-")), "telemetry.jsonl"),
		);
		const result = await harness.tools.get("give_buddy_feedback").execute(
			"call-2",
			{
				feedback: "same",
				concernDisposition: "rebutted",
				reason: "The active branch contains contrary evidence",
			},
			undefined,
			undefined,
			harness.ctx,
		);

		assert.equal(result.details.concernId, "wd-new");
		assert.equal(result.details.concernDisposition, "rebutted");
		assert.match(
			result.content[0].text,
			/marked rebutted: The active branch contains contrary evidence/,
		);
		assert.doesNotMatch(result.content[0].text, /wd-new headline/);
	});

	it("rejects incomplete disposition feedback without changing cadence", async () => {
		__setTelemetryPathForTests(
			join(mkdtempSync(join(tmpdir(), "buddy-validation-")), "telemetry.jsonl"),
		);
		const harness = createHarness([]);
		for (const handler of harness.handlers.get("session_start") ?? []) {
			await handler({ reason: "startup" }, harness.ctx);
		}
		const feedbackTool = harness.tools.get("give_buddy_feedback");
		await assert.rejects(
			feedbackTool.execute(
				"call-3",
				{ feedback: "less", concernId: "wd-missing" },
				undefined,
				undefined,
				harness.ctx,
			),
			/concernId requires concernDisposition/,
		);
		await assert.rejects(
			feedbackTool.execute(
				"call-4",
				{ feedback: "less", concernDisposition: "fixed" },
				undefined,
				undefined,
				harness.ctx,
			),
			/concrete reason is required/,
		);
		await assert.rejects(
			feedbackTool.execute(
				"call-5",
				{
					feedback: "less",
					concernDisposition: "rebutted",
					reason: "No concern exists",
				},
				undefined,
				undefined,
				harness.ctx,
			),
			/No open Buddy concern/,
		);

		const valid = await feedbackTool.execute(
			"call-6",
			{ feedback: "less", reason: "Cadence only" },
			undefined,
			undefined,
			harness.ctx,
		);
		assert.equal(valid.details.previousLevel, 0);
		assert.equal(valid.details.newLevel, -1);
	});
});
