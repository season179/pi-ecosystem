#!/usr/bin/env node
// Legacy pi-memory -> per-repository Hindsight banks (plan stage 7). Local operator script, not shipped.
// Dry run by default. Prints counts only and writes a content-free manifest; memory text is
// processed locally and never printed. Sources (files, old bank, transcripts, backup) are read-only.
//   node scripts/migrate-legacy.mjs [--backup-stores <dir>]                  (dry run)
//   node scripts/migrate-legacy.mjs --apply --expect <dryrun manifest.jsonl>  (refuses unless the plan is unchanged)
//   node scripts/migrate-legacy.mjs --plan-map <json> --plan-global-bank <id>   (dry-run preview before config edits)
//   node scripts/migrate-legacy.mjs --verify <manifest.jsonl>
// Exit status is nonzero on any conflict, error, incomplete inventory (apply) or failed verification.
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
const OUT_ROOT = option('out-root') ?? join(HOME, '.hindsight/migrations');
// --source-bank exists only for synthetic rehearsals against disposable banks.
const OLD_BANK = option('source-bank') ?? 'pi-memory';
const PAGE = 500;
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
const canonical = value => JSON.stringify(Object.keys(value).sort().map(k => [k, value[k]]));

/** Every item of a paginated list; the pages must add up to the (unchanged) reported total. */
async function listAll(cfg, bank, path) {
  const items = []; let total;
  for (let offset = 0; ; offset += PAGE) {
    const page = await get(cfg, bank, `${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(page?.items) || !Number.isInteger(page.total)) die(`invalid list response for ${path}`);
    if (total !== undefined && page.total !== total) die(`${bank}${path} changed during listing (${total} -> ${page.total}); stop writers and rerun`);
    total = page.total; items.push(...page.items);
    if (page.items.length < PAGE || items.length >= total) break;
  }
  if (items.length !== total) die(`${bank}${path}: listed ${items.length} of reported ${total}`);
  return items;
}

// Destination contract (Hindsight 0.10.1): with memory_defense unset and store_document_text on,
// documents.original_text is the submitted content verbatim, so an exact hash comparison is valid.
async function assertExactStorage(cfg, bank) {
  const config = (await get(cfg, bank, '/config'))?.config ?? {};
  if (config.memory_defense != null || config.store_document_text === false) die(`bank ${bank} transforms or drops document text; exact verification impossible`);
}

/** Compare a stored document with the manifest's expected redacted payload and shape. */
function documentState(doc, row) {
  if (doc === undefined) return 'missing';
  if (typeof doc.original_text !== 'string' || sha(doc.original_text) !== row.expected_sha256) return 'content mismatch';
  const tags = new Set(doc.tags ?? []);
  if (!row.expected_tags.every(t => tags.has(t))) return 'tags mismatch';
  const meta = doc.document_metadata ?? {};
  const actual = Object.fromEntries(row.expected_metadata_keys.map(k => [k, meta[k]]));
  return sha(canonical(actual)) === row.expected_metadata_sha256 ? 'match' : 'metadata mismatch';
}

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
    const explicit = Object.entries(map).some(([path, bank]) => bank === id && (repo === path || repo.startsWith(`${path}/`))
      // Remote-less banks carry a path-hash suffix so equal basenames can never share a bank.
      && (!bank.startsWith('coding-agent::local:') || bank.endsWith(`-${sha(path).slice(0, 8)}`)));
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
  const inventory = { transcripts: sessionFiles.length, unreadable: 0, backup: existsSync(BACKUP_STORES) ? 'present' : 'MISSING' };
  const retire = (id, body) => { if (typeof body === 'string' && body !== current.get(id)) retired.push({ tokens: tokens(body), current: current.has(id) ? tokens(current.get(id)) : undefined }); };
  for (const file of sessionFiles) {
    let text; try { text = readFileSync(file, 'utf8'); } catch { inventory.unreadable++; continue; }
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
  const inventoryComplete = inventory.backup === 'present' && inventory.unreadable === 0;
  if (apply && !inventoryComplete) die(`retired-source inventory incomplete (backup ${inventory.backup}, ${inventory.unreadable} unreadable transcripts); refusing apply`);
  const docs = await listAll(main, OLD_BANK, '/documents');
  const curatedDocs = new Set();
  for (const unit of await listAll(main, OLD_BANK, '/memories/list')) if (unit.document_id && (unit.edited_at || unit.invalidated_at || (unit.state && unit.state !== 'valid'))) curatedDocs.add(unit.document_id);

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
    // Speaker provenance is never invented: anything but an explicit user/assistant role is quarantined.
    const role = meta.source_role === 'assistant' || meta.source_role === 'user' ? meta.source_role : undefined;
    if (!role && !dest.quarantine) dest = { quarantine: 'unknown source_role' };
    const when = doc.retain_params?.event_date ?? doc.created_at;
    items.push({ kind: 'bank-span', source_id: doc.id, source_sha256: sha(text), ...dest, document_id: `legacy-bank:${OLD_BANK}:${doc.id}`,
      content: redact(`[${role} message in Pi session ${meta.source_session ?? 'unknown'} at ${when}]\n${text}`), timestamp: when,
      context: 'Verbatim excerpt of an earlier Pi conversation, selected by the legacy pi-memory automation. A primary quote with its original speaker and time, not a derived summary.',
      tags: ['source:legacy-pi-memory-bank', 'harness:pi', `legacy-role:${role}`],
      metadata: { source: 'legacy-pi-memory-bank', harness: 'pi', legacy_document_id: doc.id, legacy_content_hash: String(doc.content_hash ?? ''),
        session_id: String(meta.source_session ?? ''), source_role: role, jev_label: String(meta.jev_label ?? '') } });
  }

  const out = join(OUT_ROOT, `${new Date().toISOString().replace(/[:.]/g, '')}-${apply ? 'apply' : 'dryrun'}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const manifest = writer(join(out, 'manifest.jsonl'));
  const summary = new Map();
  const count = key => summary.set(key, (summary.get(key) ?? 0) + 1);
  const banks = new Set(items.filter(i => i.bank).map(i => i.bank));
  // Plan rows are computed before any write; an apply must reproduce the reviewed dry run exactly.
  const plans = items.map(item => {
    const row = { kind: item.kind, source_id: item.source_id, source_sha256: item.source_sha256, destination: item.bank ?? null,
      document_id: item.document_id, quarantine: item.quarantine ?? null, injection: item.injection };
    if (item.quarantine) return row;
    // Expected evidence: hashes of the exact redacted payload and metadata, never the text itself.
    return { ...row, operation_id: uuidV5(`${item.bank}\n${item.document_id}\nappend\n${item.content}`), expected_sha256: sha(item.content),
      expected_tags: item.tags, expected_metadata_keys: Object.keys(item.metadata).sort(), expected_metadata_sha256: sha(canonical(item.metadata)) };
  });
  if (apply) {
    if (!option('expect')) die('--apply requires --expect <reviewed dry-run manifest.jsonl>');
    const drift = planDrift(plans, option('expect'));
    if (drift) die(`plan differs from the reviewed dry run (${drift}); refusing apply`);
    for (const bank of banks) {
      const pages = await get(main, bank, '/mental-models?limit=1').catch(() => undefined);
      if (!pages) die(`bank ${bank} missing or unreachable; run scripts/setup-bank.mjs first`);
      await assertExactStorage(main, bank);
    }
    if (!await client(main, OLD_BANK).supportsIdempotentRetain()) die('server lacks idempotent retain');
  }
  let failures = 0;
  const outcomes = new Map();
  const outcome = key => outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
  for (const [index, item] of items.entries()) {
    const row = { mode: apply ? 'apply' : 'dryrun', ...plans[index] };
    if (item.quarantine) { count(`quarantine\t${item.kind}\t${item.quarantine}`); manifest.row({ ...row, outcome: 'quarantined; not imported' }); continue; }
    count(`${item.bank}\t${item.kind}${item.injection === 'always' ? ' (legacy always)' : ''}`);
    const operationId = row.operation_id;
    if (!apply) { manifest.row({ ...row, outcome: 'planned' }); continue; }
    const c = client(main, item.bank);
    let result;
    try {
      const existing = await c.document(item.document_id);
      if (existing !== undefined) {
        // Never silently skip: an existing document must be exactly this evidence, else it is a conflict.
        const state = documentState(existing, row);
        result = state === 'match' ? 'present; verified identical' : `CONFLICT: existing document ${state}; not overwritten`;
      } else {
        const previous = await c.operation(operationId);
        if (previous?.status === 'failed') result = 'FAILED: earlier operation failed; not retried';
        else if (previous?.status === 'completed') result = 'ERROR: operation completed but document absent';
        else if (previous) result = `already submitted (${previous.status}); document not yet visible`;
        else {
          await c.retain(item.content, item.context, item.document_id, item.tags, 'document',
            { timestamp: item.timestamp, metadata: item.metadata, operationId });
          result = 'accepted';
        }
      }
    } catch (error) {
      result = `ERROR: ${error instanceof Error && error.message.startsWith('Hindsight ') ? error.message : 'request failed'}`;
    }
    if (/^(CONFLICT|FAILED|ERROR)/.test(result)) failures++;
    outcome(result.replace(/:.*/, '')); manifest.row({ ...row, outcome: result });
  }
  manifest.close();
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${items.length} sources (${curated.length} curated notes, ${docs.length} old-bank spans); retired note versions considered: ${retired.length}`);
  for (const [key, n] of [...summary].sort()) console.log(`${String(n).padStart(4)}  ${key}`);
  console.log(`retired-source inventory: ${inventory.transcripts} transcripts (${inventory.unreadable} unreadable), backup stores ${inventory.backup}${inventoryComplete ? '' : ' -> UNVERIFIED'}`);
  for (const [key, n] of [...outcomes].sort()) console.log(`${String(n).padStart(4)}  outcome ${key}`);
  console.log(`manifest (no content): ${join(out, 'manifest.jsonl')}`);
  if (failures) { console.error(`migrate-legacy: ${failures} conflict/failed/error item(s); see manifest`); process.exit(1); }
  if (apply) console.log(`next: node scripts/migrate-legacy.mjs --verify ${join(out, 'manifest.jsonl')} (after extraction completes)`);
}

/** First difference between the recomputed plan and a dry-run manifest, as a content-free description. */
function planDrift(plans, path) {
  let rows;
  try { rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return 'expected manifest unreadable'; }
  if (!rows.length || rows.some(r => r.mode !== 'dryrun')) return 'expected manifest is not a dry run';
  const key = r => `${r.kind}\n${r.source_id}`;
  const expected = new Map(rows.map(r => [key(r), r]));
  if (expected.size !== rows.length) return 'expected manifest has duplicate sources';
  if (plans.length !== rows.length) return `${plans.length} sources now vs ${rows.length} reviewed`;
  for (const plan of plans) {
    const want = expected.get(key(plan));
    if (!want) return `new source ${plan.kind} ${plan.source_id}`;
    for (const field of Object.keys(plan)) {
      if (JSON.stringify(plan[field] ?? null) !== JSON.stringify(want[field] ?? null)) return `${field} changed for ${plan.kind} ${plan.source_id}`;
    }
  }
  return undefined;
}

async function verify(path) {
  const main = loadConfig({ harness: 'pi', path: MAIN_CONFIG });
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!rows.length || rows.some(r => r.mode !== 'apply')) die('verify needs a non-empty apply manifest');
  const counts = new Map();
  const count = key => counts.set(key, (counts.get(key) ?? 0) + 1);
  let bad = 0;
  for (const bank of new Set(rows.map(r => r.destination).filter(Boolean))) await assertExactStorage(main, bank);
  for (const row of rows) {
    if (!row.destination) { count('quarantined (not imported)'); continue; }
    const c = client(main, row.destination);
    let state;
    try {
      const doc = documentState(await c.document(row.document_id), row);
      const op = await c.operation(row.operation_id);
      // Evidence must be present, identical, and its extraction completed.
      state = doc !== 'match' ? `document ${doc}` : op?.status === 'completed' ? 'ok' : `operation ${op?.status ?? 'unknown'}`;
    } catch { state = 'request failed'; }
    if (state !== 'ok') bad++;
    count(`${row.destination}\t${state}`);
  }
  for (const [key, n] of [...counts].sort()) console.log(`${String(n).padStart(4)}  ${key}`);
  if (bad) { console.error(`migrate-legacy: verification failed for ${bad} of ${rows.filter(r => r.destination).length} imported item(s)`); process.exit(1); }
  console.log('verified: every imported item is present, identical and extracted');
}
