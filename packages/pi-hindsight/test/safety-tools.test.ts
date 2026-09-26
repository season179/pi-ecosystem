import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { config, exchange, extensionFixture, message, persisted, Server, BANK } from './helpers.js';
import { readHistory } from '../src/history.js';
const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), 'pi-hindsight-safe-')); roots.push(p); return p; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('modes, privacy and identified tools', () => {
  it('explicit OFF has zero HTTP/config access; read-only tools never retain or curate', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'not captured');
    const off = extensionFixture(manager, server, { configPath: '/missing-and-must-not-be-read', mode: 'off' });
    await off.emit('session_start'); await off.emit('agent_settled');
    expect(await off.emit('before_agent_start', { type: 'before_agent_start', prompt: 'first prompt' } as any)).toBeUndefined();
    await expect(off.tool('hindsight_reflect', { query: 'question' })).rejects.toThrow('off'); expect(server.calls).toHaveLength(0);
    expect([...off.tools.keys()]).toEqual(['hindsight_reflect', 'hindsight_search_knowledge_pages', 'hindsight_read_knowledge_page', 'hindsight_retain', 'hindsight_manage_fact']);
    const ro = extensionFixture(manager, server, { configPath: config(r), mode: 'read-only' });
    expect((await ro.tool('hindsight_reflect', { query: 'token=secret-test-value question' })).content[0]).toMatchObject({ type: 'text' });
    expect(server.calls.at(-1)!.body.query).toContain('[REDACTED]');
    expect(JSON.stringify(await ro.tool('hindsight_search_knowledge_pages', { query: 'decisions' }))).toContain('kp-one');
    const page = JSON.stringify(await ro.tool('hindsight_read_knowledge_page', { page_id: 'kp-one' }));
    expect(page).toContain('untrusted'); expect(page).toContain('Page content'); expect(page).not.toContain('duplicate');
    await expect(ro.tool('hindsight_retain', { content: 'no write' })).rejects.toThrow('read-only');
    await expect(ro.tool('hindsight_manage_fact', { action: 'invalidate', fact_id: 'fact-one' })).rejects.toThrow('read-only');
    await ro.emit('agent_settled'); expect(server.retains).toHaveLength(0);
    expect(server.calls.every(c => c.method === 'GET' || c.url.pathname.endsWith('/reflect'))).toBe(true);
  });

  it('default read-write makes zero fetches without explicit effective endpoint configuration', async () => {
    for (const settings of [undefined, {}, { serverMode: 'self-hosted' }, { banks: { [BANK]: { serverMode: 'daemon' } } }]) {
      const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'must stay local');
      const path = join(r, 'endpoint-config.json');
      if (settings) writeFileSync(path, JSON.stringify({ bankId: BANK, ...settings }));
      const ext = extensionFixture(manager, server, { configPath: path });
      await ext.emit('agent_settled');
      expect(ext.status).toContain('explicit endpoint');
      await expect(ext.tool('hindsight_reflect', { query: 'must stay local' })).rejects.toThrow('explicit endpoint');
      expect(server.calls).toHaveLength(0);
    }
  });

  it('accepts deliberate self-hosted/Cloud endpoints through official file, harness, bank and env layers', async () => {
    const cases = [
      { settings: { apiUrl: 'http://hindsight.invalid' }, url: 'http://hindsight.invalid' },
      { settings: { serverMode: 'cloud' }, url: 'https://api.hindsight.vectorize.io' },
      { settings: { harnesses: { pi: { apiUrl: 'https://pi.invalid' } } }, url: 'https://pi.invalid' },
      { settings: { banks: { [BANK]: { apiUrl: 'https://bank.invalid' } } }, url: 'https://bank.invalid' },
      { settings: { banks: { [BANK]: { serverMode: 'cloud' } } }, url: 'https://api.hindsight.vectorize.io' },
      { settings: {}, env: 'https://env.invalid', url: 'https://env.invalid' },
      { settings: { apiUrl: null }, env: 'https://env.invalid', url: undefined },
    ];
    for (const { settings, env, url } of cases) {
      const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'explicit destination');
      const path = join(r, 'endpoint-config.json'); writeFileSync(path, JSON.stringify({ bankId: BANK, ...settings }));
      try {
        if (env) process.env.HINDSIGHT_API_URL = env;
        const ext = extensionFixture(manager, server, { configPath: path });
        await ext.emit('agent_settled');
        if (url) { expect(server.retains).toHaveLength(1); expect(server.calls.every(c => c.url.origin === url)).toBe(true); }
        else { expect(ext.status).toContain('explicit endpoint'); expect(server.calls).toHaveLength(0); }
      } finally { delete process.env.HINDSIGHT_API_URL; }
    }
  });

  it('honors official disabled/retainSessions switches and never touches the legacy bank', async () => {
    for (const patch of [{ disabled: true }, { retainSessions: false }, { bankId: 'pi-memory' }]) {
      const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'private');
      const ext = extensionFixture(manager, server, { configPath: config(r, patch), mode: 'read-write' });
      await ext.emit('agent_settled'); expect(server.calls).toHaveLength(0);
    }
  });

  it('excludes system/thinking/raw tools/summaries/custom memory and exact echoes, preserving roles, dates and qualified edits', async () => {
    const r = root(), manager = persisted(r);
    const echo = 'Memory-derived statement from a prior session should not become fresh corroboration.';
    const userId = manager.appendMessage({ role: 'user', content: 'old text', timestamp: 1_800_000_000_000 });
    manager.appendMessage({ ...message('assistant original'), content: [
      { type: 'thinking', thinking: 'SECRET_THINKING' }, { type: 'text', text: 'New result is provisional.' },
      { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'SECRET_TOOL_ARGS' } },
    ] });
    manager.appendMessage({ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT' }], isError: false, timestamp: 1_800_000_001_000 });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'm1', toolName: 'hindsight_reflect', content: [{ type: 'text', text: echo }],
      details: { hindsight: { echoTexts: [echo] } }, isError: false, timestamp: 1_800_000_001_000 });
    manager.appendCustomMessageEntry('pi-memory-catalog', 'SECRET_CUSTOM_MEMORY', false);
    manager.appendContextEdit(userId, { content: 'User qualified: only on staging. api_key=abcdef123456 <pi_memory>SECRET_INJECTION</pi_memory>' });
    manager.appendCompaction('SECRET_DERIVED_SUMMARY', userId, 9999);
    manager.appendMessage(message(`${echo} Completed final reply`, 1_800_000_003_000));
    const history = readHistory(manager), text = JSON.stringify(history.turns);
    for (const forbidden of ['SECRET_', 'abcdef123456', echo, 'old text']) expect(text).not.toContain(forbidden);
    expect(text).toContain('[REDACTED]'); expect(text).toContain('only on staging'); expect(text).toContain('New result is provisional');
    expect(history.turns[0]).toMatchObject({ role: 'user', timestamp: new Date(1_800_000_000_000).toISOString() });
  });

  it('explicit retain is deterministic and suppresses later assistant echoes without erasing user evidence', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'setup');
    const ext = extensionFixture(manager, server, { configPath: config(r), mode: 'read-write' });
    const content = 'Explicit user-requested durable fact, qualified to staging only.';
    const first = await ext.tool('hindsight_retain', { content });
    expect(JSON.stringify(first)).toContain('accepted'); expect(JSON.stringify(first)).toContain('not verified');
    await ext.tool('hindsight_retain', { content }); expect(server.retains).toHaveLength(1);
    manager.appendMessage({ role: 'user', content, timestamp: Date.now() });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'test-tool', toolName: 'hindsight_retain', content: first.content as any, details: JSON.parse(JSON.stringify(first.details)), timestamp: Date.now(), isError: false });
    manager.appendMessage(message(`${content} Retained that fact.`));
    const turns = readHistory(manager).turns;
    expect(turns.find(t => t.role === 'user' && t.content === content)).toBeDefined();
    expect(turns.at(-1)?.content).not.toContain(content);
  });

  it('scoped fact curation uses exact PATCH, rejects mismatches/observations, and durably blocks local source replay', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'original source');
    const path = config(r), ext = extensionFixture(manager, server, { configPath: path, mode: 'read-write' });
    await ext.emit('agent_settled');
    server.facts.set('fact-one', { id: 'fact-one', bank_id: BANK, fact_type: 'world', text: 'old fact', document_id: `conversation:${manager.getSessionId()}` });
    const params = { fact_id: 'fact-one', document_id: `conversation:${manager.getSessionId()}`, expected_text: 'old fact' };
    await expect(ext.tool('hindsight_manage_fact', { ...params, document_id: 'wrong', action: 'edit', text: 'new fact' })).rejects.toThrow('scope');
    server.facts.get('fact-one').fact_type = 'observation';
    await expect(ext.tool('hindsight_manage_fact', { ...params, action: 'invalidate' })).rejects.toThrow('world/experience');
    server.facts.get('fact-one').fact_type = 'world';
    const answer = await ext.tool('hindsight_manage_fact', { ...params, action: 'edit', text: 'new fact; only staging' });
    expect(JSON.stringify(answer)).toContain('not permanent erasure');
    expect(server.calls.filter(c => c.method === 'PATCH').map(c => c.body)).toEqual([{ text: 'new fact; only staging' }]);
    await ext.tool('hindsight_manage_fact', { ...params, expected_text: 'new fact; only staging', action: 'invalidate', reason: 'superseded' });
    expect(server.facts.get('fact-one').state).toBe('invalidated');
    await ext.tool('hindsight_manage_fact', { ...params, expected_text: 'new fact; only staging', action: 'revert' });
    expect(server.facts.get('fact-one').state).toBe('valid');
    const reopened = SessionManager.open(manager.getSessionFile()!); exchange(reopened, 'after correction');
    const next = extensionFixture(reopened, server, { configPath: path, mode: 'read-write' });
    await next.emit('agent_settled'); expect(next.status).toContain('blocked after curation'); expect(server.retains).toHaveLength(1);
    const calls = server.calls.length;
    await expect(ext.tool('hindsight_manage_fact', { ...params, action: 'permanent-delete' })).rejects.toThrow('unavailable');
    expect(server.calls).toHaveLength(calls);
    expect(server.calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('revalidates mode/scope after an awaited fact read, and propagates abort/shutdown without late writes', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'private'); const path = config(r);
    const ext = extensionFixture(manager, server, { configPath: path, mode: 'read-write' });
    server.facts.set('f', { id: 'f', fact_type: 'world', text: 'old', document_id: 'd' });
    server.before = c => { if (c.url.pathname.endsWith('/memories/f')) config(r, { disabled: true }); };
    await expect(ext.tool('hindsight_manage_fact', { action: 'edit', fact_id: 'f', expected_text: 'old', document_id: 'd', text: 'new' })).rejects.toThrow();
    expect(server.calls.some(c => c.method === 'PATCH')).toBe(false);
    config(r); server.before = undefined;
    const aborted = new AbortController(); aborted.abort();
    const before = server.calls.length;
    await expect(ext.tool('hindsight_reflect', { query: 'never sent' }, aborted.signal)).rejects.toThrow(); expect(server.calls).toHaveLength(before);
    let release!: () => void;
    server.before = () => new Promise<void>(resolve => { release = resolve; });
    const capture = ext.emit('agent_settled');
    await new Promise(resolve => setTimeout(resolve, 5));
    await ext.emit('session_shutdown'); await capture;
    release(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(server.retains).toHaveLength(0);
  });

  it('invalid config fails closed without exposing its contents or sending HTTP', async () => {
    const r = root(), server = new Server(), manager = persisted(r); exchange(manager, 'private');
    const path = config(r); writeFileSync(path, '{"apiToken":"CREDENTIAL_CANARY", broken');
    const ext = extensionFixture(manager, server, { configPath: path, mode: 'read-write' });
    await ext.emit('agent_settled'); expect(server.calls).toHaveLength(0); expect(ext.status).not.toContain('CREDENTIAL_CANARY');
  });
});
