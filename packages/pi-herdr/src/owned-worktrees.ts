/**
 * Session-owned worktree ledger for pi-herdr.
 *
 * Herdr and Git hold live truth; the ledger persists only this conversation's
 * ownership, creation intent, Herdr receipts and cleanup outcomes. Events are
 * append-order custom session entries filtered by the owning session id and
 * read from every entry, like the worker ledger: resume restores them, forks
 * and clones inherit nothing, and `/orchestrate off` leaves them alone. Live
 * observations are computed on each read and never persisted.
 *
 * Uncertainty preserves: an ambiguous creation is recorded `unknown` and never
 * retried, adopted or deleted; removal refuses unless every precondition is
 * verified live. Nothing here passes `--force`, deletes with `-D`, or prompts.
 */

import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { runHerdr, type CliResult } from './herdr-cli.js';

export const WORKTREE_ENTRY_TYPE = 'pi-herdr-worktree';
const CREATE_TIMEOUT_MS = 30_000;
const REMOVE_TIMEOUT_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 3_000;
const GIT_TIMEOUT_MS = 10_000;
const BRANCH_ATTEMPTS = 5;

export type WorktreeState = 'pending' | 'created' | 'failed' | 'unknown' | 'removed';

export interface WorktreeRecord {
  /** Display ordinal in intent order; stable because entries are append-only. */
  id: number;
  /** Distinct identity of this creation operation; every event is keyed by it. */
  op: string;
  branch: string;
  repoRoot: string;
  sourceWorkspace?: string;
  base: string;
  target: string;
  task: string;
  state: WorktreeState;
  path?: string;
  workspaceId?: string;
  rootPaneId?: string;
  rootTerminalId?: string;
  /** failed/unknown reason. */
  error?: string;
  branchOutcome?: { deleted: true } | { deleted: false; reason: string };
}

interface EntryBase {
  op: string;
  sessionId: string;
  at: string;
  branch: string;
}

export type WorktreeEntry =
  | (EntryBase & {
      event: 'intent';
      repoRoot: string;
      sourceWorkspace?: string;
      base: string;
      target: string;
      task: string;
    })
  | (EntryBase & {
      event: 'created';
      path: string;
      workspaceId: string;
      rootPaneId: string;
      rootTerminalId?: string;
    })
  | (EntryBase & { event: 'failed' | 'unknown' | 'branch-kept'; reason: string })
  | (EntryBase & { event: 'removed' | 'branch-deleted' });

interface EntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Tolerates malformed or older entries by skipping them. */
function parseEntry(data: unknown): WorktreeEntry | undefined {
  if (!isRecord(data)) return undefined;
  const op = nonEmpty(data.op);
  const sessionId = nonEmpty(data.sessionId);
  const branch = nonEmpty(data.branch);
  if (op === undefined || sessionId === undefined || branch === undefined) return undefined;
  const base = { op, sessionId, branch, at: typeof data.at === 'string' ? data.at : '' };
  switch (data.event) {
    case 'intent': {
      const repoRoot = nonEmpty(data.repoRoot);
      const sha = nonEmpty(data.base);
      const target = nonEmpty(data.target);
      const task = nonEmpty(data.task);
      if (!repoRoot || !sha || !target || !task) return undefined;
      const sourceWorkspace = nonEmpty(data.sourceWorkspace);
      return {
        event: 'intent',
        ...base,
        repoRoot,
        ...(sourceWorkspace ? { sourceWorkspace } : {}),
        base: sha,
        target,
        task,
      };
    }
    case 'created': {
      const path = nonEmpty(data.path);
      const workspaceId = nonEmpty(data.workspaceId);
      const rootPaneId = nonEmpty(data.rootPaneId);
      if (!path || !workspaceId || !rootPaneId) return undefined;
      const rootTerminalId = nonEmpty(data.rootTerminalId);
      return {
        event: 'created',
        ...base,
        path,
        workspaceId,
        rootPaneId,
        ...(rootTerminalId ? { rootTerminalId } : {}),
      };
    }
    case 'failed':
    case 'unknown':
    case 'branch-kept':
      return { event: data.event, ...base, reason: nonEmpty(data.reason) ?? 'no reason recorded' };
    case 'removed':
    case 'branch-deleted':
      return { event: data.event, ...base };
    default:
      return undefined;
  }
}

