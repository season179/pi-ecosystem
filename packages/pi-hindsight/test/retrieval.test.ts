import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  config,
  exchange,
  extensionFixture,
  GLOBAL_BANK,
  BANK,
  jev,
  message,
  persisted,
  sdk,
  Server,
  typesafe,
} from './helpers.js';
import { CONTEXT_TYPE, GATE_MAX_MS, REFLECT_MAX_MS } from '../src/retrieval.js';
// Seam: tests may defer the async local gate/key reads; otherwise the real ones run.
const deferred = vi.hoisted(() => ({
  loadGate: undefined as undefined | (() => Promise<unknown>),
  loadKey: undefined as undefined | (() => Promise<unknown>),
}));
vi.mock('../src/retrieval.js', async (original) => {
  const real = await original<typeof import('../src/retrieval.js')>();
  return {
    ...real,
    loadGate: (...a: Parameters<typeof real.loadGate>) =>
      deferred.loadGate?.() ?? real.loadGate(...a),
    loadKey: (...a: Parameters<typeof real.loadKey>) => deferred.loadKey?.() ?? real.loadKey(...a),
  };
});
const roots: string[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), 'pi-hindsight-retrieval-'));
  roots.push(p);
  return p;
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  deferred.loadGate = deferred.loadKey = undefined;
  delete process.env.TYPESAFE_API_KEY;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const reflects = (server: Server) =>
  server.calls.filter((c) => c.url.pathname.endsWith('/reflect'));
const replies = (count: number) =>
  Array.from({ length: count }, (_, i) => message(`reply ${i + 1}`));
const contexts = (manager: ReturnType<typeof persisted>) =>
  manager.getBranch().filter((e) => e.type === 'custom_message' && e.customType === CONTEXT_TYPE);

