/**
 * Lightweight JSONL telemetry for buddy consultations, following the
 * pi-moa precedent (~/.pi/agent/moa-timings.jsonl).
 *
 * One line per consultation to ~/.pi/agent/buddy-telemetry.jsonl:
 * source (tool/command/watchdog), stance, outcome (ok/pass/concern/resolved/error),
 * rounds, tool activity count, transcript size, provider-reported token usage,
 * retry attempts, and wall-clock duration.
 *
 * This answers "is the buddy working well?":
 * - watchdog pass/concern/resolved ratio and review-to-commit revisions
 * - consult frequency by stance (is the agent actually consulting?)
 * - rounds/activity (is the buddy verifying with tools, or armchair-guessing?)
 * - durations (is the buddy slowing turns down?)
 * - errors (auth/model failures that pass suppression would otherwise hide)
 *
 * Best-effort: telemetry failures never break a consultation.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	BuddyOutcome,
	BuddySource,
	BuddyTrigger,
} from "./buddy-context.js";
import type { ConcernDisposition } from "./concern-history.js";

export type { BuddyOutcome, BuddySource, BuddyTrigger } from "./buddy-context.js";
export type BuddyFeedback = "more" | "same" | "less";

export interface BuddyModelFailureTelemetry {
	model: string;
	label?: string;
	errorKind: string;
	retried?: boolean;
	attempts?: number;
	error?: string;
}

export interface BuddyTelemetryRecord {
	v: 1;
	ts: string;
	source: BuddySource;
	/** Stance for pulls; "watchdog" for pushes. */
	stance: string;
	outcome: BuddyOutcome;
	model: string;
	totalMs: number;
	/** For watchdog records: which automatic path launched it. */
	trigger?: BuddyTrigger;
	/** Turns the agent completed between launch and verdict (staleness). */
	turnsElapsed?: number;
	/** Initial detached review or current-state commit check. */
	reviewPhase?: "review" | "revalidation";
	/** Activity revision tied to the private candidate. */
	reviewRevision?: number;
	/** Activity revision supplied to this revalidation attempt. */
	revalidationRevision?: number;
	/** Number of current-state checks performed before publication/suppression. */
	revalidationCount?: number;
	/** Tool-loop rounds the buddy used (absent on error). */
	rounds?: number;
	/** Number of read-only tool calls the buddy made. */
	toolCalls?: number;
	/** Estimated tokens of the transcript sent to the buddy. */
	transcriptTokens?: number;
	/** Provider-reported uncached input tokens, summed across model calls. */
	inputTokens?: number;
	/** Provider-reported output tokens, summed across model calls. */
	outputTokens?: number;
	/** Provider-reported cache-read input tokens, summed across model calls. */
	cacheReadTokens?: number;
	/** Provider-reported cache-write input tokens, summed across model calls. */
	cacheWriteTokens?: number;
	/** Provider-reported reasoning tokens, if the provider exposes them. */
	reasoningTokens?: number;
	/** Provider-reported total tokens, summed across model calls. */
	totalTokens?: number;
	/** Provider-reported dollar cost, when pi-ai has pricing metadata. */
	costUsd?: number;
	/** Provider-reported input tokens for the final model call only. */
	finalRoundInputTokens?: number;
	/** Provider-reported total tokens for the final model call only. */
	finalRoundTotalTokens?: number;
	/** Length of the buddy's answer in characters. */
	answerChars?: number;
	/** True when the answer hit the output-token cap (stopReason "length"). */
	truncated?: boolean;
	/** Lessons harvested into memory (phase 3). */
	lessons?: number;
	/** Retractions applied to memory (phase 3). */
	retractions?: number;
	/** RETRACT directives that matched no entry (buddy hallucinating memory). */
	retractMisses?: number;
	/** Size of the injected memory block in characters. */
	memoryChars?: number;
	/** Delivered concern created by this watchdog consultation. */
	concernId?: string;
	/** Session concern history included in this consultation. */
	openConcerns?: number;
	fixedConcerns?: number;
	rebuttedConcerns?: number;
	concernHistoryChars?: number;
	/** Number of provider consultation attempts (foreground retries included). */
	attempts?: number;
	/** True when a transient provider error was retried. */
	retried?: boolean;
	/** Ordered model candidates attempted during this consultation. */
	modelsAttempted?: string[];
	/** True when the successful response came from a non-primary candidate. */
	failoverUsed?: boolean;
	/** Compact failure summaries for failed/skipped model candidates. */
	modelFailures?: BuddyModelFailureTelemetry[];
	error?: string;
}

export interface BuddyFeedbackTelemetryRecord {
	v: 1;
	ts: string;
	type: "feedback";
	feedback: BuddyFeedback;
	reason?: string;
	previousLevel: number;
	newLevel: number;
	watchdogThreshold: number;
	/** Delivered watchdog concern updated by this feedback event. */
	concernId?: string;
	concernDisposition?: ConcernDisposition;
}

export interface BuddyWatchdogCommitTelemetryRecord {
	v: 1;
	ts: string;
	type: "watchdog_commit";
	trigger: BuddyTrigger;
	concernId: string;
	outcome: "delivered" | "resolved" | "deferred";
	reason?: "activity" | "error";
	reviewRevision: number;
	commitRevision: number;
	revalidationCount: number;
}

const TELEMETRY_FILE = join(homedir(), ".pi", "agent", "buddy-telemetry.jsonl");

let testTelemetryPath: string | undefined;

export function __setTelemetryPathForTests(path: string | undefined): void {
	testTelemetryPath = path;
}

export function telemetryPath(): string {
	return testTelemetryPath ?? TELEMETRY_FILE;
}

export async function recordConsultation(
	record: Omit<BuddyTelemetryRecord, "v" | "ts">,
): Promise<void> {
	await appendTelemetry(record);
}

export async function recordFeedback(
	record: Omit<BuddyFeedbackTelemetryRecord, "v" | "ts" | "type">,
): Promise<void> {
	await appendTelemetry({ type: "feedback", ...record });
}

export async function recordWatchdogCommit(
	record: Omit<BuddyWatchdogCommitTelemetryRecord, "v" | "ts" | "type">,
): Promise<void> {
	await appendTelemetry({ type: "watchdog_commit", ...record });
}

async function appendTelemetry(
	record: Omit<BuddyTelemetryRecord, "v" | "ts"> |
		Omit<BuddyFeedbackTelemetryRecord, "v" | "ts"> |
		Omit<BuddyWatchdogCommitTelemetryRecord, "v" | "ts">,
): Promise<void> {
	try {
		const path = telemetryPath();
		await mkdir(dirname(path), { recursive: true });
		const line = `${JSON.stringify({ v: 1, ts: new Date().toISOString(), ...record })}\n`;
		await appendFile(path, line);
	} catch {
		// Best-effort: never let telemetry break a consultation.
	}
}
