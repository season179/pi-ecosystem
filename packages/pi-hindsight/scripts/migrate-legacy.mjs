#!/usr/bin/env node
// Legacy pi-memory -> per-repository Hindsight banks (plan stage 7). Local operator script, not shipped.
// Dry run by default. Prints counts only and writes a content-free manifest; memory text is
// processed locally and never printed. Sources (files, old bank, transcripts, backup) are read-only.
//   node scripts/migrate-legacy.mjs [--apply] [--backup-stores <dir>]
//   node scripts/migrate-legacy.mjs --plan-map <json> --plan-global-bank <id>   (dry-run preview before config edits)
//   node scripts/migrate-legacy.mjs --verify <manifest.jsonl>
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../dist/upstream/config.js';
import { deriveBankIdOrSkip } from '../dist/upstream/bank.js';
import { HindsightClient } from '../dist/upstream/client.js';
import { uuidV5 } from '../dist/upstream/uuid.js';
import { redact } from '../dist/safety.js';
import { parseDetails } from '../../pi-memory/dist/store.js';
import { resolveProjectIdentity } from '../../pi-memory/dist/identity.js';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const HOME = homedir();
const MEMORY_ROOT = option('memory-root') ?? join(HOME, '.pi/agent/pi-memory');
const SESSIONS = option('sessions') ?? join(HOME, '.pi/agent/sessions');
const BACKUP_STORES = option('backup-stores') ?? join(HOME, '.hindsight/backups/20260926T090722Z/files/pi-memory');
const MAIN_CONFIG = option('config') ?? join(HOME, '.hindsight/coding-agent.json');
const GLOBAL_CONFIG = option('global-config') ?? join(HOME, '.hindsight/coding-agent-global.json');
const OLD_BANK = 'pi-memory';
const RETIRED_MATCH = 0.6, RETIRED_MARGIN = 0.1, MIN_TOKENS = 8;

const sha = text => createHash('sha256').update(text).digest('hex');
const tokens = text => new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []);
const containment = (a, b) => { if (!a.size) return 0; let n = 0; for (const t of a) if (b.has(t)) n++; return n / a.size; };
const die = message => { console.error(`migrate-legacy: ${message}`); process.exit(1); };

function client(cfg, bank) {
  return new HindsightClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, bank, observationScopes: cfg.observationScopes,
    guard: () => {}, signal: AbortSignal.timeout(60_000) });
}
const get = (cfg, bank, suffix) => { const c = client(cfg, bank); return c.request('GET', c.bankUrl(suffix)); };

function writer(path) {
  const fd = openSync(path, 'wx', 0o600);
  return { row: value => writeSync(fd, `${JSON.stringify(value)}\n`), close: () => closeSync(fd) };
}

if (option('verify')) await verify(option('verify'));
else await migrate(flag('apply'));