/** Replay this session's worktree events in append order; out-of-order events are ignored. */
export function readWorktreeRecords(
  entries: readonly EntryLike[],
  sessionId: string,
): WorktreeRecord[] {
  const records = new Map<string, WorktreeRecord>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== WORKTREE_ENTRY_TYPE) continue;
    const parsed = parseEntry(entry.data);
    if (parsed === undefined || parsed.sessionId !== sessionId) continue;
    const record = records.get(parsed.op);
    if (parsed.event === 'intent') {
      if (record) continue;
      records.set(parsed.op, {
        id: records.size + 1,
        op: parsed.op,
        branch: parsed.branch,
        repoRoot: parsed.repoRoot,
        ...(parsed.sourceWorkspace ? { sourceWorkspace: parsed.sourceWorkspace } : {}),
        base: parsed.base,
        target: parsed.target,
        task: parsed.task,
        state: 'pending',
      });
      continue;
    }
    if (record === undefined || parsed.branch !== record.branch) continue;
    if (parsed.event === 'created' && record.state === 'pending') {
      record.state = 'created';
      record.path = parsed.path;
      record.workspaceId = parsed.workspaceId;
      record.rootPaneId = parsed.rootPaneId;
      if (parsed.rootTerminalId) record.rootTerminalId = parsed.rootTerminalId;
    } else if (
      (parsed.event === 'failed' || parsed.event === 'unknown') &&
      record.state === 'pending'
    ) {
      record.state = parsed.event;
      record.error = parsed.reason;
    } else if (parsed.event === 'removed' && record.state === 'created') {
      record.state = 'removed';
    } else if (parsed.event === 'branch-deleted' && record.state === 'removed') {
      record.branchOutcome = { deleted: true };
    } else if (parsed.event === 'branch-kept' && record.state === 'removed') {
      record.branchOutcome = { deleted: false, reason: parsed.reason };
    }
  }
  return [...records.values()];
}

/** Branch names of every recorded creation intent, in any session. */
function recordedBranches(entries: readonly EntryLike[]): Set<string> {
  const branches = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== WORKTREE_ENTRY_TYPE) continue;
    const parsed = parseEntry(entry.data);
    if (parsed?.event === 'intent') branches.add(parsed.branch);
  }
  return branches;
}

/** A removed checkout whose branch deletion or retention was never recorded. */
function branchUnresolved(record: WorktreeRecord): boolean {
  return record.state === 'removed' && record.branchOutcome === undefined;
}

/**
 * Records still holding (or possibly holding) a checkout, of which unknown
 * (pending counts as unknown), plus removed checkouts with an unresolved branch.
 */
export function outstandingWorktrees(records: readonly WorktreeRecord[]): {
  open: number;
  unknown: number;
  unresolved: number;
} {
  const open = records.filter((r) => ['pending', 'created', 'unknown'].includes(r.state));
  return {
    open: open.length,
    unknown: open.filter((r) => r.state !== 'created').length,
    unresolved: records.filter(branchUnresolved).length,
  };
}

// ---------------------------------------------------------------------------
// Bounded git

