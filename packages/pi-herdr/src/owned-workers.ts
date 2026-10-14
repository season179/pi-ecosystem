/**
 * Session-owned worker ledger for pi-herdr.
 *
 * Herdr is the source of truth for live state; the ledger records only which
 * workers this conversation claimed and why (task, report, declared model).
 * Claims and releases are append-order custom session entries filtered by the
 * owning session id and read from every entry (not the active `/tree`
 * branch), like orchestration activation: resume restores them, forks and
 * clones inherit nothing, and `/orchestrate off` leaves them alone. Live
 * observations are computed on each read and never persisted.
 */

import { runHerdr } from './herdr-cli.js';
import type { AgentIdentity } from './types.js';

export type { AgentIdentity } from './types.js';

export const WORKER_ENTRY_TYPE = 'pi-herdr-worker';
const LOOKUP_TIMEOUT_MS = 3_000;

export interface WorkerRecord {
  /** Display ordinal in claim order; stable because entries are append-only. */
  id: number;
  identity: AgentIdentity;
  task?: string;
  report?: string;
  /** Model the orchestrator declared at claim time; never verified. */
  model?: string;
  released: boolean;
}

export type Observation = 'match' | 'session unverified' | 'replaced' | 'absent' | 'unknown';

export interface LiveAgent {
  identity: AgentIdentity;
  name?: string;
  status?: string;
}

export interface ObservedWorker {
  record: WorkerRecord;
  observation: Observation;
  live?: LiveAgent;
}

export interface WorkerObservations {
  /** `failed` means Herdr could not be read; every observation is then `unknown`. */
  lookup: 'ok' | 'failed';
  workers: ObservedWorker[];
}

interface EntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Normalized `agent_session` so equality never depends on object identity or key order. */
export function normalizeSession(value: unknown): string | undefined {
  if (typeof value === 'string') return nonEmpty(value);
  if (!isRecord(value)) return undefined;
  const id = nonEmpty(value.value);
  if (id === undefined) return undefined;
  return [nonEmpty(value.agent) ?? '', nonEmpty(value.kind) ?? '', id].join(':');
}

/** Identity of one Herdr agent object (`agent get` / `agent list` / `agent wait` result). */
export function liveAgentFrom(value: unknown): LiveAgent | undefined {
  if (!isRecord(value)) return undefined;
  const paneId = nonEmpty(value.pane_id);
  const terminalId = nonEmpty(value.terminal_id);
  if (paneId === undefined || terminalId === undefined) return undefined;
  const session = normalizeSession(value.agent_session);
  const name = nonEmpty(value.name);
  const status = nonEmpty(value.agent_status);
  return {
    identity: { paneId, terminalId, ...(session ? { session } : {}) },
    ...(name ? { name } : {}),
    ...(status ? { status } : {}),
  };
}

/** The `result.agent` object of `herdr agent get` and `herdr agent wait` JSON. */
export function resultAgent(json: unknown): unknown {
  return isRecord(json) && isRecord(json.result) ? json.result.agent : undefined;
}

/**
 * Compare a trusted snapshot with a later observation. Only terminal plus
 * session equality is a match; a missing session on either side is unverified,
 * never a match.
 */
export function compareIdentity(
  snapshot: AgentIdentity | undefined,
  observed: AgentIdentity | undefined,
): 'match' | 'replaced' | 'unverified' {
  if (snapshot === undefined || observed === undefined) return 'unverified';
  if (observed.terminalId !== snapshot.terminalId) return 'replaced';
  if (snapshot.session === undefined || observed.session === undefined) return 'unverified';
  return observed.session === snapshot.session ? 'match' : 'replaced';
}

function herdrError(result: { stdout: string; stderr: string; errorJson?: unknown }): string {
  const error = isRecord(result.errorJson) ? result.errorJson.error : undefined;
  const message = isRecord(error) ? nonEmpty(error.message) : undefined;
  return message ?? (nonEmpty(result.stderr)?.split('\n', 1)[0] || 'herdr lookup failed');
}

