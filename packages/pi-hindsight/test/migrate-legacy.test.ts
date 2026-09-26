import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real importer process against a loopback stand-in of the 0.10.1 routes it uses.
const script = fileURLToPath(new URL('../scripts/migrate-legacy.mjs', import.meta.url));
const GLOBAL = 'coding-agent::test:global';
const CANARY = 'MIGRATION_CONTENT_CANARY';
const note = (id: string, body: string) => `## ${id} — Preference\nUpdated: 2026-09-01\nTags: style\nCue: answers\n\n${body}\n`;

class Api {
  docs = new Map<string, Map<string, any>>([['pi-memory', new Map()]]);
  ops = new Map<string, string>();
  retained: string[] = [];
  completeOnRetain = true;
  lieAboutTotal = false;
  constructor() {
    for (const [id, role] of [['d1', 'user'], ['d2', 'assistant'], ['d3', 'tool']]) {
      this.docs.get('pi-memory')!.set(id, { id, original_text: `${CANARY} span ${id} says the deploy uses blue green rollout safely`,
        document_metadata: { applicability: 'user-wide', source_role: role, source_session: 's1' }, created_at: '2026-09-01T00:00:00Z' });
    }
  }
  bank(id: string) { if (!this.docs.has(id)) this.docs.set(id, new Map()); return this.docs.get(id)!; }
  handle(method: string, url: URL, body: any): [number, unknown] {
    if (url.pathname === '/version') return [200, { api_version: '0.10.1' }];
    const m = /^\/v1\/default\/banks\/([^/]+)(\/.*)?$/.exec(url.pathname)!;
    const bank = decodeURIComponent(m[1]!), route = m[2] ?? '';
    const docs = this.bank(bank);
    const limit = Number(url.searchParams.get('limit') ?? 100), offset = Number(url.searchParams.get('offset') ?? 0);
    const page = (all: unknown[]) => [200, { items: all.slice(offset, offset + limit), total: all.length + (this.lieAboutTotal ? 1 : 0), limit, offset }] as [number, unknown];
    if (route === '/config') return [200, { config: { memory_defense: null, store_document_text: true } }];
    if (route === '/mental-models') return [200, { items: [] }];
    if (route === '/documents') return page([...docs.values()].map(({ original_text, ...rest }) => rest));
    if (route === '/memories/list') return page([]);
    if (route.startsWith('/documents/')) { const d = docs.get(decodeURIComponent(route.slice(11))); return d ? [200, d] : [404, {}]; }
    if (route.startsWith('/operations/')) {
      const id = decodeURIComponent(route.slice(12)); const status = this.ops.get(id);
      return status ? [200, { operation_id: id, status }] : [404, {}];
    }
    if (method === 'POST' && route === '/memories') {
      const item = body.items[0];
      this.retained.push(item.document_id);
      docs.set(item.document_id, { id: item.document_id, original_text: item.content, tags: item.tags, document_metadata: item.metadata });
      this.ops.set(body.operation_id, this.completeOnRetain ? 'completed' : 'pending');
      return [200, { operation_id: body.operation_id }];
    }
    return [500, {}];
  }
}