interface GitResult {
  ok: boolean;
  /** Exit status, or null when git could not run or was killed (timeout/abort). */
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : null;
        done({ ok: code === 0, code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function gitMessage(result: GitResult): string {
  return nonEmpty(result.stderr)?.split('\n', 1)[0] ?? `git exited ${result.code ?? 'abnormally'}`;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/** `git worktree list --porcelain` → path → branch (undefined when detached). */
async function gitWorktrees(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<Array<{ path: string; branch?: string; head?: string }> | undefined> {
  const result = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], signal);
  if (!result.ok) return undefined;
  const list: Array<{ path: string; branch?: string; head?: string }> = [];
  for (const block of result.stdout.split(/\n\s*\n/u)) {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    const branch = lines.find((line) => line.startsWith('branch '))?.slice(7);
    const head = lines.find((line) => line.startsWith('HEAD '))?.slice(5);
    list.push({
      path,
      ...(branch ? { branch: branch.replace(/^refs\/heads\//u, '') } : {}),
      ...(head ? { head } : {}),
    });
  }
  return list;
}

/** Ancestry of the branch tip into a target commit: true, false, or undefined (unknown). */
async function mergedInto(
  repoRoot: string,
  tip: string,
  targetCommit: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const result = await runGit(repoRoot, ['merge-base', '--is-ancestor', tip, targetCommit], signal);
  return result.code === 0 ? true : result.code === 1 ? false : undefined;
}

async function branchTip(
  repoRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await runGit(
    repoRoot,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
    signal,
  );
  return result.ok ? nonEmpty(result.stdout) : undefined;
}

/** Exact local branch existence: true, false, or undefined (git failed). */
async function localBranchExists(
  repoRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const result = await runGit(
    repoRoot,
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    signal,
  );
  return result.code === 0 ? true : result.code === 1 ? false : undefined;
}

// ---------------------------------------------------------------------------
// Herdr lookups

function herdrError(result: CliResult): { code?: string; message: string } {
  const error = isRecord(result.errorJson) ? result.errorJson.error : undefined;
  const code = isRecord(error) ? nonEmpty(error.code) : undefined;
  const message =
    (isRecord(error) ? nonEmpty(error.message) : undefined) ??
    nonEmpty(result.stderr)?.split('\n', 1)[0] ??
    (result.exitCode === null ? 'herdr timed out or was cancelled' : 'herdr failed');
  return { ...(code ? { code } : {}), message };
}

function herdrResult(result: CliResult): Record<string, unknown> | undefined {
  if (result.exitCode !== 0 || !isRecord(result.json)) return undefined;
  return isRecord(result.json.result) ? result.json.result : result.json;
}

/** workspace id → checkout path (undefined entry = workspace without a worktree). */
async function workspaceCheckouts(
  signal?: AbortSignal,
): Promise<Map<string, string | undefined> | undefined> {
  const result = herdrResult(
    await runHerdr(['workspace', 'list'], {
      timeoutMs: LOOKUP_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    }),
  );
  if (!result || !Array.isArray(result.workspaces)) return undefined;
  const map = new Map<string, string | undefined>();
  for (const workspace of result.workspaces) {
    if (!isRecord(workspace)) return undefined;
    const id = nonEmpty(workspace.workspace_id);
    if (!id) return undefined;
    map.set(
      id,
      isRecord(workspace.worktree) ? nonEmpty(workspace.worktree.checkout_path) : undefined,
    );
  }
  return map;
}

interface PaneInfo {
  paneId: string;
  terminalId?: string;
  workspaceId?: string;
  agent?: string;
}

function paneFrom(value: unknown): PaneInfo | undefined {
  if (!isRecord(value)) return undefined;
  const paneId = nonEmpty(value.pane_id);
  if (!paneId) return undefined;
  const terminalId = nonEmpty(value.terminal_id);
  const workspaceId = nonEmpty(value.workspace_id);
  const agent = nonEmpty(value.agent);
  return {
    paneId,
    ...(terminalId ? { terminalId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(agent ? { agent } : {}),
  };
}

/** `pane list --workspace` or `agent list`; undefined when any member is unreadable. */
async function listPanes(args: string[], key: string, signal?: AbortSignal) {
  const result = herdrResult(
    await runHerdr(args, { timeoutMs: LOOKUP_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
  );
  if (!result || !Array.isArray(result[key])) return undefined;
  const panes = (result[key] as unknown[]).map(paneFrom);
  return panes.every((pane) => pane !== undefined) ? (panes as PaneInfo[]) : undefined;
}

// ---------------------------------------------------------------------------
// Tool operations

export interface WorktreeContext {
  sessionId: string;
  cwd: string;
  entries: () => readonly EntryLike[];
  /** Appends to this session; must throw if the session was replaced. */
  append: (entry: WorktreeEntry) => void;
  /** Throws if the session was replaced since the operation started. */
  ensureCurrent: (what: string) => void;
  signal?: AbortSignal;
}

export interface WorktreeToolResult {
  text: string;
  details: Record<string, unknown>;
}

function slug(text: string, max: number): string {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, max)
    .replace(/-+$/u, '');
  return value || 'task';
}

function nonce(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

export function worktreeBranch(sessionId: string, task: string): string {
  return `herdr/${slug(sessionId.slice(0, 8), 8)}/${slug(task, 32)}-${nonce()}`;
}

function inspectHint(record: WorktreeRecord): string {
  return `inspect manually: git -C ${record.repoRoot} worktree list; git -C ${record.repoRoot} branch --list ${record.branch}; herdr worktree list${
    record.sourceWorkspace ? ` --workspace ${record.sourceWorkspace}` : ''
  }. Never adopted or deleted automatically.`;
}

export async function createWorktree(
  ctx: WorktreeContext,
  params: { task?: string; target?: string },
): Promise<WorktreeToolResult> {
  const task = params.task?.trim();
  if (!task) throw new Error('create requires task; nothing recorded');
  const { signal } = ctx;
  const top = await runGit(ctx.cwd, ['rev-parse', '--show-toplevel'], signal);
  if (!top.ok) throw new Error(`not in a git repository (${gitMessage(top)}); nothing recorded`);
  const repoRoot = top.stdout.trim();
  const head = await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], signal);
  const base = head.stdout.trim();
  if (!head.ok || !/^[0-9a-f]{40,64}$/u.test(base)) {
    throw new Error(`could not resolve HEAD (${gitMessage(head)}); nothing recorded`);
  }
  let target = params.target?.trim();
  if (target) {
    // A literal local branch name only: no revision expressions or shorthands.
    const format = await runGit(repoRoot, ['check-ref-format', '--branch', target], signal);
    if (
      !format.ok ||
      format.stdout.trim() !== target ||
      (await localBranchExists(repoRoot, target, signal)) !== true
    ) {
      throw new Error(`target ${target} is not an existing local branch name; nothing recorded`);
    }
  } else {
    const current = await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal);
    target = current.ok ? nonEmpty(current.stdout) : undefined;
    if (!target) {
      throw new Error(
        'source checkout is on a detached HEAD; pass target (the branch to integrate into); nothing recorded',
      );
    }
  }
  const status = await runGit(repoRoot, ['status', '--porcelain', '--untracked-files=all'], signal);
  const sourceDirty = !status.ok
    ? 'could not be checked for uncommitted changes'
    : status.stdout.trim().length > 0
      ? 'has uncommitted changes'
      : undefined;
  // Never reuse a branch another record (even an unknown one) or git already holds.
  const taken = recordedBranches(ctx.entries());
  let branch: string | undefined;
  for (let attempt = 0; attempt < BRANCH_ATTEMPTS && branch === undefined; attempt += 1) {
    const candidate = worktreeBranch(ctx.sessionId, task);
    if (taken.has(candidate)) continue;
    const exists = await localBranchExists(repoRoot, candidate, signal);
    if (exists === undefined) {
      throw new Error(`could not check whether ${candidate} exists; nothing recorded`);
    }
    if (!exists) branch = candidate;
  }
  if (branch === undefined)
    throw new Error('could not allocate an unused branch; nothing recorded');
  ctx.ensureCurrent('nothing recorded');

  const op = randomUUID();
  const sourceWorkspace = nonEmpty(process.env.HERDR_WORKSPACE_ID);
  const at = (): string => new Date().toISOString();
  const common = { op, sessionId: ctx.sessionId, branch };
  ctx.append({
    event: 'intent',
    ...common,
    at: at(),
    repoRoot,
    ...(sourceWorkspace ? { sourceWorkspace } : {}),
    base,
    target,
    task,
  });

  // Never --force, --trust-repository or --focus.
  const result = await runHerdr(
    [
      'worktree',
      'create',
      ...(sourceWorkspace ? ['--workspace', sourceWorkspace] : ['--cwd', repoRoot]),
      '--branch',
      branch,
      '--base',
      base,
      '--no-focus',
    ],
    { timeoutMs: CREATE_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  ctx.ensureCurrent(
    'the creation outcome was not recorded; the original conversation keeps it pending',
  );

  const record = (): WorktreeRecord =>
    readWorktreeRecords(ctx.entries(), ctx.sessionId).find((r) => r.op === op)!;
  const parsed = herdrResult(result);
  if (parsed === undefined) {
    const error = herdrError(result);
    if (result.exitCode !== null && result.exitCode !== 0 && error.code) {
      ctx.append({
        event: 'failed',
        ...common,
        at: at(),
        reason: `${error.code}: ${error.message}`,
      });
      const failed = record();
      return {
        text: `worktree #${failed.id} creation failed (${error.code}: ${error.message}); nothing was created. Branch ${branch} was not reused.`,
        details: { worktree: failed },
      };
    }
    ctx.append({ event: 'unknown', ...common, at: at(), reason: error.message });
    const unknown = record();
    return {
      text: `worktree #${unknown.id} creation outcome unknown (${error.message}); it may or may not exist. Not retried. Branch ${branch}; ${inspectHint(unknown)}`,
      details: { worktree: unknown },
    };
  }

  const worktree = isRecord(parsed.worktree) ? parsed.worktree : {};
  const workspace = isRecord(parsed.workspace) ? parsed.workspace : {};
  const pane = isRecord(parsed.root_pane) ? parsed.root_pane : {};
  const path = nonEmpty(worktree.path);
  const workspaceId = nonEmpty(workspace.workspace_id) ?? nonEmpty(worktree.open_workspace_id);
  const rootPaneId = nonEmpty(pane.pane_id);
  const rootTerminalId = nonEmpty(pane.terminal_id);
  const problem =
    nonEmpty(worktree.branch) !== branch
      ? `Herdr reported branch ${nonEmpty(worktree.branch) ?? '(none)'}, not ${branch}`
      : !path || !existsSync(path)
        ? `reported path ${path ?? '(none)'} does not exist`
        : !workspaceId || !rootPaneId
          ? 'Herdr reported no workspace or root pane'
          : undefined;
  if (problem || !path || !workspaceId || !rootPaneId) {
    ctx.append({ event: 'unknown', ...common, at: at(), reason: problem ?? 'unverifiable result' });
    const unknown = record();
    return {
      text: `worktree #${unknown.id} creation unverified (${problem}); recorded unknown, not retried. ${inspectHint(unknown)}`,
      details: { worktree: unknown },
    };
  }
  ctx.append({
    event: 'created',
    ...common,
    at: at(),
    path,
    workspaceId,
    rootPaneId,
    ...(rootTerminalId ? { rootTerminalId } : {}),
  });
  const created = record();
  const lines = [
    `created worktree #${created.id}: ${path}`,
    `branch: ${branch} (base ${base}); integrate into: ${target}`,
    `workspace: ${workspaceId}; root pane: ${rootPaneId} — start the worker with \`herdr agent start --pane ${rootPaneId} ...\`, then claim it with herdr_workers.`,
    ...(sourceDirty
      ? [
          `WARNING: the source checkout ${sourceDirty}; uncommitted changes are NOT in this worktree (it starts at the last commit). Work that depends on them must wait until they are committed.`,
        ]
      : []),
  ];
  return {
    text: lines.join('\n'),
    details: { worktree: created, sourceDirty: sourceDirty !== undefined },
  };
}

export async function removeWorktree(
  ctx: WorktreeContext,
  params: { worktree?: number },
): Promise<WorktreeToolResult> {
  const id = params.worktree;
  if (id === undefined) {
    throw new Error('remove requires worktree: the record number shown by herdr_worktrees list');
  }
  const record = readWorktreeRecords(ctx.entries(), ctx.sessionId).find((r) => r.id === id);
  if (record === undefined) throw new Error(`no recorded worktree #${id} in this conversation`);
  const refuse = (why: string): never => {
    throw new Error(`refused to remove worktree #${id}: ${why}. Nothing was changed.`);
  };
  if (record.state !== 'created' || !record.path || !record.workspaceId || !record.rootPaneId) {
    refuse(`its state is ${record.state}, not created`);
  }
  const path = record.path!;
  const workspaceId = record.workspaceId!;
  const { signal } = ctx;

  const [checkouts, workspaces, panes, status] = await Promise.all([
    gitWorktrees(record.repoRoot, signal),
    workspaceCheckouts(signal),
    listPanes(['pane', 'list', '--workspace', workspaceId], 'panes', signal),
    runGit(path, ['status', '--porcelain', '--untracked-files=all'], signal),
  ]);
  ctx.ensureCurrent('nothing removed');
  if (signal?.aborted) refuse('cancelled');
  if (checkouts === undefined) refuse(`git worktree list failed in ${record.repoRoot}`);
  const checkout = checkouts!.find((entry) => samePath(entry.path, path));
  if (!checkout) refuse(`git does not list ${path} as a worktree of ${record.repoRoot}`);
  if (checkout!.branch !== record.branch) {
    refuse(`${path} is on ${checkout!.branch ?? 'a detached HEAD'}, not ${record.branch}`);
  }
  if (workspaces === undefined) refuse('Herdr workspace lookup failed');
  const mapped = workspaces!.get(workspaceId);
  if (!workspaces!.has(workspaceId)) refuse(`Herdr lists no workspace ${workspaceId}`);
  if (!mapped || !samePath(mapped, path)) {
    refuse(`Herdr maps workspace ${workspaceId} to ${mapped ?? 'no checkout'}, not ${path}`);
  }
  if (panes === undefined) refuse(`Herdr pane lookup for ${workspaceId} failed`);
  const agents = panes!.filter((pane) => pane.agent !== undefined);
  if (agents.length > 0) {
    refuse(`agent ${agents.map((p) => `${p.agent} in ${p.paneId}`).join(', ')} is still running`);
  }
  const unexpected = panes!.filter(
    (pane) =>
      pane.paneId !== record.rootPaneId ||
      (record.rootTerminalId !== undefined && pane.terminalId !== record.rootTerminalId),
  );
  if (unexpected.length > 0 || panes!.length !== 1) {
    refuse(
      `workspace ${workspaceId} has panes other than the recorded root pane ${record.rootPaneId} (${
        panes!.map((p) => p.paneId).join(', ') || 'none'
      })`,
    );
  }
  if (!status.ok) refuse(`git status failed in ${path} (${gitMessage(status)})`);
  if (status.stdout.trim().length > 0) refuse(`${path} has uncommitted or untracked changes`);

  // Without --force: Herdr itself also refuses a dirty checkout.
  ctx.ensureCurrent('nothing removed');
  const removal = await runHerdr(['worktree', 'remove', '--workspace', workspaceId], {
    timeoutMs: REMOVE_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  const receipt = herdrResult(removal);
  const receiptOk =
    receipt !== undefined &&
    receipt.type === 'worktree_removed' &&
    typeof receipt.path === 'string' &&
    samePath(receipt.path, path) &&
    receipt.workspace_id === workspaceId &&
    receipt.forced === false;
  const gone = !existsSync(path);
  ctx.ensureCurrent(
    `Herdr removal ${receiptOk ? 'succeeded' : 'was not confirmed'}${gone ? ' and the checkout path is gone' : ''}, but the outcome was not recorded`,
  );
  if (!receiptOk || !gone) {
    const error =
      receipt === undefined
        ? herdrError(removal)
        : receiptOk
          ? undefined
          : { message: 'Herdr returned an unexpected removal receipt' };
    return {
      text: `worktree #${id} removal not confirmed: ${
        error
          ? `${error.code ? `Herdr ${error.code}: ` : ''}${error.message}`
          : 'Herdr reported success'
      }; ${
        gone
          ? 'the checkout path is gone, but the record stays created'
          : 'the checkout still exists and is preserved'
      }. Check herdr_worktrees list.`,
      details: { worktree: record, removed: false },
    };
  }
  const at = (): string => new Date().toISOString();
  const common = { op: record.op, sessionId: ctx.sessionId, branch: record.branch };
  ctx.append({ event: 'removed', ...common, at: at() });

  // Branch: deleted only when its verified tip is unchanged and merged into the
  // recorded target, both re-read immediately before `git branch -d` (never -D).
  // Residual window: git re-resolves the name inside `branch -d`; a write between
  // the last re-read and that call is not excluded (git -d still checks HEAD/upstream).
  let kept: string | undefined;
  const verified = checkout!.head;
  const [tip, targetTip] = await Promise.all([
    branchTip(record.repoRoot, record.branch, signal),
    branchTip(record.repoRoot, record.target, signal),
  ]);
  if (verified === undefined || tip === undefined) kept = 'could not read the branch tip';
  else if (tip !== verified) kept = 'branch tip moved during removal';
  else if (targetTip === undefined) kept = `could not read ${record.target}`;
  else {
    const merged = await mergedInto(record.repoRoot, tip, targetTip, signal);
    if (merged === undefined) kept = `could not verify ancestry into ${record.target}`;
    else if (!merged) kept = `not merged into ${record.target}`;
    else {
      const [tipNow, targetNow] = await Promise.all([
        branchTip(record.repoRoot, record.branch, signal),
        branchTip(record.repoRoot, record.target, signal),
      ]);
      if (tipNow !== tip || targetNow !== targetTip) {
        kept = `branch or ${record.target} moved before deletion`;
      } else {
        ctx.ensureCurrent(
          'the checkout was removed; the branch was NOT deleted and its outcome is unresolved',
        );
        const deletion = await runGit(record.repoRoot, ['branch', '-d', record.branch], signal);
        if (!deletion.ok) kept = `git branch -d refused: ${gitMessage(deletion)}`;
      }
    }
  }
  ctx.ensureCurrent(
    `the checkout was removed and the branch was ${kept === undefined ? 'deleted' : 'kept'}, but that outcome was not recorded`,
  );
  ctx.append(
    kept === undefined
      ? { event: 'branch-deleted', ...common, at: at() }
      : { event: 'branch-kept', ...common, at: at(), reason: kept },
  );
  const final = readWorktreeRecords(ctx.entries(), ctx.sessionId).find((r) => r.id === id)!;
  return {
    text: `removed worktree #${id} (${path}; workspace ${workspaceId} closed). Branch ${record.branch} ${
      kept === undefined ? 'deleted (merged into ' + record.target + ')' : `kept: ${kept}`
    }.`,
    details: { worktree: final, removed: true },
  };
}

interface Observation {
  checkout: 'present' | 'missing' | 'wrong branch' | 'unknown';
  workspace: 'mapped' | 'absent' | 'mismatch' | 'unknown';
  changes: 'clean' | 'dirty' | 'unknown';
  tip?: string;
  merged: 'merged' | 'unmerged' | 'unknown';
  agents: string[] | 'unknown';
}

async function observeRecord(
  record: WorktreeRecord,
  checkouts: Map<string, Awaited<ReturnType<typeof gitWorktrees>>>,
  workspaces: Map<string, string | undefined> | undefined,
  agents: PaneInfo[] | undefined,
  signal?: AbortSignal,
): Promise<Observation> {
  const path = record.path!;
  const list = checkouts.get(record.repoRoot);
  const entry = list?.find((candidate) => samePath(candidate.path, path));
  const checkout: Observation['checkout'] =
    list === undefined
      ? 'unknown'
      : !entry
        ? 'missing'
        : entry.branch === record.branch
          ? 'present'
          : 'wrong branch';
  const mapped = workspaces?.get(record.workspaceId!);
  const workspace: Observation['workspace'] =
    workspaces === undefined
      ? 'unknown'
      : !workspaces.has(record.workspaceId!)
        ? 'absent'
        : mapped && samePath(mapped, path)
          ? 'mapped'
          : 'mismatch';
  let changes: Observation['changes'] = 'unknown';
  if (checkout === 'present') {
    const status = await runGit(path, ['status', '--porcelain', '--untracked-files=all'], signal);
    if (status.ok) changes = status.stdout.trim().length > 0 ? 'dirty' : 'clean';
  }
  const tip = await branchTip(record.repoRoot, record.branch, signal);
  const merged =
    tip === undefined
      ? undefined
      : await mergedInto(record.repoRoot, tip, `refs/heads/${record.target}`, signal);
  return {
    checkout,
    workspace,
    changes,
    ...(tip ? { tip } : {}),
    merged: merged === undefined ? 'unknown' : merged ? 'merged' : 'unmerged',
    agents:
      agents === undefined
        ? 'unknown'
        : agents
            .filter((agent) => agent.workspaceId === record.workspaceId)
            .map((agent) => `${agent.agent ?? 'agent'} in ${agent.paneId}`),
  };
}

export async function listWorktrees(ctx: WorktreeContext): Promise<WorktreeToolResult> {
  const records = readWorktreeRecords(ctx.entries(), ctx.sessionId);
  // Removed checkouts stay listed until their branch outcome is recorded.
  const removed = records.filter(
    (record) => record.state === 'removed' && !branchUnresolved(record),
  );
  const visible = records.filter(
    (record) => record.state !== 'removed' || branchUnresolved(record),
  );
  const keptBranches = removed.filter((record) => record.branchOutcome?.deleted === false);
  const hidden =
    removed.length > 0
      ? ` (${removed.length} removed, not shown${
          keptBranches.length > 0
            ? `; kept branches: ${keptBranches.map((r) => r.branch).join(', ')}`
            : ''
        })`
      : '';
  if (visible.length === 0) {
    return {
      text: `no recorded worktrees in this conversation${hidden}`,
      details: { worktrees: [], removed: removed.length },
    };
  }
  const created = visible.filter((record) => record.state === 'created');
  const repoRoots = [...new Set(created.map((record) => record.repoRoot))];
  const { signal } = ctx;
  const [checkoutLists, workspaces, agents] = await Promise.all([
    Promise.all(repoRoots.map((root) => gitWorktrees(root, signal))),
    created.length > 0 ? workspaceCheckouts(signal) : Promise.resolve(undefined),
    created.length > 0
      ? listPanes(['agent', 'list'], 'agents', signal)
      : Promise.resolve(undefined),
  ]);
  const checkouts = new Map(repoRoots.map((root, index) => [root, checkoutLists[index]]));
  const observations = new Map<number, Observation>();
  for (const record of created) {
    observations.set(record.id, await observeRecord(record, checkouts, workspaces, agents, signal));
  }
  ctx.ensureCurrent('list discarded');

  const lines = [
    `${visible.length} recorded worktree${visible.length === 1 ? '' : 's'} in this conversation${hidden}. Observations come from Git and Herdr now; a failed lookup is unknown, never missing.`,
  ];
  for (const record of visible) {
    lines.push(`#${record.id} ${record.state}: ${record.branch}`);
    lines.push(`  task: ${record.task}`);
    lines.push(
      `  repo: ${record.repoRoot}; base ${record.base.slice(0, 12)}; integrate into ${record.target}`,
    );
    const observed = observations.get(record.id);
    if (record.state === 'created' && observed) {
      lines.push(
        `  path: ${record.path}; workspace ${record.workspaceId}; root pane ${record.rootPaneId}`,
      );
      lines.push(
        `  live: checkout ${observed.checkout}; workspace ${observed.workspace}; changes ${observed.changes}; branch ${
          observed.tip ? observed.tip.slice(0, 12) : 'tip unknown'
        } ${observed.merged === 'unknown' ? 'merge state unknown' : `${observed.merged} into ${record.target}`}; agents ${
          observed.agents === 'unknown'
            ? 'unknown'
            : observed.agents.length === 0
              ? 'none'
              : observed.agents.join(', ')
        }`,
      );
    } else if (record.state === 'failed') {
      lines.push(`  failed: ${record.error}; nothing was created`);
    } else if (record.state === 'removed') {
      lines.push(
        `  checkout removed; branch outcome unresolved: ${record.branch} was neither deleted nor confirmed kept, and deletion is never resumed automatically. Inspect: git -C ${record.repoRoot} branch --list ${record.branch}; delete only with git branch -d after verifying it is merged into ${record.target}.`,
      );
    } else {
      lines.push(
        `  ${record.state === 'pending' ? 'creation outcome never recorded' : `outcome unknown: ${record.error}`}; ${inspectHint(record)}`,
      );
    }
  }
  return {
    text: lines.join('\n'),
    details: {
      removed: removed.length,
      worktrees: visible.map((record) => ({
        ...record,
        ...(observations.has(record.id) ? { observation: observations.get(record.id) } : {}),
      })),
    },
  };
}
