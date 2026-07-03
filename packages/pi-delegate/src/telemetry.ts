/**
 * One JSONL record per delegation (same pattern as pi-moa's telemetryPath).
 * The point is judging the economics after a week of dogfooding: success
 * rate, takeover rate, verify-failure rate, worker spend vs orchestrator
 * tokens saved. Telemetry failures never break the tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DelegateBrief } from "./brief.js";
import type { Checkpoint, WorkChanges } from "./git.js";
import type { DelegateStatus, VerifyOutcome } from "./result.js";
import type { WorkerResult } from "./worker.js";

export interface TelemetryRecord {
	ts: string;
	/** 1-based delegate-call counter within this pi session. */
	call: number;
	model: string;
	status: DelegateStatus;
	aborted: boolean;
	taskChars: number;
	contextChars: number;
	filesInScope: number;
	verifyCommand: string;
	workerTurns: number;
	workerInput: number;
	workerOutput: number;
	workerCacheRead: number;
	workerCacheWrite: number;
	workerCostUsd: number;
	workerDurationMs: number;
	verifyExit: number | null;
	verifyTimedOut: boolean | null;
	/** Last diffstat line, e.g. " 2 files changed, 10 insertions(+)". */
	changed: string | null;
	untrackedCount: number;
	checkpoint: string;
	checkpointCommitted: boolean;
}

export function buildRecord(args: {
	call: number;
	model: string;
	status: DelegateStatus;
	brief: DelegateBrief;
	worker: WorkerResult;
	checkpoint: Checkpoint;
	changes: WorkChanges | null;
	verify: VerifyOutcome | null;
}): TelemetryRecord {
	const { call, model, status, brief, worker, checkpoint, changes, verify } = args;
	const diffstatLines = (changes?.diffstat ?? "").trimEnd().split("\n").filter(Boolean);

	return {
		ts: new Date().toISOString(),
		call,
		model,
		status,
		aborted: worker.aborted,
		taskChars: brief.task.length,
		contextChars: brief.context.length,
		filesInScope: brief.files?.length ?? 0,
		verifyCommand: brief.verify,
		workerTurns: worker.usage.turns,
		workerInput: worker.usage.input,
		workerOutput: worker.usage.output,
		workerCacheRead: worker.usage.cacheRead,
		workerCacheWrite: worker.usage.cacheWrite,
		workerCostUsd: worker.usage.cost,
		workerDurationMs: worker.durationMs,
		verifyExit: verify ? verify.code : null,
		verifyTimedOut: verify ? verify.timedOut : null,
		changed: diffstatLines.length > 0 ? diffstatLines[diffstatLines.length - 1].trim() : null,
		untrackedCount: changes?.untracked.length ?? 0,
		checkpoint: checkpoint.sha,
		checkpointCommitted: checkpoint.committed,
	};
}

/** Append one record; returns false (never throws) when the write fails. */
export async function appendTelemetry(filePath: string, record: TelemetryRecord): Promise<boolean> {
	try {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}
