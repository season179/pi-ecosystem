import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBankConfig, loadConfig } from '../src/upstream/config.js';

// Real setup-bank process with a stub "official runtime": deepen.js only records the private config
// it was handed. Guards the durable manual page-freshness policy (2026-09-27): a cron request in the
// source file, its harness section or its bank section must never reach the official seeder.
const script = fileURLToPath(new URL('../scripts/setup-bank.mjs', import.meta.url));
const REPO_BANK = 'coding-agent::test:repo',
  GLOBAL_BANK = 'coding-agent::test:global';
const stub = `import { readFileSync, writeFileSync } from 'node:fs';
const i = process.argv.indexOf('--config');
writeFileSync(process.env.SETUP_BANK_STUB_OUT, JSON.stringify({ argv: process.argv.slice(2), config: JSON.parse(readFileSync(process.argv[i + 1], 'utf8')),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('HINDSIGHT_'))) }));`;

let server: HttpServer, root: string, url: string, repo: string;
beforeEach(async () => {
  server = createServer((req, res) => {
    const ok =
      req.method === 'GET' &&
      /^\/v1\/default\/banks\/[^/]+\/mental-models\?limit=50$/.test(req.url!);
    res
      .writeHead(ok ? 200 : 500, { 'content-type': 'application/json' })
      .end(JSON.stringify(ok ? { items: [{ id: 'kp-1', name: 'Core concepts' }] } : {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  root = mkdtempSync(join(tmpdir(), 'pi-hindsight-setup-'));
  mkdirSync(join(root, 'runtime/dist'), { recursive: true });
  writeFileSync(join(root, 'runtime/package.json'), JSON.stringify({ version: '0.7.0' }));
  writeFileSync(join(root, 'runtime/dist/deepen.js'), stub);
  repo = join(root, 'repo');
  mkdirSync(repo);
  repo = realpathSync(repo);
  const cron = (id: string) => ({
    pageTriggerType: 'cron',
    pageTriggerCron: `${id} 3 * * *`,
    retainSessions: true,
    autoSeed: true,
  });
  writeFileSync(
    join(root, 'main.json'),
    JSON.stringify({
      apiUrl: url,
      serverMode: 'remote',
      mapPathToBank: { [repo]: REPO_BANK },
      ...cron('1'),
      harnesses: {
        'claude-code': { ...cron('2'), captureSince: '2026-09-26T00:00:00Z' },
        pi: cron('3'),
      },
      banks: { [REPO_BANK]: cron('4') },
    }),
  );
  writeFileSync(
    join(root, 'global.json'),
    JSON.stringify({
      apiUrl: url,
      bankId: GLOBAL_BANK,
      dynamicBankId: false,
      autoInject: 'pages',
      ...cron('5'),
      harnesses: { 'claude-code': cron('6') },
      banks: { [GLOBAL_BANK]: cron('7') },
    }),
  );
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

function run(...args: string[]): Promise<{ code: number; out: string; received: any }> {
  const out = join(root, 'received.json');
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      [script, '--runtime', join(root, 'runtime'), ...args],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SETUP_BANK_STUB_OUT: out,
          HINDSIGHT_PAGE_TRIGGER_TYPE: 'cron',
          HINDSIGHT_PAGE_TRIGGER_CRON: '9 * * * *',
        },
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as any).code ?? 1) : 0,
          out: stdout + stderr,
          received: JSON.parse(readFileSync(out, 'utf8')),
        }),
    ),
  );
}

describe('setup-bank page policy', () => {
  it.each([
    ['--repo', REPO_BANK, 'main.json', ['--repo', '']],
    ['--global', GLOBAL_BANK, 'global.json', ['--global']],
  ])(
    '%s: the official seeder only ever sees manual page triggers',
    async (_mode, bank, file, args) => {
      const source = join(root, file),
        before = readFileSync(source, 'utf8');
      const r = await run(...args.map((a) => a || repo), '--config', source);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`${bank}: 1 page(s): Core concepts`);
      const { config, argv, env } = r.received;
      const layers = [config, ...Object.values(config.harnesses), ...Object.values(config.banks)];
      expect(layers).toHaveLength(file === 'main.json' ? 4 : 3);
      for (const layer of layers)
        expect(layer).toMatchObject({
          pageTriggerType: 'manual',
          retainSessions: false,
          autoSeed: false,
          gitIngest: 'none',
        });
      // Effective policy as the official runtime resolves it: file over env, harness and bank sections.
      const privateConfig = argv[argv.indexOf('--config') + 1];
      writeFileSync(join(root, 'empty.json'), '{}');
      writeFileSync(join(root, 'received-config.json'), JSON.stringify(config));
      process.env.HINDSIGHT_PAGE_TRIGGER_TYPE = 'cron';
      try {
        const envOnly = loadConfig({ harness: 'claude-code', path: join(root, 'empty.json') }); // proves the env fallback is live
        const loaded = loadConfig({
          harness: 'claude-code',
          path: join(root, 'received-config.json'),
        });
        expect([
          envOnly.pageTriggerType,
          loaded.pageTriggerType,
          applyBankConfig(loaded, bank).cfg.pageTriggerType,
        ]).toEqual(['cron', 'manual', 'manual']);
      } finally {
        delete process.env.HINDSIGHT_PAGE_TRIGGER_TYPE;
      }
      expect(privateConfig).not.toBe(source);
      expect(env.HINDSIGHT_PAGE_TRIGGER_TYPE).toBeUndefined();
      expect(env.HINDSIGHT_PAGE_TRIGGER_CRON).toBeUndefined();
      expect(env.HINDSIGHT_CONFIG).toBe(privateConfig);
      // Unrelated read-write/capture settings pass through; the operator's file is untouched.
      expect(config).toMatchObject(
        file === 'main.json'
          ? {
              serverMode: 'remote',
              harnesses: { 'claude-code': { captureSince: '2026-09-26T00:00:00Z' } },
            }
          : { autoInject: 'pages' },
      );
      expect(readFileSync(source, 'utf8')).toBe(before);
    },
  );
});
