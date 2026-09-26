import { openSync, closeSync, readFileSync, fstatSync } from 'node:fs';
import type { FileEntry, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { TransportTurn } from './upstream/chat.js';
import { redact, stripMemory, textOf } from './safety.js';
import { CONTEXT_TYPE, DELIVERY_TYPE, type Delivery } from './retrieval.js';

export const HISTORY_BYTES = 256 * 1024;
export const SESSION_BYTES = 8 * 1024 * 1024;
export interface History {
  sessionId: string; file: string; cwd: string; leaf: string; start: string;
  entries: SessionEntry[]; branch: SessionEntry[]; turns: TransportTurn[];
}
function fail(): never { throw new Error('Hindsight persisted history is missing, malformed or ambiguous; capture blocked'); }
export function readHistory(manager: ExtensionContext['sessionManager']): History {
  const file = manager.getSessionFile(), leaf = manager.getLeafId();
  if (!file || !leaf) throw new Error('Hindsight capture requires a persisted Pi session with a completed reply');
  let raw: string;
  try {
    const fd = openSync(file, 'r');
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > SESSION_BYTES) throw new Error('limit');
      raw = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(raw) > SESSION_BYTES || !raw.endsWith('\n')) fail();
    } finally { closeSync(fd); }
  } catch { return fail(); }
  let rows: FileEntry[];
  try { rows = raw.trimEnd().split('\n').map(line => JSON.parse(line)); } catch { return fail(); }
  const header = rows[0];
  if (header?.type !== 'session' || header.version !== 3 || header.id !== manager.getSessionId() || header.cwd !== manager.getCwd() || !Number.isFinite(Date.parse(header.timestamp))) fail();
  if (header.parentSession) throw new Error('Hindsight capture of forked/cloned session ancestry is unsupported; start a fresh session instead');
  const entries = rows.slice(1) as SessionEntry[];
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !e.id || byId.has(e.id) || typeof e.timestamp !== 'string' || !Number.isFinite(Date.parse(e.timestamp))) fail();
    if (e.parentId !== null && !byId.has(e.parentId)) fail();
    byId.set(e.id, e);
  }
  const branch: SessionEntry[] = [];
  let cursor: string | null = leaf;
  while (cursor) { const e = byId.get(cursor); if (!e) fail(); branch.push(e); cursor = e.parentId; }
  branch.reverse();
  if (branch.map(e => e.id).join(',') !== manager.getBranch().map(e => e.id).join(',')) fail();
  const edits = new Map<string, { content: unknown } | null>();
  for (const e of branch) {
    if (e.type === 'context_edit') edits.set(e.targetId, e.replacement);
  }
  const echoes: string[] = [];
  const staged = new Map<string, string[]>();
  const addEchoes = (values: unknown): string[] => Array.isArray(values)
    ? values.filter((text): text is string => typeof text === 'string' && text.length >= 20).map(redact) : [];
  const turns: TransportTurn[] = [];
  let lastRole = '', lastStop = '';
  for (const e of branch) {
    // Tool results and automatic injections: only subsequent assistant prose can echo them; never rewrite earlier evidence.
    const memory = e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName.startsWith('hindsight_') ? e.message.details
      : e.type === 'custom_message' && e.customType === CONTEXT_TYPE ? e.details : undefined;
    if (memory !== undefined) {
      const details = memory as { hindsight?: { echoTexts?: unknown; late?: boolean; deliveryId?: string } };
      const texts = addEchoes(details.hindsight?.echoTexts);
      if (details.hindsight?.late) {
        if (details.hindsight.deliveryId) staged.set(details.hindsight.deliveryId, texts);
      } else echoes.push(...texts); // compatible with existing fast injections and tool results
    }
    if (e.type === 'custom' && e.customType === DELIVERY_TYPE) {
      const delivery = e.data as Delivery | undefined;
      // Register provenance at RELEASE, never retroactively at staging. Invalidation does not erase provenance.
      if (delivery?.action === 'release') {
        echoes.push(...(staged.get(delivery.id) ?? [])); staged.delete(delivery.id);
      }
    }
    if (e.type !== 'message' || (e.message.role !== 'user' && e.message.role !== 'assistant')) continue;
    const m = e.message;
    const edit = edits.get(e.id);
    const content = edit === null ? null : edit ? edit.content : m.content;
    if (content === null) continue;
    if (m.role === 'assistant' && ['error', 'aborted', 'pending', 'deferred'].includes(m.stopReason)) continue;
    lastRole = m.role; lastStop = m.role === 'assistant' ? m.stopReason : '';
    let text = redact(stripMemory(textOf(content))).trim();
    if (m.role === 'assistant') for (const echo of echoes) text = text.split(echo).join('[memory-derived text omitted]');
    if (!text) continue;
    const timestamp = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : e.timestamp;
    turns.push({ role: m.role, content: text, timestamp, source_entry_id: e.id, source_session_id: header.id } as TransportTurn);
  }
  if (lastRole !== 'assistant' || lastStop !== 'stop') throw new Error('Hindsight capture waits for a completed, non-aborted reply');
  if (!turns.length || Buffer.byteLength(JSON.stringify(turns)) > HISTORY_BYTES) throw new Error('Hindsight full history exceeds capture limit; refusing truncation');
  return { sessionId: header.id, file, cwd: header.cwd, leaf, start: header.timestamp, entries, branch, turns };
}
