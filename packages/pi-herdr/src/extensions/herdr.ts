import { StringEnum } from '@earendil-works/pi-ai';
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fetchClaudeQuota, formatClaudeQuota } from '../claude-quota.js';
import { registerWatchesCommand } from '../commands.js';
import { loadHerdrConfig } from '../config.js';
import { runHerdr } from '../herdr-cli.js';
import { SidebarReconciler } from '../sidebar.js';
import {
  type ActivationSource,
  loadOrchestrationSkill,
  ORCHESTRATION_ENTRY_TYPE,
  parseOrchestrateArgs,
  readOrchestrationState,
} from '../orchestration-state.js';
import { createJevOpener } from '../jev.js';
import { fetchCodexQuota } from '../quota.js';
import { decideDelivery, type DeliveryDecision } from '../policy.js';
import {
  compareIdentity,
  findRecord,
  formatIdentity,
  formatObservedWorker,
  liveAgentFrom,
  lookupAgent,
  observeWorkers,
  readWorkerRecords,
  resultAgent,
  WORKER_ENTRY_TYPE,
  type AgentIdentity,
  type ClaimEntry,
  type ReleaseEntry,
} from '../owned-workers.js';
import {
  createWorktree,
  listWorktrees,
  outstandingWorktrees,
  readWorktreeRecords,
  removeWorktree,
  WORKTREE_ENTRY_TYPE,
  type WorktreeContext,
} from '../owned-worktrees.js';
import {
  formatQuotaLine,
  formatStatusChip,
  formatWatchCard,
  formatWatchLine,
  summarizeCommand,
  type WatchIdentityVerdict,
} from '../render.js';
import {
  formatSelection,
  runSelection,
  SELECT_PURPOSES,
  SelectCancelledError,
  type SelectEnvironment,
  type SelectRequest,
} from '../select.js';
import { appendTelemetry } from '../telemetry.js';
import type { WatchOutcome, WatchRecordPublic, WatchSpec } from '../types.js';
import { WatchManager } from '../watches.js';
import { fetchZaiQuota, formatZaiQuota } from '../zai-quota.js';

const WATCH_MESSAGE_TYPE = 'pi-herdr-watch';
/** Tools that become active only while orchestration is explicitly on. */
const ORCHESTRATOR_TOOL_NAMES = [
  'herdr_select',
  'herdr_watch',
  'herdr_unwatch',
  'herdr_watches',
  'herdr_workers',
  'herdr_worktrees',
] as const;
const ORCHESTRATOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(ORCHESTRATOR_TOOL_NAMES);

const WATCH_DESCRIPTION =
  "Register a non-blocking watch on a herdr agent, pane, or bounded command. You will be woken with a report when it fires — do NOT poll `herdr agent read` in a loop, and NEVER run `herdr agent wait` or `agent prompt --wait` through bash (that blocks your whole turn). To watch a command finishing (CI runs, builds, deploys), prefer mode: 'command': you are woken with its exit code, with no pane or sentinel needed. For workers, prompt WITHOUT --wait, then herdr_watch them, then end your turn or do other work.";

const WatchParams = Type.Object({
  target: Type.Optional(
    Type.String({
      description: 'Required for agent/output mode: unique live agent name or pane ID',
    }),
  ),
  mode: Type.Optional(StringEnum(['agent', 'output', 'command'] as const)),
  until: Type.Optional(Type.Array(Type.String())),
  match: Type.Optional(
    Type.String({
      description:
        'Output mode literal substring. Exactly one of match/regex; the existing pane snapshot is searched immediately on arm.',
    }),
  ),
  regex: Type.Optional(
    Type.String({
      description:
        'Output mode Rust-syntax regex. Exactly one of regex/match; the existing pane snapshot is searched immediately on arm.',
    }),
  ),
  command: Type.Optional(
    Type.String({
      description:
        'Command mode only: non-empty POSIX-shell command run as /bin/sh -c. Fires on any numeric exit code, including non-zero; signal deaths report as errors.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: 'Positive integer timeout in milliseconds; required for command mode.',
    }),
  ),
  note: Type.Optional(Type.String()),
  wake: Type.Optional(Type.Boolean()),
});

const UnwatchParams = Type.Object({
  id: Type.Optional(Type.Number({ description: 'Watch ID to stop' })),
  all: Type.Optional(Type.Boolean({ description: 'Stop every armed watch' })),
});

const WorkersParams = Type.Object({
  action: StringEnum(['list', 'claim', 'release'] as const),
  target: Type.Optional(
    Type.String({ description: 'claim only: live agent name or pane ID of the worker you own' }),
  ),
  task: Type.Optional(
    Type.String({ description: 'claim: short task summary; required on the first claim' }),
  ),
  report: Type.Optional(Type.String({ description: 'claim: report path the worker will write' })),
  model: Type.Optional(
    Type.String({ description: 'claim: model you launched it with (recorded as declared)' }),
  ),
  worker: Type.Optional(
    Type.Number({ description: 'release only: worker number shown by list or claim' }),
  ),
});

const WORKERS_DESCRIPTION =
  'Record which Herdr workers this orchestrator owns. claim right after a successful `herdr agent start` (before the substantive prompt), or to adopt an existing worker you are authorized to control; list to reconcile recorded workers against live Herdr state; release after a verified quit or handoff. Launches nothing and quits nothing; release is not quit, and herdr_unwatch is not release. Records survive reload/resume of this conversation only; a crash between launch and claim leaves the worker unrecorded.';

const WorktreesParams = Type.Object({
  action: StringEnum(['create', 'list', 'remove'] as const),
  task: Type.Optional(
    Type.String({ description: 'create: short task summary (names the branch)' }),
  ),
  target: Type.Optional(
    Type.String({
      description:
        'create: local branch the work will be merged into; defaults to the current branch of the session checkout',
    }),
  ),
  worktree: Type.Optional(
    Type.Number({ description: 'remove only: worktree number shown by create or list' }),
  ),
});

