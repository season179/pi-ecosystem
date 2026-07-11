/**
 * The result contract: what flows back to the orchestrator. Deliberately
 * compact — summary + diffstat + verify tail, never the full diff — because
 * the orchestrator re-reading everything would claw back the savings.
 */

import type { WorkChanges } from "./git.js";
import { getFinalOutput, type WorkerResult } from "./worker.js";

export type DelegateStatus = "success" | "verify_failed" | "worker_error" | "timeout";

export const SUMMARY_CAP_CHARS = 2000;
export const VERIFY_TAIL_LINES = 50;
export const VERIFY_TAIL_CAP_CHARS = 4000;

export interface VerifyOutcome {
	code: number;
	output: string;
	timedOut: boolean;
}

export function capText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

export function tailLines(text: string, maxLines: number): string {
	const lines = text.trimEnd().split("\n");
	if (lines.length <= maxLines) return text.trimEnd();
	return `[... ${lines.length - maxLines} earlier lines omitted]\n${lines.slice(-maxLines).join("\n")}`;
}

export function workerFailed(worker: WorkerResult): boolean {
	// M1 smoke finding: normal completion reports stopReason "stop", so
	// failure detection keys on exit code and explicit error states only.
	return (
		worker.exitCode !== 0 ||
		worker.aborted ||
		worker.stopReason === "error" ||
		worker.stopReason === "aborted"
	);
}

export function deriveStatus(worker: WorkerResult, verify: VerifyOutcome | null): DelegateStatus {
	if (worker.timedOut) return "timeout";
	if (workerFailed(worker)) return "worker_error";
	if (!verify || verify.code !== 0 || verify.timedOut) return "verify_failed";
	return "success";
}

export interface DelegateReport {
	status: DelegateStatus;
	checkpoint: { sha: string; committed: boolean };
	worker: WorkerResult;
	changes: WorkChanges | null;
	/** Null when the worker failed and verify was skipped. */
	verify: VerifyOutcome | null;
}

export function formatReport(report: DelegateReport): string {
	const { status, checkpoint, worker, changes, verify } = report;
	const lines: string[] = [];

	lines.push(`status: ${status}`);
	lines.push(
		`checkpoint: ${checkpoint.sha.slice(0, 12)}${checkpoint.committed ? " (dirty tree was auto-committed; this commit is the reset point)" : ""}`,
	);
	lines.push(`reject with: git reset --hard ${checkpoint.sha.slice(0, 12)} (new untracked files must be deleted separately)`);

	const seconds = (worker.durationMs / 1000).toFixed(1);
	lines.push(
		`worker: ${worker.model ?? "unknown"} — ${worker.usage.turns} turns, ${seconds}s, $${worker.usage.cost.toFixed(4)}`,
	);

	if (status === "timeout") {
		lines.push("worker hit its wall-clock timeout and was killed; the tree may contain partial changes.");
	}
	if (status === "worker_error") {
		if (worker.aborted) {
			lines.push("worker aborted by the user; partial changes remain in the tree.");
		} else {
			const reason = worker.errorMessage || worker.stderr.trim() || `exit code ${worker.exitCode}`;
			lines.push(`worker error: ${capText(reason, 500)}`);
		}
	}

	lines.push("", "diffstat vs checkpoint:");
	lines.push(changes && changes.diffstat ? changes.diffstat : " (no tracked changes)");
	if (changes && changes.untracked.length > 0) {
		lines.push("new untracked files:");
		for (const file of changes.untracked) lines.push(` ${file}`);
	}

	if (verify) {
		const verdict = verify.timedOut ? "TIMED OUT" : `exit ${verify.code}`;
		lines.push("", `verify (${verdict}):`);
		lines.push(capText(tailLines(verify.output, VERIFY_TAIL_LINES), VERIFY_TAIL_CAP_CHARS) || " (no output)");
	} else if (status === "timeout") {
		const hasWork = !!(changes && (changes.diffstat || changes.untracked.length > 0));
		lines.push(
			"",
			hasWork
				? "verify: skipped (worker killed at timeout) — partial work exists; run the verify command yourself to assess salvage, or reset to the checkpoint"
				: "verify: skipped (worker killed at timeout; no changes were made)",
		);
	} else if (worker.aborted) {
		lines.push("", "verify: skipped (delegation aborted by the user)");
	} else {
		lines.push("", "verify: skipped (worker did not finish cleanly)");
	}

	const summary = getFinalOutput(worker.messages);
	lines.push("", "worker summary:");
	lines.push(summary ? capText(summary, SUMMARY_CAP_CHARS) : " (none)");

	return lines.join("\n");
}