/** One bounded, cancellable `herdr agent get`. */
export async function lookupAgent(
  target: string,
  signal?: AbortSignal,
): Promise<{ ok: true; agent: LiveAgent } | { ok: false; error: string }> {
  const result = await runHerdr(['agent', 'get', target], {
    timeoutMs: LOOKUP_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (result.exitCode !== 0) return { ok: false, error: herdrError(result) };
  const agent = liveAgentFrom(resultAgent(result.json));
  return agent
    ? { ok: true, agent }
    : { ok: false, error: 'herdr returned no pane/terminal identity' };
}

/**
 * One bounded, cancellable `herdr agent list`; undefined when it failed or any
 * member lacks a pane/terminal identity (an incomplete list cannot prove absence).
 */
export async function listAgents(signal?: AbortSignal): Promise<LiveAgent[] | undefined> {
  const result = await runHerdr(['agent', 'list'], {
    timeoutMs: LOOKUP_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (result.exitCode !== 0 || !isRecord(result.json) || !isRecord(result.json.result)) {
    return undefined;
  }
  const agents = result.json.result.agents;
  if (!Array.isArray(agents)) return undefined;
  const live = agents.map(liveAgentFrom);
  return live.every((agent) => agent !== undefined) ? (live as LiveAgent[]) : undefined;
}

/** Reclaims merge only into the exact same identity, including a missing session. */
function identityKey(identity: { terminalId: string; session?: string }): string {
  return `${identity.terminalId}\u0000${identity.session ?? ''}`;
}

export interface ClaimEntry {
  action: 'claim';
  sessionId: string;
  at: string;
  paneId: string;
  terminalId: string;
  session?: string;
  task?: string;
  report?: string;
  model?: string;
}

export interface ReleaseEntry {
  action: 'release';
  sessionId: string;
  at: string;
  terminalId: string;
  session?: string;
}

type WorkerEntry = ClaimEntry | ReleaseEntry;

/** Tolerates malformed or older entries by skipping them. */
function parseEntry(data: unknown): WorkerEntry | undefined {
  if (!isRecord(data)) return undefined;
  const sessionId = nonEmpty(data.sessionId);
  const terminalId = nonEmpty(data.terminalId);
  if (sessionId === undefined || terminalId === undefined) return undefined;
  const session = nonEmpty(data.session);
  const at = typeof data.at === 'string' ? data.at : '';
  const base = { sessionId, at, terminalId, ...(session ? { session } : {}) };
  if (data.action === 'release') return { action: 'release', ...base };
  if (data.action !== 'claim') return undefined;
  const paneId = nonEmpty(data.paneId);
  if (paneId === undefined) return undefined;
  const task = nonEmpty(data.task);
  const report = nonEmpty(data.report);
  const model = nonEmpty(data.model);
  return {
    action: 'claim',
    ...base,
    paneId,
    ...(task ? { task } : {}),
    ...(report ? { report } : {}),
    ...(model ? { model } : {}),
  };
}

/** Replay this session's claims and releases in append order. */
export function readWorkerRecords(
  entries: readonly EntryLike[],
  sessionId: string,
): WorkerRecord[] {
  const records = new Map<string, WorkerRecord>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== WORKER_ENTRY_TYPE) continue;
    const parsed = parseEntry(entry.data);
    if (parsed === undefined || parsed.sessionId !== sessionId) continue;
    const key = identityKey(parsed);
    const existing = records.get(key);
    if (parsed.action === 'release') {
      if (existing) existing.released = true;
      continue;
    }
    const supplied = {
      ...(parsed.task ? { task: parsed.task } : {}),
      ...(parsed.report ? { report: parsed.report } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
    };
    if (existing) {
      // Merge supplied fields; omitted fields never blank recorded intent.
      Object.assign(existing, supplied, { released: false });
      existing.identity.paneId = parsed.paneId;
      continue;
    }
    records.set(key, {
      id: records.size + 1,
      identity: {
        paneId: parsed.paneId,
        terminalId: parsed.terminalId,
        ...(parsed.session ? { session: parsed.session } : {}),
      },
      ...supplied,
      released: false,
    });
  }
  return [...records.values()];
}

export function findRecord(
  records: readonly WorkerRecord[],
  identity: AgentIdentity,
): WorkerRecord | undefined {
  const key = identityKey(identity);
  return records.find((record) => identityKey(record.identity) === key);
}

/** Observation of one record against one `agent list` snapshot (undefined = lookup failed). */
export function observe(
  record: WorkerRecord,
  live: readonly LiveAgent[] | undefined,
): ObservedWorker {
  if (live === undefined) return { record, observation: 'unknown' };
  const sameTerminal = live.find(
    (agent) => agent.identity.terminalId === record.identity.terminalId,
  );
  if (sameTerminal) {
    const verdict = compareIdentity(record.identity, sameTerminal.identity);
    const observation: Observation =
      verdict === 'unverified'
        ? record.identity.session === undefined
          ? 'session unverified'
          : 'unknown'
        : verdict;
    return { record, observation, live: sameTerminal };
  }
  const samePane = live.find((agent) => agent.identity.paneId === record.identity.paneId);
  return samePane
    ? { record, observation: 'replaced', live: samePane }
    : { record, observation: 'absent' };
}

/** Join unreleased records with one bounded `herdr agent list` (skipped when none). */
export async function observeWorkers(
  records: readonly WorkerRecord[],
  signal?: AbortSignal,
): Promise<WorkerObservations> {
  const open = records.filter((record) => !record.released);
  if (open.length === 0) return { lookup: 'ok', workers: [] };
  const live = await listAgents(signal);
  return {
    lookup: live === undefined ? 'failed' : 'ok',
    workers: open.map((record) => observe(record, live)),
  };
}

const OBSERVATION_TEXT: Record<Observation, string> = {
  match: 'match (terminal and session verified)',
  'session unverified': 'session unverified (terminal matches; no session recorded)',
  replaced: 'replaced (a different agent now holds this terminal or pane)',
  absent: 'absent (Herdr lists no agent on this terminal or pane)',
  unknown: 'unknown (identity could not be verified)',
};

export function formatIdentity(identity: AgentIdentity): string {
  return `pane ${identity.paneId}, terminal ${identity.terminalId}, session ${
    identity.session ?? 'unrecorded'
  }`;
}

export function formatObservedWorker(worker: ObservedWorker, watches: readonly number[]): string {
  const { record } = worker;
  const lines = [`#${record.id} ${OBSERVATION_TEXT[worker.observation]}`];
  lines.push(`  recorded: ${formatIdentity(record.identity)}`);
  if (worker.live && worker.observation !== 'match') {
    lines.push(`  live now: ${formatIdentity(worker.live.identity)}`);
  }
  if (worker.live?.status) lines.push(`  live status: ${worker.live.status}`);
  lines.push(`  task: ${record.task ?? '(none recorded)'}`);
  if (record.report) lines.push(`  report: ${record.report}`);
  lines.push(`  declared model: ${record.model ?? 'unknown'}`);
  lines.push(
    `  armed watches: ${watches.length === 0 ? 'none' : watches.map((id) => `#${id}`).join(', ')}`,
  );
  return lines.join('\n');
}
