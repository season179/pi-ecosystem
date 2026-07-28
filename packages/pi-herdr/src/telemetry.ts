/**
 * Best-effort JSONL telemetry sink for pi-herdr.
 *
 * One append per call, one JSON object per line. Parent directories are
 * created on demand. This function MUST NEVER throw or reject — telemetry
 * is observability, not a feature path, so any failure (perms, disk full,
 * a parent that is a file) is swallowed silently.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function appendTelemetry(
	path: string,
	record: Record<string, unknown>,
): void {
	if (path === "") return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch {
		// Intentionally swallowed: telemetry must never break a turn.
	}
}
