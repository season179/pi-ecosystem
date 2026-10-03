import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Standalone operator script, not a runtime TS module.
import { decide } from '../scripts/claude-stop-guard.mjs';

const BANK = 'coding-agent::test:guard';

const guard = fileURLToPath(new URL('../scripts/claude-stop-guard.mjs', import.meta.url));
const CUT = '2026-09-26T12:00:00Z';
const config = (cutoff: unknown = CUT) =>
  JSON.stringify({
    apiUrl: 'http://127.0.0.1:1',
    harnesses: { 'claude-code': { captureSince: cutoff } },
  });
const line = (ts: string, extra = {}) =>
  JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp: ts,
    message: { content: 'hi' },
    ...extra,
  });
const input = { hook_event_name: 'Stop', session_id: 's1', transcript_path: '/t', cwd: '/r' };

describe('Claude Stop guard decision', () => {
  it('forwards fresh sessions and refuses pre-cutover, resumed or undated ones', () => {
    expect(
      decide(
        input,
        config(),
        [JSON.stringify({ type: 'mode' }), line('2026-09-26T12:00:01Z')].join('\n'),
      ),
    ).toBe('forward');
    // Resumed pre-cutover session: new post-cutover turns appended to an old file.
    expect(
      decide(
        input,
        config(),
        [line('2026-09-20T08:00:00Z'), line('2026-09-26T13:00:00Z')].join('\n'),
      ),
    ).toBe('pre-cutover session');
    expect(decide(input, config(), JSON.stringify({ type: 'mode' }))).toBe('session start unknown');
    expect(
      decide(
        input,
        config(),
        [line('2026-09-26T13:00:00Z'), line('2026-09-26T13:00:01Z', { sessionId: 'other' })].join(
          '\n',
        ),
      ),
    ).toBe('foreign session entries');
    expect(decide(input, config(), undefined)).toBe('transcript unreadable');
  });
  it('fails closed on missing/invalid cutoff config and unexpected input', () => {
    expect(decide(input, config(null), line('2026-09-27T00:00:00Z'))).toBe(
      'captureSince missing or invalid',
    );
    expect(decide(input, config('yesterday'), line('2026-09-27T00:00:00Z'))).toBe(
      'captureSince missing or invalid',
    );
    expect(decide(input, '{not json', line('2026-09-27T00:00:00Z'))).toBe('config unreadable');
    expect(
      decide({ ...input, hook_event_name: 'SubagentStop' }, config(), line('2026-09-27T00:00:00Z')),
    ).toBe('unexpected hook input');
  });
});