async function migrate(apply) {
  const main = loadConfig({ harness: 'pi', path: MAIN_CONFIG });
  if (main.explicitApiUrl !== main.apiUrl) die('main config needs an explicit apiUrl');
  // Dry run only: preview planned (not yet live) repository mappings and global bank.
  if (option('plan-map')) { if (apply) die('--plan-map is dry-run only'); main.mapPathToBank = { ...main.mapPathToBank, ...JSON.parse(readFileSync(option('plan-map'), 'utf8')) }; }
  if (!existsSync(GLOBAL_CONFIG) && (apply || !option('plan-global-bank'))) die(`global config missing: ${GLOBAL_CONFIG}`);
  const global = existsSync(GLOBAL_CONFIG) ? loadConfig({ harness: 'pi', path: GLOBAL_CONFIG })
    : { apiUrl: main.apiUrl, bankId: option('plan-global-bank'), mapPathToBank: {} };
  const globalBank = global.bankId;
  if (!globalBank || global.dynamicBankId || Object.keys(global.mapPathToBank ?? {}).length || global.apiUrl !== main.apiUrl) die('global config must be one static bank on the same endpoint');

  // Repository -> bank only through an explicit mapPathToBank entry (never the basename default).
  const map = main.mapPathToBank ?? {};
  const bankFor = repo => {
    const id = deriveBankIdOrSkip(main, repo, 'pi', repo);
    const explicit = Object.entries(map).some(([path, bank]) => bank === id && (repo === path || repo.startsWith(`${path}/`)));
    return explicit && id !== globalBank && id !== OLD_BANK ? id : undefined;
  };

  // Identity hash (16 hex, as tagged by pi-memory) -> identity, from store sidecars and Pi session cwds.
  const identities = new Map();
  const remember = identity => identities.set(identity.identityHash.replace(/^sha256:/, '').slice(0, 16), identity);
  const stores = existsSync(join(MEMORY_ROOT, 'projects')) ? readdirSync(join(MEMORY_ROOT, 'projects')) : [];
  for (const dir of stores) remember(JSON.parse(readFileSync(join(MEMORY_ROOT, 'projects', dir, 'project.json'), 'utf8')));
  const sessionFiles = readdirSync(SESSIONS, { recursive: true }).filter(f => String(f).endsWith('.jsonl')).map(f => join(SESSIONS, String(f)));
  const cwds = new Set();
  for (const file of sessionFiles) {
    try { const header = JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]); if (typeof header.cwd === 'string') cwds.add(header.cwd); } catch { /* skip */ }
  }
  for (const cwd of cwds) if (existsSync(cwd)) { const id = await resolveProjectIdentity(cwd); if (id.status === 'ok') remember(id); }
  const destinationOf = hash16 => {
    const id = identities.get(hash16);
    if (!id) return { quarantine: 'unknown project identity' };
    // Plain directories migrate only when explicitly mapped; $HOME and the Pi agent dir are never projects.
    const path = id.kind === 'git-common-dir' && basename(id.canonicalIdentity) === '.git' ? dirname(id.canonicalIdentity) : id.canonicalIdentity;
    if (id.kind !== 'git-common-dir' && (path === HOME || path === join(HOME, '.pi') || path.startsWith(join(HOME, '.pi') + '/'))) return { quarantine: 'home or Pi agent directory, not a project' };
    const bank = bankFor(path);
    return bank ? { bank } : { quarantine: `${id.kind === 'git-common-dir' ? 'repository' : 'directory'} not explicitly mapped` };
  };

  // Current curated notes, plus retired/superseded versions (deletion/replacement intent).
  const current = new Map(); // id -> body
  const curated = [];
  const readStore = (dir, storeKey, dest) => {
    const path = join(dir, 'details.md');
    if (!existsSync(path)) return;
    for (const memory of parseDetails(readFileSync(path, 'utf8'))) { current.set(memory.id, memory.body); curated.push({ memory, storeKey, dest }); }
  };
  readStore(MEMORY_ROOT, 'legacy-global', { bank: globalBank });
  for (const dir of stores) {
    const id = JSON.parse(readFileSync(join(MEMORY_ROOT, 'projects', dir, 'project.json'), 'utf8'));
    readStore(join(MEMORY_ROOT, 'projects', dir), dir, destinationOf(id.identityHash.replace(/^sha256:/, '').slice(0, 16)));
  }
  const retired = []; // { body, currentBody? }
  const retire = (id, body) => { if (typeof body === 'string' && body !== current.get(id)) retired.push({ tokens: tokens(body), current: current.has(id) ? tokens(current.get(id)) : undefined }); };
  for (const file of sessionFiles) {
    let text; try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes('"remember"')) continue;
    for (const line of text.split('\n')) {
      if (!line.includes('"toolName":"remember"')) continue;
      try {
        const m = JSON.parse(line).message;
        if (m?.role === 'toolResult' && m.toolName === 'remember' && !m.isError && m.details?.memory?.id) retire(m.details.memory.id, m.details.memory.body);
      } catch { /* torn line */ }
    }
  }
  if (existsSync(BACKUP_STORES)) {
    const dirs = [BACKUP_STORES, ...(existsSync(join(BACKUP_STORES, 'projects')) ? readdirSync(join(BACKUP_STORES, 'projects')).map(d => join(BACKUP_STORES, 'projects', d)) : [])];
    for (const dir of dirs) if (existsSync(join(dir, 'details.md'))) for (const m of parseDetails(readFileSync(join(dir, 'details.md'), 'utf8'))) retire(m.id, m.body);
  }

  // Old bank: selected verbatim spans. Facts/observations are derived and never migrated.
  const docs = (await get(main, OLD_BANK, '/documents?limit=10000')).items;
  const curatedDocs = new Set();
  for (let offset = 0; ; offset += 500) {
    const page = await get(main, OLD_BANK, `/memories/list?limit=500&offset=${offset}`);
    for (const unit of page.items) if (unit.document_id && (unit.edited_at || unit.invalidated_at || (unit.state && unit.state !== 'valid'))) curatedDocs.add(unit.document_id);
    if (offset + 500 >= page.total) break;
  }

  const items = [];
  for (const { memory, storeKey, dest } of curated) {
    const injection = memory.injection ?? 'on-demand';
    const content = redact(`# ${memory.title}\nTags: ${memory.tags.join(', ')}\nCue: ${memory.cue}\nLegacy injection: ${injection}\nUpdated: ${memory.updated}\n\n${memory.body}`);
    items.push({ kind: 'curated-note', source_id: `${storeKey}/${memory.id}`, source_sha256: sha(memory.body), injection, ...dest,
      document_id: `legacy-file:${storeKey}:${memory.id}`, content, timestamp: memory.updated,
      context: 'Legacy curated pi-memory note written as a summary by the agent/user, not a transcript. Later statements supersede it.',
      tags: ['source:legacy-pi-memory-file', `legacy-injection:${injection}`],
      metadata: { source: 'legacy-pi-memory-file', legacy_store: storeKey, legacy_id: memory.id, legacy_updated: memory.updated } });
  }
  for (const doc of docs) {
    const meta = doc.document_metadata ?? {};
    let dest;
    if (curatedDocs.has(doc.id)) dest = { quarantine: 'old-bank fact edited or invalidated' };
    else if (String(meta.jev_label ?? '').split(';').includes('not_durable')) dest = { quarantine: 'labelled not_durable' };
    else if (meta.applicability === 'user-wide') dest = { bank: globalBank };
    else dest = destinationOf(String(meta.source_project_hash ?? '').slice(0, 16));
    const full = await get(main, OLD_BANK, `/documents/${encodeURIComponent(doc.id)}`);
    const text = typeof full?.original_text === 'string' ? full.original_text : '';
    if (!text) dest = { quarantine: 'source text unavailable' };
    const span = tokens(text);
    if (!dest.quarantine && span.size >= MIN_TOKENS && retired.some(r => { const c = containment(span, r.tokens); return c >= RETIRED_MATCH && c > (r.current ? containment(span, r.current) : 0) + RETIRED_MARGIN; })) {
      dest = { quarantine: 'matches retired or superseded curated note' };
    }
    const role = meta.source_role === 'assistant' ? 'assistant' : 'user';
    const when = doc.retain_params?.event_date ?? doc.created_at;
    items.push({ kind: 'bank-span', source_id: doc.id, source_sha256: sha(text), ...dest, document_id: `legacy-bank:pi-memory:${doc.id}`,
      content: redact(`[${role} message in Pi session ${meta.source_session ?? 'unknown'} at ${when}]\n${text}`), timestamp: when,
      context: 'Verbatim excerpt of an earlier Pi conversation, selected by the legacy pi-memory automation. A primary quote with its original speaker and time, not a derived summary.',
      tags: ['source:legacy-pi-memory-bank', 'harness:pi', `legacy-role:${role}`],
      metadata: { source: 'legacy-pi-memory-bank', harness: 'pi', legacy_document_id: doc.id, legacy_content_hash: String(doc.content_hash ?? ''),
        session_id: String(meta.source_session ?? ''), source_role: role, jev_label: String(meta.jev_label ?? '') } });
  }

  const out = join(HOME, '.hindsight/migrations', `${new Date().toISOString().replace(/[:.]/g, '')}-${apply ? 'apply' : 'dryrun'}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const manifest = writer(join(out, 'manifest.jsonl'));
  const summary = new Map();
  const count = key => summary.set(key, (summary.get(key) ?? 0) + 1);
  const banks = new Set(items.filter(i => i.bank).map(i => i.bank));
  if (apply) {
    for (const bank of banks) {
      const pages = await get(main, bank, '/mental-models?limit=1').catch(() => undefined);
      if (!pages) die(`bank ${bank} missing or unreachable; run scripts/setup-bank.mjs first`);
    }
    if (!await client(main, OLD_BANK).supportsIdempotentRetain()) die('server lacks idempotent retain');
  }
  for (const item of items) {
    const row = { kind: item.kind, source_id: item.source_id, source_sha256: item.source_sha256, destination: item.bank ?? null,
      document_id: item.document_id, quarantine: item.quarantine ?? null, injection: item.injection };
    if (item.quarantine) { count(`quarantine\t${item.kind}\t${item.quarantine}`); manifest.row({ ...row, outcome: 'quarantined; not imported' }); continue; }
    count(`${item.bank}\t${item.kind}${item.injection === 'always' ? ' (legacy always)' : ''}`);
    if (!apply) { manifest.row({ ...row, outcome: 'planned' }); continue; }
    const c = client(main, item.bank);
    const operationId = uuidV5(`${item.bank}\n${item.document_id}\nappend\n${item.content}`);
    try {
      const previous = await c.operation(operationId);
      if (previous) { manifest.row({ ...row, operation_id: operationId, outcome: `already submitted (${previous.status})` }); continue; }
      if (await c.document(item.document_id) !== undefined) { manifest.row({ ...row, outcome: 'document exists; skipped' }); continue; }
      await c.retain(item.content, item.context, item.document_id, item.tags, 'document',
        { timestamp: item.timestamp, metadata: item.metadata, operationId });
      manifest.row({ ...row, operation_id: operationId, outcome: 'accepted' });
    } catch (error) {
      manifest.row({ ...row, operation_id: operationId, outcome: `error: ${error instanceof Error && error.message.startsWith('Hindsight ') ? error.message : 'request failed'}` });
    }
  }
  manifest.close();
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${items.length} sources (${curated.length} curated notes, ${docs.length} old-bank spans); retired note versions considered: ${retired.length}`);
  for (const [key, n] of [...summary].sort()) console.log(`${String(n).padStart(4)}  ${key}`);
  console.log(`manifest (no content): ${join(out, 'manifest.jsonl')}`);
}

async function verify(path) {
  const main = loadConfig({ harness: 'pi', path: MAIN_CONFIG });
  const counts = new Map();
  const count = key => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (!row.destination) { count('quarantined'); continue; }
    const c = client(main, row.destination);
    const doc = await c.document(row.document_id);
    const op = row.operation_id ? await c.operation(row.operation_id) : undefined;
    count(`${row.destination}\tdocument ${doc ? 'present' : 'MISSING'}\toperation ${op?.status ?? 'n/a'}`);
  }
  for (const [key, n] of [...counts].sort()) console.log(`${String(n).padStart(4)}  ${key}`);
}
