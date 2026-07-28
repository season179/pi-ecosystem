import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { buildTelemetryRecord } from "../src/extensions/herdr.js";
import { appendTelemetry } from "../src/telemetry.js";
import type { WatchOutcome, WatchRecordPublic } from "../src/types.js";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-herdr-telemetry-"));
}

describe("buildTelemetryRecord", () => {
	it("records command mode and exit code without persisting target or command", () => {
		const watch: WatchRecordPublic = {
			id: 12,
			spec: {
				mode: "command",
				command: "deploy --token super-secret",
				timeoutMs: 60_000,
				wake: true,
			},
			startedAt: 1_000,
			status: "fired",
		};
		const outcome: WatchOutcome = {
			kind: "fired",
			exitCode: 7,
			durationMs: 500,
			stdout: "",
			stderr: "",
		};

		const record = buildTelemetryRecord(watch, outcome, {
			delivery: {
				deliverAs: "steer",
				triggerTurn: true,
				countsAsWake: true,
				reason: "wake-granted",
				wakesUsedAfter: 3,
			},
			wakeBudget: 20,
		});

		assert.equal(record.mode, "command");
		assert.equal(record.exitCode, 7);
		assert.equal(record.deliveryReason, "wake-granted");
		assert.equal(record.wakesUsed, 3);
		assert.equal(record.wakeBudget, 20);
		assert.equal("target" in record, false);
		assert.equal("command" in record, false);
		assert.doesNotMatch(JSON.stringify(record), /super-secret/u);
	});

	it("keeps agent targets without adding an exit code", () => {
		const watch: WatchRecordPublic = {
			id: 13,
			spec: {
				mode: "agent",
				target: "reviewer",
				wake: true,
			},
			startedAt: 1_000,
			status: "fired",
		};
		const outcome: WatchOutcome = {
			kind: "fired",
			exitCode: 0,
			durationMs: 500,
			stdout: "",
			stderr: "",
		};

		const record = buildTelemetryRecord(watch, outcome, {
			delivery: {
				deliverAs: "steer",
				triggerTurn: false,
				countsAsWake: false,
				reason: "budget-exhausted",
				wakesUsedAfter: 20,
			},
			wakeBudget: 20,
		});

		assert.equal(record.mode, "agent");
		assert.equal(record.target, "reviewer");
		assert.equal("exitCode" in record, false);
	});

	it("retains a delivery snapshot after mutable epoch state resets", () => {
		let epochWakesUsed = 20;
		const delivery = {
			deliverAs: "steer" as const,
			triggerTurn: false,
			countsAsWake: false,
			reason: "budget-exhausted" as const,
			wakesUsedAfter: epochWakesUsed,
		};
		epochWakesUsed = 0;

		const record = buildTelemetryRecord(
			{
				id: 14,
				spec: { mode: "agent", target: "reviewer", wake: true },
				startedAt: 1_000,
				status: "fired",
			},
			{
				kind: "fired",
				exitCode: 0,
				durationMs: 500,
				stdout: "",
				stderr: "",
			},
			{ delivery, wakeBudget: 20 },
		);

		assert.equal(epochWakesUsed, 0);
		assert.equal(record.wakesUsed, 20);
		assert.equal(record.wakeBudget, 20);
	});

	it("omits deliveryReason for stale or stopped no-decision snapshots", () => {
		const record = buildTelemetryRecord(
			{
				id: 15,
				spec: { mode: "agent", target: "reviewer", wake: true },
				startedAt: 1_000,
				status: "stopped",
			},
			{
				kind: "killed",
				exitCode: null,
				durationMs: 500,
				stdout: "",
				stderr: "",
			},
			{ wakesUsed: 7, wakeBudget: 20 },
		);

		assert.equal("deliveryReason" in record, false);
		assert.equal(record.wakesUsed, 7);
		assert.equal(record.wakeBudget, 20);
	});
});

describe("appendTelemetry", () => {
	it("appends two records as two parseable JSON lines", () => {
		const path = join(tmpDir(), "telemetry.jsonl");
		appendTelemetry(path, { event: "armed", target: "w1" });
		appendTelemetry(path, { event: "fired", target: "w1", ms: 1234 });

		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]);
		const second = JSON.parse(lines[1]);
		assert.equal(first.event, "armed");
		assert.equal(second.event, "fired");
		assert.equal(second.ms, 1234);
	});

	it("creates missing parent directories recursively", () => {
		const dir = tmpDir();
		const path = join(dir, "nested", "deep", "telemetry.jsonl");
		appendTelemetry(path, { ok: true });
		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		assert.equal(lines.length, 1);
		assert.deepEqual(JSON.parse(lines[0]), { ok: true });
	});

	it("is a no-op (and does not throw) when path is empty", () => {
		const dir = tmpDir();
		assert.doesNotThrow(() =>
			appendTelemetry("", { event: "should-not-write" }),
		);
		// nothing created under the temp dir
		assert.throws(
			() => statSync(join(dir, "telemetry.jsonl")),
			(err) => (err as NodeJS.ErrnoException).code === "ENOENT",
		);
	});

	it("does not throw when the path is unwritable (parent is a file)", () => {
		const dir = tmpDir();
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "i am a file, not a directory");
		const impossible = join(blocker, "telemetry.jsonl");
		assert.doesNotThrow(() => appendTelemetry(impossible, { event: "x" }));
	});
});
