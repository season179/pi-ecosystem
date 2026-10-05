import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Sensitive local diagnostics. Conversation-derived content is intentional; transport
// credentials, headers, URLs and raw service error bodies must never be passed here.
export const TELEMETRY_FILE = 'hindsight-telemetry.jsonl';
export const TELEMETRY_BYTES = 500_000_000; // active + one archive = 1 GB total
export type Row = Record<string, unknown>;

/** Fixed categories only: never serialize arbitrary transport/SDK errors. */
export function diagnosticError(error: unknown): Row {
  const message = error instanceof Error ? error.message : '';
  const status = /^Hindsight HTTP (\d{3});/.exec(message)?.[1];
  return {
    reason: status
      ? 'http_error'
      : /cancelled|deadline|timeout/i.test(message)
        ? 'timeout_or_cancelled'
        : /^Hindsight invalid/.test(message)
          ? 'invalid_response'
          : /response exceeds safety limit/.test(message)
            ? 'response_limit'
            : /assessment state limit/.test(message)
              ? 'assessment_state_limit'
              : /assessment response limit/.test(message)
                ? 'assessment_response_limit'
                : 'request_failed',
    ...(status ? { httpStatus: Number(status) } : {}),
  };
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
function ownerOnly(path: string): void {
  try {
    if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
}
const size = (path: string) => {
  try {
    return statSync(path).size;
  } catch (error) {
    if (code(error) === 'ENOENT') return 0;
    throw error;
  }
};
let dropped = 0;

/** Unlinking a unique marker succeeds for one caller only; rmdir then cannot remove a newer, nonempty lock. */
function retire(dir: string, marker: string): boolean {
  try {
    unlinkSync(join(dir, marker));
  } catch {
    return false;
  }
  try {
    rmdirSync(dir);
  } catch {
    /* already replaced by a newer lock, or emptied for the next writer */
  }
  return true;
}

/** A dead owner is recoverable; unknown, live or EPERM owners are not. A reused PID stays busy until it exits. */
function alive(marker: string): boolean {
  const pid = Number(/^(\d+)-/.exec(marker)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) !== 'ESRCH';
  }
}

/**
 * Nonblocking cross-process lock with no age-based stealing: a directory holding one `<pid>-<uuid>`
 * owner marker, published by atomic rename (which fails while a nonempty lock exists), so a held lock
 * always names its owner, and an empty lock abandoned mid-release is simply replaced. Returns the
 * marker, or undefined when busy.
 */
function lock(path: string): string | undefined {
  const marker = `${process.pid}-${randomUUID()}`,
    staged = `${path}.${marker}`;
  mkdirSync(staged, { mode: 0o700 });
  try {
    writeFileSync(join(staged, marker), '', { mode: 0o600 });
  } catch (error) {
    rmdirSync(staged);
    throw error;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(staged, path);
      return marker;
    } catch (error) {
      if (code(error) !== 'ENOTEMPTY' && code(error) !== 'EEXIST') break;
    }
    let owners: string[];
    try {
      owners = readdirSync(path);
    } catch (error) {
      if (code(error) === 'ENOENT') continue; // released meanwhile
      break;
    }
    if (owners.length !== 1 || alive(owners[0]) || !retire(path, owners[0])) break;
  }
  retire(staged, marker);
  return;
}

/** Best effort. Busy writers drop rows, never block the agent; the next row reports the count. */
export function record(agentDir: string, row: Row): void {
  const path = join(agentDir, TELEMETRY_FILE),
    archive = `${path}.1`,
    lockPath = `${path}.lock`;
  let owner: string | undefined;
  try {
    owner = lock(lockPath);
    if (!owner) {
      dropped++;
      return;
    }
    const line = `${JSON.stringify({ ...row, schema: 2, ts: new Date().toISOString(), ...(dropped ? { droppedRows: dropped } : {}) })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > TELEMETRY_BYTES) {
      dropped++;
      return;
    }
    ownerOnly(path);
    ownerOnly(archive);
    // Also repair oversized files left by older/manual writers without loading them.
    if (size(archive) > TELEMETRY_BYTES) unlinkSync(archive);
    if (size(path) > TELEMETRY_BYTES) unlinkSync(path);
    if (size(path) + bytes > TELEMETRY_BYTES) renameSync(path, archive);
    appendFileSync(path, line, { mode: 0o600 });
    dropped = 0;
  } catch {
    dropped++;
  } finally {
    if (owner) retire(lockPath, owner);
  }
}
