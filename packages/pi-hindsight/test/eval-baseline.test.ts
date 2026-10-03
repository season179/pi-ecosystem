import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Standalone operator script is intentionally not a runtime TS module.
import { parseArgs, runBaseline, FIXTURES } from '../scripts/eval-baseline.mjs';

const endpoint = 'http://127.0.0.1:8888';
const secret = 'SERVER_AND_CREDENTIAL_CANARY';
const pageId = `kp-${'1'.repeat(32)}`,
  modelId = `mm-${'2'.repeat(32)}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const limits = {
  requestMs: 200,
  waitMs: 50,
  pollMs: 1,
  maxPolls: 2,
  totalMs: 5000,
  cleanupMs: 500,
};

/** In-memory API contract, never a listener or real fetch. Unrecognized routes fail closed. */
class SyntheticServer {
  banks = new Map<
    string,
    { name: string; facts: Map<string, any>; docs: Map<string, any>; page: string }
  >();
  calls: Array<{ method: string; bank: string; route: string; body: any }> = [];
  collision = false;
  unexpectedContent = false;
  pending = false;
  lostCreateAck = false;
  lostRetainAck = false;
  refuseCleanup = false;
  ambiguous = false;
  consolidationPending = false;
  badLabels = false;
  private serial = 100;
  fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url),
      method = init.method!;
    if (u.pathname === '/version') return json({ api_version: '0.10.1' });
    if (u.pathname === '/v1/default/banks') {
      // Actual 0.10.1 list: substring filter on ID or name; other matching banks may appear too.
      const q = u.searchParams.get('q')!;
      this.calls.push({ method, bank: q, route: '?list', body: undefined });
      expect(q).toMatch(/^pi-hindsight-eval-[0-9a-f-]+-[ab]$/);
      const items = [...this.banks]
        .filter(([b]) => b.includes(q))
        .map(([b, s]) => ({
          bank_id: b,
          name: this.refuseCleanup && s.docs.size ? secret : s.name,
          fact_count: s.facts.size,
        }));
      if (this.collision) items.push({ bank_id: q, name: secret, fact_count: 3 });
      items.push({ bank_id: `${q}-other`, name: secret, fact_count: 1 });
      return json({ banks: items, total: items.length, limit: 10, offset: 0 });
    }
    const match = /^\/v1\/default\/banks\/([^/]+)(.*)$/.exec(u.pathname);
    if (!match) throw new Error(secret);
    const bank = decodeURIComponent(match[1]!),
      route = match[2]!,
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, bank, route, body });
    expect(bank).toMatch(/^pi-hindsight-eval-[0-9a-f-]+-[ab]$/);
    let state = this.banks.get(bank);
    if (route === '/profile')
      return json({ detail: 'The bank profile endpoints have been removed.' }, 410); // actual 0.10.1
    if (route === '/config' && method === 'GET')
      return state || this.collision
        ? json({ bank_id: bank, config: {}, overrides: {} })
        : json({ detail: 'not found' }, 404);
    if (method === 'PUT' && route === '') {
      expect(state).toBeUndefined();
      state = { name: body.name, facts: new Map(), docs: new Map(), page: '' };
      this.banks.set(bank, state);
      if (this.lostCreateAck) throw new Error(secret);
      return json({ bank_id: bank, name: state.name });
    }
    if (!state) return json({}, 404);
    if (route === '/stats')
      return json({
        total_nodes: this.unexpectedContent ? 1 : state.facts.size,
        total_documents: state.docs.size,
        pending_consolidation: this.consolidationPending && state.docs.size ? 1 : 0,
        failed_consolidation: 0,
        total_observations: 0,
      });
    if (method === 'GET' && ['/mental-models', '/directives'].includes(route))
      return json({ items: [], total: 0 });
    if (route === '/memories' && method === 'POST') {
      for (const item of body.items) {
        state.docs.set(item.document_id, item);
        const add = () => {
          const key = id(this.serial++);
          state!.facts.set(key, {
            id: key,
            bank_id: bank,
            document_id: item.document_id,
            text: item.content,
            state: 'valid',
            fact_type: 'world',
          });
        };
        add();
        if (this.ambiguous && item.document_id === 'eval-edit') add();
      }
      if (this.lostRetainAck) throw new Error(secret);
      return json({
        operation_id: body.operation_id,
        success: true,
        usage: { input_tokens: 11, cost_usd: 0.01, private: secret },
      });
    }
    if (route.startsWith('/operations/')) {
      if (method === 'DELETE') return json({ success: true });
      return json({
        operation_id: route.split('/').at(-1),
        status: this.pending ? 'processing' : 'completed',
        error_message: secret,
      });
    }
    if (route === '/memories/list') {
      const facts =
        u.searchParams.get('type') === 'observation'
          ? []
          : [...state.facts.values()].filter(
              (f) => f.document_id === u.searchParams.get('document_id') && f.state === 'valid',
            );
      return json({ items: facts, total: facts.length });
    }
    if (route.startsWith('/memories/')) {
      const fact = state.facts.get(route.split('/').at(-1)!);
      if (!fact) return json({}, 404);
      if (method === 'PATCH') Object.assign(fact, body);
      const { fact_type, ...detail } = fact;
      return json({ ...detail, type: fact_type }); // actual 0.10.1 detail shape
    }
    if (route === '/knowledge-base/pages' && method === 'POST') {
      state.page = '43117 CEDAR-17';
      return json({ page_id: pageId, mental_model_id: modelId, operation_id: id(this.serial++) });
    }
    if (route === `/mental-models/${modelId}/refresh`) {
      state.page = [...state.facts.values()]
        .filter((f) => f.state === 'valid')
        .map((f) => f.text)
        .join('\n');
      return json({ operation_id: id(this.serial++) });
    }
    if (route === `/knowledge-base/pages/${pageId}`)
      return json({ id: pageId, body: state.page, trace: secret });
    if (route.endsWith('/reprocess')) {
      const doc = route.split('/')[2]!;
      for (const [key, fact] of state.facts) if (fact.document_id === doc) state.facts.delete(key);
      const key = id(this.serial++);
      state.facts.set(key, {
        id: key,
        document_id: doc,
        text: state.docs.get(doc).content,
        state: 'valid',
        fact_type: 'world',
      });
      return json({ operation_id: id(this.serial++), success: true });
    }
    if (route === '/reflect') {
      // Deliberately NOT a semantic oracle: labels must never become a usefulness pass.
      const summary = this.badLabels ? secret : 'unknown';
      return json({
        text: secret,
        structured_output: { answer: summary, private: secret },
        based_on: { memories: [{ id: secret, text: secret, type: 'world' }] },
        usage: { input_tokens: 5, output_tokens: 2, private: secret },
        trace: secret,
      });
    }
    if (method === 'DELETE' && route === '') {
      this.banks.delete(bank);
      return json({ success: true, message: secret });
    }
    throw new Error(secret);
  };
}
function run(server: SyntheticServer, extra: Record<string, unknown> = {}) {
  return runBaseline(
    { run: true, endpoint, token: secret },
    { fetch: server.fetch, limits, ...extra },
  );
}

describe('synthetic baseline operator boundary', () => {
  it('default CLI and import perform no network; unsafe endpoints and arbitrary bank selection are rejected', async () => {
    const fetch = vi.fn(() => {
      throw new Error('must not run');
    });
    expect((await runBaseline({}, { fetch })).mode).toBe('dry-run');
    expect(fetch).not.toHaveBeenCalled();
    const script = fileURLToPath(new URL('../scripts/eval-baseline.mjs', import.meta.url));
    const cli = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, HINDSIGHT_EVAL_TOKEN: secret },
    });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout).network).toBe(false);
    expect(cli.stdout).not.toContain(secret);
    for (const bad of [
      'https://example.com:8888',
      'http://localhost:8888',
      'http://127.0.0.1',
      'http://user:secret@127.0.0.1:8888',
      'http://127.0.0.1:8888/api',
      'http://127.0.0.1:8888?token=secret',
    ]) {
      expect(() => parseArgs(['--run', '--endpoint', bad])).toThrow();
    }
    expect(() => parseArgs(['--run'])).toThrow();
    expect(() => parseArgs(['--run', '--endpoint', endpoint, '--bank', 'pi-memory'])).toThrow();
    expect(parseArgs(['--apply', '--endpoint', endpoint]).run).toBe(true);
  });

  it('exercises both harnesses, qualifiers, isolation, curation, derivatives and unsafe source replay without claiming semantic success', async () => {
    const server = new SyntheticServer(),
      report = await run(server);
    expect(report.status).toBe('completed-needs-manual-assessment');
    expect(report.cases).toHaveLength(14);
    expect(report.cases.map((r: any) => r.id)).toEqual(
      expect.arrayContaining([
        'must-find-pi',
        'must-find-claude',
        'indirect',
        'qualifier',
        'speaker-uncertainty',
        'unrelated-abstention',
        'isolation-negative',
        'isolation-positive',
        'after-edit',
        'after-invalidate',
        'replay-edit',
        'replay-invalidate',
      ]),
    );
    expect(report.cases.every((r: any) => r.assessment === 'manual-review-required')).toBe(true);
    expect(report.cases.find((r: any) => r.id === 'must-find-pi').labelAgreement).toBe(false);
    expect(report.curation.map((r: any) => r.status)).toEqual([
      'verified-fact-only',
      'verified-fact-only',
    ]);
    expect(report.derivatives.map((r: any) => r.page.oldPort)).toEqual([true, false, true]);
    expect(report.derivatives.map((r: any) => r.page.retiredCode)).toEqual([true, false, true]);
    expect(
      report.derivatives.map(
        (r: any) => r.sourceFacts.find((f: any) => f.kind === 'invalidate').total,
      ),
    ).toEqual([1, 0, 1]);
    expect(
      report.operations
        .filter((r: any) => r.phase === 'retain-extraction')
        .every((r: any) => r.acceptance === 'accepted' && r.extraction === 'completed'),
    ).toBe(true);
    const retained = server.calls
      .filter((c) => c.route === '/memories')
      .flatMap((c) => c.body.items);
    expect(retained.map((i) => i.content)).toEqual(FIXTURES.map((f: any) => f.content));
    expect(retained.flatMap((i) => i.tags)).toEqual(
      expect.arrayContaining(['harness:pi', 'harness:claude']),
    );
    expect(
      server.calls
        .filter((c) => c.route === '/reflect')
        .every((c) => c.body.budget === 'low' && !c.body.tags && !c.body.fact_types),
    ).toBe(true);
    expect(server.calls.some((c) => c.route.includes('recall'))).toBe(false);
    expect(report.cleanupComplete).toBe(true);
    expect(server.banks.size).toBe(0);
    expect(report.requests.find((r: any) => r.operation === 'retain').usage.cost_usd).toBe(0.01);
    expect(report.cases[0].usage).toEqual({ input_tokens: 5, output_tokens: 2 });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('never updates or deletes a colliding preexisting bank', async () => {
    const server = new SyntheticServer();
    server.collision = true;
    const report = await run(server);
    expect(report.error).toBe('bank-collision');
    expect(
      server.calls.every((c) => c.method === 'GET' && ['/config', '?list'].includes(c.route)),
    ).toBe(true);
    expect(server.calls.some((c) => c.route === '/profile')).toBe(false);
    expect(report.cleanup).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(secret);
    const raced = new SyntheticServer();
    raced.unexpectedContent = true;
    const refused = await run(raced);
    expect(refused.error).toBe('new-bank-not-empty');
    expect(refused.cleanupComplete).toBe(false);
    expect(refused.cleanup[0].status).toBe('refused-unexpected-preexisting-content');
    expect(raced.calls.some((c) => c.method === 'DELETE' || c.route === '/memories')).toBe(false);
  });

  it('recovers an ambiguous create only through matching ownership and refuses changed ownership', async () => {
    const lost = new SyntheticServer();
    lost.lostCreateAck = true;
    const report = await run(lost);
    expect(report.error).toBe('transport-or-response-error');
    expect(report.cleanupComplete).toBe(true);
    expect(lost.banks.size).toBe(0);
    const changed = new SyntheticServer();
    changed.refuseCleanup = true;
    const refused = await run(changed);
    expect(refused.cleanupComplete).toBe(false);
    expect(changed.banks.size).toBe(2);
    expect(changed.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(refused.cleanup.every((r: any) => r.status === 'refused-ownership-mismatch')).toBe(true);
  });

  it('bounds pending extraction, does not call Reflect prematurely, and cancels owned work during cleanup', async () => {
    const server = new SyntheticServer();
    server.pending = true;
    const report = await run(server);
    expect(report.status).toBe('incomplete-extraction');
    expect(report.error).toBeUndefined();
    expect(
      report.operations.every((r: any) => r.extraction === 'pending-at-deadline' && r.polls <= 2),
    ).toBe(true);
    expect(server.calls.some((c) => c.route === '/reflect')).toBe(false);
    expect(
      server.calls.filter((c) => c.method === 'DELETE' && c.route.startsWith('/operations/')),
    ).toHaveLength(2);
    expect(report.cleanupComplete).toBe(true);
  });

  it('tracks unknown retain acceptance without retrying and keeps consolidation separate from extraction', async () => {
    const server = new SyntheticServer();
    server.lostRetainAck = true;
    const report = await run(server);
    expect(report.operations[0]).toMatchObject({ acceptance: 'unknown', extraction: 'unknown' });
    expect(server.calls.filter((c) => c.method === 'POST' && c.route === '/memories')).toHaveLength(
      1,
    );
    expect(
      server.calls.some((c) => c.method === 'DELETE' && c.route.startsWith('/operations/')),
    ).toBe(true);
    expect(report.cleanupComplete).toBe(true);
    const pending = new SyntheticServer();
    pending.consolidationPending = true;
    const waiting = await run(pending);
    expect(waiting.status).toBe('incomplete-async');
    expect(waiting.consolidation.every((r: any) => r.status === 'pending-at-deadline')).toBe(true);
    expect(
      waiting.operations
        .filter((r: any) => r.phase === 'retain-extraction')
        .every((r: any) => r.extraction === 'completed'),
    ).toBe(true);
  });

  it('refuses ambiguous curation rather than deleting supporting facts and drops non-allowlisted model output', async () => {
    const server = new SyntheticServer();
    server.ambiguous = true;
    server.badLabels = true;
    const report = await run(server);
    expect(report.curation[0].status).toBe('ambiguous-or-missing-target');
    expect(report.cases.find((r: any) => r.id === 'after-edit').status).toBe(
      'blocked-curation-not-verified',
    );
    expect(report.cases.find((r: any) => r.id === 'replay-edit').status).toBe(
      'blocked-curation-not-verified',
    );
    expect(server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(server.calls.some((c) => c.route === '/documents/eval-edit/reprocess')).toBe(false);
    expect(report.cases[0].summary).toBeNull();
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('bounds fetches ignoring abort and never dispatches late work; unsupported versions have no mutations', async () => {
    let calls = 0;
    const report = await runBaseline(
      { run: true, endpoint },
      {
        limits: { ...limits, requestMs: 5 },
        fetch: () => {
          calls++;
          return new Promise(() => {});
        },
      },
    );
    expect(report.error).toBe('request-deadline');
    expect(calls).toBe(1);
    expect(report.cleanup).toEqual([]);
    const fetch = vi.fn(async () => json({ api_version: '0.11.0', token: secret }));
    const unsupported = await runBaseline({ run: true, endpoint }, { fetch });
    expect(unsupported.error).toBe('unsupported-api-version');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(unsupported)).not.toContain(secret);
    const oversized = await runBaseline(
      { run: true, endpoint },
      { fetch: async () => new Response('x'.repeat(1_048_577)) },
    );
    expect(oversized.error).toBe('response-too-large');
    expect(oversized.cleanup).toEqual([]);
    const server = new SyntheticServer(),
      controller = new AbortController();
    const interrupted = await run(server, {
      signal: controller.signal,
      fetch: (url: string, init: RequestInit) => {
        if (url.endsWith('/memories') && init.method === 'POST') {
          controller.abort();
          return new Promise(() => {});
        }
        return server.fetch(url, init);
      },
    });
    expect(interrupted.error).toBe('interrupted');
    expect(interrupted.cleanupComplete).toBe(true);
    expect(server.banks.size).toBe(0);
  });
});
