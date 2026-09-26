import { beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Standalone operator script, not a runtime TS module.
import { decide } from '../scripts/claude-stop-guard.mjs';

const guard = fileURLToPath(new URL('../scripts/claude-stop-guard.mjs', import.meta.url));
const CUT = '2026-09-26T12:00:00Z';
const config = (cutoff: unknown = CUT) => JSON.stringify({ apiUrl: 'http://127.0.0.1:1', harnesses: { 'claude-code': { captureSince: cutoff } } });
const line = (ts: string, extra = {}) => JSON.stringify({ type: 'user', sessionId: 's1', timestamp: ts, message: { content: 'hi' }, ...extra });
const input = { hook_event_name: 'Stop', session_id: 's1', transcript_path: '/t', cwd: '/r' };

describe('Claude Stop guard decision', () => {
  it('forwards fresh sessions and refuses pre-cutover, resumed or undated ones', () => {
    expect(decide(input, config(), [JSON.stringify({ type: 'mode' }), line('2026-09-26T12:00:01Z')].join('\n'))).toBe('forward');
    // Resumed pre-cutover session: new post-cutover turns appended to an old file.
    expect(decide(input, config(), [line('2026-09-20T08:00:00Z'), line('2026-09-26T13:00:00Z')].join('\n'))).toBe('pre-cutover session');
    expect(decide(input, config(), JSON.stringify({ type: 'mode' }))).toBe('session start unknown');
    expect(decide(input, config(), [line('2026-09-26T13:00:00Z'), line('2026-09-26T13:00:01Z', { sessionId: 'other' })].join('\n'))).toBe('foreign session entries');
    expect(decide(input, config(), undefined)).toBe('transcript unreadable');
  });
  it('fails closed on missing/invalid cutoff config and unexpected input', () => {
    expect(decide(input, config(null), line('2026-09-27T00:00:00Z'))).toBe('captureSince missing or invalid');
    expect(decide(input, config('yesterday'), line('2026-09-27T00:00:00Z'))).toBe('captureSince missing or invalid');
    expect(decide(input, '{not json', line('2026-09-27T00:00:00Z'))).toBe('config unreadable');
    expect(decide({ ...input, hook_event_name: 'SubagentStop' }, config(), line('2026-09-27T00:00:00Z'))).toBe('unexpected hook input');
  });
});

describe('Claude Stop guard process', () => {
  let root: string, official: string, pin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-hindsight-guard-'));
    mkdirSync(join(root, '.hindsight'));
    official = join(root, 'official.mjs');
    // Stand-in official hook: records the exact stdin bytes it received.
    writeFileSync(official, `import { writeFileSync } from 'node:fs'; let s=''; process.stdin.on('data', d => s += d).on('end', () => { writeFileSync(${JSON.stringify(join(root, 'forwarded'))}, s); process.exit(3); });`);
    pin = createHash('sha256').update(readFileSync(official)).digest('hex');
    writeFileSync(join(root, '.hindsight/coding-agent.json'), config());
  });
  const run = (payload: string, sha = pin): Promise<number> => new Promise(resolve => {
    const child = execFile(process.execPath, [guard, '--official', official, '--sha256', sha], { env: { PATH: process.env.PATH, HOME: root } },
      error => resolve(error ? (error as any).code : 0));
    child.stdin!.end(payload);
  });
  const payload = (transcript: string) => {
    writeFileSync(join(root, 't.jsonl'), transcript);
    return `${JSON.stringify({ ...input, transcript_path: join(root, 't.jsonl') })}\n`;
  };

  it('forwards unchanged stdin to the pinned hook and propagates its status', async () => {
    const body = payload(line('2026-09-26T12:30:00Z'));
    expect(await run(body)).toBe(3);
    expect(readFileSync(join(root, 'forwarded'), 'utf8')).toBe(body);
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
    expect(await run(`{"hook_event_name":"Stop","session_id":"s1","pad":"${'x'.repeat(1024 * 1024)}"}`)).toBe(0);
    expect(existsSync(join(root, 'forwarded'))).toBe(false);
    const log = join(root, '.hindsight/coding-agents-logs/stop-guard.jsonl');
    expect(readFileSync(log, 'utf8')).toContain('unexpected hook input');
    writeFileSync(log, 'x'.repeat(2 * 1024 * 1024));
    expect(await run(payload(line('2026-09-01T00:00:00Z')))).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('pre-cutover session');
    expect(existsSync(`${log}.1`)).toBe(true);
  });
});
