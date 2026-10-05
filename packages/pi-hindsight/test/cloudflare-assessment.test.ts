import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAssessmentConfig, loadKey } from '../src/retrieval.js';
import { TELEMETRY_FILE } from '../src/telemetry.js';
import { typesafe } from './helpers.js';
import { contexts, retrievalFixture, until } from './retrieval-support.js';

const accountId = 'a'.repeat(32);
const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hindsight-clef-'));
  roots.push(dir);
  return dir;
};
const configure = (agentDir: string, extra: Record<string, unknown> = {}) =>
  typesafe(agentDir, {
    model: 'jev-1.13.0',
    apiKeyFile: 'typesafe.key',
    hindsight: {
      enabled: true,
      provider: 'cloudflare',
      accountId,
      apiKeyFile: 'cloudflare.key',
      ...extra,
    },
  });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const result = {
  model: 'clef',
  answers: { memory_0: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 1 },
};
afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.PERSONAL_CF_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('routes Clef with its own key, unwraps its response, delivers memory and logs model identity without credentials', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = retrievalFixture(root(), [], {
    assessmentFetch: async (url, init) => {
      calls.push({ url, init });
      return response({ success: true, result });
    },
  });
  configure(f.agentDir);
  writeFileSync(join(f.agentDir, 'cloudflare.key'), 'cloudflare-transport-secret');
  await f.send('What did we decide?');
  await f.ready();
  await f.stage();
  await f.release();
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef`,
  );
  expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(
    'Bearer cloudflare-transport-secret',
  );
  expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
    model: 'clef',
    questions: { memory_0: { type: 'noul', criteria: { true: expect.any(String) } } },
  });
  expect(contexts(f.manager)).toHaveLength(1);
  const log = readFileSync(join(f.agentDir, TELEMETRY_FILE), 'utf8');
  const rows = log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const request = rows.find((r) => r.event === 'assessment_request');
  expect(request).toMatchObject({
    provider: 'cloudflare',
    model: 'clef',
    endpointHost: 'api.cloudflare.com',
    threshold: 0.7,
  });
  expect(rows.find((r) => r.event === 'assessment_response')).toMatchObject({
    job: request.job,
    responseModel: 'clef',
    modelMatches: true,
  });
  expect(rows.find((r) => r.event === 'assessment_result')).toMatchObject({
    provider: 'cloudflare',
    decisions: [{ score: 0.9, selected: true }],
  });
  for (const secret of ['cloudflare-transport-secret', 'synthetic-assessment-key', accountId])
    expect(log).not.toContain(secret);
  await f.ext.emit('agent_settled');
});

it('does not inherit TypeSafe credentials; rejects bad routes and supports the personal token alias', async () => {
  const dir = root();
  configure(dir, { apiKeyFile: undefined });
  writeFileSync(join(dir, 'typesafe.key'), 'wrong-provider-key');
  process.env.TYPESAFE_API_KEY = 'wrong-provider-env';
  const cfg = await loadAssessmentConfig(dir);
  expect(cfg).toMatchObject({ kind: 'enabled', provider: 'cloudflare', model: 'clef' });
  if (cfg.kind !== 'enabled') throw new Error('Expected enabled config');
  expect(await loadKey(dir, cfg.apiKeyFile, cfg.provider)).toBeUndefined();
  process.env.PERSONAL_CF_API_TOKEN = 'personal-token';
  writeFileSync(join(dir, 'cloudflare.key'), 'file-token');
  expect(await loadKey(dir, 'cloudflare.key', cfg.provider)).toBe('personal-token');
  process.env.CLOUDFLARE_API_TOKEN = 'canonical-token';
  expect(await loadKey(dir, 'cloudflare.key', cfg.provider)).toBe('canonical-token');
  for (const invalid of [
    { provider: 'unknown' },
    { model: 'jev-1.13.0' },
    { accountId: '../other' },
  ]) {
    configure(dir, invalid);
    expect(await loadAssessmentConfig(dir)).toEqual({ kind: 'invalid' });
  }
});

it.each([
  ['HTTP error', () => response({ message: 'PRIVATE_PROVIDER_ERROR' }, 429)],
  [
    'failed envelope with plausible answers',
    () =>
      response({
        success: false,
        result,
        errors: [{ code: 10000, message: 'PRIVATE_PROVIDER_ERROR' }],
      }),
  ],
  [
    'malformed answer',
    () =>
      response({
        success: true,
        result: { ...result, answers: { memory_0: { type: 'noul', noul: 2 } } },
      }),
  ],
  ['oversized streamed body', () => new Response(' '.repeat(33 * 1024))],
  ['abort-ignoring transport', () => new Promise<Response>(() => {})],
] as const)(
  'fails closed for Cloudflare %s without logging provider bodies',
  async (_name, reply) => {
    const f = retrievalFixture(root(), [], { assessmentFetch: async () => reply() });
    configure(f.agentDir, { timeoutMs: 50 });
    process.env.CLOUDFLARE_API_TOKEN = 'cf-test-key';
    await f.send('Find a memory');
    await until(() => f.ext.memoryStatus.includes('unavailable'));
    expect(await f.stage()).toBeUndefined();
    expect(contexts(f.manager)).toHaveLength(0);
    const log = readFileSync(join(f.agentDir, TELEMETRY_FILE), 'utf8');
    expect(log).not.toContain('PRIVATE_PROVIDER_ERROR');
    expect(log).not.toContain('cf-test-key');
    if (_name === 'failed envelope with plausible answers')
      expect(log).toContain('"errorCodes":[10000]');
    await f.ext.emit('agent_settled');
  },
);
