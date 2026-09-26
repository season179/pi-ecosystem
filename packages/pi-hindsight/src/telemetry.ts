import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Local, best-effort, metadata-only usage log (Buddy's JSONL pattern). Callers pass only
// fixed outcome strings, counts, IDs and timings: never prompts, answers, memory or credentials.
export const TELEMETRY_FILE = 'hindsight-telemetry.jsonl';
export const TELEMETRY_BYTES = 2 * 1024 * 1024;
export type Row = Record<string, string | number | boolean | undefined>;

export function record(agentDir: string, row: Row): void {
  const path = join(agentDir, TELEMETRY_FILE);
  try {
    // One previous generation: total on disk stays under twice the limit.
    try { if (statSync(path).size >= TELEMETRY_BYTES) renameSync(path, `${path}.1`); } catch { /* absent */ }
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, { mode: 0o600 });
  } catch { /* telemetry never affects memory operations */ }
}
