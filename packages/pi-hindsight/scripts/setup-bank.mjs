#!/usr/bin/env node
// Explicit Knowledge Page / bank setup (plan stage 5). Local operator script, not shipped.
// Runs the official 0.7.0 deepen.js with a private copy of the config that forbids transcript
// import, git ingest, survey and auto-update, so only the additive bank config + page seeding run.
//   node scripts/setup-bank.mjs --repo <path>     (repository must be explicitly mapped)
//   node scripts/setup-bank.mjs --global          (static bank from the global config file)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/upstream/config.js';
import { deriveBankIdOrSkip } from '../dist/upstream/bank.js';
import { HindsightClient } from '../dist/upstream/client.js';

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const HOME = homedir();
const RUNTIME = option('runtime') ?? join(HOME, '.hindsight/coding-agents');
const HARNESS = 'claude-code';
const die = message => { console.error(`setup-bank: ${message}`); process.exit(1); };
// Forced everywhere a harness or bank section could re-enable them (sections shallow-merge).
const SAFE = { retainSessions: false, gitIngest: 'none', autoSeed: false, codebaseSurvey: false, autoUpdate: false };

const global = argv.includes('--global');
const repoArg = option('repo');
if (global === Boolean(repoArg)) die('pass exactly one of --repo <path> or --global');
const source = option('config') ?? (global ? join(HOME, '.hindsight/coding-agent-global.json') : join(HOME, '.hindsight/coding-agent.json'));

const version = JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')).version;
if (version !== '0.7.0') die(`official runtime ${version} is not the reviewed 0.7.0`);

const cfg = loadConfig({ harness: HARNESS, path: source });
if (cfg.explicitApiUrl !== cfg.apiUrl) die('config needs an explicit apiUrl');
if (cfg.disabled) die('config is disabled');
let bank, repo;
if (global) {
  if (!cfg.bankId || cfg.dynamicBankId || Object.keys(cfg.mapPathToBank ?? {}).length) die('global config must be one static bankId with no mapPathToBank');
  bank = cfg.bankId;
} else {
  repo = realpathSync(repoArg);
  bank = deriveBankIdOrSkip(cfg, repo, HARNESS);
  if (!bank || !Object.values(cfg.mapPathToBank ?? {}).includes(bank)) die('repository is not explicitly mapped in mapPathToBank');
}
if (bank === 'pi-memory') die('refusing the legacy pi-memory bank');

const raw = JSON.parse(readFileSync(source, 'utf8'));
const safe = { ...raw, ...SAFE };
for (const key of ['harnesses', 'banks']) {
  if (safe[key] && typeof safe[key] === 'object') {
    safe[key] = Object.fromEntries(Object.entries(safe[key]).map(([k, v]) => [k, v && typeof v === 'object' ? { ...v, ...SAFE } : v]));
  }
}
const dir = mkdtempSync(join(tmpdir(), 'hindsight-setup-')); // 0700
const tmpConfig = join(dir, 'config.json');
let status;
try {
  writeFileSync(tmpConfig, JSON.stringify(safe), { mode: 0o600 });
  // --global has no repository: an empty private directory, with the bank passed explicitly.
  const args = [join(RUNTIME, 'dist/deepen.js'), '--repo', repo ?? dir, '--config', tmpConfig, '--harness', HARNESS, '--git-ingest', 'none', ...(global ? ['--bank', bank] : [])];
  const run = spawnSync(process.execPath, args, {
    env: { ...process.env, HINDSIGHT_CONFIG: tmpConfig, HINDSIGHT_DISABLE_HOOKS: '1' },
    encoding: 'utf8', timeout: 10 * 60_000,
  });
  status = run.status;
  // deepen logs bank/step lines only; forward them for the operator.
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
} finally { rmSync(dir, { recursive: true, force: true }); }
if (status !== 0) die(`official deepen.js exited ${status}`);

const client = new HindsightClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, bank, observationScopes: cfg.observationScopes,
  guard: () => {}, signal: AbortSignal.timeout(30_000) });
const pages = await client.request('GET', client.bankUrl('/mental-models?limit=50'));
const names = (pages?.items ?? []).map(p => p.name).filter(Boolean).sort();
if (!names.length) die(`bank ${bank}: no Knowledge Pages after setup`);
console.log(`setup-bank: ${bank}: ${names.length} page(s): ${names.join(', ')}`);
