import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, exchange, extensionFixture, jev, message, persisted, sdk, Server, typesafe } from './helpers.js';
import { CONTEXT_TYPE } from '../src/retrieval.js';
const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), 'pi-hindsight-retrieval-')); roots.push(p); return p; };
afterEach(() => { vi.restoreAllMocks(); delete process.env.TYPESAFE_API_KEY; for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const reflects = (server: Server) => server.calls.filter(c => c.url.pathname.endsWith('/reflect'));
const replies = (count: number) => Array.from({ length: count }, (_, i) => message(`reply ${i + 1}`));
const contexts = (manager: ReturnType<typeof persisted>) => manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === CONTEXT_TYPE);

describe('automatic retrieval', () => {
  it('real Pi: initial ungated Reflect is redacted, persisted after the prompt, sent once, and never captured or echoed as evidence', async () => {
    const r = root(), server = new Server(), manager = persisted(r), memory = server.reflectText;
    const subject = await sdk(r, server, manager, [message(`Checked: ${memory}`), message('second reply')]);
    try {
      await subject.session.prompt('What was the timeout? api_key=abcdef123456');
      expect(reflects(server).map(c => c.body)).toEqual([{ query: 'What was the timeout? api_key=[REDACTED]', budget: 'low' }]);
      const branch = manager.getBranch(), index = branch.findIndex(e => e.type === 'custom_message');
      expect(branch[index - 1]).toMatchObject({ type: 'message', message: { role: 'user' } });
      expect(branch[index]).toMatchObject({ customType: CONTEXT_TYPE, display: true, details: { hindsight: { echoTexts: [memory], trigger: 'initial' } } });
      expect(JSON.stringify(subject.requests[0])).toContain('untrusted historical evidence');
      expect(JSON.stringify(subject.requests[0])).toContain(memory);
      const stored = server.documents.get(`conversation:${manager.getSessionId()}`)!;
      expect(stored).toContain('What was the timeout?'); expect(stored).not.toContain('abcdef123456');
      expect(stored).not.toContain(memory); expect(stored).not.toContain('untrusted historical'); expect(stored).toContain('[memory-derived text omitted]');
      await subject.session.prompt('second prompt');
      expect(reflects(server)).toHaveLength(1); expect(contexts(manager)).toHaveLength(1);
    } finally { await subject.dispose(); }
  });

  it('real Pi read-only: Jev gates timing only; negative/unavailable/duplicate/empty handling, pause and per-activation attempt budget', async () => {
    const r = root(), server = new Server(), manager = persisted(r), agentDir = join(r, 'agent');
    typesafe(agentDir, { timeoutMs: 30_000 }); process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
    const gate = jev([0.2, 0.9, 0.9, 'error', 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
    const subject = await sdk(r, server, manager, replies(45), { mode: 'read-only', agentDir, jevFetch: gate.fetch });
    let n = 0;
    const until = async (last: number, text?: string) => { if (text !== undefined) server.reflectText = text; while (n < last) { n++; await subject.session.prompt(n === 4 ? 'prompt 4 token=supersecret99' : `prompt ${n}`); } };
    try {
      await until(4, 'Memory A: the deploy target is staging only, per an earlier decision.');
      expect(reflects(server)).toHaveLength(1); expect(gate.calls).toHaveLength(0);
      await until(5);
      expect(gate.calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(gate.calls[0].body).toMatchObject({ model: 'jev-1.13.0', state: { current_request: 'prompt 5', memory_already_provided: [server.reflectText] } });
      expect(JSON.stringify(gate.calls[0].body)).toContain('[REDACTED]'); expect(JSON.stringify(gate.calls[0].body)).not.toContain('supersecret99');
      expect(reflects(server)).toHaveLength(1); // negative: no Reflect
      await until(9); await until(13, '');       // positive duplicate, positive empty: attempted, not injected
      expect(reflects(server)).toHaveLength(3); expect(contexts(manager)).toHaveLength(1);
      await until(21);                           // 17: Jev unavailable -> pause; 21: no call at all
      expect(gate.calls).toHaveLength(4); expect(reflects(server)).toHaveLength(3);
      const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
      for (const [last, text] of [[25, 'B'], [29, 'C'], [33, 'D'], [37, 'E'], [41, 'F']] as const) await until(last, `Memory ${text}: a distinct earlier decision worth recalling.`);
      await until(45);                           // Reflect attempt budget (8) used: no Jev or Reflect
      expect(reflects(server)).toHaveLength(8); expect(gate.calls).toHaveLength(9); expect(contexts(manager)).toHaveLength(6);
      expect(server.calls.every(c => c.method === 'POST' && c.url.pathname.endsWith('/reflect'))).toBe(true); // no capture, pages or Recall
    } finally { await subject.dispose(); }
  });

  it('real Pi: pre-run waits stay bounded even when fetches ignore abort, and a failure pauses later retrieval', { timeout: 30_000 }, async () => {
    const r = root(), server = new Server(), manager = persisted(r), agentDir = join(r, 'agent');
    typesafe(agentDir, { timeoutMs: 30_000 }); process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
    server.before = c => c.url.pathname.endsWith('/reflect') ? new Promise<void>(() => {}) : undefined;
    const gate = jev([0.9]);
    let subject = await sdk(r, server, manager, replies(5), { mode: 'read-only', agentDir, jevFetch: gate.fetch });
    try {
      let started = Date.now();
      await subject.session.prompt('official 20 s default is capped'); // Reflect <= 6 s
      expect(Date.now() - started).toBeGreaterThanOrEqual(5_500); expect(Date.now() - started).toBeLessThan(7_500);
      for (const n of [2, 3, 4, 5]) await subject.session.prompt(`prompt ${n}`);
      expect(gate.calls).toHaveLength(0); expect(reflects(server)).toHaveLength(1); expect(contexts(manager)).toHaveLength(0);
      await subject.dispose();
      const other = persisted(r); for (let i = 0; i < 4; i++) exchange(other, `earlier ${i}`);
      const hung = jev(['hang']);
      subject = await sdk(r, server, other, replies(1), { mode: 'read-only', agentDir, jevFetch: hung.fetch });
      started = Date.now();
      await subject.session.prompt('Jev capped at 2 s');
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_800); expect(Date.now() - started).toBeLessThan(3_500);
      expect(hung.calls).toHaveLength(1); expect(reflects(server)).toHaveLength(1);
    } finally { await subject.dispose(); }
  });

  it('lower official timeout is respected; stale session/config results, unsupported autoInject and the branch cap make no injection', async () => {
    const r = root(), server = new Server(), manager = persisted(r), path = config(r, { reflectTimeoutMs: 200 });
    const start = { type: 'before_agent_start', prompt: 'first question' } as any;
    server.before = c => c.url.pathname.endsWith('/reflect') ? new Promise<void>(() => {}) : undefined;
    let started = Date.now();
    expect(await extensionFixture(manager, server, { configPath: path, mode: 'read-only' }).emit('before_agent_start', start)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_500);
    for (const change of ['session', 'config'] as const) {
      let release!: () => void;
      server.before = c => c.url.pathname.endsWith('/reflect') ? new Promise<void>(resolve => { release = resolve; }) : undefined;
      const ext = extensionFixture(manager, server, { configPath: config(r), mode: 'read-only' });
      const pending = ext.emit('before_agent_start', start);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (change === 'session') await ext.emit('session_before_switch'); else config(r, { apiUrl: 'http://other.invalid' });
      release();
      expect(await pending).toBeUndefined();
    }
    server.before = undefined; config(r);
    const calls = server.calls.length;
    for (const autoInject of ['recall', 'pages', 'none']) {
      const ext = extensionFixture(manager, server, { configPath: config(r, { autoInject }), mode: 'read-write' });
      expect(await ext.emit('before_agent_start', start)).toBeUndefined();
      expect(ext.status).toContain(autoInject === 'none' ? 'disabled' : 'no pages/Recall substitution');
    }
    const capped = persisted(r);
    for (let i = 0; i < 4; i++) exchange(capped, `earlier ${i}`);
    for (let i = 0; i < 8; i++) capped.appendCustomMessageEntry(CONTEXT_TYPE, `injected ${i}`, true);
    const agentDir = join(r, 'agent'); typesafe(agentDir); process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
    const gate = jev([0.9]);
    const ext = extensionFixture(capped, server, { configPath: config(r), mode: 'read-only', agentDir, jevFetch: gate.fetch });
    expect(await ext.emit('before_agent_start', start)).toBeUndefined();
    expect(ext.status).toContain('cap'); expect(gate.calls).toHaveLength(0); expect(server.calls).toHaveLength(calls);
  });
});
