import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, TELEMETRY_FILE } from '../src/telemetry.js';
import { retrievalFixture, until } from './retrieval-support.js';

const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(join(tmpdir(), 'hindsight-telemetry-'));
  roots.push(r);
  return r;
};
const rows = (dir: string): any[] =>
  readFileSync(join(dir, TELEMETRY_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

it('preserves rejected memory text and scores, and explains a selected but undelivered memory', async () => {
  const f = retrievalFixture(root(), [0.1]);
  await f.send('Prefer short answers');
  await until(() => rows(f.agentDir).some((r) => r.event === 'delivery'));
  let log = rows(f.agentDir);
  expect(log.find((r) => r.event === 'assessment_request').state.candidates.memory_0.text).toBe(
    f.server.reflectText,
  );
  expect(log.find((r) => r.event === 'assessment_result').decisions).toMatchObject([
    { score: 0.1, selected: false, reason: 'below_threshold' },
  ]);
  expect(log.find((r) => r.event === 'delivery')).toMatchObject({
    outcome: 'not_delivered',
    reason: 'none_useful',
  });

  const g = retrievalFixture(root());
  await g.send('What was decided?');
  await g.ready();
  await g.ext.emit('turn_end', {
    outcome: 'completed',
    toolResults: [],
    context: { pendingMessages: [] },
  } as any);
  await g.ext.emit('agent_settled');
  log = rows(g.agentDir);
  expect(log.find((r) => r.event === 'delivery')).toMatchObject({
    outcome: 'not_delivered',
    reason: 'agent_settled',
    lastBoundary: 'no_tool_results',
    selected: true,
    staged: false,
  });
  expect(log.filter((r) => r.event === 'delivery' && r.outcome === 'released')).toHaveLength(0);
});

it('records HTTP failure and bank without logging credentials or service response bodies', async () => {
  const f = retrievalFixture(root(), [0.9], {
    fetch: async () => new Response('SENSITIVE_SERVER_BODY', { status: 400 }),
  });
  await f.send('Find previous decisions');
  await until(() => rows(f.agentDir).some((r) => r.event === 'retrieval'));
  expect(rows(f.agentDir).find((r) => r.event === 'recall_result')).toMatchObject({
    outcome: 'error',
    reason: 'http_error',
    httpStatus: 400,
    scope: 'project',
  });
  const text = readFileSync(join(f.agentDir, TELEMETRY_FILE), 'utf8');
  expect(text).not.toContain('SENSITIVE_SERVER_BODY');
  expect(text).not.toContain('synthetic-assessment-key');
});

it('skips a live lock owner, then recovers dead and abandoned locks and reports the dropped rows', () => {
  const dir = root(),
    file = join(dir, TELEMETRY_FILE),
    lock = `${file}.lock`;
  const owner = (pid: number) => {
    mkdirSync(lock);
    writeFileSync(join(lock, `${pid}-other-writer`), '');
  };
  owner(process.pid);
  record(dir, { event: 'busy' });
  expect(existsSync(file)).toBe(false);

  rmSync(lock, { recursive: true });
  owner(spawnSync(process.execPath, ['-e', '']).pid!);
  record(dir, { event: 'after_dead_owner' });
  mkdirSync(lock); // crashed between releasing its marker and removing the directory
  record(dir, { event: 'after_abandoned' });

  expect(rows(dir)).toMatchObject([
    { event: 'after_dead_owner', droppedRows: 1 },
    { event: 'after_abandoned' },
  ]);
  expect(readdirSync(dir).sort()).toEqual([TELEMETRY_FILE]);
});