let api: Api, server: HttpServer, root: string, url: string;
beforeEach(async () => {
  api = new Api();
  server = createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      const [status, value] = api.handle(req.method!, new URL(req.url!, 'http://x'), raw ? JSON.parse(raw) : undefined);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  root = mkdtempSync(join(tmpdir(), 'pi-hindsight-migrate-'));
  for (const d of ['memory', 'sessions', 'backup', 'out']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'memory/details.md'), note('m_aaaaaaaaaa', `${CANARY} prefer concise answers`));
  writeFileSync(join(root, 'backup/details.md'), note('m_aaaaaaaaaa', `${CANARY} prefer concise answers`));
  writeFileSync(join(root, 'main.json'), JSON.stringify({ apiUrl: url, mapPathToBank: {} }));
  writeFileSync(join(root, 'global.json'), JSON.stringify({ apiUrl: url, bankId: GLOBAL, dynamicBankId: false }));
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

function run(...args: string[]): Promise<{ code: number; out: string }> {
  const base = ['--config', join(root, 'main.json'), '--global-config', join(root, 'global.json'), '--memory-root', join(root, 'memory'),
    '--sessions', join(root, 'sessions'), '--backup-stores', join(root, 'backup'), '--out-root', join(root, 'out')];
  // Caller options first: the script takes the first occurrence of an option.
  return new Promise(resolve => execFile(process.execPath, [script, ...args, ...base], { env: { PATH: process.env.PATH, HOME: root } },
    (error, stdout, stderr) => resolve({ code: error ? (error as any).code ?? 1 : 0, out: stdout + stderr })));
}
/** Apply after a fresh dry run, as the operator does: --apply must reproduce the reviewed plan. */
async function apply(...args: string[]) {
  const dry = await run(...args);
  if (dry.code) return dry;
  return run('--apply', '--expect', latest('dryrun'), ...args);
}
const latest = (mode: string) => {
  const dir = readdirSync(join(root, 'out')).filter(d => d.endsWith(mode)).sort().at(-1)!;
  return join(root, 'out', dir, 'manifest.jsonl');
};
const manifest = (mode: string) => {
  const dir = readdirSync(join(root, 'out')).find(d => d.endsWith(mode))!;
  return join(root, 'out', dir, 'manifest.jsonl');
};

describe('legacy migration importer', () => {
  it('imports, quarantines unknown speaker roles, and verifies exact content plus completed extraction', async () => {
    const applied = await apply();
    expect(applied.code, applied.out).toBe(0);
    const rows = readFileSync(manifest('apply'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows.find(r => r.source_id === 'd3')).toMatchObject({ quarantine: 'unknown source_role', destination: null });
    expect(rows.filter(r => r.outcome === 'accepted')).toHaveLength(3);
    expect(rows.every(r => r.quarantine || /^[0-9a-f]{64}$/.test(r.expected_sha256))).toBe(true);
    expect(readFileSync(manifest('apply'), 'utf8') + applied.out).not.toContain(CANARY);
    const verified = await run('--verify', manifest('apply'));
    expect(verified.code, verified.out).toBe(0);
    expect(verified.out).toContain('3  coding-agent::test:global\tok');
  });

  it('never skips a conflicting existing document and fails the run', async () => {
    api.bank(GLOBAL).set('legacy-bank:pi-memory:d1', { id: 'legacy-bank:pi-memory:d1', original_text: 'different', tags: [], document_metadata: {} });
    const applied = await apply();
    expect(applied.code).toBe(1);
    expect(api.retained).not.toContain('legacy-bank:pi-memory:d1');
    expect(api.bank(GLOBAL).get('legacy-bank:pi-memory:d1').original_text).toBe('different');
    const row = readFileSync(manifest('apply'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.source_id === 'd1');
    expect(row.outcome).toBe('CONFLICT: existing document content mismatch; not overwritten');
    // A rerun recognizes already-imported identical documents instead of resubmitting them.
    const before = api.retained.length;
    expect((await apply()).code).toBe(1);
    expect(api.retained).toHaveLength(before);
  });

  it('verify fails with counts on missing, pending and changed documents', async () => {
    api.completeOnRetain = false;
    expect((await apply()).code).toBe(0);
    const bank = api.bank(GLOBAL);
    bank.delete('legacy-bank:pi-memory:d1');
    bank.get('legacy-file:legacy-global:m_aaaaaaaaaa').original_text += ' edited';
    const verified = await run('--verify', manifest('apply'));
    expect(verified.code).toBe(1);
    expect(verified.out).toMatch(/document missing/);
    expect(verified.out).toMatch(/document content mismatch/);
    expect(verified.out).toMatch(/operation pending/);
    expect(verified.out).toContain('verification failed for 3 of 3');
    expect((await run('--verify', manifest('apply').replace('apply', 'nope'))).code).toBe(1);
  });

  it('refuses apply without the retired-source inventory and marks dry runs unverified', async () => {
    const args = ['--backup-stores', join(root, 'absent')];
    const dry = await run(...args);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain('backup stores MISSING -> UNVERIFIED');
    const applied = await run('--apply', '--expect', latest('dryrun'), ...args);
    expect(applied.code).toBe(1);
    expect(applied.out).toContain('retired-source inventory incomplete');
    expect(api.retained).toHaveLength(0);
  });

  it('refuses apply without, or with a drifted, reviewed dry-run manifest', async () => {
    const bare = await run('--apply');
    expect(bare.code).toBe(1);
    expect(bare.out).toContain('--apply requires --expect');
    expect((await run()).code).toBe(0);
    const reviewed = latest('dryrun');
    writeFileSync(join(root, 'memory/details.md'), note('m_aaaaaaaaaa', `${CANARY} prefer detailed answers`));
    const drifted = await run('--apply', '--expect', reviewed);
    expect(drifted.code).toBe(1);
    expect(drifted.out).toMatch(/plan differs from the reviewed dry run \(source_sha256 changed for curated-note /);
    expect(drifted.out).not.toContain(CANARY);
    expect((await run('--apply', '--expect', join(root, 'absent.jsonl'))).out).toContain('expected manifest unreadable');
    expect(api.retained).toHaveLength(0);
  });

  it('fails when list pages do not add up to the reported total', async () => {
    api.lieAboutTotal = true;
    const dry = await run();
    expect(dry.code).toBe(1);
    expect(dry.out).toMatch(/listed \d+ of reported \d+/);
  });
});
