/**
 * Lightweight JSONL telemetry for buddy consultations, following the
 * pi-moa precedent (~/.pi/agent/moa-timings.jsonl).
 *
 * One line per consultation to ~/.pi/agent/buddy-telemetry.jsonl:
 * source (tool/command/watchdog), stance, outcome (ok/pass/concern/error),
 * rounds, tool activity count, transcript size, provider-reported token usage,
 * retry attempts, and wall-clock duration.
 *
 * This answers "is the buddy working well?":
 * - watchdog pass/concern ratio (too many concerns => noisy; all pass => useless)
 * - consult frequency by stance (is the agent actually consulting?)
 * - rounds/activity (is the buddy verifying with tools, or armchair-guessing?)
 * - durations (is the buddy slowing turns down?)
 * - errors (auth/model failures that PASS-suppression would otherwise hide)
 *
 * Best-effort: telemetry failures never break a consultation.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type BuddySource = "tool" | "command" | "watchdog";
export type BuddyOutcome = "ok" | "pass" | "concern" | "error" | "discarded";
/** Which automatic path launched a watchdog consultation. */
export type BuddyTrigger = "turns" | "run_end";
export type BuddyFeedback = "more" | "same" | "less";

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
	/** Lessons harvested into memory (phase 3). */
	lessons?: number;
	/** Retractions applied to memory (phase 3). */
	retractions?: number;
	/** RETRACT directives that matched no entry (buddy hallucinating memory). */
	retractMisses?: number;
	/** Size of the injected memory block in characters. */
	memoryChars?: number;
	/** Number of provider consultation attempts (foreground retries included). */
	attempts?: number;
	/** True when a transient provider error was retried. */
	retried?: boolean;
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

async function appendTelemetry(
	record: Omit<BuddyTelemetryRecord, "v" | "ts"> |
		Omit<BuddyFeedbackTelemetryRecord, "v" | "ts">,
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
