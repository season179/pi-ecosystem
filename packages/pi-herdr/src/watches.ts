import { spawn, type ChildProcess } from 'node:child_process';
import { herdrCommand } from './herdr-cli.js';
import { liveAgentFrom, resultAgent } from './owned-workers.js';
import type { WatchOutcome, WatchRecordPublic, WatchSpec } from './types.js';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_KILL_GRACE_MS = 5_000;
const GROUP_POLL_MS = 25;
const STARTUP_WINDOW_MS = 5_000;

type TerminationCause = 'none' | 'timeout' | 'stopped';

class TailBuffer {
  private value: Buffer = Buffer.alloc(0);

  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length >= MAX_CAPTURE_BYTES) {
      this.value = incoming.subarray(incoming.length - MAX_CAPTURE_BYTES);
      return;
    }

    const combined = Buffer.concat([this.value, incoming]);
    this.value =
      combined.length > MAX_CAPTURE_BYTES
        ? combined.subarray(combined.length - MAX_CAPTURE_BYTES)
        : combined;
  }

  toString(): string {
    return this.value.toString('utf8');
  }
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    const lastLine = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (lastLine === undefined) return undefined;
    try {
      return JSON.parse(lastLine);
    } catch {
      return undefined;
    }
  }
}

function copySpec(spec: WatchSpec): WatchSpec {
  if (spec.mode === 'agent') {
    return {
      ...spec,
      ...(spec.until === undefined ? {} : { until: [...spec.until] }),
      ...(spec.identity === undefined ? {} : { identity: { ...spec.identity } }),
    };
  }
  return { ...spec };
}

function copyRecord(record: WatchRecordPublic): WatchRecordPublic {
  return { ...record, spec: copySpec(record.spec) };
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The command may not have established a process group yet.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A close/error event will settle a child that already exited.
  }
}

/** Stop waiting on pipes that an unreachable (detached) descendant inherited. */
function releaseStdio(entry: { child: ChildProcess }): void {
  entry.child.stdout?.destroy();
  entry.child.stderr?.destroy();
}

