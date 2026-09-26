#!/usr/bin/env node
// Pre-cutover replay guard for the official Claude Code Stop hook. Dependency-free; installed as a copy.
// The official hook retains the WHOLE transcript on every Stop, and a resumed Claude session appends
// to its original file, so resuming a pre-cutover session would upload history the legacy writer
// already captured. This wrapper forwards the unchanged stdin to the pinned official hook only when
// the transcript's earliest timestamp is at/after `harnesses["claude-code"].captureSince` in the
// official config. Unknown start, invalid cutoff, or a changed official hook: no capture.
// Always exits 0 on refusal, never blocking Claude's stop, and never prints transcript content.
//   node claude-stop-guard.mjs --official <.../dist/claude-stop-hook.js> --sha256 <hex>
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const CONFIG = process.env.HINDSIGHT_CONFIG || join(homedir(), '.hindsight', 'coding-agent.json');
const LOG = join(homedir(), '.hindsight', 'coding-agents-logs', 'stop-guard.jsonl');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Decide from the parsed hook input, raw config text and transcript text; pure for tests. */
export function decide(input, configText, transcriptText) {
  let cutoff;
  try { cutoff = JSON.parse(configText)?.harnesses?.['claude-code']?.captureSince; } catch { return 'config unreadable'; }
  if (typeof cutoff !== 'string' || !ISO.test(cutoff) || Number.isNaN(Date.parse(cutoff))) return 'captureSince missing or invalid';
  if (input?.hook_event_name !== 'Stop' || typeof input.session_id !== 'string') return 'unexpected hook input';
  if (typeof transcriptText !== 'string') return 'transcript unreadable';
  let earliest = Infinity;
  for (const line of transcriptText.split('\n')) {
    if (!line.trim()) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    // Any entry carrying another session's ID means copied/forked history of unknown age.
    if (typeof entry?.sessionId === 'string' && entry.sessionId !== input.session_id) return 'foreign session entries';
    const t = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(t) && t < earliest) earliest = t;
  }
  if (earliest === Infinity) return 'session start unknown';
  return earliest < Date.parse(cutoff) ? 'pre-cutover session' : 'forward';
}

function note(sessionId, reason) {
  // Metadata only: session ID and fixed reason.
  try {
    mkdirSync(dirname(LOG), { recursive: true, mode: 0o700 });
    appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), session: sessionId, outcome: 'capture skipped', reason })}\n`, { mode: 0o600 });
  } catch { /* never affects the host */ }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  let input; try { input = JSON.parse(raw.toString('utf8')); } catch { input = undefined; }
  const official = option('official'), pin = option('sha256');
  let reason;
  try {
    if (!official || !/^[0-9a-f]{64}$/.test(pin ?? '')) reason = 'guard not pinned';
    else if (createHash('sha256').update(readFileSync(official)).digest('hex') !== pin) reason = 'official hook changed; re-review and re-pin';
  } catch { reason = 'official hook unreadable'; }
  if (!reason) {
    let configText, transcript;
    try { configText = readFileSync(CONFIG, 'utf8'); } catch { configText = ''; }
    try {
      const path = input?.transcript_path;
      if (typeof path === 'string' && statSync(path).isFile()) transcript = readFileSync(path, 'utf8');
    } catch { /* unreadable */ }
    const verdict = decide(input, configText, transcript);
    if (verdict !== 'forward') reason = verdict;
  }
  if (reason) { note(typeof input?.session_id === 'string' ? input.session_id : null, reason); return 0; }
  // Unchanged bytes on stdin, same env/cwd, host-visible stdout/stderr and exit status.
  const child = spawn(process.execPath, [official], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(raw);
  return await new Promise(resolve => {
    child.on('error', () => resolve(0));
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 0));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
