import { openSync, closeSync, readFileSync, fstatSync } from 'node:fs';
import type { FileEntry, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { TransportTurn } from './upstream/chat.js';
import { redact, stripMemory } from './safety.js';

export const HISTORY_BYTES = 256 * 1024;
export const SESSION_BYTES = 8 * 1024 * 1024;
export interface History {
  sessionId: string; file: string; cwd: string; leaf: string; start: string;
  entries: SessionEntry[]; branch: SessionEntry[]; turns: TransportTurn[];
}
function fail(): never { throw new Error('Hindsight persisted history is missing, malformed or ambiguous; capture blocked'); }
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
}
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
  const turns: TransportTurn[] = [];
  let lastRole = '', lastStop = '';
  for (const e of branch) {
    // Only subsequent assistant prose can echo this result; never rewrite earlier evidence.
    if (e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName.startsWith('hindsight_')) {
      const details = e.message.details as { hindsight?: { echoTexts?: unknown } } | undefined;
      if (Array.isArray(details?.hindsight?.echoTexts)) for (const text of details.hindsight.echoTexts) {
        if (typeof text === 'string' && text.length >= 20) echoes.push(redact(text));
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
