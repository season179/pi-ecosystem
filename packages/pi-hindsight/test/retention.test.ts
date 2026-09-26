import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { config, exchange, extensionFixture, message, persisted, sdk, Server, BANK } from './helpers.js';
import { CURSOR_TYPE } from '../src/retention.js';
const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), 'pi-hindsight-test-')); roots.push(p); return p; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('persisted conversation evidence', () => {
  it('real Pi 0.87.1 defaults to automatic read-write capture across two runs, reopen and compaction', async () => {
    const r = root(), server = new Server(), manager = persisted(r);
    let subject = await sdk(r, server, manager, [message('RUN_ONE reply'), message('RUN_TWO reply')]);
    try {
      await subject.session.prompt('RUN_ONE user: only on staging');
      await subject.session.prompt('RUN_TWO user: keep qualification');
      expect(server.retains).toHaveLength(2);
      expect(server.retains.every(c => c.body.items[0].update_mode === 'append')).toBe(true);
      expect(server.retains[1].body.items[0].content).not.toContain('RUN_ONE');
      const file = manager.getSessionFile()!;
      expect(readFileSync(file, 'utf8')).toContain(CURSOR_TYPE);
      await subject.dispose();
      const reopened = SessionManager.open(file);
      const before = reopened.getBranch().find(e => e.type === 'message' && e.message.role === 'user')!;
      reopened.appendCompaction('DERIVED_SUMMARY_NOT_EVIDENCE', before.id, 9000);
      subject = await sdk(r, server, reopened, [message('AFTER_RESTART reply')]);
      await subject.session.prompt('AFTER_RESTART user');
      const stored = server.documents.get(`conversation:${manager.getSessionId()}`)!;
      for (const marker of ['RUN_ONE', 'RUN_TWO', 'AFTER_RESTART', 'only on staging']) expect(stored).toContain(marker);
      expect(stored).not.toContain('DERIVED_SUMMARY');
      expect(server.retains).toHaveLength(3);
      const firstTurn = JSON.parse(server.retains[0].body.items[0].content.split('\n')[1]);
      expect(firstTurn.role).toBe('user'); expect(firstTurn.source_entry_id).toBeTypeOf('string');
      expect(Number.isFinite(Date.parse(firstTurn.timestamp))).toBe(true);
      expect(server.retains[0].body.items[0]).toMatchObject({ context: 'coding agent session', strategy: 'conversation', observation_scopes: 'shared',
        tags: ['source:chat', 'harness:pi'], metadata: { source: 'chat', harness: 'pi', session_id: manager.getSessionId() } });
    } finally { await subject.dispose(); }
  });

  it('later Reflect results never rewrite earlier retained sources; only subsequent assistant echoes are excluded', async () => {
    const r = root(), server = new Server(), manager = persisted(r);
    const source = 'Previously retrieved memory says the old timeout was thirty seconds.';
    manager.appendMessage({ role: 'user', content: source, timestamp: 1_800_000_000_000 });
    manager.appendMessage(message(`Original acknowledgement: ${source}`));
    const ext = extensionFixture(manager, server, { configPath: config(r) });
    await ext.emit('agent_settled');
    const original = server.documents.get(`conversation:${manager.getSessionId()}`)!;
    manager.appendMessage({ role: 'user', content: 'Check what memory says now.', timestamp: 1_800_000_002_000 });
    const reflected = await ext.tool('hindsight_reflect', { query: 'timeout' });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'reflect', toolName: 'hindsight_reflect',
      content: reflected.content as any, details: JSON.parse(JSON.stringify(reflected.details)), isError: false, timestamp: 1_800_000_003_000 });
    manager.appendMessage(message(`${source} New work remains provisional.`, 1_800_000_004_000));
    await ext.emit('agent_settled');
    expect(server.retains).toHaveLength(2);
    const stored = server.documents.get(`conversation:${manager.getSessionId()}`)!;
    expect(stored.startsWith(`${original}\n`)).toBe(true);
    const delta = server.retains[1].body.items[0].content;
    expect(delta).not.toContain(source); expect(delta).toContain('[memory-derived text omitted]');
    expect(delta).toContain('New work remains provisional.');
  });

  it('blocks divergent branches/source rewrites, but permits returning to the original lineage', async () => {
    const r = root(), server = new Server(), manager = persisted(r);
    const ext = extensionFixture(manager, server, { configPath: config(r), mode: 'read-write' });
    exchange(manager, 'first'); const first = manager.getLeafId()!;
    await ext.emit('agent_settled'); exchange(manager, 'second'); await ext.emit('agent_settled');
    const original = manager.getLeafId()!;
    manager.branch(first); exchange(manager, 'SIBLING_NOT_CAPTURED'); await ext.emit('agent_settled');
    expect(ext.status).toContain('branch or earlier source changed');
    expect(server.retains).toHaveLength(2);
    manager.branch(original); exchange(manager, 'third'); await ext.emit('agent_settled');
    expect(server.retains).toHaveLength(3);
    expect(server.documents.get(`conversation:${manager.getSessionId()}`)).not.toContain('SIBLING_NOT_CAPTURED');
    manager.appendContextEdit(first, { content: [{ type: 'text', text: 'edited old response' }] });
    await ext.emit('agent_settled'); expect(server.retains).toHaveLength(3);
  });

  it('persists the pending operation before dispatch; resume never blindly retries ambiguous/failed/pruned writes', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'before crash');
    const path = config(r);
    const ext = extensionFixture(manager, server, { configPath: path, mode: 'read-write' });
    server.before = c => { if (c.method === 'POST') {
      expect(readFileSync(manager.getSessionFile()!, 'utf8')).toContain(c.body.operation_id);
      throw new Error('simulated uncertain transport');
    } };
    await ext.emit('agent_settled'); expect(server.retains).toHaveLength(1);
    server.before = undefined;
    const reopened = SessionManager.open(manager.getSessionFile()!);
    exchange(reopened, 'after crash');
    const next = extensionFixture(reopened, server, { configPath: path, mode: 'read-write' });
    await next.emit('agent_settled'); expect(next.status).toContain('uncertain'); expect(server.retains).toHaveLength(1);
    const op = server.retains[0].body.operation_id;
    server.operations.set(op, { status: 'pending' }); await next.emit('agent_settled');
    expect(next.status).toContain('still pending'); expect(server.retains).toHaveLength(1);
    server.operations.set(op, { status: 'failed' }); await next.emit('agent_settled'); expect(server.retains).toHaveLength(1);
  });

  it('refuses an existing document without a cursor instead of re-extracting curated history', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'existing');
    server.documents.set(`conversation:${manager.getSessionId()}`, 'OLD_EVIDENCE_WITH_CURATION');
    const ext = extensionFixture(manager, server, { configPath: config(r), mode: 'read-write' });
    await ext.emit('agent_settled'); expect(server.retains).toHaveLength(0);
    expect(ext.status).toContain('without a trusted cursor'); expect([...server.documents.values()]).toEqual(['OLD_EVIDENCE_WITH_CURATION']);
  });

  it('blocks remote source drift and overlapping writers instead of repairing or racing them', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'first');
    const ext = extensionFixture(manager, server, { configPath: config(r), mode: 'read-write' });
    await ext.emit('agent_settled'); exchange(manager, 'second');
    server.documents.set(`conversation:${manager.getSessionId()}`, 'OTHER_WRITER_CHANGED_SOURCE');
    await ext.emit('agent_settled'); expect(ext.status).toContain('remote source'); expect(server.retains).toHaveLength(1);
    const { lockSession } = await import('../src/retention.js');
    const unlock = lockSession(manager.getSessionFile()!);
    try { await ext.emit('agent_settled'); expect(ext.status).toContain('locked'); expect(server.retains).toHaveLength(1); }
    finally { unlock(); }
  });

  it('refuses torn/oversize histories and incomplete replies, rather than sending a destructive tail', async () => {
    for (const kind of ['torn', 'oversize', 'unfinished'] as const) {
      const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'ordinary');
      if (kind === 'torn') appendFileSync(manager.getSessionFile()!, '{"type":');
      if (kind === 'oversize') exchange(manager, 'x'.repeat(270_000));
      if (kind === 'unfinished') manager.appendMessage({ role: 'user', content: 'no reply yet', timestamp: Date.now() });
      const ext = extensionFixture(manager, server, { configPath: config(r), mode: 'read-write' });
      await ext.emit('agent_settled'); expect(server.retains).toHaveLength(0); expect(ext.status).toMatch(/blocked|limit|waits/);
    }
  });

  it('does not carry a session cursor to another bank, or capture forked ancestry as fresh evidence', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'first');
    const path = config(r), ext = extensionFixture(manager, server, { configPath: path, mode: 'read-write' });
    await ext.emit('agent_settled'); exchange(manager, 'second'); config(r, { bankId: `${BANK}:other` });
    await ext.emit('agent_settled'); expect(ext.status).toContain('destination changed'); expect(server.retains).toHaveLength(1);
    const fork = SessionManager.create(r, join(r, 'forks')); fork.newSession({ parentSession: manager.getSessionFile()! }); exchange(fork, 'fork');
    const f = extensionFixture(fork, server, { configPath: path, mode: 'read-write' });
    await f.emit('agent_settled'); expect(f.status).toContain('forked/cloned'); expect(server.retains).toHaveLength(1);
  });
});
