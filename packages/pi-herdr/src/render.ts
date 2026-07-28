/**
 * Pure rendering helpers for pi-herdr: wake cards, /watches rows and the
 * footer status chip. No pi imports, no side effects. Terminal-friendly:
 * short lines (~72 chars), no ANSI colors (pi themes the message box).
 */

import type { WatchOutcome, WatchRecordPublic } from "./types.js";

const MAX_TAIL_LINES = 20;
const MAX_NOTE_CHARS = 40;
const MAX_MATCH_CHARS = 60;

/** Compact duration: `41s`, `3m41s`, `1h02m`. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Read a string from loosely-shaped CLI JSON, trying several paths. */
function digString(value: unknown, paths: string[][]): string | undefined {
	for (const path of paths) {
		let current: unknown = value;
		for (const key of path) {
			if (typeof current !== "object" || current === null) {
				current = undefined;
				break;
			}
			current = (current as Record<string, unknown>)[key];
		}
		if (typeof current === "string" && current.length > 0) return current;
	}
	return undefined;
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function lastNonEmptyLine(text: string): string | undefined {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim().length > 0) return lines[i].trim();
	}
	return undefined;
}

function conditionSummary(record: WatchRecordPublic): string {
	const { spec } = record;
	if (spec.mode === "agent") {
		const until =
			spec.until && spec.until.length > 0 ? spec.until.join("|") : "idle|done|blocked";
		return `agent ${spec.target} (until ${until})`;
	}
	if (spec.regex !== undefined) return `output ${spec.target} (regex /${spec.regex}/)`;
	return `output ${spec.target} (match "${spec.match ?? ""}")`;
}

/**
 * Multi-line wake card for a watch outcome. Line 1 adapts to
 * outcome.kind; the note and tail sections are omitted when absent.
 */
export function formatWatchCard(
	record: WatchRecordPublic,
	outcome: WatchOutcome,
	tail?: string,
): string {
	const header = `watch #${record.id} "${record.spec.target}"`;
	const duration = formatDuration(outcome.durationMs);
	const lines: string[] = [];
	switch (outcome.kind) {
		case "fired":
			if (record.spec.mode === "agent") {
				const state = digString(outcome.json, [
					["result", "agent", "agent_status"],
					["agent_status"],
				]);
				lines.push(
					state
						? `${header} fired: agent settled (${state}) after ${duration}`
						: `${header} fired: agent settled after ${duration}`,
				);
			} else {
				lines.push(`${header} fired: output matched after ${duration}`);
				const matched =
					digString(outcome.json, [
						["result", "text"],
						["result", "matched"],
						["text"],
					]) ?? lastNonEmptyLine(outcome.stdout);
				if (matched) lines.push(`match: ${truncate(firstLine(matched), MAX_MATCH_CHARS)}`);
			}
			break;
		case "timeout":
			lines.push(`${header} timed out after ${duration}`);
			break;
		case "error": {
			lines.push(`${header} failed (exit ${outcome.exitCode ?? "?"}) after ${duration}`);
			const stderrLines = outcome.stderr
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.slice(0, 2);
			for (const line of stderrLines) lines.push(`  ${line}`);
			break;
		}
		case "killed":
			lines.push(`${header} stopped after ${duration}`);
			break;
	}
	if (record.spec.note) lines.push(`note: ${record.spec.note}`);
	if (tail) {
		const tailLines = tail.replace(/\n+$/, "").split("\n").slice(-MAX_TAIL_LINES);
		lines.push("last lines:");
		for (const line of tailLines) lines.push(`  ${line}`);
	}
	return lines.join("\n");
}

/** One compact row for `/watches` lists and the `herdr_watches` tool. */
export function formatWatchLine(record: WatchRecordPublic, nowMs: number): string {
	const elapsed =
		record.status === "armed" ? formatDuration(nowMs - record.startedAt) : "-";
	let line = `#${record.id} ${record.status}  ${conditionSummary(record)}  ${elapsed}`;
	if (record.spec.note) line += `  — ${truncate(record.spec.note, MAX_NOTE_CHARS)}`;
	return line;
}

/** Footer chip text, or undefined when nothing is armed. */
export function formatStatusChip(armedCount: number): string | undefined {
	if (armedCount <= 0) return undefined;
	return `herdr: ${armedCount} ${armedCount === 1 ? "watch" : "watches"}`;
}
