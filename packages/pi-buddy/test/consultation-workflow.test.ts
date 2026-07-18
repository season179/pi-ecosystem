import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
	ConsultationWorkflow,
	type ConsultationInjection,
} from "../src/extensions/consultation-workflow.js";
import { MemoryStore } from "../src/extensions/memory.js";

function model(provider: string, id: string, contextWindow = 100_000) {
	return { provider, id, contextWindow } as any;
}

function context(models: Record<string, any>) {
	const statuses: Array<[string, string | undefined]> = [];
	const notices: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: "/tmp/pi-buddy-project",
		signal: undefined,
		modelRegistry: {
			find(provider: string, id: string) {
				return models[`${provider}/${id}`];
			},
		},
		sessionManager: { getBranch: () => [] },
		ui: {
			setStatus(key: string, value: string | undefined) {
				statuses.push([key, value]);
			},
			notify(message: string) {
				notices.push(message);
			},
		},
	} as any;
	return { ctx, statuses, notices };
}

const injection: ConsultationInjection = {
	block: "remember this",
	memoryChars: 13,
	openConcerns: 1,
	fixedConcerns: 2,
	rebuttedConcerns: 3,
	concernHistoryChars: 21,
};

describe("ConsultationWorkflow", () => {
	it("owns model resolution, harvesting, and telemetry for a requested Consultation", async () => {
		const memoryDir = mkdtempSync(join(tmpdir(), "buddy-workflow-memory-"));
		const memoryStore = new MemoryStore(memoryDir);
		const primary = model("zai", "glm-5.2");
		const { ctx, statuses, notices } = context({ "zai/glm-5.2": primary });
		const records: any[] = [];
		const modelStatuses: Array<[string | undefined, boolean | undefined]> = [];
		let now = 1_000;
		const workflow = new ConsultationWorkflow({
			defaultModelSpec: () => "zai/glm-5.2",
			buildInjection: () => injection,
			memoryStore,
			webTools: [],
			setModelStatus: (_ctx, spec, options) =>
				modelStatuses.push([spec, options?.failover]),
			notifyConfigWarnings: () => undefined,
			loadConfig: async () => ({
				path: "buddy.json",
				found: false,
				models: [],
				warnings: [],
			}),
			consult: async (request) => {
				assert.equal(request.model, primary);
				assert.equal(request.memoryBlock, injection.block);
				return {
					answer: "Keep the public behavior stable.\nLESSON[project]: Preserve compatibility.",
					activity: ["read README.md"],
					rounds: 2,
					transcriptTokens: 42,
				};
			},
			record: async (record) => {
				records.push(record);
			},
			now: () => {
				now += 25;
				return now;
			},
		});

		const result = await workflow.run({
			ctx,
			systemPrompt: "Be candid.",
			requestText: "Review the plan.",
			source: "tool",
			stance: "review",
			harvest: true,
		});

		assert.equal(result.answer, "Keep the public behavior stable.");
		assert.equal(result.model, "zai/glm-5.2");
		assert.deepEqual(result.modelsAttempted, ["zai/glm-5.2"]);
		assert.equal(result.failoverUsed, false);
		assert.match(
			readFileSync(memoryStore.projectPath("tmp-pi-buddy-project"), "utf8"),
			/Preserve compatibility/,
		);
		assert.ok(notices.some((notice) => notice.includes("remembered 1 lesson")));
		assert.deepEqual(modelStatuses, [
			["zai/glm-5.2", undefined],
			["zai/glm-5.2", false],
			["zai/glm-5.2", false],
		]);
		assert.equal(records.length, 1);
		assert.deepEqual(
			{
				outcome: records[0].outcome,
				model: records[0].model,
				lessons: records[0].lessons,
				memoryChars: records[0].memoryChars,
				openConcerns: records[0].openConcerns,
				totalMs: records[0].totalMs,
			},
			{
				outcome: "ok",
				model: "zai/glm-5.2",
				lessons: 1,
				memoryChars: 13,
				openConcerns: 1,
				totalMs: 25,
			},
		);
		assert.deepEqual(statuses.at(-1), ["buddy", undefined]);
	});

	it("contains retry and Model Plan failover behind the same Interface", async () => {
		const primary = model("zai", "glm-5.2");
		const fallback = model("anthropic", "claude-sonnet-4-5");
		const { ctx } = context({
			"zai/glm-5.2": primary,
			"anthropic/claude-sonnet-4-5": fallback,
		});
		const records: any[] = [];
		const attempted: string[] = [];
		const workflow = new ConsultationWorkflow({
			defaultModelSpec: () => "zai/glm-5.2",
			buildInjection: () => injection,
			memoryStore: new MemoryStore(
				mkdtempSync(join(tmpdir(), "buddy-workflow-failover-")),
			),
			webTools: [],
			setModelStatus: () => undefined,
			notifyConfigWarnings: () => undefined,
			loadConfig: async () => ({
				path: "buddy.json",
				found: true,
				models: [
					{ id: "zai/glm-5.2", priority: 1 },
					{ id: "anthropic/claude-sonnet-4-5", priority: 2 },
				],
				perModelRetries: 0,
				warnings: [],
			}),
			consult: async (request) => {
				attempted.push(`${request.model.provider}/${request.model.id}`);
				if (request.model === primary) throw new Error("HTTP 429 rate limit");
				return {
					answer: "Fallback answer",
					activity: [],
					rounds: 1,
					transcriptTokens: 10,
				};
			},
			record: async (record) => {
				records.push(record);
			},
		});

		const result = await workflow.run({
			ctx,
			systemPrompt: "Review.",
			requestText: "Check this.",
			source: "command",
			stance: "discuss",
		});

		assert.deepEqual(attempted, [
			"zai/glm-5.2",
			"anthropic/claude-sonnet-4-5",
		]);
		assert.equal(result.model, "anthropic/claude-sonnet-4-5");
		assert.equal(result.failoverUsed, true);
		assert.deepEqual(result.modelsAttempted, attempted);
		assert.equal(records[0].modelFailures[0].errorKind, "rate_limit");
		assert.equal(records[0].failoverUsed, true);
	});

	it("retries a transient failure on the same model before failover", async () => {
		const primary = model("zai", "glm-5.2");
		const { ctx } = context({ "zai/glm-5.2": primary });
		const records: any[] = [];
		const delays: number[] = [];
		let attempts = 0;
		const workflow = new ConsultationWorkflow({
			defaultModelSpec: () => "zai/glm-5.2",
			buildInjection: () => injection,
			memoryStore: new MemoryStore(
				mkdtempSync(join(tmpdir(), "buddy-workflow-retry-")),
			),
			webTools: [],
			setModelStatus: () => undefined,
			notifyConfigWarnings: () => undefined,
			loadConfig: async () => ({
				path: "buddy.json",
				found: true,
				models: [{ id: "zai/glm-5.2", priority: 1 }],
				perModelRetries: 1,
				warnings: [],
			}),
			consult: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("HTTP 429 rate limit");
				return {
					answer: "Recovered answer",
					activity: [],
					rounds: 1,
					transcriptTokens: 10,
				};
			},
			record: async (record) => {
				records.push(record);
			},
			retryDelay: () => 125,
			delay: async (delayMs) => {
				delays.push(delayMs);
			},
		});

		const result = await workflow.run({
			ctx,
			systemPrompt: "Review.",
			requestText: "Check this.",
			source: "tool",
			stance: "review",
		});

		assert.equal(result.answer, "Recovered answer");
		assert.equal(result.failoverUsed, false);
		assert.deepEqual(result.modelsAttempted, ["zai/glm-5.2"]);
		assert.deepEqual(delays, [125]);
		assert.equal(records[0].attempts, 2);
		assert.equal(records[0].retried, true);
		assert.equal(records[0].modelFailures, undefined);
	});
});
