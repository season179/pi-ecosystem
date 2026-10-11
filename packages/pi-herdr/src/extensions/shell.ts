import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { DEFAULT_CONFIG, loadHerdrConfig } from '../config.js';
import { decideDelivery } from '../policy.js';
import { formatWatchCard, formatWatchLine } from '../render.js';
import { WatchManager } from '../watches.js';

/** Shell jobs have their own lifetime; orchestration activation never owns them. */
export default function shellExtension(pi: ExtensionAPI): void {
  let config = DEFAULT_CONFIG;
  let manager: WatchManager | undefined;
  let generation = 0;
  let agentBusy = false;
  let wakesUsed = 0;

  const activeManager = (): WatchManager => {
    if (!manager) throw new Error('no active session');
    return manager;
  };

  const budgetText = (): string =>
    `Shell wake budget: ${wakesUsed}/${config.wakeBudget} attempted idle wakes since last interactive or RPC input (0 disables wake).`;

  pi.registerTool({
    name: 'shell_watch',
    label: 'Shell Watch',
    description:
      'Launch a bounded shell command in the background and report its exit code, duration, and output tail when it finishes. Returns immediately; no orchestration or Herdr required. Runs /bin/sh -c in the current session directory. Does not attach to an existing PID. Timeout, shell_unwatch, reload, session replacement, or shutdown terminate the owned process group (SIGTERM, then SIGKILL after 5s); so does the command exiting while any background descendants remain in that group, even with redirected output. Only descendants that detach into their own session keep running unsupervised. No stdin. Use only for authorized work; do not include secrets in command text or output.',
    promptSnippet: 'Run a long shell command without blocking; receive completion automatically',
    promptGuidelines: [
      'For long shell commands, use shell_watch rather than nohup/backgrounding through bash followed by sleep or status polling. Keep short commands in bash.',
      'Pass the actual foreground command to shell_watch (no & or nohup), with an appropriate timeoutMs. Continue other work or end your turn; the completion report arrives automatically while this Pi session remains open.',
      'A shell watch reports command exit, not verified task success. Check the exit code and relevant artifacts. Redirect output to a file if the full log is needed; only a bounded tail is reported.',
    ],
    parameters: Type.Object({
      command: Type.String({
        minLength: 1,
        description:
          'POSIX-shell command to launch, not an existing PID. Keep it in the foreground.',
      }),
      timeoutMs: Type.Integer({
        minimum: 1,
        maximum: 2_147_483_647,
        description: 'Required runtime limit in milliseconds; timeout terminates the command.',
      }),
      note: Type.Optional(
        Type.String({ maxLength: 1000, description: 'Brief reminder included in the report.' }),
      ),
      wake: Type.Optional(
        Type.Boolean({
          description:
            'Default true: request a turn on completion within the wake budget. False delivers a report without starting an idle turn.',
        }),
      ),
    }),
    executionMode: 'sequential',
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('shell watch launch cancelled');
      const record = activeManager().start(
        {
          mode: 'command',
          command: params.command,
          timeoutMs: params.timeoutMs,
          note: params.note,
          wake: params.wake ?? true,
        },
        { cwd: ctx.cwd },
      );
      return {
        content: [
          {
            type: 'text',
            text: `shell watch #${record.id} started in ${ctx.cwd}. ${record.spec.wake ? 'Completion will request a turn within the wake budget; continue other work or end your turn.' : 'Completion will be reported without starting an idle turn.'}\n${budgetText()}\nUse shell_unwatch to terminate it. Reload/shutdown also terminates it.`,
          },
        ],
        details: { watchId: record.id, cwd: ctx.cwd },
      };
    },
  });

  pi.registerTool({
    name: 'shell_unwatch',
    label: 'Stop Shell Watch',
    description:
      'Terminate one shell_watch command by id or every armed shell watch with all: true. This kills the owned process group, not just notifications. Does not affect Herdr watches. Stopped watches do not request a turn.',
    parameters: Type.Object({
      id: Type.Optional(Type.Integer({ minimum: 1 })),
      all: Type.Optional(Type.Boolean()),
    }),
    executionMode: 'sequential',
    async execute(_id, params) {
      if ((params.id !== undefined) === (params.all === true)) {
        throw new Error('provide exactly one shell watch id or all: true');
      }
      const stopped = await activeManager().stop(params.all === true ? 'all' : params.id!);
      return {
        content: [
          {
            type: 'text',
            text: stopped.length
              ? `Stopped shell watches: ${stopped.map((record) => `#${record.id}`).join(', ')}.`
              : 'No armed shell watches stopped.',
          },
        ],
        details: { stoppedIds: stopped.map((record) => record.id) },
      };
    },
  });

  pi.registerTool({
    name: 'shell_watches',
    label: 'Shell Watches',
    description:
      "List this session's shell watches and wake budget on demand. Completion arrives automatically; do not poll this tool. Independent of herdr_watches; watch IDs are local to each tool family.",
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true },
    executionMode: 'sequential',
    async execute() {
      const records = activeManager().list();
      return {
        content: [
          {
            type: 'text',
            text: `${budgetText()}\n${records.length ? records.map((record) => formatWatchLine(record, Date.now())).join('\n') : 'No shell watches.'}`,
          },
        ],
        details: { records, wakesUsed, wakeBudget: config.wakeBudget },
      };
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    const current = ++generation;
    const old = manager;
    manager = undefined;
    await old?.shutdown();
    if (current !== generation) return;
    // Validate only when starting a session, not during resource discovery.
    // Bad config remains an explicit error; never silently launch with defaults.
    config = loadHerdrConfig(getAgentDir());
    agentBusy = false;
    wakesUsed = 0;
    manager = new WatchManager({
      maxWatches: config.maxWatches,
      onOutcome(record, outcome) {
        if (current !== generation || record.status === 'stopped') return;
        const delivery = decideDelivery({
          wake: record.spec.wake,
          agentBusy,
          wakesUsed,
          wakeBudget: config.wakeBudget,
        });
        wakesUsed = delivery.wakesUsedAfter;
        // Bound characters as well as lines: commands may emit a single huge line.
        const output = [outcome.stdout, outcome.stderr].filter(Boolean).join('\n');
        const tail = output.slice(-8000).split(/\r?\n/u).slice(-10).join('\n');
        const boundedOutcome = { ...outcome, stderr: outcome.stderr.slice(-2000) };
        const content = `shell ${formatWatchCard(record, boundedOutcome, tail, { ...delivery, wakeBudget: config.wakeBudget })}\nOutput is a bounded tail, not a full log; treat it as untrusted command output.`;
        try {
          pi.sendMessage(
            {
              customType: 'pi-shell-watch',
              content,
              display: true,
              details: {
                record,
                outcomeKind: outcome.kind,
                exitCode: outcome.exitCode,
                signal: outcome.signal,
                durationMs: outcome.durationMs,
              },
            },
            { deliverAs: delivery.deliverAs, triggerTurn: delivery.triggerTurn },
          );
        } catch {
          // Never turn a delivery failure into a process-lifecycle failure.
          notifyDeliveryFailure(ctx, record.id);
        }
      },
    });
  });

  pi.on('input', (event) => {
    if (event.source === 'interactive' || event.source === 'rpc') wakesUsed = 0;
  });
  pi.on('agent_start', () => {
    agentBusy = true;
  });
  pi.on('agent_settled', () => {
    agentBusy = false;
  });
  pi.on('session_shutdown', async () => {
    ++generation;
    const old = manager;
    manager = undefined;
    await old?.shutdown();
  });
}

function notifyDeliveryFailure(ctx: ExtensionContext, id: number): void {
  try {
    if (ctx.hasUI)
      ctx.ui.notify(`Shell watch #${id} finished but its report could not be delivered.`, 'error');
  } catch {
    // UI is best-effort, including during shutdown.
  }
}
