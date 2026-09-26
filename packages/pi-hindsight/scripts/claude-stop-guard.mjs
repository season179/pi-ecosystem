#!/usr/bin/env node
// Replay guard for the official Claude Code Stop hook. Installed as ONE bundled file
// (scripts/bundle-claude-guard.mjs) so it carries the same vendored 0.7.0 config/bank resolution.
// The official hook retains the WHOLE transcript on every Stop, and a resumed Claude session appends
// to its original file. Two refusals:
//  1. Pre-cutover: the transcript's earliest timestamp predates `harnesses["claude-code"].captureSince`
//     (history the legacy writer already captured).
//  2. Curated source: any fact extracted from `conversation:<session>` in the bank the official hook
//     resolves was hand-edited or invalidated (by any session or harness); re-retaining would
//     re-extract the obsolete claims. A permanently deleted fact leaves no trace and is not detected.
// Otherwise the unchanged stdin goes to the pinned official hook. Unknown start, invalid cutoff,
// unresolved destination, a failed/unbounded curation read, or a changed official hook: no capture.
// Always exits 0 on refusal, never blocking Claude's stop, and never prints transcript or memory content.
//   node claude-stop-guard.mjs --official <.../dist/claude-stop-hook.js> --sha256 <hex>
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyBankConfig, loadConfig } from '../dist/upstream/config.js';
import { deriveBankIdOrSkip } from '../dist/upstream/bank.js';
import { HindsightClient } from '../dist/upstream/client.js';

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const CONFIG = process.env.HINDSIGHT_CONFIG || join(homedir(), '.hindsight', 'coding-agent.json');
const LOG = join(homedir(), '.hindsight', 'coding-agents-logs', 'stop-guard.jsonl');
const LOG_BYTES = 2 * 1024 * 1024; // same policy as pi-hindsight telemetry: one .1 generation
const INPUT_BYTES = 1024 * 1024; // hook payload is a small JSON object
const TRANSCRIPT_BYTES = 256 * 1024 * 1024; // far above real sessions (largest seen ~11 MB)
const CURATION_MS = 10_000; // well inside the hook timeout; a slow read refuses capture
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Decide from the parsed hook input, raw config text and transcript text; pure for tests. */
export function decide(input, configText, transcriptText) {
  let cutoff;
  try { cutoff = JSON.parse(configText)?.harnesses?.['claude-code']?.captureSince; } catch { return 'config unreadable'; }
  if (typeof cutoff !== 'string' || !ISO.test(cutoff) || Number.isNaN(Date.parse(cutoff))) return 'captureSince missing or invalid';
  if (input?.hook_event_name !== 'Stop' || typeof input.session_id !== 'string' || !/^[^/\\\0]{1,256}$/.test(input.session_id)) return 'unexpected hook input';
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

/**
 * Resolve the destination exactly as the official Stop hook does (loadConfig -> recorded session
 * root -> deriveBankIdOrSkip -> applyBankConfig), read-only, then check the source's facts.
 * Returns a refusal reason, or undefined when capture may proceed.
 */
export async function curatedSource(input, options = {}) {
  let cfg, bank;
  try {
    const base = loadConfig({ harness: 'claude-code' });
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    // Official sessionRootDir, minus its write: the first Stop records cwd, later ones reuse it.
    let root = cwd;
    try { root = readFileSync(join(tmpdir(), 'hindsight-claude-code', `${input.session_id}.root`), 'utf8').trim() || cwd; } catch { /* first Stop */ }
    const id = deriveBankIdOrSkip(base, cwd, 'claude-code', root);
    if (id === null) return undefined; // the official hook skips this session itself
    ({ cfg, bankId: bank } = applyBankConfig(base, id, cwd));
  } catch { return 'destination unresolved'; }
  if (cfg.disabled || !cfg.retainSessions) return undefined; // the official hook writes nothing
  try {
    const client = new HindsightClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, bank, observationScopes: cfg.observationScopes,
      guard: () => {}, signal: AbortSignal.timeout(options.timeoutMs ?? CURATION_MS), fetch: options.fetch });
    const state = await client.documentCuration(`conversation:${input.session_id}`);
    return state.edited || state.invalidated ? 'curated source facts' : undefined;
  } catch { return 'curation check failed'; }
}

function ownerOnly(path) {
  try { if (statSync(path).mode & 0o077) chmodSync(path, 0o600); } catch { /* absent */ }
}

function note(sessionId, reason) {
  // Metadata only: session ID and fixed reason.
  try {
    mkdirSync(dirname(LOG), { recursive: true, mode: 0o700 });
    try { if (statSync(LOG).size >= LOG_BYTES) renameSync(LOG, `${LOG}.1`); } catch { /* absent */ }
    ownerOnly(LOG); ownerOnly(`${LOG}.1`);
    appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), session: sessionId, outcome: 'capture skipped', reason })}\n`, { mode: 0o600 });
  } catch { /* never affects the host */ }
}

async function main() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size <= INPUT_BYTES) chunks.push(chunk); }
  const raw = Buffer.concat(chunks);
  let input; try { input = size <= INPUT_BYTES ? JSON.parse(raw.toString('utf8')) : undefined; } catch { input = undefined; }
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
      const stat = typeof path === 'string' ? statSync(path) : undefined;
      if (stat?.isFile() && stat.size <= TRANSCRIPT_BYTES) transcript = readFileSync(path, 'utf8');
    } catch { /* unreadable */ }
    const verdict = decide(input, configText, transcript);
    reason = verdict === 'forward' ? await curatedSource(input) : verdict;
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
