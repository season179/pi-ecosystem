/**
 * Milestone-3 tests: config loading (loud failure on bad files), telemetry
 * record shape + append behavior, and steering-text regression.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILENAME, ConfigError, defaultConfig, loadConfig } from "../src/config.js";
import setup from "../src/extensions/delegate.js";
import { appendTelemetry, buildRecord } from "../src/telemetry.js";
import { emptyUsage, type WorkerResult } from "../src/worker.js";

describe("loadConfig", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-delegate-config-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	const write = (content: string) => writeFileSync(join(agentDir, CONFIG_FILENAME), content);

	it("returns defaults when the file is missing", () => {
		expect(loadConfig(agentDir)).toEqual(defaultConfig(agentDir));
		expect(loadConfig(agentDir).workerModel).toBe("zai/glm-5.2");
	});

	it("merges partial overrides onto defaults", () => {
		write(JSON.stringify({ workerModel: "deepseek/deepseek-v4-pro", workerTimeoutMs: 60000 }));
		const config = loadConfig(agentDir);

		expect(config.workerModel).toBe("deepseek/deepseek-v4-pro");
		expect(config.workerTimeoutMs).toBe(60000);
		expect(config.verifyTimeoutMs).toBe(defaultConfig(agentDir).verifyTimeoutMs);
	});

	it("expands tilde in telemetryPath", () => {
		write(JSON.stringify({ telemetryPath: "~/custom/t.jsonl" }));
		expect(loadConfig(agentDir).telemetryPath).toBe(join(homedir(), "custom/t.jsonl"));
	});

	it("throws ConfigError on invalid JSON", () => {
		write("{ nope");
		expect(() => loadConfig(agentDir)).toThrow(ConfigError);
	});

	it("throws ConfigError on unknown keys (typo protection)", () => {
		write(JSON.stringify({ workerTimeout: 1000 }));
		expect(() => loadConfig(agentDir)).toThrow(/unknown key "workerTimeout"/);
	});

	it("throws ConfigError on bad types", () => {
		write(JSON.stringify({ workerModel: "" }));
		expect(() => loadConfig(agentDir)).toThrow(/workerModel/);
		write(JSON.stringify({ verifyTimeoutMs: -5 }));
		expect(() => loadConfig(agentDir)).toThrow(/verifyTimeoutMs/);
		write(JSON.stringify(["array"]));
		expect(() => loadConfig(agentDir)).toThrow(/JSON object/);
	});
});

function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
	return {
		messages: [],
		usage: { ...emptyUsage(), turns: 3, input: 500, output: 100, cost: 0.002 },
		exitCode: 0,
		timedOut: false,
		aborted: false,
		stderr: "",
		durationMs: 12345,
		model: "glm-5.2",
		stopReason: "stop",
		...overrides,
	};
}

describe("telemetry", () => {
	it("builds a full record from a delegation", () => {
		const record = buildRecord({
			call: 2,
			model: "zai/glm-5.2",
			status: "success",
			brief: { task: "do it", context: "ctx", files: ["a.ts", "b.ts"], verify: "npm test" },
			worker: makeWorkerResult(),
			checkpoint: { sha: "abc123", committed: true },
			changes: { diffstat: " a.ts | 2 +-\n 1 file changed, 1 insertion(+)", untracked: ["new.txt"] },
			verify: { code: 0, output: "ok", timedOut: false },
		});

		expect(record).toMatchObject({
			call: 2,
			model: "zai/glm-5.2",
			status: "success",
			taskChars: 5,
			contextChars: 3,
			filesInScope: 2,
			verifyCommand: "npm test",
			workerTurns: 3,
			workerCostUsd: 0.002,
			workerDurationMs: 12345,
			verifyExit: 0,
			verifyTimedOut: false,
			changed: "1 file changed, 1 insertion(+)",
			untrackedCount: 1,
			checkpoint: "abc123",
			checkpointCommitted: true,
		});
		expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("uses nulls when verify was skipped and nothing changed", () => {
		const record = buildRecord({
			call: 1,
			model: "zai/glm-5.2",
			status: "worker_error",
			brief: { task: "t", context: "c", verify: "v" },
			worker: makeWorkerResult({ exitCode: 1 }),
			checkpoint: { sha: "abc", committed: false },
			changes: null,
			verify: null,
		});

		expect(record.verifyExit).toBeNull();
		expect(record.verifyTimedOut).toBeNull();
		expect(record.changed).toBeNull();
		expect(record.untrackedCount).toBe(0);
	});

	it("appends JSONL records, creating parent dirs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-delegate-telemetry-"));
		try {
			const file = join(dir, "nested", "t.jsonl");
			const record = buildRecord({
				call: 1,
				model: "m",
				status: "success",
				brief: { task: "t", context: "c", verify: "v" },
				worker: makeWorkerResult(),
				checkpoint: { sha: "abc", committed: false },
				changes: { diffstat: "", untracked: [] },
				verify: { code: 0, output: "", timedOut: false },
			});

			expect(await appendTelemetry(file, record)).toBe(true);
			expect(await appendTelemetry(file, record)).toBe(true);

			const lines = readFileSync(file, "utf-8").trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0]).status).toBe("success");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns false instead of throwing when the write fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-delegate-telemetry-"));
		try {
			// The telemetry "file" is a directory — appendFile must fail.
			const record = buildRecord({
				call: 1,
				model: "m",
				status: "success",
				brief: { task: "t", context: "c", verify: "v" },
				worker: makeWorkerResult(),
				checkpoint: { sha: "abc", committed: false },
				changes: null,
				verify: null,
			});
			expect(await appendTelemetry(dir, record)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("steering (DELEGATE.md §6 regression)", () => {
	it("tool description and guidelines carry the steering rules", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-delegate-steer-"));
		mkdirSync(agentDir, { recursive: true });
		const prevEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			let tool: any;
			setup({ registerTool: (definition: unknown) => (tool = definition), exec: async () => ({}) } as any);

			expect(tool.name).toBe("delegate");
			expect(tool.description).toContain("Good for:");
			expect(tool.description).toContain("Bad for:");
			expect(tool.description).toContain("not understood yet");
			const guidelines = tool.promptGuidelines.join(" ");
			expect(guidelines).toContain("context");
			expect(guidelines).toContain("at most twice");
			expect(guidelines).toContain("sharpening the brief");
			expect(guidelines).toContain("spot-check");
		} finally {
			if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevEnv;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
