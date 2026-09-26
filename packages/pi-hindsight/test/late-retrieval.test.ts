import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { config, exchange, extensionFixture, message, persisted, sdk, Server, GLOBAL_BANK } from './helpers.js';
import { BACKGROUND_MAX_MS, CONTEXT_TYPE, DELIVERY_TYPE, matchesPrompt } from '../src/retrieval.js';
import { hash } from '../src/safety.js';
import { readHistory } from '../src/history.js';

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), 'hindsight-late-')); roots.push(r); return r; };
afterEach(() => { vi.useRealTimers(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const hold = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const toolReply = () => ({ ...message(''), stopReason: 'toolUse' as const, content: [{ type: 'toolCall' as const, id: 'wait-1', name: 'synthetic_work', arguments: {} }] });
const boundary = () => ({ type: 'turn_end', outcome: 'completed', toolResults: [{}], context: { pendingMessages: [] } }) as any;
const customs = (manager: ReturnType<typeof persisted>) => manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === CONTEXT_TYPE);

it('real SDK: image-normalized request receives healthy project memory at a natural turn despite an abort-ignoring global sibling', { timeout: 15_000 }, async () => {
  const r = root(), server = new Server(), manager = persisted(r), held = hold(), globalHeld = hold();
  const globalConfigPath = join(r, 'global.json');
  writeFileSync(globalConfigPath, JSON.stringify({ apiUrl: 'http://hindsight.invalid', bankId: GLOBAL_BANK, reflectTimeoutMs: 90_000 }));
  server.before = c => c.url.pathname.endsWith('/reflect') ? c.url.pathname.includes(encodeURIComponent(GLOBAL_BANK)) ? globalHeld.promise : held.promise : undefined;
  const subject = await sdk(r, server, manager, [toolReply(), message(`Checked: ${server.reflectText}`)],
    { configPath: config(r, { reflectTimeoutMs: 90_000 }), globalConfigPath }, [{
    name: 'synthetic_work', label: 'work', description: 'synthetic local work', parameters: Type.Object({}),
    async execute() { held.release(); await new Promise(r => setTimeout(r, 10)); return { content: [{ type: 'text', text: 'done' }], details: undefined }; },
  }]);
  try {
    const started = Date.now();
    await subject.session.prompt('Check the remembered timeout while doing work.', {
      images: [{ type: 'image', data: Buffer.from('not an image').toString('base64'), mimeType: 'image/x-invalid' }],
    });
    expect(Date.now() - started).toBeLessThan(12_000); // well before the equal 90-second lifetime
    expect(JSON.stringify(subject.requests[0])).toContain('[Image omitted:'); // actual installed Pi normalization
    expect(subject.requests).toHaveLength(2);
    expect(JSON.stringify(subject.requests[0])).not.toContain(server.reflectText);
    expect(JSON.stringify(subject.requests[1])).toContain(server.reflectText);
    expect(customs(manager)).toHaveLength(1);
    const branch = manager.getBranch(), release = branch.findIndex(e => e.type === 'custom' && e.customType === DELIVERY_TYPE);
    expect(release).toBeGreaterThan(branch.findIndex(e => e.type === 'custom_message'));
    expect(branch[release + 1]).toMatchObject({ type: 'message', message: { role: 'assistant' } });
    expect(server.documents.get(`conversation:${manager.getSessionId()}`)).toContain('[memory-derived text omitted]');
    expect(server.documents.get(`conversation:${manager.getSessionId()}`)).not.toContain(server.reflectText);
    expect(server.calls.filter(c => c.url.pathname.endsWith('/reflect'))).toHaveLength(2);
    const frozen = JSON.stringify(customs(manager));
    globalHeld.release(); await new Promise(r => setTimeout(r, 10)); // transport ignored cancellation
    expect(JSON.stringify(customs(manager))).toBe(frozen);
    expect(JSON.stringify(subject.requests[1])).not.toContain(server.globalText);
    expect(subject.requests).toHaveLength(2); // no amendment or induced turn
  } finally { await subject.dispose(); }
});

it('real SDK: a terminating tool stages but never releases; later unrelated primary evidence is neither injected nor stripped', { timeout: 15_000 }, async () => {
  const r = root(), server = new Server(), manager = persisted(r), held = hold();
  server.before = c => c.url.pathname.endsWith('/reflect') ? held.promise : undefined;
  const subject = await sdk(r, server, manager, [toolReply(), message(server.reflectText)], {}, [{
    name: 'synthetic_work', label: 'work', description: 'synthetic terminating work', parameters: Type.Object({}),
    async execute() { held.release(); await new Promise(r => setTimeout(r, 10)); return { content: [{ type: 'text', text: 'done' }], details: undefined, terminate: true }; },
  }]);
  try {
    await subject.session.prompt('Original question');
    expect(subject.requests).toHaveLength(1); expect(customs(manager)).toHaveLength(1);
    await subject.session.prompt('Unrelated new question');
    expect(subject.requests).toHaveLength(2);
    expect(JSON.stringify(subject.requests[1])).not.toContain(server.reflectText);
    expect(readHistory(manager).turns.at(-1)?.content).toBe(server.reflectText);
    expect(manager.getBranch().some(e => e.type === 'custom' && e.customType === DELIVERY_TYPE)).toBe(false);
  } finally { await subject.dispose(); }
});

it('release is chronological: staging/discard/invalidation never rewrites earlier captured evidence', async () => {
  const r = root(), server = new Server(), manager = persisted(r), text = server.reflectText;
  exchange(manager, 'original');
  manager.appendCustomMessageEntry(CONTEXT_TYPE, text, true, { hindsight: { deliveryId: 'late', late: true, echoTexts: [text] } });
  manager.appendMessage(message(text));
  const ext = extensionFixture(manager, server, { configPath: config(r) });
  await ext.emit('agent_settled');
  const before = server.documents.get(`conversation:${manager.getSessionId()}`)!;
  expect(before).toContain(text);
  manager.appendCustomEntry(DELIVERY_TYPE, { action: 'release', id: 'late' });
  manager.appendCustomEntry(DELIVERY_TYPE, { action: 'invalidate', ids: ['late'] });
  manager.appendMessage(message(`After release ${text}`));
  await ext.emit('agent_settled');
  const after = server.documents.get(`conversation:${manager.getSessionId()}`)!;
  expect(after.startsWith(before + '\n')).toBe(true);
  expect(server.retains.at(-1)!.body.items[0].content).toContain('[memory-derived text omitted]');
  expect(server.retains.at(-1)!.body.items[0].content).not.toContain(text);
});

async function pendingFixture(readyBeforeUser = false) {
  const r = root(), server = new Server(), manager = persisted(r), held = hold();
  server.before = c => c.url.pathname.endsWith('/reflect') ? held.promise : undefined;
  const ext = extensionFixture(manager, server, { configPath: config(r, { reflectTimeoutMs: 200_000 }), mode: 'read-write' });
  const start = ext.emit('before_agent_start', { type: 'before_agent_start', prompt: 'original question' } as any);
  await vi.advanceTimersByTimeAsync(6000); expect(await start).toBeUndefined();
  if (readyBeforeUser) { held.release(); await vi.advanceTimersByTimeAsync(0); }
  const user = { role: 'user' as const, content: 'original question', timestamp: Date.now() };
  manager.appendMessage(user); await ext.emit('message_end', { type: 'message_end', message: user } as any);
  return { r, server, manager, held, ext };
}
async function readyDraft(f: Awaited<ReturnType<typeof pendingFixture>>) {
  f.held.release(); await vi.advanceTimersByTimeAsync(0);
  const result = await f.ext.emit('turn_end', boundary());
  expect(result?.continue).toBeUndefined();
  const draft = result.entries[0];
  f.manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
}

it('steering, input edits, restart and abort after release prevent stale first delivery; natural messages do not', async () => {
  for (const change of ['steer', 'edit', 'restart', 'abort', 'scope', 'shutdown', 'early'] as const) {
    vi.useFakeTimers();
    const f = await pendingFixture(change === 'early');
    // Natural assistant/tool progress must not invalidate the input snapshot.
    f.manager.appendMessage(toolReply());
    await readyDraft(f);
    let ext = f.ext;
    if (change === 'steer') {
      const steering = { role: 'user' as const, content: 'original question but a different task', timestamp: Date.now() + 1 };
      await ext.emit('message_end', { type: 'message_end', message: steering } as any); // host emits before persistence
      f.manager.appendMessage(steering);
    }
    if (change === 'edit') f.manager.appendContextEdit(f.manager.getBranch().find(e => e.type === 'message' && e.message.role === 'user')!.id, { content: 'edited request' });
    if (change === 'restart') ext = extensionFixture(f.manager, f.server, { configPath: config(f.r) });
    if (change === 'scope') config(f.r, { bankId: 'coding-agent::test:other' });
    if (change === 'shutdown') await ext.emit('session_shutdown');
    const signal = new AbortController();
    if (change === 'abort') { Object.defineProperty(ext.ctx, 'signal', { value: signal.signal }); await ext.emit('turn_start'); }
    const context = () => ({ type: 'context', messages: f.manager.buildSessionContext().messages }) as any;
    const result = await ext.emit('context', context());
    expect(JSON.stringify(result.messages).includes(f.server.reflectText)).toBe(change === 'abort' || change === 'early');
    if (!['abort', 'early'].includes(change)) expect(ext.status).toContain('discarded');
    if (change === 'abort') {
      signal.abort(); // after receipt, before provider dispatch
      const reopened = extensionFixture(f.manager, f.server, { configPath: config(f.r) });
      expect(JSON.stringify((await reopened.emit('context', context())).messages)).not.toContain(f.server.reflectText);
    }
    await f.ext.emit('session_shutdown'); vi.useRealTimers();
  }
});

it('image note matching accepts only exact original text and pinned normalization notes, not prefix-related requests', () => {
  const prompt = 'Inspect this image', key = hash(prompt), hint = '[Image omitted: could not be converted to a supported inline image format.]';
  expect(matchesPrompt(key, 1, `${prompt}\n\n${hint}`)).toBe(true);
  expect(matchesPrompt(key, 0, `${prompt}\n\n${hint}`)).toBe(false);
  for (const changed of [`${prompt} instead deploy production`, `${prompt}\n\nunrelated new request`, `Different request\n\n${hint}`, `${prompt}\n\n${hint}\nunrelated new request`])
    expect(matchesPrompt(key, 1, changed)).toBe(false);
  const long = 'x'.repeat(4000);
  expect(matchesPrompt(hash(long + 'first'), 0, long + 'different')).toBe(false);
});

it('hard total deadline and curation cancel pending work; curation still PATCHes and persistently filters old injections', async () => {
  vi.useFakeTimers();
  const expired = await pendingFixture();
  await vi.advanceTimersByTimeAsync(BACKGROUND_MAX_MS - 6000);
  expect(expired.ext.status).toContain('background deadline');
  expired.held.release(); await vi.advanceTimersByTimeAsync(0);
  expect(await expired.ext.emit('turn_end', boundary())).toBeUndefined();
  expect(expired.server.calls.filter(c => c.url.pathname.endsWith('/reflect'))).toHaveLength(1);
  const f = await pendingFixture();
  f.manager.appendMessage(message('reply to make the session durable'));
  f.manager.appendCustomMessageEntry(CONTEXT_TYPE, f.server.reflectText, true, { hindsight: { echoTexts: [f.server.reflectText] } });
  const beforeCuration = f.manager.getLeafId()!;
  f.server.facts.set('f', { id: 'f', type: 'world', text: 'old claim', document_id: 'source', state: 'valid' });
  await f.ext.tool('hindsight_manage_fact', { action: 'edit', fact_id: 'f', expected_text: 'old claim', document_id: 'source', text: 'corrected claim' });
  expect(f.server.facts.get('f').text).toBe('corrected claim');
  f.held.release(); await vi.advanceTimersByTimeAsync(0);
  expect(await f.ext.emit('turn_end', boundary())).toBeUndefined();
  const reloaded = extensionFixture(f.manager, f.server, { configPath: config(f.r) });
  expect(JSON.stringify((await reloaded.emit('context', { type: 'context', messages: f.manager.buildSessionContext().messages } as any)).messages)).not.toContain(f.server.reflectText);
  const marks = f.manager.getBranch().filter(e => e.type === 'custom' && e.customType === DELIVERY_TYPE);
  expect(JSON.stringify(marks)).not.toContain(f.server.reflectText); // text is stored only once
  f.manager.branch(beforeCuration); // bank correction also applies after returning to an earlier branch
  expect(JSON.stringify((await reloaded.emit('context', { type: 'context', messages: f.manager.buildSessionContext().messages } as any)).messages)).not.toContain(f.server.reflectText);
});