const WORKTREES_DESCRIPTION =
  "Create, list, and remove isolated Git worktrees for concurrent writer workers, through `herdr worktree`. create pins this checkout's last commit as base on a new unique branch and opens one new Herdr workspace (no focus change); start the worker in its root pane with `herdr agent start --pane`. Uncommitted source changes are NOT copied. remove takes a record number only and refuses unless the checkout is this conversation's, Git and Herdr agree on it, no agent or extra pane is in its workspace, and it is clean; it never forces. The branch is deleted with `git branch -d` only when merged into its target, otherwise kept. Never prompts; on doubt it preserves and reports.";

const SELECT_DESCRIPTION =
  "Ask Jev who should do a piece of work: you inline, or a new worker (harness + model). Call it BEFORE deciding to do a task inline or delegate it, and before EVERY new worker launch. Supply facts only: the task brief, relevant context, purpose, and for review/discussion/debate the models that authored the work or position (provenance). Follow the result. Override only when outcome is 'failed' (Jev unavailable, tool error); cannot_select and needs_context are valid answers, not failures. Starts no worker and polls nothing. Never include secrets.";

const SelectParams = Type.Object({
  task: Type.String({
    description:
      'Factual brief of the work: outcome wanted, scope, constraints, checks. No secrets.',
  }),
  context: Type.Optional(
    Type.String({
      description:
        'Relevant known facts (repo, files, current state). Not a transcript; no secrets.',
    }),
  ),
  purpose: Type.Optional(
    StringEnum(SELECT_PURPOSES, {
      description:
        'work (default), review, discussion or debate. The last three require provenance.',
    }),
  ),
  provenance: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Models that authored the work being reviewed or the position being challenged, as known facts, e.g. openai-codex/gpt-6.1-sol. Do not guess.',
    }),
  ),
  provenanceUnknown: Type.Optional(
    Type.Boolean({ description: 'true when the authoring model is genuinely unknown' }),
  ),
  requiresVision: Type.Optional(
    Type.Boolean({
      description:
        'Known fact only: the task needs images/screenshots interpreted (true) or is text-only (false). Omit when unknown.',
    }),
  ),
  allowedOptions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Only when the user explicitly restricted choices: allowed option ids (inline, pi_gpt_6_1_sol, claude_code_opus_5_5).',
    }),
  ),
  activeWorkers: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Models of running workers NOT claimed by this orchestrator, if known (e.g. claude-opus-5-5). Claimed workers are supplied automatically; by convention do not list them again. Omit when unknown.',
    }),
  ),
  queuedDemand: Type.Optional(
    Type.String({
      description: 'Known upcoming work that will need workers, if any. Omit when unknown.',
    }),
  ),
  userPreferences: Type.Optional(
    Type.String({
      description: "The user's explicit preferences relevant to this choice, stated faithfully.",
    }),
  ),
});

function executableOnPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

