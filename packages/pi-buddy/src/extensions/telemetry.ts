/**
 * Lightweight JSONL telemetry for buddy consultations, following the
 * pi-moa precedent (~/.pi/agent/moa-timings.jsonl).
 *
 * One line per consultation to ~/.pi/agent/buddy-telemetry.jsonl:
 * source (tool/command/watchdog), stance, outcome (ok/pass/concern/error),
 * rounds, tool activity count, transcript size, and wall-clock duration.
 *
 * This answers "is the buddy working well?":
 * - watchdog pass/concern ratio (too many concerns => noisy; all pass => useless)
 * - pull frequency by stance (is the agent actually consulting?)
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
export type BuddyOutcome = "ok" | "pass" | "concern" | "error";

export interface BuddyTelemetryRecord {
	v: 1;
	ts: string;
	source: BuddySource;
	/** Stance for pulls; "watchdog" for pushes. */
	stance: string;
	outcome: BuddyOutcome;
	model: string;
	totalMs: number;
	/** Tool-loop rounds the buddy used (absent on error). */
	rounds?: number;
	/** Number of read-only tool calls the buddy made. */
	toolCalls?: number;
	/** Estimated tokens of the transcript sent to the buddy. */
	transcriptTokens?: number;
	/** Length of the buddy's answer in characters. */
	answerChars?: number;
	error?: string;
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
	try {
		const path = telemetryPath();
		await mkdir(dirname(path), { recursive: true });
		const line = `${JSON.stringify({ v: 1, ts: new Date().toISOString(), ...record })}\n`;
		await appendFile(path, line);
	} catch {
		// Best-effort: never let telemetry break a consultation.
	}
}