describe('automatic retrieval', () => {
  it('real Pi: initial ungated Reflect is redacted, persisted after the prompt, sent once, and never captured or echoed as evidence', async () => {
    const r = root(),
      server = new Server(),
      manager = persisted(r),
      memory = server.reflectText;
    const subject = await sdk(r, server, manager, [
      message(`Checked: ${memory}`),
      message('second reply'),
    ]);
    try {
      await subject.session.prompt('What was the timeout? api_key=abcdef123456');
      expect(reflects(server).map((c) => c.body)).toEqual([
        { query: 'What was the timeout? api_key=[REDACTED]', budget: 'low' },
      ]);
      const branch = manager.getBranch(),
        index = branch.findIndex((e) => e.type === 'custom_message');
      expect(branch[index - 1]).toMatchObject({ type: 'message', message: { role: 'user' } });
      expect(branch[index]).toMatchObject({
        customType: CONTEXT_TYPE,
        display: true,
        details: { hindsight: { echoTexts: [memory], trigger: 'initial' } },
      });
      expect(JSON.stringify(subject.requests[0])).toContain('untrusted historical evidence');
      expect(JSON.stringify(subject.requests[0])).toContain(memory);
      const stored = server.documents.get(`conversation:${manager.getSessionId()}`)!;
      expect(stored).toContain('What was the timeout?');
      expect(stored).not.toContain('abcdef123456');
      expect(stored).not.toContain(memory);
      expect(stored).not.toContain('untrusted historical');
      expect(stored).toContain('[memory-derived text omitted]');
      await subject.session.prompt('second prompt');
      expect(reflects(server)).toHaveLength(1);
      expect(contexts(manager)).toHaveLength(1);
    } finally {
      await subject.dispose();
    }
  });

  it('real Pi read-only: Jev gates timing only; negative/unavailable/duplicate/empty handling, pause and per-activation attempt budget', async () => {
    const r = root(),
      server = new Server(),
      manager = persisted(r),
      agentDir = join(r, 'agent');
    typesafe(agentDir, { timeoutMs: 30_000 });
    process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
    const gate = jev([0.2, 0.9, 0.9, 'error', 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
    const subject = await sdk(r, server, manager, replies(45), {
      mode: 'read-only',
      agentDir,
      jevFetch: gate.fetch,
    });
    let n = 0;
    const until = async (last: number, text?: string) => {
      if (text !== undefined) server.reflectText = text;
      while (n < last) {
        n++;
        await subject.session.prompt(n === 4 ? 'prompt 4 token=supersecret99' : `prompt ${n}`);
      }
    };
    try {
      await until(4, 'Memory A: the deploy target is staging only, per an earlier decision.');
      expect(reflects(server)).toHaveLength(1);
      expect(gate.calls).toHaveLength(0);
      await until(5);
      expect(gate.calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(gate.calls[0].body).toMatchObject({
        model: 'jev-1.13.0',
        state: { current_request: 'prompt 5', memory_already_provided: [server.reflectText] },
      });
      expect(JSON.stringify(gate.calls[0].body)).toContain('[REDACTED]');
      expect(JSON.stringify(gate.calls[0].body)).not.toContain('supersecret99');
      expect(reflects(server)).toHaveLength(1); // negative: no Reflect
      await until(9);
      await until(13, ''); // positive duplicate, positive empty: attempted, not injected
      expect(reflects(server)).toHaveLength(3);
      expect(contexts(manager)).toHaveLength(1);
      await until(21); // 17: Jev unavailable -> pause; 21: no call at all
      expect(gate.calls).toHaveLength(4);
      expect(reflects(server)).toHaveLength(3);
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
      for (const [last, text] of [
        [25, 'B'],
        [29, 'C'],
        [33, 'D'],
        [37, 'E'],
        [41, 'F'],
      ] as const)
        await until(last, `Memory ${text}: a distinct earlier decision worth recalling.`);
      await until(45); // Reflect attempt budget (8) used: no Jev or Reflect
      expect(reflects(server)).toHaveLength(8);
      expect(gate.calls).toHaveLength(9);
      expect(contexts(manager)).toHaveLength(6);
      expect(
        server.calls.every((c) => c.method === 'POST' && c.url.pathname.endsWith('/reflect')),
      ).toBe(true); // no capture, pages or Recall
    } finally {
      await subject.dispose();
    }
  });

  it(
    'real Pi: foreground detaches from abort-ignoring Reflect; settlement cancels without a failure pause; Jev stays bounded',
    { timeout: 30_000 },
    async () => {
      const r = root(),
        server = new Server(),
        manager = persisted(r),
        agentDir = join(r, 'agent');
      typesafe(agentDir, { timeoutMs: 30_000 });
      process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
      server.before = (c) =>
        c.url.pathname.endsWith('/reflect') ? new Promise<void>(() => {}) : undefined;
      const gate = jev([0.9]);
      let subject = await sdk(r, server, manager, replies(5), {
        mode: 'read-only',
        agentDir,
        jevFetch: gate.fetch,
      });
      try {
        let started = Date.now();
        await subject.session.prompt('official 20 s default is capped'); // Reflect <= 6 s
        expect(Date.now() - started).toBeGreaterThanOrEqual(5_500);
        expect(Date.now() - started).toBeLessThan(7_500);
        for (const n of [2, 3, 4, 5]) await subject.session.prompt(`prompt ${n}`);
        expect(gate.calls).toHaveLength(1);
        expect(reflects(server)).toHaveLength(2);
        expect(contexts(manager)).toHaveLength(0);
        await subject.dispose();
        const other = persisted(r);
        for (let i = 0; i < 4; i++) exchange(other, `earlier ${i}`);
        const hung = jev(['hang']);
        subject = await sdk(r, server, other, replies(1), {
          mode: 'read-only',
          agentDir,
          jevFetch: hung.fetch,
        });
        started = Date.now();
        await subject.session.prompt('Jev capped at 2 s');
        expect(Date.now() - started).toBeGreaterThanOrEqual(1_800);
        expect(Date.now() - started).toBeLessThan(3_500);
        expect(hung.calls).toHaveLength(1);
        expect(reflects(server)).toHaveLength(2);
      } finally {
        await subject.dispose();
      }
    },
  );

  it('lower official timeout is respected; stale session/config results, unsupported autoInject and the branch cap make no injection', async () => {
    const r = root(),
      server = new Server(),
      manager = persisted(r),
      path = config(r, { reflectTimeoutMs: 200 });
    const start = { type: 'before_agent_start', prompt: 'first question' } as any;
    server.before = (c) =>
      c.url.pathname.endsWith('/reflect') ? new Promise<void>(() => {}) : undefined;
    let started = Date.now();
    expect(
      await extensionFixture(manager, server, { configPath: path, mode: 'read-only' }).emit(
        'before_agent_start',
        start,
      ),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_500);
    for (const change of ['session', 'config'] as const) {
      let release!: () => void;
      server.before = (c) =>
        c.url.pathname.endsWith('/reflect')
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined;
      const ext = extensionFixture(manager, server, { configPath: config(r), mode: 'read-only' });
      const pending = ext.emit('before_agent_start', start);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (change === 'session') await ext.emit('session_before_switch');
      else config(r, { apiUrl: 'http://other.invalid' });
      release();
      expect(await pending).toBeUndefined();
    }
    server.before = undefined;
    config(r);
    const calls = server.calls.length;
    for (const autoInject of ['recall', 'pages', 'none']) {
      const ext = extensionFixture(manager, server, {
        configPath: config(r, { autoInject }),
        mode: 'read-write',
      });
      expect(await ext.emit('before_agent_start', start)).toBeUndefined();
      expect(ext.status).toContain(
        autoInject === 'none' ? 'disabled' : 'no pages/Recall substitution',
      );
    }
    const capped = persisted(r);
    for (let i = 0; i < 4; i++) exchange(capped, `earlier ${i}`);
    for (let i = 0; i < 8; i++)
      capped.appendCustomMessageEntry(CONTEXT_TYPE, `injected ${i}`, true);
    const agentDir = join(r, 'agent');
    typesafe(agentDir);
    process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
    const gate = jev([0.9]);
    const ext = extensionFixture(capped, server, {
      configPath: config(r),
      mode: 'read-only',
      agentDir,
      jevFetch: gate.fetch,
    });
    expect(await ext.emit('before_agent_start', start)).toBeUndefined();
    expect(ext.status).toContain('cap');
    expect(gate.calls).toHaveLength(0);
    expect(server.calls).toHaveLength(calls);
    // Staging was never delivery: eight orphaned late drafts must not exhaust the branch cap.
    const discarded = persisted(r);
    for (let i = 0; i < 8; i++)
      discarded.appendCustomMessageEntry(CONTEXT_TYPE, `discarded ${i}`, true, {
        hindsight: { late: true, deliveryId: `discarded-${i}` },
      });
    const available = extensionFixture(discarded, server, {
      configPath: config(r),
      mode: 'read-only',
    });
    expect((await available.emit('before_agent_start', start)).message.customType).toBe(
      CONTEXT_TYPE,
    );
    await available.emit('session_shutdown');
  });

  it('opportunity is frozen: mode/config/scope changes during async reads or a positive gate, and the 8 s wall, stop later dispatch', async () => {
    const r = root(),
      server = new Server(),
      manager = persisted(r),
      agentDir = join(r, 'agent'),
      start = { type: 'before_agent_start', prompt: 'periodic question' } as any;
    for (let i = 0; i < 4; i++) exchange(manager, `earlier ${i}`);
    typesafe(agentDir);
    process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
    const fixture = (gate: ReturnType<typeof jev>) =>
      extensionFixture(manager, server, { configPath: config(r), agentDir, jevFetch: gate.fetch });
    const hold = () => {
      let release!: () => void;
      return {
        wait: new Promise<void>((resolve) => {
          release = resolve;
        }),
        release: () => release(),
      };
    };
    // Mode off while the gate config is being read: no Jev.
    let gate = jev([0.9]),
      ext = fixture(gate),
      read = hold();
    deferred.loadGate = () =>
      read.wait.then(() => ({ kind: 'enabled', model: 'jev-1.13.0', timeoutMs: 2000 }));
    let pending = ext.emit('before_agent_start', start);
    await new Promise((resolve) => setTimeout(resolve, 5));
    ext.flags.set('hindsight-mode', 'off');
    read.release();
    expect(await pending).toBeUndefined();
    expect(gate.calls).toHaveLength(0);
    expect(server.calls).toHaveLength(0);
    deferred.loadGate = undefined;
    // Endpoint, bank or autoInject changed while a positive gate is pending: no Reflect into the new scope.
    for (const change of [
      { apiUrl: 'http://other.invalid' },
      { bankId: 'coding-agent::test:other' },
      { autoInject: 'none' },
    ]) {
      gate = jev([
        () => {
          config(r, change);
          return 0.9;
        },
      ]);
      ext = fixture(gate);
      expect(await ext.emit('before_agent_start', start)).toBeUndefined();
      expect(gate.calls).toHaveLength(1);
      expect(server.calls).toHaveLength(0);
    }
    // Local reads that outlive the pre-run deadline: the hook returns at the wall and nothing is dispatched later.
    for (const slow of ['loadGate', 'loadKey'] as const) {
      vi.useFakeTimers();
      gate = jev([0.9]);
      ext = fixture(gate);
      read = hold();
      let done = false;
      if (slow === 'loadKey')
        deferred.loadGate = async () => ({ kind: 'enabled', model: 'jev-1.13.0', timeoutMs: 2000 });
      deferred[slow] = () =>
        read.wait.then(() =>
          slow === 'loadGate'
            ? { kind: 'enabled', model: 'jev-1.13.0', timeoutMs: 2000 }
            : 'test-typesafe-key',
        );
      pending = ext.emit('before_agent_start', start).then((value: unknown) => {
        done = true;
        return value;
      });
      try {
        await vi.advanceTimersByTimeAsync(GATE_MAX_MS + REFLECT_MAX_MS);
        expect(done).toBe(true);
      } finally {
        read.release();
      }
      expect(await pending).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10);
      expect(gate.calls).toHaveLength(0);
      expect(server.calls).toHaveLength(0);
      expect(ext.status).toContain('deadline');
      vi.useRealTimers();
      deferred.loadGate = deferred.loadKey = undefined;
    }
  });
});

describe('global cross-project memory', () => {
  it('real Pi: project and global Reflect share one opportunity; capture and writes never reach the global bank', async () => {
    const r = root(),
      server = new Server(),
      manager = persisted(r),
      globalConfigPath = join(r, 'global.json');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        apiUrl: 'http://hindsight.invalid',
        bankId: GLOBAL_BANK,
        mapPathToBank: {},
        retainSessions: false,
      }),
    );
    const subject = await sdk(r, server, manager, [message('reply 1')], { globalConfigPath });
    try {
      await subject.session.prompt('How should I answer?');
      expect(
        reflects(server)
          .map((c) => decodeURIComponent(c.url.pathname))
          .sort(),
      ).toEqual(
        [`/v1/default/banks/${BANK}/reflect`, `/v1/default/banks/${GLOBAL_BANK}/reflect`].sort(),
      );
      const [context] = contexts(manager) as any[];
      expect(context.content).toContain('Repository memory');
      expect(context.content).toContain('Global cross-project memory');
      expect(context.details.hindsight.echoTexts).toEqual([server.reflectText, server.globalText]);
      expect(server.retains.map((c) => decodeURIComponent(c.url.pathname))).toEqual([
        `/v1/default/banks/${BANK}/memories`,
      ]);
      expect(JSON.stringify(server.retains[0].body)).not.toContain(server.globalText);
    } finally {
      await subject.dispose();
    }
    const ext = extensionFixture(manager, server, {
      configPath: config(r),
      globalConfigPath,
      mode: 'read-write',
    });
    await ext.tool('hindsight_reflect', { query: 'preferences?', scope: 'global' });
    expect(decodeURIComponent(reflects(server).at(-1)!.url.pathname)).toBe(
      `/v1/default/banks/${GLOBAL_BANK}/reflect`,
    );
    // A repository routed to the global bank is refused rather than written into it.
    const routed = extensionFixture(manager, server, {
      configPath: config(r, { bankId: GLOBAL_BANK }),
      globalConfigPath,
      mode: 'read-write',
    });
    const writes = server.retains.length;
    exchange(manager, 'must stay out of global');
    await routed.emit('agent_settled');
    expect(routed.status).toContain('global bank');
    expect(server.retains).toHaveLength(writes);
  });

  it('the automatic global leg honors the global autoInject and rejects a mid-flight global settings change', async () => {
    const r = root(),
      server = new Server(),
      globalConfigPath = join(r, 'global.json');
    const global = (extra = {}) =>
      writeFileSync(
        globalConfigPath,
        JSON.stringify({ apiUrl: 'http://hindsight.invalid', bankId: GLOBAL_BANK, ...extra }),
      );
    global({ autoInject: 'none' });
    const off = extensionFixture(persisted(r), server, {
      configPath: config(r),
      globalConfigPath,
      mode: 'read-only',
    });
    const injected = await off.emit('before_agent_start', {
      type: 'before_agent_start',
      prompt: 'first',
    } as any);
    expect(injected.message.details.hindsight.echoTexts).toEqual([server.reflectText]);
    expect(server.calls.some((c) => c.url.pathname.includes(encodeURIComponent(GLOBAL_BANK)))).toBe(
      false,
    );
    // Explicit global Reflect stays available.
    expect(
      JSON.stringify(
        (await off.tool('hindsight_reflect', { query: 'preferences?', scope: 'global' })).content,
      ),
    ).toContain(server.globalText);
    global();
    server.before = (c) => {
      if (c.url.pathname.endsWith('/reflect')) global({ autoInject: 'none' });
    };
    const changed = extensionFixture(persisted(root()), server, {
      configPath: config(r),
      globalConfigPath,
      mode: 'read-only',
    });
    expect(
      await changed.emit('before_agent_start', {
        type: 'before_agent_start',
        prompt: 'first',
      } as any),
    ).toBeUndefined();
    expect(changed.status).toContain('stale retrieval rejected');
  });

  it('a global failure or broken global config never blocks project retrieval', async () => {
    const r = root(),
      server = new Server(),
      globalConfigPath = join(r, 'global.json');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({ apiUrl: 'http://hindsight.invalid', bankId: GLOBAL_BANK }),
    );
    server.before = (c) => {
      if (c.url.pathname.includes(encodeURIComponent(GLOBAL_BANK))) throw new Error('global down');
    };
    const one = extensionFixture(persisted(r), server, {
      configPath: config(r),
      globalConfigPath,
      mode: 'read-only',
    });
    const injected = await one.emit('before_agent_start', {
      type: 'before_agent_start',
      prompt: 'first',
    } as any);
    expect(injected.message.details.hindsight.echoTexts).toEqual([server.reflectText]);
    expect(one.status).toContain('Reflect failed, retrieval paused');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        apiUrl: 'http://hindsight.invalid',
        template: 'x',
        mapPathToBank: { '/': 'x' },
      }),
    );
    server.before = undefined;
    const two = extensionFixture(persisted(root()), server, {
      configPath: config(r),
      globalConfigPath,
      mode: 'read-only',
    });
    expect(
      (await two.emit('before_agent_start', { type: 'before_agent_start', prompt: 'first' } as any))
        .message.details.hindsight.echoTexts,
    ).toEqual([server.reflectText]);
  });
});