function selectEnvironment(ctx: ExtensionContext): SelectEnvironment {
  const registry = ctx.modelRegistry;
  let usage: SelectEnvironment['contextUsage'];
  try {
    const current = ctx.getContextUsage();
    if (current)
      usage = {
        tokens: current.tokens,
        contextWindow: current.contextWindow,
        percent: current.percent,
      };
  } catch {
    // Context usage is an optional fact.
  }
  return {
    ...(ctx.model
      ? { orchestrator: { provider: ctx.model.provider, id: ctx.model.id, input: ctx.model.input } }
      : {}),
    ...(usage ? { contextUsage: usage } : {}),
    lookupModel: (provider, id) => {
      const model = registry.find(provider, id);
      return model
        ? { input: model.input, authConfigured: registry.hasConfiguredAuth(model) }
        : undefined;
    },
    knownModels: registry.getAll().map((model) => `${model.provider}/${model.id}`),
    harnessInstalled: (harness) => harness === 'pi' || executableOnPath('claude'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findStringForKey(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string | undefined {
  if (!isRecord(value) || depth > 5) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  for (const nested of Object.values(value)) {
    const candidate = findStringForKey(nested, keys, depth + 1);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function extractAgentState(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const result = isRecord(json.result) ? json.result : undefined;
  const agent = result && isRecord(result.agent) ? result.agent : undefined;
  if (typeof agent?.agent_status === 'string') return agent.agent_status;
  if (typeof result?.agent_status === 'string') return result.agent_status;
  return typeof json.agent_status === 'string' ? json.agent_status : undefined;
}

function extractTail(json: unknown, stdout: string): string | undefined {
  const text = findStringForKey(
    json,
    new Set(['text', 'content', 'output', 'snapshot', 'recent_unwrapped']),
  );
  if (text !== undefined) return text;
  if (json !== undefined) return undefined;
  const raw = stdout.trim();
  return raw.length > 0 ? raw : undefined;
}

function conditionSummary(spec: WatchSpec): string {
  if (spec.mode === 'agent') {
    return spec.until && spec.until.length > 0
      ? `until ${spec.until.join('|')}`
      : 'until idle|done|blocked';
  }
  if (spec.mode === 'command') {
    return `command "${summarizeCommand(spec.command)}"`;
  }
  if (spec.regex !== undefined) return `regex /${spec.regex}/`;
  return `match "${spec.match}"`;
}

function lastLines(text: string, count: number): string | undefined {
  const trimmed = text.replace(/\n+$/u, '');
  if (trimmed.length === 0) return undefined;
  return trimmed.split(/\r?\n/u).slice(-count).join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type TelemetrySnapshot =
  | { delivery: DeliveryDecision; wakeBudget: number }
  | { delivery?: undefined; wakesUsed: number; wakeBudget: number };

export function buildTelemetryRecord(
  record: WatchRecordPublic,
  outcome: WatchOutcome,
  snapshot: TelemetrySnapshot,
): Record<string, unknown> {
  const delivery = snapshot.delivery;
  const wakesUsed = delivery === undefined ? snapshot.wakesUsed : delivery.wakesUsedAfter;
  return {
    watchId: record.id,
    ...(record.spec.mode === 'command'
      ? { exitCode: outcome.exitCode }
      : { target: record.spec.target }),
    mode: record.spec.mode,
    kind: outcome.kind,
    durationMs: outcome.durationMs,
    triggerTurn: delivery?.triggerTurn ?? false,
    countsAsWake: delivery?.countsAsWake ?? false,
    ...(delivery === undefined ? {} : { deliveryReason: delivery.reason }),
    wakesUsed,
    wakeBudget: snapshot.wakeBudget,
  };
}

export default function herdrExtension(pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID) {
    return;
  }

  const agentDir = getAgentDir();
  const config = loadHerdrConfig(agentDir);
  const envActivation = process.env.PI_HERDR_ORCHESTRATOR === '1';
  let manager: WatchManager | undefined;
  // Activation belongs to the session: it is decided in session_start from
  // persisted entries (or the explicit env launch) and never assumed from
  // package installation alone.
  let promoted = false;
  let recoveryNote: string | undefined;
  const noticedSessions = new Set<string>();
  let agentBusy = false;
  let wakesUsed = 0;
  let exhaustionNotified = false;
  let uiCtx: ExtensionContext | undefined;
  let sessionGeneration = 0;
  let sidebar: SidebarReconciler | undefined;

  const updateFooter = (): void => {
    try {
      if (!uiCtx?.hasUI) return;
      if (!promoted) {
        uiCtx.ui.setStatus('herdr', undefined);
        return;
      }
      const armedCount = manager?.list().filter((record) => record.status === 'armed').length ?? 0;
      uiCtx.ui.setStatus('herdr', formatStatusChip(armedCount, wakesUsed, config.wakeBudget));
    } catch {
      // Footer rendering is best-effort and must not affect watches.
    }
  };

  const setOrchestratorToolsActive = (active: boolean): void => {
    const current = pi.getActiveTools();
    pi.setActiveTools(
      active
        ? [...new Set([...current, ...ORCHESTRATOR_TOOL_NAMES])]
        : current.filter((name) => !ORCHESTRATOR_TOOL_NAME_SET.has(name)),
    );
  };

  const notify = (
    ctx: ExtensionContext | undefined,
    message: string,
    level: 'info' | 'warning' | 'error',
  ): void => {
    try {
      if (ctx?.hasUI) ctx.ui.notify(message, level);
    } catch {
      // Notifications are best-effort.
    }
  };

  pi.on('context', (event) => {
    // Older versions persisted automatic quota messages. Keep them out of resumed
    // context without removing user text, historical /limits output or watch reports.
    return {
      messages: event.messages.filter(
        (m) =>
          !(
            m.role === 'custom' &&
            (m.customType === 'pi-herdr-quota-warning' || m.customType === 'pi-herdr-quota-context')
          ),
      ),
    };
  });

  const persistActivation = (
    ctx: ExtensionContext,
    active: boolean,
    source: ActivationSource,
  ): void => {
    pi.appendEntry(ORCHESTRATION_ENTRY_TYPE, {
      active,
      sessionId: ctx.sessionManager.getSessionId(),
      source,
      at: new Date().toISOString(),
    });
  };

  /** Single activation path shared by `/orchestrate`, `herdr_orchestrate`, env, and restore. */
  const activate = (
    ctx: ExtensionContext,
    source: ActivationSource,
    options: { persist: boolean },
  ): boolean => {
    const changed = !promoted;
    promoted = true;
    setOrchestratorToolsActive(true);
    updateFooter();
    if (changed && options.persist) persistActivation(ctx, true, source);
    void sidebar?.refresh();
    return changed;
  };

  /** Deactivate guidance and tools; stops only this extension's armed watches. */
  const deactivate = async (ctx: ExtensionContext): Promise<number> => {
    const changed = promoted;
    promoted = false;
    const clearing = sidebar?.stop();
    const stopped = manager ? (await manager.stop('all')).length : 0;
    await clearing;
    recoveryNote = undefined;
    setOrchestratorToolsActive(false);
    updateFooter();
    if (changed) persistActivation(ctx, false, 'command');
    return stopped;
  };

  const OFF_DISCLOSURE =
    'workers were NOT stopped and conversation history is unchanged; recorded worker claims and worktree records are kept; resolve any outstanding supervision deliberately.';

  const buildGuidance = (): string => {
    const skill = loadOrchestrationSkill();
    const body =
      'body' in skill
        ? `${skill.body}\n\nSkill directory: ${skill.directory}\nResolve relative reference links from this directory. Read a reference only when its stated condition applies.`
        : `Orchestration workflow guidance is unavailable (${skill.error}). Follow the user's explicit instructions and the herdr_watch tool guidance only.`;
    const lines = [
      '# Herdr orchestration (active for this session)',
      '',
      body,
      '',
      '## Runtime status',
      '- Armed watches never survive reload, resume, new session, or fork; re-arm only after reconciling what is actually running.',
      ...(recoveryNote ? [`- ${recoveryNote}`] : []),
      `- \`/orchestrate off\` removes this guidance and stops armed watches only; ${OFF_DISCLOSURE}`,
    ];
    return lines.join('\n');
  };

  const writeTelemetry = (
    record: WatchRecordPublic,
    outcome: WatchOutcome,
    snapshot: TelemetrySnapshot,
  ): void => {
    appendTelemetry(config.telemetryPath, buildTelemetryRecord(record, outcome, snapshot));
  };

  const handleOutcome = async (
    generation: number,
    record: WatchRecordPublic,
    outcome: WatchOutcome,
  ): Promise<void> => {
    let telemetryWritten = false;
    let telemetrySnapshot: TelemetrySnapshot | undefined;
    try {
      updateFooter();
      if (record.status === 'stopped') {
        telemetrySnapshot = {
          wakesUsed,
          wakeBudget: config.wakeBudget,
        };
        writeTelemetry(record, outcome, telemetrySnapshot);
        telemetryWritten = true;
        return;
      }

      let tail: string | undefined;
      let identityVerdict: WatchIdentityVerdict | undefined;
      if (record.spec.mode === 'agent' && outcome.kind === 'fired') {
        // The waited-on pane may now host a different agent. Attribute state and read the tail
        // only after both the wait result and a fresh lookup match the arm-time snapshot.
        const snapshot = record.spec.identity;
        let verdict = compareIdentity(snapshot, liveAgentFrom(resultAgent(outcome.json))?.identity);
        if (verdict === 'match' && config.includeTailLines > 0) {
          const current = await lookupAgent(snapshot!.paneId);
          verdict = current.ok ? compareIdentity(snapshot, current.agent.identity) : 'unverified';
          if (verdict === 'match') {
            // Residual race: the pane can still change between this lookup and the read.
            const tailResult = await runHerdr(
              [
                'agent',
                'read',
                snapshot!.paneId,
                '--source',
                'recent-unwrapped',
                '--lines',
                String(config.includeTailLines),
              ],
              { timeoutMs: 5_000 },
            );
            if (tailResult.exitCode === 0) {
              tail = extractTail(tailResult.json, tailResult.stdout);
            }
          }
        }
        // Independent of tail configuration: only a verified identity gets state, tail, or toast.
        identityVerdict = verdict === 'match' ? 'verified' : verdict;
      }
      if (record.spec.mode === 'command') {
        tail = lastLines([outcome.stdout, outcome.stderr].filter(Boolean).join('\n'), 10);
      } else if (
        tail === undefined &&
        outcome.json === undefined &&
        identityVerdict === undefined
      ) {
        tail = lastLines(outcome.stdout || outcome.stderr, 10);
      }

      if (generation !== sessionGeneration) {
        telemetrySnapshot = {
          wakesUsed,
          wakeBudget: config.wakeBudget,
        };
        writeTelemetry(record, outcome, telemetrySnapshot);
        telemetryWritten = true;
        return;
      }

      const busyAtDecision = agentBusy;
      const delivery = decideDelivery({
        wake: record.spec.wake,
        agentBusy: busyAtDecision,
        wakesUsed,
        wakeBudget: config.wakeBudget,
      });
      wakesUsed = delivery.wakesUsedAfter;
      telemetrySnapshot = { delivery, wakeBudget: config.wakeBudget };
      const content = formatWatchCard(
        record,
        outcome,
        tail,
        {
          reason: delivery.reason,
          wakesUsedAfter: delivery.wakesUsedAfter,
          wakeBudget: config.wakeBudget,
          countsAsWake: delivery.countsAsWake,
        },
        identityVerdict,
      );
      pi.sendMessage(
        {
          customType: WATCH_MESSAGE_TYPE,
          content,
          display: true,
          details: { record, outcomeKind: outcome.kind },
        },
        {
          deliverAs: delivery.deliverAs,
          triggerTurn: delivery.triggerTurn,
        },
      );
      const notifyExhaustion =
        delivery.reason === 'budget-exhausted' && !busyAtDecision && !exhaustionNotified;
      if (notifyExhaustion) exhaustionNotified = true;
      updateFooter();

      if (notifyExhaustion) {
        try {
          await runHerdr(
            [
              'notification',
              'show',
              `Herdr wake budget exhausted (${delivery.wakesUsedAfter}/${config.wakeBudget}); watch #${record.id} did not start a turn`,
              '--sound',
              'request',
            ],
            { timeoutMs: 5_000 },
          );
        } catch {
          // Exhaustion notifications are best-effort; the latch stays set.
        }
        // The session may have been replaced during that I/O; deliver nothing more to it.
        if (generation !== sessionGeneration) {
          writeTelemetry(record, outcome, telemetrySnapshot);
          telemetryWritten = true;
          return;
        }
      }

      const state = record.spec.mode === 'agent' ? extractAgentState(outcome.json) : undefined;
      if (
        record.spec.mode === 'agent' &&
        outcome.kind === 'fired' &&
        identityVerdict === 'verified' &&
        state !== undefined &&
        config.toastOn.includes(state)
      ) {
        try {
          await runHerdr([
            'notification',
            'show',
            `${record.spec.target} ${state}`,
            '--sound',
            'request',
          ]);
        } catch {
          // Herdr notifications are best-effort.
        }
      }

      writeTelemetry(record, outcome, telemetrySnapshot);
      telemetryWritten = true;
    } catch (error) {
      if (!telemetryWritten) {
        telemetrySnapshot ??= {
          wakesUsed,
          wakeBudget: config.wakeBudget,
        };
        writeTelemetry(record, outcome, telemetrySnapshot);
      }
      if (generation === sessionGeneration) {
        try {
          pi.sendMessage(
            {
              customType: WATCH_MESSAGE_TYPE,
              content: `watch #${record.id} delivery failed: ${errorMessage(error)}`,
              display: true,
              details: { record, outcomeKind: outcome.kind },
            },
            { deliverAs: 'steer', triggerTurn: false },
          );
        } catch {
          // A delivery failure must never become an unhandled rejection.
        }
      }
    } finally {
      updateFooter();
    }
  };

  pi.registerTool({
    name: 'herdr_orchestrate',
    label: 'Herdr Orchestrate',
    description:
      "Activate herdr orchestration for this session: enables herdr_select/herdr_watch/herdr_unwatch/herdr_watches/herdr_workers/herdr_worktrees and returns the orchestration workflow to follow. Call this ONLY when the user explicitly asks you to act as the orchestrator (e.g. 'you are the orchestrator', 'dispatch this to workers'). Never call it on your own initiative or because a worker brief mentions orchestration. Activation starts no workers.",
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const changed = activate(ctx, 'tool', { persist: true });
      const guidance = buildGuidance();
      const header = changed
        ? 'orchestration activated for this session (persisted; restored on reload/resume, not on fork). No workers were started. Follow this workflow now:'
        : 'orchestration already active for this session. Current workflow:';
      return {
        content: [{ type: 'text', text: `${header}\n\n${guidance}` }],
        details: { promoted: true, changed },
      };
    },
  });

  pi.registerMessageRenderer(WATCH_MESSAGE_TYPE, (message, _options, theme) => {
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
    const box = new Box(1, 1, (text) => theme.bg('customMessageBg', text));
    box.addChild(new Text(content, 0, 0));
    return box;
  });

  pi.registerTool({
    name: 'herdr_watch',
    label: 'Herdr Watch',
    description: WATCH_DESCRIPTION,
    promptSnippet: 'Register a non-blocking herdr watch that reports when it fires',
    promptGuidelines: [
      'Use herdr_watch after prompting a herdr worker without --wait; continue other work or end the turn until the watch reports.',
      'Never poll herdr agent read in a loop or run herdr agent wait or agent prompt --wait through bash; use herdr_watch instead.',
      "To watch a command finishing (CI runs, builds, deploys), prefer mode: 'command' — you are woken with the exit code; no pane or sentinel is needed.",
      'If a pane sentinel is still appropriate, print the exit status inline: …; printf \'\\n__TAG_%s__\\n\' "$?". Never assign to status: it is read-only in zsh and aborts the rest of the line. Keep a %s-style placeholder in the typed command so its echoed text cannot false-match the regex.',
    ],
    parameters: WatchParams,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (manager === undefined) throw new Error('no active session');
      const mode = params.mode ?? 'agent';
      let identity: AgentIdentity | undefined;
      let claimNote: string | undefined;
      if (mode === 'agent' && params.target?.trim()) {
        // Snapshot identity once; a failed lookup still arms the watch as before.
        const generation = sessionGeneration;
        const lookup = await lookupAgent(params.target, signal);
        // Cancellation is not a lookup failure: never start a waiter for a cancelled call.
        if (signal?.aborted) throw new Error('herdr_watch cancelled; watch not armed');
        if (generation !== sessionGeneration || manager === undefined) {
          throw new Error('session changed while resolving the watch target; watch not armed');
        }
        if (lookup.ok) {
          identity = lookup.agent.identity;
          const claimed = readWorkerRecords(
            ctx.sessionManager.getEntries(),
            ctx.sessionManager.getSessionId(),
          ).some(
            (record) =>
              !record.released &&
              record.identity.terminalId === identity!.terminalId &&
              (record.identity.session === undefined ||
                record.identity.session === identity!.session),
          );
          if (!claimed) {
            claimNote = 'not a claimed worker; claim it with herdr_workers if you own it.';
          }
        } else {
          claimNote = `identity lookup failed (${lookup.error}); claim status unknown${
            config.includeTailLines > 0 ? ' and the fired card will omit the tail' : ''
          }.`;
        }
      }
      const specInput = {
        mode,
        ...(params.target === undefined ? {} : { target: params.target }),
        ...(identity === undefined ? {} : { identity }),
        ...(params.until === undefined ? {} : { until: params.until }),
        ...(params.match === undefined ? {} : { match: params.match }),
        ...(params.regex === undefined ? {} : { regex: params.regex }),
        ...(params.command === undefined ? {} : { command: params.command }),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(params.note === undefined ? {} : { note: params.note }),
        wake: params.wake ?? true,
      };
      const record = manager.start(specInput as WatchSpec);
      updateFooter();
      const armedOn =
        record.spec.mode === 'command'
          ? conditionSummary(record.spec)
          : `${record.spec.target} (${conditionSummary(record.spec)})`;
      const deliveryPromise = record.spec.wake
        ? 'you will be woken when it fires; continue other work or end your turn.'
        : 'report will be delivered without starting a turn';
      return {
        content: [
          {
            type: 'text',
            text: `watch #${record.id} armed on ${armedOn} — ${deliveryPromise}${
              claimNote ? `\n${claimNote}` : ''
            }`,
          },
        ],
        details: { watchId: record.id },
      };
    },
  });

  pi.registerTool({
    name: 'herdr_unwatch',
    label: 'Herdr Unwatch',
    description:
      'Stop armed herdr watches by providing an id or all: true. A stopped watch delivers no report.',
    parameters: UnwatchParams,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      if (manager === undefined) throw new Error('no active session');
      const target = params.all === true ? 'all' : params.id;
      if (target === undefined) throw new Error('provide a watch id or all: true');
      const stopped = await manager.stop(target);
      updateFooter();
      const text =
        stopped.length === 0
          ? 'no armed watches stopped'
          : stopped.length === 1
            ? `stopped watch #${stopped[0]?.id}`
            : `stopped ${stopped.length} watches: ${stopped
                .map((record) => `#${record.id}`)
                .join(', ')}`;
      return {
        content: [{ type: 'text', text }],
        details: { stoppedIds: stopped.map((record) => record.id) },
      };
    },
  });

  pi.registerTool({
    name: 'herdr_watches',
    label: 'Herdr Watches',
    description: 'List armed herdr watches and recent watch history.',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute() {
      if (manager === undefined) throw new Error('no active session');
      const records = manager.list();
      const header =
        config.wakeBudget === 0
          ? 'wake: off (budget 0)'
          : `wake budget: ${wakesUsed}/${config.wakeBudget} attempted idle wakes since last interactive or RPC input`;
      const rows =
        records.length === 0
          ? 'no watches'
          : records.map((record) => formatWatchLine(record, Date.now())).join('\n');
      return {
        content: [{ type: 'text', text: `${header}\n${rows}` }],
        details: {
          count: records.length,
          wakesUsed,
          wakeBudget: config.wakeBudget,
          exhausted: config.wakeBudget > 0 && wakesUsed >= config.wakeBudget,
        },
      };
    },
  });

  pi.registerTool({
    name: 'herdr_workers',
    label: 'Herdr Workers',
    description: WORKERS_DESCRIPTION,
    promptSnippet: 'Claim, list, or release the Herdr workers this orchestrator owns',
    parameters: WorkersParams,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (manager === undefined) throw new Error('no active session');
      const sessionId = ctx.sessionManager.getSessionId();
      const readRecords = () => readWorkerRecords(ctx.sessionManager.getEntries(), sessionId);

      if (params.action === 'claim') {
        const target = params.target?.trim();
        if (!target) throw new Error('claim requires target: the worker agent name or pane ID');
        const generation = sessionGeneration;
        const lookup = await lookupAgent(target, signal);
        // Never append into a session that replaced the one this claim started in.
        if (generation !== sessionGeneration) {
          throw new Error('session changed during the Herdr lookup; nothing recorded');
        }
        if (!lookup.ok) {
          throw new Error(`could not resolve ${target}: ${lookup.error}; nothing recorded`);
        }
        const identity = lookup.agent.identity;
        const records = readRecords();
        const existing = findRecord(records, identity);
        const task = params.task?.trim();
        if (!task && !existing?.task) {
          throw new Error('task is required on the first claim; nothing recorded');
        }
        const report = params.report?.trim();
        const model = params.model?.trim();
        const entry: ClaimEntry = {
          action: 'claim',
          sessionId,
          at: new Date().toISOString(),
          ...identity,
          ...(task ? { task } : {}),
          ...(report ? { report } : {}),
          ...(model ? { model } : {}),
        };
        pi.appendEntry(WORKER_ENTRY_TYPE, entry);
        void sidebar?.refresh();
        const updated = readRecords();
        const record = findRecord(updated, identity)!;
        const others = updated.filter(
          (other) =>
            other !== record &&
            !other.released &&
            (other.identity.paneId === identity.paneId ||
              other.identity.terminalId === identity.terminalId),
        );
        const verb =
          existing === undefined ? 'claimed' : existing.released ? 'reclaimed' : 'updated';
        const lines = [
          `${verb} worker #${record.id}: ${formatIdentity(identity)}`,
          ...(identity.session
            ? []
            : [
                'session unverified: Herdr reported no session, so this record can never verify as a full match.',
              ]),
          `task: ${record.task ?? '(none recorded)'}`,
          ...(record.report ? [`report: ${record.report}`] : []),
          `declared model: ${record.model ?? 'unknown'}`,
          ...others.map(
            (other) =>
              `#${other.id} (a different identity on this pane or terminal) stays recorded until released.`,
          ),
          'Ownership only: nothing was launched, prompted, or watched.',
        ];
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: { worker: record },
        };
      }

      if (params.action === 'release') {
        const id = params.worker;
        if (id === undefined) {
          throw new Error('release requires worker: the number shown by herdr_workers list');
        }
        const record = readRecords().find((candidate) => candidate.id === id);
        if (record === undefined) throw new Error(`no recorded worker #${id} in this conversation`);
        if (record.released) {
          return {
            content: [{ type: 'text', text: `worker #${id} was already released` }],
            details: { worker: record },
          };
        }
        const entry: ReleaseEntry = {
          action: 'release',
          sessionId,
          at: new Date().toISOString(),
          terminalId: record.identity.terminalId,
          ...(record.identity.session ? { session: record.identity.session } : {}),
        };
        pi.appendEntry(WORKER_ENTRY_TYPE, entry);
        await sidebar?.release(id);
        return {
          content: [
            {
              type: 'text',
              text: `released worker #${id} (${formatIdentity(record.identity)}). It was NOT quit and its watches were not stopped; this conversation no longer records owning it.`,
            },
          ],
          details: { worker: { ...record, released: true } },
        };
      }

      const records = readRecords();
      const released = records.filter((record) => record.released).length;
      const generation = sessionGeneration;
      const observed = await observeWorkers(records, signal);
      // Never report one conversation's records, or another session's watches, as this one's.
      if (generation !== sessionGeneration) {
        throw new Error('session changed during the Herdr lookup; list discarded');
      }
      const armed = (manager?.list() ?? []).filter(
        (watch) => watch.status === 'armed' && watch.spec.mode === 'agent',
      );
      const watchesFor = (identity: AgentIdentity): number[] =>
        armed
          .filter((watch) => {
            if (watch.spec.mode !== 'agent') return false;
            const snapshot = watch.spec.identity;
            if (snapshot === undefined) return watch.spec.target === identity.paneId;
            return (
              snapshot.terminalId === identity.terminalId &&
              (identity.session === undefined || snapshot.session === identity.session)
            );
          })
          .map((watch) => watch.id);
      const hidden = released > 0 ? ` (${released} released, not shown)` : '';
      const lines =
        observed.workers.length === 0
          ? [`no recorded workers in this conversation${hidden}`]
          : [
              `${observed.workers.length} recorded worker${observed.workers.length === 1 ? '' : 's'} in this conversation${hidden}. Observations come from one Herdr lookup now; they are not delivery evidence, and never-claimed workers are not listed.`,
              ...(observed.lookup === 'failed'
                ? ['Herdr lookup failed: every observation is unknown, not absent.']
                : []),
              ...observed.workers.map((worker) =>
                formatObservedWorker(worker, watchesFor(worker.record.identity)),
              ),
            ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          lookup: observed.lookup,
          released,
          workers: observed.workers.map((worker) => ({
            ...worker.record,
            observation: worker.observation,
            watches: watchesFor(worker.record.identity),
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: 'herdr_worktrees',
    label: 'Herdr Worktrees',
    description: WORKTREES_DESCRIPTION,
    promptSnippet: 'Create, list, or remove guarded per-worker Git worktrees through Herdr',
    parameters: WorktreesParams,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (manager === undefined) throw new Error('no active session');
      const generation = sessionGeneration;
      const ensureCurrent = (what: string): void => {
        // Never append into, or report for, a session that replaced this one.
        if (generation !== sessionGeneration) throw new Error(`session changed; ${what}`);
      };
      const worktreeCtx: WorktreeContext = {
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        entries: () => ctx.sessionManager.getEntries(),
        append: (entry) => {
          ensureCurrent('nothing recorded');
          pi.appendEntry(WORKTREE_ENTRY_TYPE, entry);
        },
        ensureCurrent,
        ...(signal ? { signal } : {}),
      };
      const result =
        params.action === 'create'
          ? await createWorktree(worktreeCtx, params)
          : params.action === 'remove'
            ? await removeWorktree(worktreeCtx, params)
            : await listWorktrees(worktreeCtx);
      return { content: [{ type: 'text', text: result.text }], details: result.details };
    },
  });

  const openJev = createJevOpener({ agentDir });

  pi.registerTool({
    name: 'herdr_select',
    label: 'Herdr Select',
    description: SELECT_DESCRIPTION,
    promptSnippet: 'Ask Jev whether to work inline or which worker harness/model to launch',
    promptGuidelines: [
      'Call herdr_select before deciding to do a task inline or delegate it, and before every new worker launch; follow its result.',
      'Override a herdr_select result only when its outcome is failed; cannot_select and needs_context are valid answers.',
    ],
    parameters: SelectParams,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await runSelection(
          params as SelectRequest,
          selectEnvironment(ctx),
          {
            openJev,
            fetchCodexQuota: (quotaSignal) => fetchCodexQuota({ signal: quotaSignal }),
            fetchClaudeQuota: (quotaSignal) => fetchClaudeQuota({ signal: quotaSignal }),
            fetchZaiQuota: (quotaSignal) =>
              fetchZaiQuota({
                getApiKey: () => ctx.modelRegistry.getApiKeyForProvider('zai'),
                signal: quotaSignal,
              }),
            observeClaimedWorkers: (lookupSignal) =>
              observeWorkers(
                readWorkerRecords(
                  ctx.sessionManager.getEntries(),
                  ctx.sessionManager.getSessionId(),
                ),
                lookupSignal,
              ),
          },
          signal,
        );
        return { content: [{ type: 'text', text: formatSelection(result) }], details: result };
      } catch (error) {
        if (error instanceof SelectCancelledError) throw error;
        // Parameter errors carry fixed text; anything else stays generic.
        throw new Error(
          error instanceof Error &&
            /^(task is required|unknown allowedOptions)/u.test(error.message)
            ? error.message
            : 'herdr_select failed unexpectedly',
        );
      }
    },
  });

  // Always active (like herdr_orchestrate): a read-only quota peek is useful
  // before and during orchestration, and leaks no orchestrator machinery.
  pi.registerTool({
    name: 'codex_quota',
    label: 'Codex Quota',
    description:
      'Check current Codex subscription usage using the local Codex CLI login. Returns allowed/limit-reached, usage percentages, window lengths, and reset delays. On demand only; do not poll in a loop.',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute(_toolCallId, _params, signal) {
      const snapshot = await fetchCodexQuota({ signal });
      return {
        content: [{ type: 'text', text: formatQuotaLine(snapshot) }],
        details: snapshot,
      };
    },
  });

  pi.registerTool({
    name: 'claude_quota',
    label: 'Claude Quota',
    description:
      'Check Claude subscription usage using the local Claude Code login. Returns five-hour, weekly, and reported model-specific weekly windows with usage percentages and absolute reset times. Missing windows are unknown, not zero usage. On demand only; do not poll in a loop.',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute(_toolCallId, _params, signal) {
      const snapshot = await fetchClaudeQuota({ signal });
      return {
        content: [{ type: 'text', text: formatClaudeQuota(snapshot) }],
        details: snapshot,
      };
    },
  });

  pi.registerTool({
    name: 'zai_quota',
    label: 'Z.ai Quota',
    description:
      "Check personal Z.ai Coding Plan usage using Pi's configured zai API key. Returns coding and MCP quota windows with reported usage percentages and absolute reset times. Shared subscription limits are not per-model headroom. On demand only; do not poll in a loop.",
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const snapshot = await fetchZaiQuota({
        getApiKey: () => ctx.modelRegistry.getApiKeyForProvider('zai'),
        signal,
      });
      return {
        content: [{ type: 'text', text: formatZaiQuota(snapshot) }],
        details: snapshot,
      };
    },
  });

  registerWatchesCommand(pi, {
    list: () => manager?.list() ?? [],
    stop: async (id) => {
      if (manager === undefined) return [];
      const stopped = await manager.stop(id);
      updateFooter();
      return stopped;
    },
  });

  pi.registerCommand('orchestrate', {
    description:
      'Activate herdr orchestration for this session (`/orchestrate`) or switch it off (`/orchestrate off`)',
    getArgumentCompletions: (prefix) =>
      'off'.startsWith(prefix.toLowerCase()) ? [{ value: 'off', label: 'off' }] : null,
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const parsed = parseOrchestrateArgs(args);
      if (parsed.kind === 'unknown') {
        notify(
          ctx,
          `unknown /orchestrate argument "${parsed.argument}"; use /orchestrate or /orchestrate off. Task arguments are not supported.`,
          'error',
        );
        return;
      }
      if (parsed.kind === 'off') {
        const wasActive = promoted;
        const stopped = await deactivate(ctx);
        const watches =
          stopped === 0
            ? 'no armed watches'
            : `stopped ${stopped} armed watch${stopped === 1 ? '' : 'es'} (their child processes were terminated)`;
        notify(
          ctx,
          `${wasActive ? 'orchestration off' : 'orchestration was already off'}: ${watches}; ${OFF_DISCLOSURE}`,
          'info',
        );
        return;
      }
      const changed = activate(ctx, 'command', { persist: true });
      notify(
        ctx,
        changed
          ? 'orchestration active for this session: workflow guidance and watch tools enabled; no workers started. Restored on reload/resume, not on fork.'
          : 'orchestration already active for this session.',
        'info',
      );
    },
  });

  pi.registerCommand('codex-quota', {
    description: 'Show current Codex (ChatGPT plan) quota usage',
    handler: async (_args, ctx) => {
      try {
        const snapshot = await fetchCodexQuota();
        notify(ctx, formatQuotaLine(snapshot), 'info');
      } catch (error) {
        notify(
          ctx,
          `codex quota unavailable: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('claude-quota', {
    description: 'Show current Claude subscription usage',
    handler: async (_args, ctx) => {
      try {
        notify(ctx, formatClaudeQuota(await fetchClaudeQuota()), 'info');
      } catch (error) {
        notify(ctx, `claude quota unavailable: ${errorMessage(error)}`, 'error');
      }
    },
  });

  pi.registerCommand('zai-quota', {
    description: 'Show current personal Z.ai Coding Plan usage',
    handler: async (_args, ctx) => {
      try {
        const snapshot = await fetchZaiQuota({
          getApiKey: () => ctx.modelRegistry.getApiKeyForProvider('zai'),
        });
        notify(ctx, formatZaiQuota(snapshot), 'info');
      } catch (error) {
        notify(ctx, `z.ai quota unavailable: ${errorMessage(error)}`, 'error');
      }
    },
  });

  pi.on('before_agent_start', (event) => {
    if (!promoted) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${buildGuidance()}` };
  });

  pi.on('input', (event, ctx) => {
    uiCtx = ctx;
    if (event.source === 'interactive' || event.source === 'rpc') {
      wakesUsed = 0;
      exhaustionNotified = false;
      updateFooter();
    }
  });

  /**
   * Decide activation for the session that just started. Pi re-runs this
   * extension factory on reload/new/resume/fork, so nothing in memory
   * survives; the persisted entries of this session are authoritative.
   * Fork/clone copies entries under a new session id, so they never match,
   * and the explicit env launch never activates such an inherited session.
   */
  const restoreActivation = (ctx: ExtensionContext, reason: string): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = readOrchestrationState(ctx.sessionManager.getEntries(), sessionId);
    const firstNotice = !noticedSessions.has(sessionId);
    noticedSessions.add(sessionId);

    if (state.own) {
      promoted = state.own.active;
      setOrchestratorToolsActive(promoted);
      if (promoted) {
        // Records restore; their live identity and supervision do not.
        const recorded = readWorkerRecords(ctx.sessionManager.getEntries(), sessionId).filter(
          (record) => !record.released,
        ).length;
        const outstanding = outstandingWorktrees(
          readWorktreeRecords(ctx.sessionManager.getEntries(), sessionId),
        );
        const worktrees =
          outstanding.open === 0 && outstanding.unresolved === 0
            ? ''
            : `; ${outstanding.open} worktree${outstanding.open === 1 ? '' : 's'} not removed (${outstanding.unknown} unknown)${
                outstanding.unresolved === 0
                  ? ''
                  : `, ${outstanding.unresolved} removed with branch outcome unresolved`
              }; run herdr_worktrees list`;
        const workers = `${recorded} recorded worker${recorded === 1 ? '' : 's'}; supervision not restored; run herdr_workers list${worktrees}`;
        recoveryNote = `Orchestration was restored for this session (${reason}); any watches armed before that point are gone. ${workers} and verify identity and reports before re-arming.`;
        if (firstNotice) {
          notify(
            ctx,
            `orchestration restored for this session (${reason}): armed watches were NOT restored; ${workers}.`,
            'warning',
          );
        }
      }
      return;
    }

    // CLI --fork starts with reason "startup"; an inactive parent may have
    // no activation entries to mark inherited. Its header still identifies it.
    const forked =
      state.inherited ||
      reason === 'fork' ||
      Boolean(ctx.sessionManager.getHeader()?.parentSession);
    if (envActivation && !forked) {
      activate(ctx, 'env', { persist: true });
      if (firstNotice) {
        notify(
          ctx,
          'orchestration active from PI_HERDR_ORCHESTRATOR=1 for this session; no workers started.',
          'info',
        );
      }
      return;
    }

    promoted = false;
    setOrchestratorToolsActive(false);
    if (forked && firstNotice) {
      notify(
        ctx,
        `forked/cloned session: orchestration is inactive here${envActivation ? ' (PI_HERDR_ORCHESTRATOR=1 is ignored for forks)' : ''}; the parent's workers and watches are not owned by this session. Run /orchestrate to activate.`,
        'info',
      );
    }
  };

  pi.on('session_start', async (event, ctx) => {
    uiCtx = ctx;
    agentBusy = false;
    wakesUsed = 0;
    exhaustionNotified = false;
    const generation = ++sessionGeneration;
    const oldSidebar = sidebar;
    sidebar = undefined;
    const clearing = oldSidebar?.stop();
    const oldManager = manager;
    manager = undefined;
    updateFooter();
    await oldManager?.shutdown();
    await clearing;
    if (generation !== sessionGeneration) return;
    manager = new WatchManager({
      maxWatches: config.maxWatches,
      onOutcome: (record, outcome) => {
        void handleOutcome(generation, record, outcome);
      },
    });
    restoreActivation(ctx, event.reason);
    const sessionId = ctx.sessionManager.getSessionId();
    sidebar = new SidebarReconciler(
      sessionId,
      () => generation === sessionGeneration && promoted,
      () => readWorkerRecords(ctx.sessionManager.getEntries(), sessionId),
    );
    void sidebar.refresh();
    updateFooter();
  });

  pi.on('agent_start', (_event, ctx) => {
    uiCtx = ctx;
    agentBusy = true;
  });

  pi.on('agent_settled', (_event, ctx) => {
    uiCtx = ctx;
    agentBusy = false;
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    uiCtx = ctx;
    agentBusy = false;
    sessionGeneration += 1;
    const oldSidebar = sidebar;
    sidebar = undefined;
    const clearing = oldSidebar?.stop();
    const oldManager = manager;
    manager = undefined;
    await oldManager?.shutdown();
    await clearing;
    updateFooter();
  });
}