describe('Claude Stop guard process', () => {
  let root: string,
    official: string,
    pin: string,
    server: Server,
    facts: Array<Record<string, unknown>>,
    lists: URL[],
    listStatus: number;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'pi-hindsight-guard-'));
    mkdirSync(join(root, '.hindsight'));
    official = join(root, 'official.mjs');
    // Stand-in official hook: records the exact stdin bytes it received.
    writeFileSync(
      official,
      `import { writeFileSync } from 'node:fs'; let s=''; process.stdin.on('data', d => s += d).on('end', () => { writeFileSync(${JSON.stringify(join(root, 'forwarded'))}, s); process.exit(3); });`,
    );
    pin = createHash('sha256').update(readFileSync(official)).digest('hex');
    // Loopback 0.10.1 memory list: state=invalidated reads the archive, default lists live facts.
    facts = [];
    lists = [];
    listStatus = 200;
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      lists.push(url);
      const archive = url.searchParams.get('state') === 'invalidated';
      const items = facts.filter(
        (f) =>
          f.document_id === url.searchParams.get('document_id') &&
          (f.state === 'invalidated') === archive,
      );
      res
        .writeHead(
          url.pathname === `/v1/default/banks/${encodeURIComponent(BANK)}/memories/list`
            ? listStatus
            : 404,
          { 'content-type': 'application/json' },
        )
        .end(JSON.stringify({ items, total: items.length, limit: 200, offset: 0 }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${(server.address() as any).port}`;
    writeFileSync(
      join(root, '.hindsight/coding-agent.json'),
      JSON.stringify({
        apiUrl: api,
        mapPathToBank: { [root]: BANK },
        harnesses: { 'claude-code': { captureSince: CUT } },
      }),
    );
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));
  const run = (payload: string, sha = pin): Promise<number> =>
    new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [guard, '--official', official, '--sha256', sha],
        { env: { PATH: process.env.PATH, HOME: root } },
        (error) => resolve(error ? (error as any).code : 0),
      );
      child.stdin!.end(payload);
    });
  const payload = (transcript: string) => {
    writeFileSync(join(root, 't.jsonl'), transcript);
    return `${JSON.stringify({ ...input, cwd: root, transcript_path: join(root, 't.jsonl') })}\n`;
  };

  it('forwards unchanged stdin to the pinned hook and propagates its status', async () => {
    const body = payload(line('2026-09-26T12:30:00Z'));
    expect(await run(body)).toBe(3);
    expect(readFileSync(join(root, 'forwarded'), 'utf8')).toBe(body);
    // The curation read went to the bank the official hook resolves, filtered to this session's source.
    expect(lists.map((u) => u.searchParams.get('document_id'))).toEqual([
      'conversation:s1',
      'conversation:s1',
    ]);
  });
  it('refuses replay when the session source has edited or invalidated facts, or the check fails', async () => {
    const log = join(root, '.hindsight/coding-agents-logs/stop-guard.jsonl');
    facts = [
      {
        id: 'f1',
        document_id: 'conversation:s1',
        text: 'SECRET_FACT_TEXT',
        state: 'valid',
        edited_at: '2026-09-26T13:00:00Z',
      },
    ];
    expect(await run(payload(line('2026-09-26T12:30:00Z')))).toBe(0);
    facts = [
      { id: 'f2', document_id: 'conversation:s1', text: 'SECRET_FACT_TEXT', state: 'invalidated' },
    ];
    expect(await run(payload(line('2026-09-26T12:30:00Z')))).toBe(0);
    facts = [];
    listStatus = 500;
    expect(await run(payload(line('2026-09-26T12:30:00Z')))).toBe(0);
    expect(existsSync(join(root, 'forwarded'))).toBe(false);
    const text = readFileSync(log, 'utf8');
    expect(text.match(/curated source facts/g)).toHaveLength(2);
    expect(text).toContain('curation check failed');
    expect(text).not.toContain('SECRET_FACT_TEXT');
    expect(statSync(log).mode & 0o777).toBe(0o600);
    // Facts of OTHER sessions never block this one.
    facts = [{ id: 'f3', document_id: 'conversation:other', text: 'x', state: 'invalidated' }];
    listStatus = 200;
    expect(await run(payload(line('2026-09-26T12:30:00Z')))).toBe(3);
  });
  it('skips pre-cutover sessions and changed official hooks with exit 0 and a metadata log', async () => {
    expect(await run(payload(line('2026-09-01T00:00:00Z')))).toBe(0);
    expect(await run(payload(line('2026-09-26T12:30:00Z')), '0'.repeat(64))).toBe(0);
    expect(existsSync(join(root, 'forwarded'))).toBe(false);
    const log = readFileSync(join(root, '.hindsight/coding-agents-logs/stop-guard.jsonl'), 'utf8');
    expect(log).toContain('pre-cutover session');
    expect(log).toContain('official hook changed');
    expect(log).not.toContain('hi');
  });
  it('fails closed on oversized hook input and rotates its metadata log', async () => {
    expect(
      await run(`{"hook_event_name":"Stop","session_id":"s1","pad":"${'x'.repeat(1024 * 1024)}"}`),
    ).toBe(0);
    expect(existsSync(join(root, 'forwarded'))).toBe(false);
    const log = join(root, '.hindsight/coding-agents-logs/stop-guard.jsonl');
    expect(readFileSync(log, 'utf8')).toContain('unexpected hook input');
    writeFileSync(log, 'x'.repeat(2 * 1024 * 1024));
    expect(await run(payload(line('2026-09-01T00:00:00Z')))).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('pre-cutover session');
    expect(existsSync(`${log}.1`)).toBe(true);
  });
});
