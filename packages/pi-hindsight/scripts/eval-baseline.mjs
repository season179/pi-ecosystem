#!/usr/bin/env node
/** Synthetic Stage 6 baseline, NOT an extension or a migration tool.
 * Default: print the local plan, no config reads or HTTP. Run only after approval:
 *   node scripts/eval-baseline.mjs --run --endpoint http://127.0.0.1:8888
 * Optional auth: HINDSIGHT_EVAL_TOKEN (never read coding-agent.json).
 * Wire contract checked against local API 0.10.1 OpenAPI + installed Python source.
 * No atomic create-if-absent exists: random unguessable IDs + absence/ownership checks
 * protect ordinary collisions, NOT a hostile concurrent writer on the same ID.
 */
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const VERSION = '0.10.1';
// Sized for the measured local service: every model call is serialized (LLM_MAX_CONCURRENT=1) and one
// Reflect takes tens of seconds to minutes, so shorter bounds only measure timeouts.
const DEFAULTS = { requestMs: 150_000, waitMs: 600_000, pollMs: 3_000, totalMs: 2_700_000, cleanupMs: 120_000, maxPolls: 200, maxRequests: 1_500 };
const STAMP = '2026-09-26T00:00:00Z';
export const FIXTURES = [
  { bank: 'a', id: 'eval-pi', harness: 'pi', content: 'User Mira in Pi: Project Kestrel deploys using Helm chart kestrel-saffron. Set connection retries to 7 only in staging; production stays at 2. Assistant in Pi: I suspect the staging disconnects are caused by DNS, but I have not tested this. User Mira: That is an unverified assistant hypothesis, not an established root cause.' },
  { bank: 'a', id: 'eval-claude', harness: 'claude', content: 'User Noor in Claude: For Project Kestrel, the deployment recovery runbook is amber-lantern.md. Use that runbook when rolling back a failed deployment.' },
  { bank: 'a', id: 'eval-edit', harness: 'pi', content: 'User Mira: Project Kestrel diagnostic listener uses port 43117.' },
  { bank: 'a', id: 'eval-invalidate', harness: 'claude', content: 'User Noor: Project Kestrel emergency approval code is CEDAR-17.' },
  { bank: 'b', id: 'eval-isolation', harness: 'claude', content: 'User Ivo: Project Oriole release mascot is violet-otter. This fact belongs only to Project Oriole.' },
];
// Labels summarize the returned answer, not a second judge's claim that it is true.
const caseOf = (id, bank, query, choices, expected, criterion) => ({ id, bank, query, choices: [...choices, 'unknown', 'other'], expected, criterion });
export const CASES = [
  caseOf('must-find-pi', 'a', 'Which Helm chart does Project Kestrel deploy with?', ['kestrel-saffron'], 'kestrel-saffron', 'Find the Pi-origin chart fact.'),
  caseOf('must-find-claude', 'a', 'What is the Project Kestrel deployment recovery runbook?', ['amber-lantern.md'], 'amber-lantern.md', 'Find Claude-origin evidence without a Pi-only filter.'),
  caseOf('indirect', 'a', 'A Project Kestrel rollout failed. Where should I look for the rollback procedure?', ['amber-lantern.md'], 'amber-lantern.md', 'Connect rollout failure to recovery instructions.'),
  caseOf('qualifier', 'a', 'Should Project Kestrel production use 7 connection retries?', ['staging-only-production-2', 'production-7'], 'staging-only-production-2', 'Preserve staging-only qualification; do not promote it to production.'),
  caseOf('speaker-uncertainty', 'a', 'Who proposed DNS as the cause of Kestrel staging disconnects, and was it verified?', ['pi-assistant-unverified', 'user-verified', 'claude-assistant-unverified'], 'pi-assistant-unverified', 'Preserve speaker and epistemic uncertainty, not just harness tags.'),
  caseOf('unrelated-abstention', 'a', 'What is Project Juniper\'s approved lunar launch date?', ['asserted-date'], 'unknown', 'Abstain: no fixture supports an answer.'),
  caseOf('isolation-negative', 'a', 'What is Project Oriole\'s release mascot?', ['violet-otter'], 'unknown', 'Bank A must not retrieve bank B evidence.'),
  caseOf('isolation-positive', 'b', 'What is Project Oriole\'s release mascot?', ['violet-otter'], 'violet-otter', 'Positive control: bank B actually contains the isolated fact.'),
];
const correctionCase = (kind, phase) => kind === 'edit'
  ? caseOf(`${phase}-edit`, 'a', 'What port does the Project Kestrel diagnostic listener use now?', ['43117', '43118'], phase === 'before' ? '43117' : '43118', 'After edit, use 43118, not obsolete 43117. Replay of unchanged source is an adversarial probe, not safe migration.')
  : caseOf(`${phase}-invalidate`, 'a', 'What is the current Project Kestrel emergency approval code?', ['CEDAR-17'], phase === 'before' ? 'CEDAR-17' : 'unknown', 'After invalidation, do not assert retired CEDAR-17. Unchanged source replay can resurrect it under new fact IDs.');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