/** Whether any process remains in the owned group after the direct child is gone. */
function groupSurvives(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class CapacityError extends Error {}

export interface WatchManagerOptions {
  maxWatches: number;
  command?: string;
  onOutcome: (record: WatchRecordPublic, outcome: WatchOutcome) => void;
  killGraceMs?: number;
}

/** Live process state; released when the watch settles, leaving only the public record. */
interface WatchEntry {
  record: WatchRecordPublic;
  child: ChildProcess;
  stdout: TailBuffer;
  stderr: TailBuffer;
  /** Set once the outcome has been reported; nothing else happens after this. */
  closed: boolean;
  /** Set once stdout/stderr have closed; the outcome is complete but the group may survive. */
  drained: boolean;
  /** What ended the command, for classification. Explicit stop is a separate record status. */
  terminationCause: TerminationCause;
  /** Set when the direct child exits; stdout/stderr may still be held by descendants. */
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  /** Set once the grace expired: the group got SIGKILL and is no longer waited on. */
  killed: boolean;
  /** Default waits armed on idle/done first look for working or blocked. */
  startup: boolean;
  /** Shared by both phases; absent means no overall timeout. */
  deadline?: number;
  timeoutTimer?: NodeJS.Timeout;
  /**
   * One grace period per watch, armed once when the watch begins to end: by cancellation, or by
   * the command exiting with its group or pipes still busy. Expiry SIGKILLs whatever remains in
   * the group and releases pipes held out of reach. Settling early clears it.
   */
  killGraceTimer?: NodeJS.Timeout;
  /** Pending probe of the owned group after the command exited. */
  groupPollTimer?: NodeJS.Timeout;
  closePromise: Promise<void>;
  resolveClose: () => void;
}

function hasValue(value: Record<string, unknown>, key: string): boolean {
  return value[key] !== undefined;
}

function requireTarget(value: Record<string, unknown>, mode: string): void {
  if (typeof value.target !== 'string' || value.target.trim().length === 0) {
    throw new Error(`${mode} watches require a non-empty target`);
  }
}

function validateSharedFields(value: Record<string, unknown>): void {
  if (typeof value.wake !== 'boolean') {
    throw new Error('watch specs require a boolean wake field');
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw new Error('watch note must be a string');
  }
}

function validateTimeout(value: unknown, required: boolean): void {
  if (value === undefined && !required) return;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be a positive finite integer no greater than ${MAX_TIMEOUT_MS}`,
    );
  }
}

/** Runtime validation for tool callers and other non-TypeScript consumers. */
export function validateWatchSpec(spec: unknown): asserts spec is WatchSpec {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new Error('watch spec must be an object');
  }
  const value = spec as Record<string, unknown>;
  if (value.mode !== 'agent' && value.mode !== 'output' && value.mode !== 'command') {
    throw new Error(`unsupported watch mode: ${String(value.mode)}`);
  }
  validateSharedFields(value);

  switch (value.mode) {
    case 'agent':
      requireTarget(value, 'agent');
      if (hasValue(value, 'match') || hasValue(value, 'regex') || hasValue(value, 'command')) {
        throw new Error('agent watches cannot specify match, regex, or command');
      }
      if (
        value.until !== undefined &&
        (!Array.isArray(value.until) || !value.until.every((state) => typeof state === 'string'))
      ) {
        throw new Error('agent watch until must be an array of strings');
      }
      if (
        value.identity !== undefined &&
        (typeof value.identity !== 'object' ||
          value.identity === null ||
          typeof (value.identity as Record<string, unknown>).paneId !== 'string' ||
          typeof (value.identity as Record<string, unknown>).terminalId !== 'string')
      ) {
        throw new Error('agent watch identity requires paneId and terminalId strings');
      }
      validateTimeout(value.timeoutMs, false);
      return;
    case 'output': {
      requireTarget(value, 'output');
      if (hasValue(value, 'until') || hasValue(value, 'command')) {
        throw new Error('output watches cannot specify until or command');
      }
      const conditionCount = Number(hasValue(value, 'match')) + Number(hasValue(value, 'regex'));
      if (conditionCount !== 1) {
        throw new Error('output watches require exactly one of match or regex');
      }
      const condition = hasValue(value, 'match') ? value.match : value.regex;
      if (typeof condition !== 'string') {
        throw new Error('output match or regex must be a string');
      }
      validateTimeout(value.timeoutMs, false);
      return;
    }
    case 'command':
      if (typeof value.command !== 'string' || value.command.trim().length === 0) {
        throw new Error('command watches require a non-empty command');
      }
      if (
        hasValue(value, 'target') ||
        hasValue(value, 'until') ||
        hasValue(value, 'match') ||
        hasValue(value, 'regex')
      ) {
        throw new Error('command watches cannot specify target, until, match, or regex');
      }
      validateTimeout(value.timeoutMs, true);
      return;
  }
}

export function buildWatchArgs(spec: WatchSpec): string[] {
  validateWatchSpec(spec);
  if (spec.mode === 'agent') {
    // A resolved snapshot pins the waiter to that pane, not a reusable name.
    const args = ['agent', 'wait', spec.identity?.paneId ?? spec.target];
    for (const until of spec.until ?? []) args.push('--until', until);
    if (spec.timeoutMs !== undefined) {
      args.push('--timeout', String(spec.timeoutMs));
    }
    return args;
  }

  if (spec.mode === 'output') {
    const args = ['pane', 'wait-output', spec.target];
    if (spec.regex !== undefined) args.push('--regex', spec.regex);
    else args.push('--match', spec.match);
    if (spec.timeoutMs !== undefined) {
      args.push('--timeout', String(spec.timeoutMs));
    }
    return args;
  }

  throw new Error('command watches do not use herdr CLI arguments');
}

export class WatchManager {
  private readonly records = new Map<number, WatchRecordPublic>();
  private readonly live = new Map<number, WatchEntry>();
  private readonly maxWatches: number;
  private readonly command: string;
  private readonly onOutcome: WatchManagerOptions['onOutcome'];
  private readonly killGraceMs: number;
  private nextId = 1;
  private isShutdown = false;

  constructor(opts: WatchManagerOptions) {
    this.maxWatches = opts.maxWatches;
    this.command = opts.command ?? herdrCommand();
    this.onOutcome = opts.onOutcome;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  start(
    spec: WatchSpec,
    options: { cwd?: string; initialStatus?: string } = {},
  ): WatchRecordPublic {
    if (this.isShutdown) throw new Error('watch manager is shut down');
    validateWatchSpec(spec);
    const armedCount = [...this.live.values()].filter(
      (entry) => entry.record.status === 'armed',
    ).length;
    if (armedCount >= this.maxWatches) {
      throw new CapacityError(`watch capacity reached (${this.maxWatches} armed watches)`);
    }

    const record: WatchRecordPublic = {
      id: this.nextId++,
      spec: copySpec(spec),
      startedAt: Date.now(),
      status: 'armed',
    };
    const startup =
      spec.mode === 'agent' &&
      !spec.until?.length &&
      (options.initialStatus === 'idle' || options.initialStatus === 'done');
    const deadline =
      startup && spec.timeoutMs !== undefined ? record.startedAt + spec.timeoutMs : undefined;
    const child =
      spec.mode === 'command'
        ? spawn('/bin/sh', ['-c', spec.command], {
            cwd: options.cwd,
            detached: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(
            this.command,
            buildWatchArgs(
              startup && spec.mode === 'agent'
                ? {
                    ...spec,
                    until: ['working', 'blocked'],
                    timeoutMs: Math.min(
                      STARTUP_WINDOW_MS,
                      deadline === undefined ? Infinity : Math.max(1, deadline - Date.now()),
                    ),
                  }
                : spec,
            ),
            {
              detached: true,
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
    let resolveClose = (): void => undefined;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const entry: WatchEntry = {
      record,
      child,
      stdout: new TailBuffer(),
      stderr: new TailBuffer(),
      closed: false,
      drained: false,
      terminationCause: 'none',
      killed: false,
      startup,
      deadline,
      closePromise,
      resolveClose,
    };
    this.records.set(record.id, record);
    this.live.set(record.id, entry);

    this.observeChild(entry);
    if (spec.mode === 'command' || deadline !== undefined) {
      entry.timeoutTimer = setTimeout(
        () => {
          // A gated watch owns one deadline, including the inter-phase cleanup.
          if (deadline !== undefined && entry.record.status === 'armed') {
            entry.terminationCause = 'timeout';
          }
          this.terminate(entry, 'timeout');
        },
        deadline === undefined ? spec.timeoutMs : Math.max(1, deadline - Date.now()),
      );
    }

    return copyRecord(record);
  }

  private observeChild(entry: WatchEntry): void {
    const child = entry.child;
    child.stdout?.on('data', (chunk: Buffer | string) => entry.stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => entry.stderr.append(chunk));
    child.once('error', (error) => {
      entry.stderr.append(`${entry.stderr.toString() ? '\n' : ''}${error.message}`);
      this.finish(entry);
    });
    child.once('exit', (code, signal) => {
      entry.exit = { code, signal };
      this.reconcile(entry);
    });
    // `close` waits for the pipes, so output written up to the exit is captured.
    child.once('close', () => {
      entry.drained = true;
      this.reconcile(entry);
    });
  }

  /** Stops armed watches and resolves once every selected live watch has settled. */
  async stop(id: number | 'all'): Promise<WatchRecordPublic[]> {
    const selected = [...this.live.values()].filter(
      (entry) => id === 'all' || entry.record.id === id,
    );
    const targets = selected.filter((entry) => entry.record.status === 'armed');

    for (const entry of targets) this.terminate(entry, 'stopped');

    // A repeat stop or a shutdown during an earlier stop's kill grace joins that cleanup.
    await Promise.all(selected.map((entry) => entry.closePromise));
    return targets.map((entry) => copyRecord(entry.record));
  }

  list(): WatchRecordPublic[] {
    return [...this.records.values()]
      .sort((left, right) => {
        const leftGroup = left.status === 'armed' ? 0 : 1;
        const rightGroup = right.status === 'armed' ? 0 : 1;
        return leftGroup - rightGroup || left.id - right.id;
      })
      .map(copyRecord);
  }

  get(id: number): WatchRecordPublic | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : copyRecord(record);
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await this.stop('all');
  }

  private terminate(entry: WatchEntry, cause: Exclude<TerminationCause, 'none'>): void {
    if (entry.closed) return;
    if (entry.timeoutTimer !== undefined) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = undefined;
    }
    // An explicit stop is recorded even after the command exited: the caller asked for no
    // report and no wake. The outcome itself still reflects what actually ended the command.
    if (cause === 'stopped') entry.record.status = 'stopped';
    if (entry.terminationCause === 'none' && entry.exit === undefined) {
      entry.terminationCause = cause;
    }
    this.escalate(entry);
  }

  /** SIGTERM the owned process group once and start the grace. */
  private escalate(entry: WatchEntry): void {
    if (entry.killGraceTimer !== undefined) return;
    // While the direct child runs, the group is known to exist (modulo a not-yet-established
    // group, which signalChild handles). Afterwards only signal a group that still has members.
    if (entry.exit === undefined || groupSurvives(entry.child)) signalChild(entry.child, 'SIGTERM');
    this.armGrace(entry);
  }

  private armGrace(entry: WatchEntry): void {
    if (entry.killGraceTimer !== undefined) return;
    entry.killGraceTimer = setTimeout(() => {
      if (entry.closed) return;
      entry.killed = true;
      if (groupSurvives(entry.child)) signalChild(entry.child, 'SIGKILL');
      this.reconcile(entry);
    }, this.killGraceMs);
  }

  /**
   * The command has exited, its pipes closed, the grace expired, or a group probe is due: settle
   * if the owned group is finished and the output is drained; otherwise keep the end bounded.
   */
  private reconcile(entry: WatchEntry): void {
    if (entry.closed || entry.exit === undefined) return;
    if (entry.groupPollTimer !== undefined) {
      clearTimeout(entry.groupPollTimer);
      entry.groupPollTimer = undefined;
    }
    if (!entry.killed && groupSurvives(entry.child)) {
      // Same-group descendants outlived the command: they are terminated whatever they hold.
      this.escalate(entry);
      entry.groupPollTimer = setTimeout(() => this.reconcile(entry), GROUP_POLL_MS);
      return;
    }
    // The owned group is done (or was SIGKILLed and is no longer waited on).
    if (entry.drained) {
      this.finish(entry);
      return;
    }
    // Pipes still open with nothing of ours left: a detached descendant inherited them. Bound the
    // drain with the grace, then release them so they cannot hold the report or shutdown.
    if (entry.killed) releaseStdio(entry);
    else this.armGrace(entry);
  }

  private finish(entry: WatchEntry): void {
    if (entry.closed) return;
    const stdout = entry.stdout.toString();
    const stderr = entry.stderr.toString();
    const json = parseJson(stdout);
    const errorJson = parseJson(stderr);
    const { code: exitCode, signal } = entry.exit ?? { code: null, signal: null };
    if (
      entry.deadline !== undefined &&
      Date.now() >= entry.deadline &&
      entry.record.status === 'armed'
    ) {
      entry.terminationCause = 'timeout';
    }
    let kind = this.classify(entry, exitCode, stderr, errorJson);
    if (entry.startup && entry.record.status === 'armed' && entry.terminationCause === 'none') {
      const state = liveAgentFrom(resultAgent(json))?.status;
      if (kind === 'fired' && state === 'working' && !this.isShutdown) {
        // The old group and pipes are settled. Keep the record, deadline and close promise.
        if (entry.killGraceTimer !== undefined) clearTimeout(entry.killGraceTimer);
        if (entry.groupPollTimer !== undefined) clearTimeout(entry.groupPollTimer);
        entry.killGraceTimer = undefined;
        entry.groupPollTimer = undefined;
        entry.startup = false;
        entry.stdout = new TailBuffer();
        entry.stderr = new TailBuffer();
        entry.exit = undefined;
        entry.drained = false;
        entry.killed = false;
        const spec = entry.record.spec;
        entry.child = spawn(
          this.command,
          buildWatchArgs({
            ...spec,
            ...(entry.deadline === undefined
              ? {}
              : { timeoutMs: Math.max(1, entry.deadline - Date.now()) }),
          }),
          {
            detached: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        this.observeChild(entry);
        return;
      }
      if (kind === 'timeout') kind = 'startup-quiet';
      else if (kind === 'fired' && state !== 'blocked') kind = 'error';
    }
    entry.closed = true;
    if (entry.timeoutTimer !== undefined) clearTimeout(entry.timeoutTimer);
    if (entry.killGraceTimer !== undefined) clearTimeout(entry.killGraceTimer);
    if (entry.groupPollTimer !== undefined) clearTimeout(entry.groupPollTimer);
    if (entry.record.status === 'armed') entry.record.status = 'fired';
    const outcome: WatchOutcome = {
      kind,
      exitCode,
      ...(signal == null ? {} : { signal }),
      durationMs: Date.now() - entry.record.startedAt,
      stdout,
      stderr,
      ...(json === undefined ? {} : { json }),
      ...(errorJson === undefined ? {} : { errorJson }),
    };

    // Release the capture buffers and child handle; the public record stays listable.
    this.live.delete(entry.record.id);
    try {
      this.onOutcome(copyRecord(entry.record), outcome);
    } catch {
      // Outcome observers must not interfere with process cleanup.
    }
    entry.resolveClose();
  }

  private classify(
    entry: WatchEntry,
    exitCode: number | null,
    stderr: string,
    errorJson: unknown,
  ): WatchOutcome['kind'] {
    if (entry.terminationCause === 'stopped') return 'killed';
    if (entry.terminationCause === 'timeout') return 'timeout';
    if (entry.record.spec.mode === 'command') {
      return typeof exitCode === 'number' ? 'fired' : 'error';
    }
    if (exitCode === 0) return 'fired';
    const errorText = `${stderr}\n${errorJson === undefined ? '' : JSON.stringify(errorJson)}`;
    if (/timeout|timed out/iu.test(errorText)) return 'timeout';
    return 'error';
  }
}
