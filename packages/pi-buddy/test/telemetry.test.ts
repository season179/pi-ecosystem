import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import {
	__setTelemetryPathForTests,
	BUDDY_POLICY_REVISION,
	recordBuddyRun,
	recordWatchdogCandidate,
	recordWatchdogInserted,
} from "../src/extensions/telemetry.js";

it("writes narrow correlated lifecycle records and tolerates unavailable storage", async () => {
	const dir = await mkdtemp(join(tmpdir(), "buddy-lifecycle-telemetry-"));
	const path = join(dir, "events.jsonl");
	const context = {
		sessionId: "session-a", runId: "run-a", policyRevision: BUDDY_POLICY_REVISION,
		initialCadence: 3, effectiveCadence: 6,
	};
	const candidate = {
		...context, trigger: "run_end" as const, concernId: "candidate-a", ageMs: 125,
		originRunId: "origin-run", windowRunId: "run-a",
	};
	try {
		__setTelemetryPathForTests(path);
		await recordWatchdogCandidate({ ...candidate, event: "held" });
		await recordWatchdogCandidate({ ...candidate, event: "expired", reason: "window_closed" });
		await recordWatchdogInserted({
			...context, trigger: "turns", concernId: "candidate-b",
			originRunId: "origin-run", deliveryRunId: "run-a", handedOffAt: "2026-09-16T07:00:00.000Z",
		});
		await recordBuddyRun({
			...context, turns: 4, startedAt: "2026-09-16T07:00:00.000Z",
			endedAt: "2026-09-16T07:01:00.000Z", outcome: "ended", finalCadence: 12,
		});
		const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(rows.map((row) => row.type), ["watchdog_candidate", "watchdog_candidate", "watchdog_inserted", "buddy_run"]);
		for (const row of rows) {
			assert.equal(row.v, 1);
			assert.ok(Number.isFinite(Date.parse(row.ts)));
			for (const [key, value] of Object.entries(context)) assert.equal(row[key], value);
			assert.equal(row.headline, undefined);
			assert.equal(row.transcript, undefined);
		}
		assert.equal(rows[0].event, "held");
		assert.equal(rows[0].commitRevision, undefined);
		assert.equal(rows[0].reason, undefined);
		assert.equal(rows[1].reason, "window_closed");
		assert.equal(rows[1].originRunId, "origin-run");
		assert.equal(rows[1].windowRunId, "run-a");
		assert.equal(rows[2].deliveryRunId, "run-a");
		assert.equal(rows[2].handedOffAt, "2026-09-16T07:00:00.000Z");
		assert.equal(rows[3].turns, 4);
		assert.equal(rows[3].finalCadence, 12);
		assert.equal(rows[3].effectiveCadence, 6);

		// Existing regular file cannot be used as a parent directory; no private path.
		__setTelemetryPathForTests(join(path, "unwritable.jsonl"));
		await recordWatchdogCandidate({ ...candidate, event: "held" });
		await recordWatchdogInserted({ ...context, trigger: "turns", concernId: "candidate-b" });
		await recordBuddyRun({ ...context, turns: 0, startedAt: "2026-09-16T07:00:00.000Z", endedAt: "2026-09-16T07:00:00.000Z", outcome: "incomplete", finalCadence: 6 });
	} finally {
		__setTelemetryPathForTests(undefined);
		await rm(dir, { recursive: true, force: true });
	}
});