class EvalError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new EvalError(code); };
const errorCode = error => error instanceof EvalError ? error.code : 'transport-or-response-error';

export function parseArgs(args) {
  const options = { run: false, endpoint: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run' || args[i] === '--apply') options.run = true;
    else if (args[i] === '--help') options.help = true;
    else if (args[i] === '--endpoint' && options.endpoint === undefined) options.endpoint = args[++i];
    else fail('invalid-arguments');
  }
  if (options.endpoint !== undefined) options.endpoint = validateEndpoint(options.endpoint);
  if (options.run && !options.endpoint) fail('explicit-loopback-endpoint-required');
  return options;
}
function validateEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { fail('invalid-endpoint'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || !u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/') fail('explicit-loopback-origin-required');
  return u.origin;
}
export function plan() {
  return { mode: 'dry-run', network: false, baseline: 'gate-off: every case calls Reflect directly; no Jev, no raw Recall tool',
    usage: 'node scripts/eval-baseline.mjs --run --endpoint http://127.0.0.1:8888',
    warning: 'Loopback service can send synthetic text to remote models and incur costs. Only fresh disposable banks are used.',
    bounds: DEFAULTS, fixtures: FIXTURES, cases: [...CASES, ...['before', 'after', 'replay'].flatMap(p => ['edit', 'invalidate'].map(k => correctionCase(k, p)))],
    grading: 'Mechanical checks only. Enum summaries are model-produced evidence, not proof of semantics. No aggregate usefulness score.',
    privacy: 'Reports allowlist metadata and fixed synthetic labels only; no raw answer, fact, page, trace, error body, endpoint, or credential.',
    limits: ['API pinned to 0.10.1: bank existence via GET /config (404) and ownership via the ID-filtered bank list name; /profile was removed (410).', 'A single synthetic full-refresh page covers all fact types; this is not the official taxonomy/default observation-only page setup.', 'No atomic bank-create API. UUID IDs, missing-bank probes and ownership checks are not a lock against hostile concurrent writes.', 'Source replay deliberately reprocesses unchanged obsolete synthetic documents after curation.', 'Observation/page absence or a non-stale flag does not prove non-resurrection.', 'Structured output adds model work and can influence answers; this is not the exact production latency/cost path.'],
  };
}

/** Narrow dependency seam for offline transport/deadline tests; CLI bounds are fixed. */
export async function runBaseline(options = {}, deps = {}) {
  if (!options.run) return plan(); // Import and default execution have no effects.
  const endpoint = validateEndpoint(options.endpoint);
  const limits = { ...DEFAULTS, ...deps.limits };
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const makeId = deps.uuid ?? randomUUID;
  const runId = makeId(); if (!uuid(runId)) fail('invalid-run-id');
  const marker = `pi-hindsight-eval-owner-${makeId()}`;
  const banks = { a: `pi-hindsight-eval-${runId}-a`, b: `pi-hindsight-eval-${runId}-b` };
  const report = { mode: 'run', baseline: 'gate-off-reflect', api: VERSION, banks, status: 'incomplete',
    fixtures: FIXTURES, cases: [], operations: [], consolidation: [], derivatives: [], curation: [], cleanup: [], requests: [],
    limits: plan().limits, assessment: 'manual-review-required; enum agreement and marker absence are not semantic proof' };
  const owned = new Set(), attempted = new Set(), quarantined = new Set(), unfinished = new Map();
  let deadline = now() + limits.totalMs, cleaning = false, requests = 0, pageId, mentalModelId;
  const bankPath = (bank, suffix = '') => `/v1/default/banks/${encodeURIComponent(banks[bank])}${suffix}`;
  // Only fixed local labels and finite numeric usage survive. Never serialize API objects.
  const usage = value => {
    const result = {};
    for (const k of ['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'thoughts_tokens', 'cost', 'cost_usd', 'total_cost']) {
      if (finite(value?.usage?.[k])) result[k] = value.usage[k];
    }
    for (const k of ['cost', 'cost_usd', 'total_cost']) if (finite(value?.[k])) result[k] = value[k];
    return Object.keys(result).length ? result : null;
  };
  async function request(method, bank, suffix, body, missing = false, label = suffix) {
    if (bank && !owned.has(bank) && !['/config', '/stats?refresh=true'].includes(suffix) && !(method === 'PUT' && suffix === '' && attempted.has(bank))) fail('bank-not-owned');
    if (!cleaning && deps.signal?.aborted) fail('interrupted');
    const remaining = deadline - now();
    if (remaining <= 0 || (!cleaning && requests >= limits.maxRequests)) fail('run-budget-exhausted');
    requests++;
    const started = now(), controller = new AbortController();
    let timer, interrupt;
    const row = { method, bank: bank ?? null, operation: label, status: 'unknown', latencyMs: 0, usage: null };
    report.requests.push(row);
    try {
      const value = await Promise.race([
        (async () => {
          const response = await fetcher(endpoint + (bank ? bankPath(bank, suffix) : suffix), {
            method, redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          if (controller.signal.aborted) fail('request-deadline');
          if (response.status === 404 && missing) { await response.body?.cancel(); return undefined; }
          if (!response.ok) { void response.body?.cancel().catch(() => {}); fail(`http-${response.status}`); }
          const reader = response.body?.getReader();
          const chunks = []; let bytes = 0;
          if (reader) try {
            for (;;) {
              const part = await reader.read(); if (controller.signal.aborted) fail('request-deadline');
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 1_048_576) { void reader.cancel().catch(() => {}); fail('response-too-large'); }
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
          const text = Buffer.concat(chunks).toString('utf8');
          return text ? JSON.parse(text) : {};
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new EvalError('request-deadline')); }, Math.min(limits.requestMs, remaining));
          if (!cleaning && deps.signal) {
            interrupt = () => { controller.abort(); reject(new EvalError('interrupted')); };
            deps.signal.addEventListener('abort', interrupt, { once: true });
            if (deps.signal.aborted) interrupt();
          }
        }),
      ]);
      row.status = value === undefined ? 'missing' : 'ok'; row.usage = usage(value); return value;
    } catch (error) { row.status = errorCode(error); throw new EvalError(row.status); }
    finally { clearTimeout(timer); if (interrupt) deps.signal.removeEventListener('abort', interrupt); row.latencyMs = Math.max(0, now() - started); }
  }
  async function waitOperation(bank, id, phase, existing) {
    const row = existing ?? { bank, phase, acceptance: 'accepted', extraction: 'not-applicable', status: 'unknown', polls: 0 };
    if (!existing) report.operations.push(row);
    if (!uuid(id)) { row.status = 'missing-operation-id'; return row.status; }
    unfinished.set(id, bank);
    const stop = Math.min(deadline, now() + limits.waitMs);
    for (let i = 0; i < limits.maxPolls && now() < stop; i++) {
      const value = await request('GET', bank, `/operations/${encodeURIComponent(id)}`, undefined, true, 'operation-status'); row.polls++;
      if (value && value.operation_id !== id) fail('operation-identity-mismatch');
      row.status = ['pending', 'processing', 'completed', 'failed', 'cancelled', 'not_found'].includes(value?.status) ? value.status : 'unknown';
      if (['completed', 'failed', 'cancelled'].includes(row.status)) { unfinished.delete(id); return row.status; }
      // Missing/pruned/not-yet-visible is unknown, never successful extraction.
      await sleep(Math.max(0, Math.min(limits.pollMs, stop - now())));
    }
    row.status = ['pending', 'processing'].includes(row.status) ? 'pending-at-deadline' : 'unknown-at-deadline';
    return row.status;
  }
  async function consolidate(bank, phase) {
    const row = { bank, phase, status: 'unknown', pending: null, failed: null, observations: null, polls: 0 };
    report.consolidation.push(row);
    const stop = Math.min(deadline, now() + limits.waitMs);
    for (let i = 0; i < limits.maxPolls && now() < stop; i++) {
      const value = await request('GET', bank, '/stats?refresh=true', undefined, false, 'consolidation-stats'); row.polls++;
      row.pending = count(value.pending_consolidation); row.failed = count(value.failed_consolidation); row.observations = count(value.total_observations);
      if (row.failed > 0) { row.status = 'failed'; return; }
      if (row.pending === 0) { row.status = 'queue-drained-not-semantic-proof'; return; }
      if (row.pending === null) { row.status = 'unavailable'; return; }
      await sleep(Math.max(0, Math.min(limits.pollMs, stop - now())));
    }
    row.status = 'pending-at-deadline';
  }
  async function reflect(test) {
    const row = { ...test, status: 'unknown', assessment: 'manual-review-required' }; report.cases.push(row);
    try {
      const value = await request('POST', test.bank, '/reflect', {
        query: `${test.query}\nUse only this bank's evidence. Say unknown if unsupported. Preserve speaker attribution and uncertainty.`,
        budget: 'low', max_tokens: 384, include: { facts: {} },
        response_schema: { type: 'object', properties: { answer: { type: 'string', enum: test.choices } }, required: ['answer'], additionalProperties: false },
      }, false, 'reflect');
      if (typeof value.text !== 'string') fail('invalid-reflect-response');
      row.status = 'returned'; row.answerBytes = Buffer.byteLength(value.text); row.answerSha256 = hash(value.text);
      row.summary = test.choices.includes(value.structured_output?.answer) ? value.structured_output.answer : null;
      row.labelAgreement = row.summary === null ? null : row.summary === test.expected;
      row.structuredOutput = row.summary !== null ? 'available' : value.structured_output_error ? 'failed' : 'unavailable';
      row.evidence = Array.isArray(value.based_on?.memories) ? value.based_on.memories.slice(0, 100).map(f => ({
        idSha256: typeof f.id === 'string' ? hash(f.id) : null,
        type: ['world', 'experience', 'observation'].includes(f.type) ? f.type : 'unknown',
      })) : null;
      row.usage = usage(value);
    } catch (error) { row.status = errorCode(error); }
  }
  const markers = text => ({ oldPort: String(text).includes('43117'), newPort: String(text).includes('43118'), retiredCode: String(text).includes('CEDAR-17') });
  async function derivatives(phase, pageReady) {
    const value = await request('GET', 'a', '/memories/list?type=observation&limit=100&offset=0', undefined, false, 'observation-diagnostic');
    if (!Array.isArray(value.items)) fail('invalid-observation-list');
    const row = { phase, observations: { total: count(value.total), sampled: value.items.length, truncated: value.total > value.items.length,
      markerHits: value.items.map(f => markers(f.text)).reduce((a, m) => Object.fromEntries(Object.keys(m).map(k => [k, (a[k] ?? 0) + Number(m[k])])), {}) },
      sourceFacts: [], page: { status: pageReady ? 'unknown' : 'not-ready' }, assessment: 'diagnostic-only; mentions may be negated/historical, absence is not proof' };
    report.derivatives.push(row);
    for (const kind of ['edit', 'invalidate']) {
      const facts = await request('GET', 'a', `/memories/list?document_id=eval-${kind}&state=valid&limit=100&offset=0`, undefined, false, 'active-source-diagnostic');
      if (!Array.isArray(facts.items)) fail('invalid-source-list');
      row.sourceFacts.push({ kind, total: count(facts.total), truncated: facts.total > facts.items.length,
        sampled: facts.items.slice(0, 100).map(f => ({ idSha256: typeof f.id === 'string' ? hash(f.id) : null, ...markers(f.text) })) });
    }
    if (pageReady) {
      const page = await request('GET', 'a', `/knowledge-base/pages/${encodeURIComponent(pageId)}`, undefined, false, 'page-read');
      if (page.id !== pageId) fail('page-identity-mismatch');
      const text = page.body ?? page.markdown;
      row.page = { status: typeof text === 'string' ? 'read' : 'unavailable', bytes: typeof text === 'string' ? Buffer.byteLength(text) : null, ...markers(text) };
    }
  }
  // Hindsight 0.10.1 removed GET /banks/{id}/profile (always 410). Existence: GET /config is 404 for a
  // missing bank and never creates one. Ownership: the display name from the bank list, filtered by
  // this run's exact UUID bank ID; only the name comparison is kept, nothing from the list is reported.
  async function presence(bank, label) {
    const config = await request('GET', bank, '/config', undefined, true, `${label}-config`);
    const list = await request('GET', null, `/v1/default/banks?q=${encodeURIComponent(banks[bank])}&limit=10`, undefined, false, `${label}-owner`);
    if (!Array.isArray(list?.banks)) fail('invalid-bank-list'); // BankListResponse: { banks, total, limit, offset }
    const listed = list.banks.filter(item => item?.bank_id === banks[bank]);
    if (listed.length > 1) fail('ambiguous-bank-list');
    if (config === undefined && !listed.length) return { exists: false };
    return { exists: true, owned: listed.length === 1 && listed[0].name === marker };
  }
  async function refreshPage(phase, ready) {
    if (!ready) return false;
    const value = await request('POST', 'a', `/mental-models/${encodeURIComponent(mentalModelId)}/refresh`, undefined, false, 'page-refresh');
    return await waitOperation('a', value.operation_id, `page-${phase}`) === 'completed';
  }
  try {
    const version = await request('GET', null, '/version', undefined, false, 'version');
    if (version.api_version !== VERSION) fail('unsupported-api-version');
    // Check both before any creation. No bank listing or existing-bank memory reads.
    for (const bank of ['a', 'b']) if ((await presence(bank, 'absence-check')).exists) fail('bank-collision');
    for (const bank of ['a', 'b']) {
      attempted.add(bank);
      const value = await request('PUT', bank, '', { name: marker, enable_observations: true }, false, 'create-disposable-bank');
      if (value.bank_id !== banks[bank] || value.name !== marker) fail('ownership-unconfirmed');
      owned.add(bank);
      const stats = await request('GET', bank, '/stats?refresh=true', undefined, false, 'empty-bank-check');
      if (stats.total_nodes !== 0 || stats.total_documents !== 0) { quarantined.add(bank); fail('new-bank-not-empty'); }
      // Server default templates can seed pages/directives. Refuse contaminated banks.
      for (const resource of ['mental-models', 'directives']) {
        const list = await request('GET', bank, `/${resource}`, undefined, false, `empty-${resource}-check`);
        if (!Array.isArray(list.items) || list.items.length !== 0 || list.total !== 0) { quarantined.add(bank); fail('new-bank-template-or-unknown-response'); }
      }
    }
    let extracted = true;
    for (const bank of ['a', 'b']) {
      const id = makeId();
      if (!uuid(id)) fail('invalid-operation-id');
      const operation = { bank, phase: 'retain-extraction', acceptance: 'unknown', extraction: 'unknown', status: 'unknown', polls: 0 };
      report.operations.push(operation); unfinished.set(id, bank); // Claim before dispatch: lost acknowledgement is not a rejected write.
      const value = await request('POST', bank, '/memories', { async: true, operation_id: id,
        items: FIXTURES.filter(f => f.bank === bank).map(f => ({ content: f.content, document_id: f.id, timestamp: STAMP,
          context: 'Synthetic evaluation conversation; quoted speakers are explicit; no real project data.',
          metadata: { synthetic: 'true', harness: f.harness }, tags: ['source:chat', `harness:${f.harness}`], observation_scopes: 'shared', update_mode: 'append' })),
      }, false, 'retain');
      if (value.operation_id !== id || value.success !== true) fail('retain-acceptance-unknown');
      operation.acceptance = 'accepted';
      const status = await waitOperation(bank, id, 'retain-extraction', operation);
      operation.extraction = status;
      if (status !== 'completed') extracted = false;
    }
    if (!extracted) { report.status = 'incomplete-extraction'; return report; }
    for (const bank of ['a', 'b']) await consolidate(bank, 'initial');
    for (const test of [...CASES, correctionCase('edit', 'before'), correctionCase('invalidate', 'before')]) await reflect(test);
    const page = await request('POST', 'a', '/knowledge-base/pages', { name: 'Synthetic current Kestrel settings',
      source_query: 'What are the current Project Kestrel diagnostic listener port and emergency approval code? Use only current evidence; say unknown if unsupported.',
      max_tokens: 384, trigger: { mode: 'full', fact_types: ['world', 'experience', 'observation'], refresh_after_consolidation: false, refresh_cron: null, exclude_mental_models: true },
    }, false, 'page-create');
    if (typeof page.page_id !== 'string' || !/^kp-[a-f0-9]{32}$/.test(page.page_id) || typeof page.mental_model_id !== 'string' || !/^mm-[a-f0-9]{32}$/.test(page.mental_model_id)) fail('page-creation-identity-unknown');
    pageId = page.page_id; mentalModelId = page.mental_model_id;
    let pageReady = await waitOperation('a', page.operation_id, 'page-initial') === 'completed';
    await derivatives('before', pageReady);
    for (const kind of ['edit', 'invalidate']) {
      const doc = `eval-${kind}`;
      const list = await request('GET', 'a', `/memories/list?document_id=${doc}&state=valid&limit=100&offset=0`, undefined, false, 'curation-candidates');
      const candidates = Array.isArray(list.items) ? list.items.filter(f => ['world', 'experience'].includes(f.fact_type) && f.document_id === doc && typeof f.text === 'string' && f.text.includes(kind === 'edit' ? '43117' : 'CEDAR-17')) : [];
      const row = { kind, status: 'ambiguous-or-missing-target', sourceRewritten: false }; report.curation.push(row);
      // Do not mutate multiple extracted fragments or observations to force a pass.
      if (candidates.length !== 1 || count(list.total) !== list.items.length || list.total > 100 || !uuid(candidates[0].id)) continue;
      const target = candidates[0], suffix = `/memories/${encodeURIComponent(target.id)}`;
      const fact = await request('GET', 'a', suffix, undefined, false, 'curation-inspect');
      if (fact.id !== target.id || (fact.bank_id !== undefined && fact.bank_id !== banks.a) || fact.document_id !== doc || fact.text !== target.text || !['world', 'experience'].includes(fact.type) || fact.state !== 'valid') fail('curation-scope-mismatch'); // detail uses `type`
      const patch = kind === 'edit' ? { text: 'Project Kestrel diagnostic listener uses port 43118.' } : { state: 'invalidated', reason: 'Synthetic retirement; no replacement code is established.' };
      await request('PATCH', 'a', suffix, patch, false, 'curation-patch');
      const check = await request('GET', 'a', suffix, undefined, false, 'curation-readback');
      row.status = check.id === fact.id && check.document_id === doc && Object.entries(patch).filter(([k]) => k !== 'reason').every(([k, v]) => check[k] === v) ? 'verified-fact-only' : 'readback-mismatch';
    }
    await consolidate('a', 'after-curation');
    pageReady = await refreshPage('after-curation', pageReady);
    await derivatives('after-curation', pageReady);
    for (const kind of ['edit', 'invalidate']) {
      if (report.curation.some(r => r.kind === kind && r.status === 'verified-fact-only')) await reflect(correctionCase(kind, 'after'));
      else report.cases.push({ ...correctionCase(kind, 'after'), status: 'blocked-curation-not-verified' });
    }
    // Deliberately replay the UNCHANGED original source, never claim curation rewrote it.
    for (const kind of ['edit', 'invalidate']) {
      if (!report.curation.some(r => r.kind === kind && r.status === 'verified-fact-only')) continue;
      const value = await request('POST', 'a', `/documents/eval-${kind}/reprocess`, undefined, false, 'obsolete-source-replay');
      const status = await waitOperation('a', value.operation_id, `replay-${kind}`);
      report.operations.at(-1).extraction = status;
      if (status !== 'completed') { report.status = 'incomplete-replay'; return report; }
    }
    await consolidate('a', 'after-source-replay');
    pageReady = await refreshPage('after-source-replay', pageReady);
    await derivatives('after-source-replay', pageReady);
    for (const kind of ['edit', 'invalidate']) {
      if (report.curation.some(r => r.kind === kind && r.status === 'verified-fact-only')) await reflect(correctionCase(kind, 'replay'));
      else report.cases.push({ ...correctionCase(kind, 'replay'), status: 'blocked-curation-not-verified' });
    }
    report.status = report.curation.every(r => r.status === 'verified-fact-only') && report.cases.every(r => r.status === 'returned')
      ? report.operations.every(r => r.status === 'completed') && report.consolidation.every(r => r.status === 'queue-drained-not-semantic-proof')
        ? 'completed-needs-manual-assessment' : 'incomplete-async'
      : 'incomplete-cases';
  } catch (error) { report.status = 'incomplete'; report.error = errorCode(error); }
  finally {
    // Independent reserve: exhausted evaluation time cannot skip cleanup.
    cleaning = true; deadline = now() + limits.cleanupMs;
    for (const bank of attempted) {
      const row = { bank, status: 'unknown' }; report.cleanup.push(row);
      if (quarantined.has(bank)) { row.status = 'refused-unexpected-preexisting-content'; continue; }
      try {
        const found = await presence(bank, 'cleanup-ownership');
        if (!found.exists) { row.status = 'already-absent'; continue; }
        if (!found.owned) { row.status = 'refused-ownership-mismatch'; continue; }
        owned.add(bank); // Includes a PUT accepted before its acknowledgement was lost.
        for (const [id, owner] of unfinished) if (owner === bank) {
          try { await request('DELETE', bank, `/operations/${encodeURIComponent(id)}`, undefined, true, 'cancel-owned-operation'); }
          catch { row.cancellation = 'uncertain'; }
        }
        const deleted = await request('DELETE', bank, '', undefined, false, 'delete-owned-bank');
        if (deleted.success !== true) fail('cleanup-delete-unconfirmed');
        // DELETE is synchronous and the bank list reflects it at once, but GET /config was measured
        // answering 200 for ~30 s afterwards (server cache); re-check within the reserve.
        let gone = false;
        for (let i = 0; i < 15 && !gone; i++) { if (i) await sleep(limits.pollMs); gone = !(await presence(bank, 'cleanup-verify')).exists; row.verifyPolls = i + 1; }
        row.status = gone ? 'deleted-verified-immediate' : 'still-present';
      } catch (error) { row.status = errorCode(error); }
    }
    report.cleanupComplete = report.cleanup.length === attempted.size && report.cleanup.every(r => ['already-absent', 'deleted-verified-immediate'].includes(r.status));
    report.cleanupCaveat = 'Immediate absence only; server-side already-running work may outlive cancellation. No claim of delayed non-resurrection.';
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  try {
    const options = parseArgs(args);
    if (options.run && !options.help) { process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); }
    const result = options.help ? plan() : await runBaseline({ ...options, token: process.env.HINDSIGHT_EVAL_TOKEN }, { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // Pending async work is an incomplete evaluation, not a hard failure.
    return result.error || result.cleanupComplete === false ? 1 : 0;
  } catch (error) { process.stdout.write(`${JSON.stringify({ status: 'refused', error: errorCode(error) })}\n`); return 1; }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
