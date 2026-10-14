import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import herdrExtension from '../src/extensions/herdr.js';

/** Values `randomInt` returns before falling back to real randomness (forces branch nonces). */
const forcedRandom = vi.hoisted(() => [] as number[]);
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomInt = (...args: unknown[]): number =>
    forcedRandom.length > 0
      ? forcedRandom.shift()!
      : (actual.randomInt as (...a: unknown[]) => number)(...args);
  return { ...actual, default: { ...actual, randomInt }, randomInt };
});

const fixture = fileURLToPath(new URL('./fixtures/fake-herdr.mjs', import.meta.url));
const ENV_KEYS = [
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'PI_HERDR_ORCHESTRATOR',
  'PI_CODING_AGENT_DIR',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'PI_HERDR_COMMAND',
  'FAKE_HERDR_BEHAVIOR',
  'FAKE_HERDR_DELAY_MS',
  'FAKE_HERDR_NOTIFICATION_LOG',
  'FAKE_HERDR_NOTIFICATION_DELAY_MS',
  'FAKE_HERDR_NOTIFICATION_EXIT_CODE',
  'FAKE_HERDR_AGENTS_FILE',
  'FAKE_HERDR_METADATA_LOG',
  'FAKE_HERDR_METADATA_DELAY_MS',
  'FAKE_HERDR_WORKTREE_FILE',
  'HERDR_WORKSPACE_ID',
  'PATH',
  'TYPESAFE_API_KEY',
] as const;

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

interface FakeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  readonly commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
  readonly messages: Array<{ message: any; options: any }> = [];
  readonly statuses: Array<string | undefined> = [];
  readonly notices: Array<{ message: string; level: string }> = [];
  /** Simulated persisted session entries (what pi.appendEntry writes). */
  entries: FakeEntry[] = [];
  sessionId = 'session-a';
  parentSession: string | undefined;
  private activeTools: string[] = [];

  readonly ctx = {
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      setStatus: (_key: string, value: string | undefined) => {
        this.statuses.push(value);
      },
      notify: (message: string, level = 'info') => {
        this.notices.push({ message, level });
      },
    },
    sessionManager: {
      getSessionId: () => this.sessionId,
      getHeader: () => ({ parentSession: this.parentSession }),
      getBranch: () => [...this.entries],
      getEntries: () => [...this.entries],
    },
  } as unknown as ExtensionContext;

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.set(tool.name, tool);
    this.activeTools.push(tool.name);
  }

  registerCommand(name: string, command: { handler: (...args: any[]) => Promise<void> }): void {
    this.commands.set(name, command);
  }

  registerMessageRenderer(): void {}

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  setActiveTools(names: string[]): void {
    this.activeTools = [...names];
  }

  sendMessage(message: any, options: any): void {
    this.messages.push({ message, options });
  }

  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ type: 'custom', customType, data });
  }

  async emit(event: string, fields: Record<string, unknown> = {}): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...fields }, this.ctx));
    }
    return results;
  }

  async execute(
    name: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.execute('call-1', params, signal, undefined, this.ctx);
  }

  orchestrationEntries(): Array<{ active: boolean; sessionId: string; source: string }> {
    return this.entries
      .filter((entry) => entry.customType === 'pi-herdr-orchestration')
      .map((entry) => entry.data as { active: boolean; sessionId: string; source: string });
  }
}

interface Harness {
  pi: FakePi;
  dir: string;
  telemetryPath: string;
  notificationPath: string;
}

let originals = new Map<string, string | undefined>();
let harness: Harness | undefined;

function notificationCount(path: string): number {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createHarness(
  wakeBudget: number,
  options: {
    promoted?: boolean;
    notificationDelayMs?: number;
    entries?: FakeEntry[];
    sessionId?: string;
    parentSession?: string;
    reason?: string;
    includeTailLines?: number;
    toastOn?: string[];
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-herdr-extension-'));
  const telemetryPath = join(dir, 'telemetry.jsonl');
  const notificationPath = join(dir, 'notifications.jsonl');
  writeFileSync(
    join(dir, 'herdr.json'),
    JSON.stringify({
      maxWatches: 20,
      wakeBudget,
      includeTailLines: options.includeTailLines ?? 0,
      toastOn: options.toastOn ?? [],
      telemetryPath,
    }),
  );
  process.env.HERDR_ENV = '1';
  process.env.HERDR_PANE_ID = 'w1:p1';
  process.env.PI_HERDR_ORCHESTRATOR = options.promoted === false ? '0' : '1';
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CODEX_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.PI_HERDR_COMMAND = fixture;
  process.env.FAKE_HERDR_BEHAVIOR = 'ok';
  delete process.env.FAKE_HERDR_DELAY_MS;
  process.env.FAKE_HERDR_NOTIFICATION_LOG = notificationPath;
  process.env.FAKE_HERDR_NOTIFICATION_DELAY_MS = String(options.notificationDelayMs ?? 0);
  delete process.env.FAKE_HERDR_NOTIFICATION_EXIT_CODE;
  process.env.FAKE_HERDR_AGENTS_FILE = join(dir, 'agents.json');
  writeFileSync(process.env.FAKE_HERDR_AGENTS_FILE, JSON.stringify({ agents: [] }));
  process.env.FAKE_HERDR_METADATA_LOG = join(dir, 'metadata.jsonl');
  delete process.env.FAKE_HERDR_METADATA_DELAY_MS;

  const pi = new FakePi();
  if (options.entries) pi.entries = [...options.entries];
  if (options.sessionId) pi.sessionId = options.sessionId;
  pi.parentSession = options.parentSession;
  herdrExtension(pi as unknown as ExtensionAPI);
  await pi.emit('session_start', { reason: options.reason ?? 'startup' });
  harness = { pi, dir, telemetryPath, notificationPath };
  return harness;
}

async function injectedPrompt(current: Harness): Promise<string | undefined> {
  const results = (await current.pi.emit('before_agent_start', {
    prompt: 'go',
    systemPrompt: 'BASE PROMPT',
    systemPromptOptions: { cwd: process.cwd() },
  })) as Array<{ systemPrompt?: string } | undefined>;
  return results.find((result) => result?.systemPrompt !== undefined)?.systemPrompt;
}

const ORCHESTRATOR_TOOLS = [
  'herdr_select',
  'herdr_watch',
  'herdr_unwatch',
  'herdr_watches',
  'herdr_workers',
  'herdr_worktrees',
];

function activeOrchestratorTools(current: Harness): string[] {
  return current.pi
    .getActiveTools()
    .filter((name) => ORCHESTRATOR_TOOLS.includes(name))
    .sort();
}

async function arm(
  current: Harness,
  wake = true,
): Promise<{ response: any; message: { message: any; options: any } }> {
  const expectedMessages = current.pi.messages.length + 1;
  const response = await current.pi.execute('herdr_watch', {
    target: `worker-${expectedMessages}`,
    mode: 'agent',
    wake,
  });
  await waitFor(
    () => current.pi.messages.length >= expectedMessages,
    `watch delivery ${expectedMessages}`,
  );
  return {
    response,
    message: current.pi.messages[expectedMessages - 1]!,
  };
}

async function watchDetails(current: Harness): Promise<any> {
  return (await current.pi.execute('herdr_watches')).details;
}

beforeEach(() => {
  originals = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  if (harness) {
    await harness.pi.emit('session_shutdown');
    rmSync(harness.dir, { recursive: true, force: true });
    harness = undefined;
  }
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = originals.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.sequential('herdr extension attendance epochs', () => {
  it('resets budget and latch on interactive input, RPC input, and session start', async () => {
    const current = await createHarness(1);
    await arm(current);
    await arm(current);
    await waitFor(
      () => notificationCount(current.notificationPath) === 1,
      'first exhaustion notification',
    );

    await current.pi.emit('input', { source: 'interactive', text: 'hello' });
    assert.equal((await watchDetails(current)).wakesUsed, 0);
    await arm(current);
    await arm(current);
    await waitFor(
      () => notificationCount(current.notificationPath) === 2,
      'interactive epoch notification',
    );

    await current.pi.emit('input', { source: 'rpc', text: 'supervise' });
    assert.equal((await watchDetails(current)).wakesUsed, 0);
    await arm(current);
    await arm(current);
    await waitFor(
      () => notificationCount(current.notificationPath) === 3,
      'RPC epoch notification',
    );

    await current.pi.emit('session_start');
    assert.equal((await watchDetails(current)).wakesUsed, 0);
    await arm(current);
    await arm(current);
    await waitFor(
      () => notificationCount(current.notificationPath) === 4,
      'session epoch notification',
    );
  });

  it('extension input resets neither budget nor exhaustion latch', async () => {
    const current = await createHarness(1);
    await arm(current);
    await arm(current);
    await waitFor(() => notificationCount(current.notificationPath) === 1, 'initial notification');

    await current.pi.emit('input', { source: 'extension', text: 'authored' });
    assert.equal((await watchDetails(current)).wakesUsed, 1);
    await arm(current);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(notificationCount(current.notificationPath), 1);
  });

  it('latches the first idle exhaustion before asynchronous notification work', async () => {
    const current = await createHarness(1, { notificationDelayMs: 300 });
    await arm(current);
    const exhausted = await arm(current);
    assert.equal(exhausted.message.options.triggerTurn, false);
    assert.match(exhausted.message.message.content, /wake budget exhausted \(1\/1\)/u);
    await waitFor(
      () => notificationCount(current.notificationPath) === 1,
      'delayed notification start',
    );

    await arm(current);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(notificationCount(current.notificationPath), 1);
    const args = JSON.parse(readFileSync(current.notificationPath, 'utf8').trim()) as string[];
    assert.deepEqual(args, [
      'notification',
      'show',
      'Herdr wake budget exhausted (1/1); watch #2 did not start a turn',
      '--sound',
      'request',
    ]);
  });

  it('keeps the exhaustion latch after a notification CLI failure', async () => {
    const current = await createHarness(1);
    process.env.FAKE_HERDR_NOTIFICATION_EXIT_CODE = '3';
    await arm(current);
    await arm(current);
    await waitFor(
      () => notificationCount(current.notificationPath) === 1,
      'failed notification attempt',
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    await arm(current);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(notificationCount(current.notificationPath), 1);
  });

  it('does not latch a busy exhaustion, then notifies when idle', async () => {
    const current = await createHarness(1);
    await arm(current);
    await current.pi.emit('agent_start');
    await arm(current);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(notificationCount(current.notificationPath), 0);

    await current.pi.emit('agent_settled');
    await arm(current);
    await waitFor(
      () => notificationCount(current.notificationPath) === 1,
      'idle exhaustion after busy delivery',
    );
  });

  it('never reports exhaustion for budget zero or wake:false', async () => {
    const disabled = await createHarness(0);
    const budgetZero = await arm(disabled);
    assert.equal(budgetZero.message.options.triggerTurn, false);
    assert.doesNotMatch(budgetZero.message.message.content, /wake budget/u);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(notificationCount(disabled.notificationPath), 0);
    await disabled.pi.emit('session_shutdown');
    rmSync(disabled.dir, { recursive: true, force: true });
    harness = undefined;

    const optedOut = await createHarness(1);
    await arm(optedOut, true);
    const noWake = await arm(optedOut, false);
    assert.equal(noWake.message.options.triggerTurn, false);
    assert.doesNotMatch(noWake.message.message.content, /wake budget/u);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(notificationCount(optedOut.notificationPath), 0);
  });

  it('uses truthful arming text for wake-enabled and non-waking watches', async () => {
    const current = await createHarness(5);
    const enabled = await arm(current, true);
    const disabled = await arm(current, false);
    assert.match(enabled.response.content[0].text, /you will be woken when it fires/u);
    assert.match(
      disabled.response.content[0].text,
      /report will be delivered without starting a turn$/mu,
    );
    assert.doesNotMatch(disabled.response.content[0].text, /you will be woken/u);
  });

  it('reports positive and exhausted wake-budget list states', async () => {
    const current = await createHarness(1);
    const initial = await current.pi.execute('herdr_watches');
    assert.equal(
      initial.content[0].text,
      'wake budget: 0/1 attempted idle wakes since last interactive or RPC input\nno watches',
    );
    assert.deepEqual(initial.details, {
      count: 0,
      wakesUsed: 0,
      wakeBudget: 1,
      exhausted: false,
    });

    await arm(current);
    const exhausted = await current.pi.execute('herdr_watches');
    assert.match(exhausted.content[0].text, /^wake budget: 1\/1 attempted/u);
    assert.equal(exhausted.details.exhausted, true);
    assert.equal(exhausted.details.wakesUsed, 1);
  });

  it('reports disabled wake-budget list state', async () => {
    const current = await createHarness(0);
    const result = await current.pi.execute('herdr_watches');
    assert.equal(result.content[0].text, 'wake: off (budget 0)\nno watches');
    assert.deepEqual(result.details, {
      count: 0,
      wakesUsed: 0,
      wakeBudget: 0,
      exhausted: false,
    });
  });

  it('shows footer status only while promoted and clears it on orchestrate off', async () => {
    const current = await createHarness(0, { promoted: false });
    assert.equal(current.pi.statuses.at(-1), undefined);

    await current.pi.execute('herdr_orchestrate');
    assert.equal(current.pi.statuses.at(-1), 'herdr: wake off');

    const command = current.pi.commands.get('orchestrate');
    assert.ok(command);
    await command.handler('off', current.pi.ctx);
    assert.equal(current.pi.statuses.at(-1), undefined);
  });

  it('writes the decision snapshot when input resets during notification I/O', async () => {
    const current = await createHarness(1, { notificationDelayMs: 300 });
    await arm(current);
    await arm(current);
    await waitFor(
      () => notificationCount(current.notificationPath) === 1,
      'pending exhaustion notification',
    );

    await current.pi.emit('input', { source: 'interactive', text: 'reset' });
    assert.equal((await watchDetails(current)).wakesUsed, 0);
    await waitFor(() => {
      try {
        return readFileSync(current.telemetryPath, 'utf8').split('\n').filter(Boolean).length >= 2;
      } catch {
        return false;
      }
    }, 'telemetry after delayed notification');

    const records = readFileSync(current.telemetryPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const exhausted = records.find((record) => record.deliveryReason === 'budget-exhausted');
    assert.ok(exhausted);
    assert.equal(exhausted.wakesUsed, 1);
    assert.equal(exhausted.wakeBudget, 1);
    assert.equal(exhausted.triggerTurn, false);
    assert.equal(exhausted.countsAsWake, false);
  });
});

describe.sequential('herdr orchestration activation lifecycle', () => {
  it('stays inactive when installed without env or a persisted decision', async () => {
    const current = await createHarness(0, { promoted: false });
    assert.deepEqual(activeOrchestratorTools(current), []);
    assert.deepEqual(current.pi.orchestrationEntries(), []);
    assert.equal(await injectedPrompt(current), undefined);
    assert.equal(current.pi.tools.has('herdr_route'), false);
    assert.equal(current.pi.commands.has('limits'), false);
  });

  it('/orchestrate activates once, persists a session-owned entry, and injects the bundled skill', async () => {
    const current = await createHarness(0, { promoted: false });
    const command = current.pi.commands.get('orchestrate');
    assert.ok(command);

    await command.handler('', current.pi.ctx);
    assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
    assert.deepEqual(current.pi.orchestrationEntries(), [
      {
        active: true,
        sessionId: 'session-a',
        source: 'command',
        at: current.pi.orchestrationEntries()[0]!.at,
      },
    ] as any);
    assert.match(current.pi.notices.at(-1)!.message, /no workers started/u);
    assert.equal(current.pi.notices.at(-1)!.level, 'info');

    const prompt = await injectedPrompt(current);
    assert.ok(prompt?.startsWith('BASE PROMPT\n\n# Herdr orchestration'));
    assert.match(prompt!, /Own the outcome, not every pane/u, 'skill body injected');
    assert.ok(
      prompt!.includes(
        `Skill directory: ${fileURLToPath(new URL('../skills/orchestration/', import.meta.url))}`,
      ),
    );
    assert.match(prompt!, /references\/recovery\.md/);
    assert.doesNotMatch(prompt!, /^# Recovery and handoff/m, 'reference bodies stay on demand');
    assert.doesNotMatch(prompt!, /^---\nname:/mu, 'frontmatter stripped');
    assert.doesNotMatch(
      prompt!,
      /herdr_route|Routing (ready|setup required)|budgetChoice|CodexBar/u,
    );
    assert.match(prompt!, /Armed watches never survive/u);

    await command.handler('  ', current.pi.ctx);
    assert.equal(current.pi.orchestrationEntries().length, 1, 'idempotent: no duplicate entry');
    assert.match(current.pi.notices.at(-1)!.message, /already active/u);
  });

  it('herdr_orchestrate uses the same path and returns the workflow immediately', async () => {
    const current = await createHarness(0, { promoted: false });
    const result = await current.pi.execute('herdr_orchestrate');
    assert.equal(result.details.changed, true);
    assert.match(result.content[0].text, /^orchestration activated for this session/u);
    assert.match(result.content[0].text, /Own the outcome, not every pane/u);
    assert.ok(
      result.content[0].text.includes(
        `Skill directory: ${fileURLToPath(new URL('../skills/orchestration/', import.meta.url))}`,
      ),
    );
    assert.doesNotMatch(result.content[0].text, /^# Routing decisions|^# Recovery and handoff/m);
    assert.match(result.content[0].text, /No workers were started/u);
    assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
    assert.equal(current.pi.orchestrationEntries()[0]?.source, 'tool');

    const again = await current.pi.execute('herdr_orchestrate');
    assert.equal(again.details.changed, false);
    assert.match(again.content[0].text, /already active/u);
    assert.equal(current.pi.orchestrationEntries().length, 1);
  });

  it('rejects unknown /orchestrate arguments without changing state', async () => {
    const current = await createHarness(0, { promoted: false });
    const command = current.pi.commands.get('orchestrate')!;
    await command.handler('build the CRM', current.pi.ctx);
    assert.deepEqual(activeOrchestratorTools(current), []);
    assert.deepEqual(current.pi.orchestrationEntries(), []);
    assert.equal(current.pi.notices.at(-1)!.level, 'error');
    assert.match(
      current.pi.notices.at(-1)!.message,
      /unknown \/orchestrate argument "build the CRM"/u,
    );
    assert.equal(await injectedPrompt(current), undefined);
  });

  it('/orchestrate off stops armed watches, persists off, and discloses that workers keep running', async () => {
    const current = await createHarness(0, { promoted: false });
    const command = current.pi.commands.get('orchestrate')!;
    await command.handler('', current.pi.ctx);
    process.env.FAKE_HERDR_BEHAVIOR = 'stall';
    await current.pi.execute('herdr_watch', { target: 'worker-x', mode: 'agent' });
    assert.equal((await watchDetails(current)).count, 1);

    await command.handler('off', current.pi.ctx);
    assert.deepEqual(activeOrchestratorTools(current), []);
    assert.deepEqual(
      current.pi.orchestrationEntries().map((entry) => entry.active),
      [true, false],
    );
    const notice = current.pi.notices.at(-1)!.message;
    assert.match(
      notice,
      /^orchestration off: stopped 1 armed watch \(their child processes were terminated\)/u,
    );
    assert.match(notice, /workers were NOT stopped and conversation history is unchanged/u);
    assert.equal(await injectedPrompt(current), undefined);
    assert.equal(current.pi.tools.has('herdr_route'), false);

    await command.handler('off', current.pi.ctx);
    assert.equal(current.pi.orchestrationEntries().length, 2, 'repeated off appends nothing');
    assert.match(current.pi.notices.at(-1)!.message, /already off: no armed watches/u);
  });

  it('PI_HERDR_ORCHESTRATOR=1 activates and persists at session start, but a persisted off wins', async () => {
    const current = await createHarness(0);
    assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
    assert.deepEqual(
      current.pi.orchestrationEntries().map((entry) => entry.source),
      ['env'],
    );
    await current.pi.emit('session_start', { reason: 'reload' });
    assert.equal(current.pi.orchestrationEntries().length, 1, 'restore does not re-append');

    await current.pi.commands.get('orchestrate')!.handler('off', current.pi.ctx);
    await current.pi.emit('session_start', { reason: 'reload' });
    assert.deepEqual(activeOrchestratorTools(current), []);
    assert.equal(current.pi.orchestrationEntries().length, 2);
  });

  it('reads the decision conversation-wide so /tree navigation cannot silently flip it', async () => {
    const current = await createHarness(0, { promoted: false });
    await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
    // Simulate /tree moving the leaf to an earlier point: the entry is no
    // longer on the active branch but remains in the session file.
    (current.pi.ctx as any).sessionManager.getBranch = () => [];
    await current.pi.emit('session_start', { reason: 'reload' });
    assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
  });

  it('restores activation on reload/resume of the same session with a truthful watch warning', async () => {
    const current = await createHarness(0, {
      promoted: false,
      reason: 'resume',
      sessionId: 'session-a',
      entries: [
        {
          type: 'custom',
          customType: 'pi-herdr-orchestration',
          data: { active: true, sessionId: 'session-a', source: 'command', at: 't' },
        },
      ],
    });
    assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
    assert.equal(current.pi.orchestrationEntries().length, 1, 'restore appends no entry');
    const warning = current.pi.notices.find((notice) => notice.level === 'warning');
    assert.match(
      warning!.message,
      /restored for this session \(resume\): armed watches were NOT restored/u,
    );
    const prompt = await injectedPrompt(current);
    assert.match(prompt!, /Orchestration was restored for this session \(resume\)/u);

    const notices = current.pi.notices.length;
    await current.pi.emit('session_start', { reason: 'resume' });
    assert.equal(current.pi.notices.length, notices, 'duplicate session_start does not re-notify');
  });

  it('CLI fork of an inactive parent suppresses env activation even without copied role entries', async () => {
    const current = await createHarness(0, {
      promoted: true,
      reason: 'startup',
      parentSession: '/saved/inactive-parent.jsonl',
    });
    assert.deepEqual(activeOrchestratorTools(current), []);
    assert.equal(current.pi.orchestrationEntries().length, 0);
    assert.match(current.pi.notices.at(-1)!.message, /ignored for forks/);
  });

  it("a fork/clone carrying the parent's activation starts inactive and says so, even with env set", async () => {
    const current = await createHarness(0, {
      promoted: true,
      reason: 'startup',
      sessionId: 'session-child',
      entries: [
        {
          type: 'custom',
          customType: 'pi-herdr-orchestration',
          data: { active: true, sessionId: 'session-parent', source: 'command', at: 't' },
        },
      ],
    });
    assert.deepEqual(activeOrchestratorTools(current), []);
    assert.equal(await injectedPrompt(current), undefined);
    assert.match(
      current.pi.notices.at(-1)!.message,
      /forked\/cloned session: orchestration is inactive here \(PI_HERDR_ORCHESTRATOR=1 is ignored for forks\)/u,
    );
    assert.equal(current.pi.orchestrationEntries().length, 1, 'no entry appended for the child');

    await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
    assert.deepEqual(current.pi.orchestrationEntries().at(-1), {
      active: true,
      sessionId: 'session-child',
      source: 'command',
      at: current.pi.orchestrationEntries().at(-1)!.at,
    } as any);
  });

  it('ignores legacy routing configuration without restoring automatic quota collection', async () => {
    const current = await createHarness(1, { promoted: false });
    // Even malformed legacy configuration cannot block activation or trigger reads.
    writeFileSync(join(current.dir, 'herdr-routing.json'), '{ invalid legacy policy');
    await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
    assert.ok(!current.pi.tools.has('herdr_route'));
    assert.ok(!current.pi.commands.has('limits'));
    assert.equal(current.pi.notices.at(-1)!.level, 'info');
    const context = (await current.pi.emit('context', { messages: [] }))[0] as any;
    assert.deepEqual(context.messages, [], 'no quota snapshot is injected');
    await current.pi.emit('message_end', {
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'subscription quota exhausted',
      },
    });
    assert.deepEqual(current.pi.messages, [], 'no quota messages are generated');
    const delivered = await arm(current);
    assert.equal(delivered.message.message.customType, 'pi-herdr-watch');
  });
});

interface FakeAgentState {
  agents: Array<Record<string, unknown>>;
  lookup?: 'fail';
  lookupDelayMs?: number;
  wait?: Record<string, unknown>;
  read?: string;
}

function setAgents(state: FakeAgentState): void {
  writeFileSync(process.env.FAKE_HERDR_AGENTS_FILE!, JSON.stringify(state));
}

function liveAgent(
  name: string,
  pane: string,
  terminal: string,
  session?: string,
  status = 'idle',
): Record<string, unknown> {
  return {
    agent: 'pi',
    name,
    pane_id: pane,
    terminal_id: terminal,
    agent_status: status,
    ...(session
      ? { agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: session } }
      : {}),
  };
}

function workerEntries(current: Harness): unknown[] {
  return current.pi.entries.filter((entry) => entry.customType === 'pi-herdr-worker');
}

async function listWorkers(current: Harness): Promise<any> {
  return current.pi.execute('herdr_workers', { action: 'list' });
}

const observations = (result: any): Record<number, string> =>
  Object.fromEntries(result.details.workers.map((worker: any) => [worker.id, worker.observation]));

function metadataEvents(): Array<{ phase: string; args: string[] }> {
  const path = process.env.FAKE_HERDR_METADATA_LOG!;
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function metadataCalls(): string[][] {
  return metadataEvents()
    .filter((event) => event.phase === 'applied')
    .map((event) => event.args);
}

function fastSidebarTimer(): void {
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
    original(callback, delay === 30_000 ? 50 : delay, ...args)) as typeof setTimeout);
}

const flagValue = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]!;

describe.sequential('herdr worker sidebar', () => {
  it('labels only matches on the live pane with the canonical agent and guard', async () => {
    const current = await createHarness(0, { promoted: false });
    const agents = [
      liveAgent('launch-alias', 'w1:p2', 'term-1', '/s/1'),
      { ...liveAgent('other-alias', 'w1:p3', 'term-2', '/s/2'), agent: 'claude' },
      liveAgent('unverified', 'w1:p4', 'term-3'),
      liveAgent('replaced', 'w1:p5', 'term-4', '/s/4'),
      liveAgent('absent', 'w1:p6', 'term-5', '/s/5'),
      liveAgent('unknown', 'w1:p7', 'term-6', '/s/6'),
      { ...liveAgent('missing-agent', 'w1:p8', 'term-7', '/s/7'), agent: undefined },
    ];
    setAgents({ agents });
    for (const agent of agents) {
      await current.pi.execute('herdr_workers', {
        action: 'claim',
        target: agent.name,
        task: agent.name === 'launch-alias' ? '😀'.repeat(50) : 'review auth',
        model: 'not-the-harness',
      });
    }
    assert.deepEqual(metadataCalls(), [], 'inactive claims do not label');
    setAgents({
      agents: [
        { ...agents[0], pane_id: 'w9:p9' },
        agents[1]!,
        agents[2]!,
        { ...agents[3], agent_session: { value: '/s/replacement' } },
        { ...agents[5], agent_session: undefined },
        agents[6]!,
      ],
      lookupDelayMs: 300,
    });
    current.pi.appendEntry('pi-herdr-orchestration', {
      active: true,
      sessionId: current.pi.sessionId,
      source: 'command',
      at: new Date().toISOString(),
    });
    await current.pi.emit('session_start', { reason: 'resume' });
    assert.deepEqual(metadataCalls(), [], 'startup does not wait for sidebar refresh');
    await waitFor(() => metadataCalls().length >= 2, 'restored match labels');
    const calls = metadataCalls();
    assert.equal(calls.length, 2, 'only two matches have canonical agents');
    assert.deepEqual(
      calls.map((args) => args.slice(0, 3)),
      [
        ['pane', 'report-metadata', 'w9:p9'],
        ['pane', 'report-metadata', 'w1:p3'],
      ],
    );
    assert.deepEqual(
      calls.map((args) => flagValue(args, '--agent')),
      ['pi', 'claude'],
    );
    assert.equal(flagValue(calls[0]!, '--display-agent'), `pi · #1 ${'😀'.repeat(31)}…`);
    assert.equal([...flagValue(calls[0]!, '--display-agent')].length, 40);
    assert.equal(flagValue(calls[1]!, '--display-agent'), 'claude · #2 review auth');
    for (const args of calls) {
      assert.equal(flagValue(args, '--ttl-ms'), '90000');
      assert.equal(flagValue(args, '--source'), 'pi-herdr:session-a');
    }
    setAgents({ agents: [], lookup: 'fail' });
    await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
    await current.pi.commands.get('orchestrate')!.handler('off', current.pi.ctx);
    assert.equal(metadataCalls().filter((args) => args.includes('--display-agent')).length, 2);
  });

  it('/orchestrate off clears labels and stops refresh with claims retained', async () => {
    fastSidebarTimer();
    const current = await createHarness(0);
    const agent = liveAgent('worker', 'w1:p2', 'term-a', '/s/a');
    setAgents({ agents: [agent] });
    await current.pi.execute('herdr_workers', { action: 'claim', target: 'worker', task: 'Fix X' });
    await waitFor(() => metadataCalls().length >= 2, 'periodic refresh');
    const entries = vi.spyOn(current.pi.ctx.sessionManager, 'getEntries');
    let staleRead = false;
    entries.mockImplementationOnce(() => {
      staleRead = true;
      throw new Error('ctx is stale');
    });
    await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
    await waitFor(() => staleRead, 'stale context refresh');
    await current.pi.commands.get('orchestrate')!.handler('off', current.pi.ctx);
    assert.deepEqual(activeOrchestratorTools(current), []);
    assert.equal(current.pi.orchestrationEntries().at(-1)!.active, false);
    entries.mockRestore();
    const calls = metadataCalls();
    assert.ok(calls.at(-1)!.includes('--clear-display-agent'));
    assert.equal(flagValue(calls.at(-1)!, '--source'), 'pi-herdr:session-a');
    const eventsAfterOff = metadataEvents().length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      metadataEvents().length,
      eventsAfterOff,
      'no background lookups or writes after off',
    );
    assert.equal((await listWorkers(current)).details.workers.length, 1);
    await current.pi.emit('session_start', { reason: 'resume' });
    const eventsAfterResume = metadataEvents().length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      metadataEvents().length,
      eventsAfterResume,
      'restored off claims remain unlabelled',
    );
    await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
    await waitFor(() => metadataCalls().length > calls.length, 'reactivation label');
  });

  it('in-flight refresh cannot resurrect after release or session change; clears use the old source', async () => {
    const current = await createHarness(0);
    const agent = liveAgent('worker', 'w1:p2', 'term-a', '/s/a');
    // Exercise both pre-publication lookup cancellation and already-started write draining.
    for (const phase of ['lookup', 'start']) {
      for (const cleanup of ['release', 'session']) {
        await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
        setAgents({ agents: [agent] });
        await current.pi.execute('herdr_workers', {
          action: 'claim',
          target: 'worker',
          task: 'Fix X',
        });
        await waitFor(
          () => metadataCalls().at(-1)?.includes('--display-agent') === true,
          'initial label',
        );
        const oldSource = `pi-herdr:${current.pi.sessionId}`;
        const before = metadataEvents().length;
        if (phase === 'lookup') setAgents({ agents: [agent], lookupDelayMs: 300 });
        else process.env.FAKE_HERDR_METADATA_DELAY_MS = '300';
        await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
        await waitFor(
          () =>
            metadataEvents()
              .slice(before)
              .some((event) => event.phase === phase),
          'refresh in flight',
        );
        if (cleanup === 'release') {
          await current.pi.execute('herdr_workers', { action: 'release', worker: 1 });
        } else {
          await current.pi.emit('session_shutdown');
          const shutdownCalls = metadataCalls();
          assert.ok(
            shutdownCalls.at(-1)!.includes('--clear-display-agent'),
            `${phase}/shutdown: final operation is clear`,
          );
          assert.equal(flagValue(shutdownCalls.at(-1)!, '--source'), oldSource);
          const afterShutdown = metadataEvents().length;
          await new Promise((resolve) => setTimeout(resolve, 400));
          assert.equal(metadataEvents().length, afterShutdown, `${phase}/shutdown: no late write`);
          current.pi.sessionId += '-next';
          await current.pi.emit('session_start', { reason: 'new' });
        }
        const calls = metadataCalls();
        assert.ok(
          calls.at(-1)!.includes('--clear-display-agent'),
          `${phase}/${cleanup}: final operation is clear`,
        );
        assert.equal(flagValue(calls.at(-1)!, '--source'), oldSource);
        const count = metadataEvents().length;
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(metadataEvents().length, count, `${phase}/${cleanup}: no late refresh`);
        delete process.env.FAKE_HERDR_METADATA_DELAY_MS;
      }
    }
  }, 10_000);
});

describe.sequential('herdr worker ledger', () => {
  const SOL = liveAgent('sol', 'w1:p2', 'term-a', '/s/a.jsonl');

  it('keeps ownership across /orchestrate off, tree navigation and resume, but not into a fork', async () => {
    const current = await createHarness(0);
    setAgents({ agents: [SOL] });
    await current.pi.execute('herdr_workers', { action: 'claim', target: 'sol', task: 'Fix X' });
    const command = current.pi.commands.get('orchestrate')!;
    await command.handler('off', current.pi.ctx);
    await command.handler('', current.pi.ctx);
    assert.deepEqual(observations(await listWorkers(current)), { 1: 'match' });

    (current.pi.ctx as any).sessionManager.getBranch = () => [];
    await current.pi.emit('session_start', { reason: 'resume' });
    assert.deepEqual(observations(await listWorkers(current)), { 1: 'match' });
    assert.match(
      (await injectedPrompt(current))!,
      /1 recorded worker; supervision not restored; run herdr_workers list/u,
    );

    current.pi.sessionId = 'session-fork';
    current.pi.parentSession = '/saved/session-a.jsonl';
    await current.pi.emit('session_start', { reason: 'fork' });
    await command.handler('', current.pi.ctx);
    const forked = await listWorkers(current);
    assert.equal(forked.content[0].text, 'no recorded workers in this conversation');
  });

  it('claims, merges reclaims without blanking intent, and releases without quitting', async () => {
    const current = await createHarness(0);
    setAgents({ agents: [SOL] });
    await assert.rejects(
      current.pi.execute('herdr_workers', { action: 'claim', target: 'sol' }),
      /task is required on the first claim; nothing recorded/u,
    );
    await assert.rejects(
      current.pi.execute('herdr_workers', { action: 'claim', target: 'ghost', task: 'T' }),
      /could not resolve ghost: agent target ghost not found; nothing recorded/u,
    );
    assert.equal(workerEntries(current).length, 0);

    const claimed = await current.pi.execute('herdr_workers', {
      action: 'claim',
      target: 'sol',
      task: 'Fix X',
      report: '/tmp/a.md',
      model: 'openai-codex/gpt-6.1-sol',
    });
    assert.match(claimed.content[0].text, /^claimed worker #1: pane w1:p2, terminal term-a/u);
    const updated = await current.pi.execute('herdr_workers', {
      action: 'claim',
      target: 'w1:p2',
      report: '/tmp/b.md',
    });
    assert.match(updated.content[0].text, /^updated worker #1/u);
    assert.deepEqual(
      [updated.details.worker.task, updated.details.worker.report, updated.details.worker.model],
      ['Fix X', '/tmp/b.md', 'openai-codex/gpt-6.1-sol'],
    );

    const released = await current.pi.execute('herdr_workers', { action: 'release', worker: 1 });
    assert.match(released.content[0].text, /It was NOT quit/u);
    assert.equal(
      (await listWorkers(current)).content[0].text,
      'no recorded workers in this conversation (1 released, not shown)',
    );
    const reclaimed = await current.pi.execute('herdr_workers', { action: 'claim', target: 'sol' });
    assert.match(reclaimed.content[0].text, /^reclaimed worker #1/u);
    assert.equal(reclaimed.details.worker.task, 'Fix X');
  });

  it(
    'distinguishes match, session unverified, replaced, absent and failed lookups',
    { timeout: 15_000 },
    async () => {
      const current = await createHarness(0);
      const plain = liveAgent('plain', 'w1:p3', 'term-b');
      const reused = liveAgent('reused', 'w1:p4', 'term-c', '/s/c.jsonl');
      const gone = liveAgent('gone', 'w1:p5', 'term-d', '/s/d.jsonl');
      setAgents({ agents: [SOL, plain, reused, gone] });
      for (const target of ['sol', 'plain', 'reused', 'gone']) {
        await current.pi.execute('herdr_workers', { action: 'claim', target, task: target });
      }
      // Same terminal, new conversation: a replacement, not the claimed worker.
      setAgents({
        agents: [SOL, plain, liveAgent('reused', 'w1:p4', 'term-c', '/s/other.jsonl')],
      });
      assert.deepEqual(observations(await listWorkers(current)), {
        1: 'match',
        2: 'session unverified',
        3: 'replaced',
        4: 'absent',
      });

      setAgents({ agents: [SOL], lookup: 'fail' });
      const failed = await listWorkers(current);
      assert.deepEqual(observations(failed), {
        1: 'unknown',
        2: 'unknown',
        3: 'unknown',
        4: 'unknown',
      });
      assert.match(
        failed.content[0].text,
        /lookup failed: every observation is unknown, not absent/u,
      );
      const allUnknown = { 1: 'unknown', 2: 'unknown', 3: 'unknown', 4: 'unknown' };

      // An incomplete list (a member without terminal identity) cannot prove absence.
      setAgents({ agents: [SOL, { pane_id: 'w1:p5', agent_session: { value: '/s/d.jsonl' } }] });
      assert.deepEqual(observations(await listWorkers(current)), allUnknown);

      // A lookup whose descendant keeps the pipes open still settles near its bound, and a
      // timed-out lookup is unknown even when the parent already exited 0 with valid output.
      for (const lookup of ['hold-pipes', 'hold-pipes-exited']) {
        setAgents({ agents: [SOL], lookup });
        const started = Date.now();
        assert.deepEqual(observations(await listWorkers(current)), allUnknown, lookup);
        assert.ok(Date.now() - started < 4_500, `${lookup} took ${Date.now() - started}ms`);
      }
    },
  );

  it('never acts on a lookup that outlived its session or its cancellation', async () => {
    const current = await createHarness(0);
    setAgents({ agents: [SOL] });
    await current.pi.execute('herdr_workers', { action: 'claim', target: 'sol', task: 'Fix X' });
    setAgents({ agents: [SOL], lookupDelayMs: 300 });
    const claim = current.pi.execute('herdr_workers', {
      action: 'claim',
      target: 'sol',
      task: 'Other',
    });
    const list = current.pi.execute('herdr_workers', { action: 'list' });
    current.pi.sessionId = 'session-b';
    await current.pi.emit('session_start', { reason: 'new' });
    await Promise.all([
      assert.rejects(claim, /session changed during the Herdr lookup; nothing recorded/u),
      assert.rejects(list, /session changed during the Herdr lookup; list discarded/u),
    ]);
    assert.equal(workerEntries(current).length, 1);

    const controller = new AbortController();
    const arming = current.pi.execute(
      'herdr_watch',
      { target: 'sol', mode: 'agent' },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(arming, /cancelled; watch not armed/u);
    assert.equal((await watchDetails(current)).count, 0);
  });

  it('omits the tail and does not attribute state when the watched pane hosts a different agent', async () => {
    const current = await createHarness(0, { includeTailLines: 5 });
    const replacement = liveAgent('sol', 'w1:p2', 'term-z', '/s/z.jsonl', 'blocked');
    setAgents({ agents: [SOL], wait: replacement, read: 'SECRET TAIL' });
    const armed = await current.pi.execute('herdr_watch', { target: 'sol', mode: 'agent' });
    assert.match(armed.content[0].text, /not a claimed worker; claim it with herdr_workers/u);
    await waitFor(() => current.pi.messages.length === 1, 'replaced watch card');
    const card = current.pi.messages[0]!.message.content as string;
    assert.match(card, /pane w1:p2 now hosts a different agent/u);
    assert.doesNotMatch(card, /SECRET TAIL|settled \(blocked\)/u);

    // The same identity on both checks permits the tail.
    await current.pi.execute('herdr_workers', { action: 'claim', target: 'sol', task: 'Fix X' });
    setAgents({ agents: [SOL], wait: SOL, read: 'VERIFIED TAIL' });
    const again = await current.pi.execute('herdr_watch', { target: 'sol', mode: 'agent' });
    assert.doesNotMatch(again.content[0].text, /claim/u);
    await waitFor(() => current.pi.messages.length === 2, 'verified watch card');
    const verified = current.pi.messages[1]!.message.content as string;
    assert.match(verified, /settled \(idle\)[\s\S]*VERIFIED TAIL/u);

    // Tails disabled: identity still governs state attribution and toasts.
    await current.pi.emit('session_shutdown');
    rmSync(current.dir, { recursive: true, force: true });
    const toasting = await createHarness(1, { toastOn: ['blocked'], notificationDelayMs: 300 });
    const toasts = (): string[] => {
      try {
        return readFileSync(toasting.notificationPath, 'utf8')
          .split('\n')
          .filter((line) => line.includes('sol blocked'));
      } catch {
        return [];
      }
    };
    const blocked = liveAgent('sol', 'w1:p2', 'term-a', '/s/a.jsonl', 'blocked');
    setAgents({ agents: [SOL], wait: liveAgent('sol', 'w1:p2', 'term-a', undefined, 'blocked') });
    await toasting.pi.execute('herdr_watch', { target: 'sol', mode: 'agent' });
    await waitFor(() => toasting.pi.messages.length === 1, 'unverified watch card');
    const unverified = toasting.pi.messages[0]!.message.content as string;
    assert.match(unverified, /identity unverified, so its state is not attributed/u);
    assert.doesNotMatch(unverified, /settled/u);

    // A session replaced during exhaustion-notification I/O gets no late toast.
    setAgents({ agents: [SOL], wait: blocked });
    await toasting.pi.execute('herdr_watch', { target: 'sol', mode: 'agent' });
    await waitFor(
      () => notificationCount(toasting.notificationPath) === 1,
      'pending exhaustion notification',
    );
    toasting.pi.sessionId = 'session-b';
    await toasting.pi.emit('session_start', { reason: 'new' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(toasts(), [], 'no toast after the session was replaced');

    // A verified identity in a live session does get its toast.
    await toasting.pi.execute('herdr_watch', { target: 'sol', mode: 'agent' });
    await waitFor(() => toasts().length > 0, 'verified toast');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(toasts().length, 1);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

interface WorktreeFixture {
  repo: string;
  file: string;
}

/** A real git repo plus fake Herdr worktree state; the session cwd is the repo. */
function setupWorktrees(current: Harness): WorktreeFixture {
  const base = realpathSync(current.dir);
  const repo = join(base, 'repo');
  const root = join(base, 'worktrees');
  mkdirSync(repo);
  mkdirSync(root);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const file = join(current.dir, 'worktrees.json');
  writeFileSync(
    file,
    JSON.stringify({
      repo,
      root,
      workspaces: [{ workspace_id: 'w1', checkout_path: repo }],
      panes: [{ pane_id: 'w1:p1', terminal_id: 'term-w1', workspace_id: 'w1', agent: 'pi' }],
    }),
  );
  process.env.FAKE_HERDR_WORKTREE_FILE = file;
  process.env.HERDR_WORKSPACE_ID = 'w1';
  (current.pi.ctx as any).cwd = repo;
  return { repo, file };
}

function worktreeState(fx: WorktreeFixture): any {
  return JSON.parse(readFileSync(fx.file, 'utf8'));
}

function updateWorktreeState(fx: WorktreeFixture, change: (state: any) => void): void {
  const state = worktreeState(fx);
  change(state);
  writeFileSync(fx.file, JSON.stringify(state));
}

function worktreeEvents(current: Harness): string[] {
  return current.pi.entries
    .filter((entry) => entry.customType === 'pi-herdr-worktree')
    .map((entry) => (entry.data as { event: string }).event);
}

async function createWorktree(current: Harness, task: string, signal?: AbortSignal): Promise<any> {
  return current.pi.execute('herdr_worktrees', { action: 'create', task }, signal);
}

async function removeWorktree(current: Harness, worktree: number): Promise<any> {
  return current.pi.execute('herdr_worktrees', { action: 'remove', worktree });
}

/** Put a `git` on PATH that runs `onMergeBase` (CommonJS; `git(...)` is real git) after merge-base. */
function wrapGit(current: Harness, onMergeBase: string): void {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(current.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
const git = (...a) => execFileSync(${JSON.stringify(realGit)}, a);
if (args.includes('merge-base')) { ${onMergeBase} }
process.exit(result.status ?? 1);
`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

function commitIn(path: string, name: string): string {
  writeFileSync(join(path, name), 'work\n');
  git(path, 'add', '.');
  git(path, 'commit', '-qm', name);
  return git(path, 'rev-parse', 'HEAD');
}

describe.sequential('herdr worktree ledger', () => {
  it('replays worktree records across resume with a restore notice, but not into a fork', async () => {
    const current = await createHarness(0);
    setupWorktrees(current);
    await createWorktree(current, 'Fix X');
    await current.pi.emit('session_start', { reason: 'resume' });
    const listed = await current.pi.execute('herdr_worktrees', { action: 'list' });
    assert.match(listed.content[0].text, /#1 created: herdr\/session\/fix-x-[a-z0-9]{4}\n/u);
    assert.match(
      listed.content[0].text,
      /live: checkout present; workspace mapped; changes clean; branch [0-9a-f]{12} merged into main; agents none/u,
    );
    assert.match(
      (await injectedPrompt(current))!,
      /1 worktree not removed \(0 unknown\); run herdr_worktrees list/u,
    );

    current.pi.sessionId = 'session-fork';
    current.pi.parentSession = '/saved/session-a.jsonl';
    await current.pi.emit('session_start', { reason: 'fork' });
    await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
    const forked = await current.pi.execute('herdr_worktrees', { action: 'list' });
    assert.equal(forked.content[0].text, 'no recorded worktrees in this conversation');
  });

  it('records intent before Herdr, then created, failed or unknown; refuses a detached HEAD', async () => {
    const current = await createHarness(0);
    const fx = setupWorktrees(current);
    git(fx.repo, 'checkout', '-q', '--detach');
    await assert.rejects(
      createWorktree(current, 'Fix X'),
      /detached HEAD; pass target.*nothing recorded/u,
    );
    git(fx.repo, 'checkout', '-q', 'main');
    // An explicit target is a literal local branch name, never a revision expression.
    await assert.rejects(
      current.pi.execute('herdr_worktrees', {
        action: 'create',
        task: 'T',
        target: 'main^{commit}',
      }),
      /target main\^\{commit\} is not an existing local branch name; nothing recorded/u,
    );
    assert.deepEqual(worktreeEvents(current), []);
    assert.equal(worktreeState(fx).calls, undefined);

    // Intent is durable while Herdr runs; an interrupted create is unknown and never retried.
    updateWorktreeState(fx, (state) => (state.create = 'stall'));
    forcedRandom.push(0, 0, 0, 0);
    const controller = new AbortController();
    const stalled = createWorktree(current, 'Slow', controller.signal);
    await waitFor(() => worktreeState(fx).calls?.length === 1, 'create call');
    assert.deepEqual(worktreeEvents(current), ['intent']);
    controller.abort();
    assert.match(
      (await stalled).content[0].text,
      /^worktree #1 creation outcome unknown .*Not retried/u,
    );
    assert.equal(worktreeState(fx).calls.length, 1);

    updateWorktreeState(fx, (state) => (state.create = 'error'));
    assert.match(
      (await createWorktree(current, 'Clash')).content[0].text,
      /^worktree #2 creation failed \(worktree_create_failed: branch already exists\)/u,
    );

    updateWorktreeState(fx, (state) => delete state.create);
    const created = await createWorktree(current, 'Fix X');
    assert.match(
      created.content[0].text,
      /root pane: (w\d+:p1) — start the worker with `herdr agent start --pane \1/u,
    );
    assert.deepEqual(worktreeEvents(current), [
      'intent',
      'unknown',
      'intent',
      'failed',
      'intent',
      'created',
    ]);
    const head = git(fx.repo, 'rev-parse', 'HEAD');
    const call = worktreeState(fx).calls.at(-1);
    assert.equal(call[call.indexOf('--base') + 1], head);
    assert.ok(call.includes('--no-focus') && !call.includes('--force'));
    assert.ok(existsSync(created.details.worktree.path));

    // A name held by an unknown record or by git is regenerated before Herdr runs.
    git(fx.repo, 'branch', 'herdr/session/slow-1111');
    forcedRandom.push(0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2);
    const distinct = (await createWorktree(current, 'Slow')).details.worktree;
    assert.deepEqual(
      [distinct.id, distinct.state, distinct.branch],
      [4, 'created', 'herdr/session/slow-2222'],
    );
    assert.equal(
      worktreeState(fx).calls.at(-1)[worktreeState(fx).calls.at(-1).indexOf('--branch') + 1],
      'herdr/session/slow-2222',
    );
  });

  it('refuses removal unless owned, mapped, quiescent, clean and observable', async () => {
    const current = await createHarness(0);
    const fx = setupWorktrees(current);
    const { path, workspaceId, rootPaneId } = (await createWorktree(current, 'Fix X')).details
      .worktree;
    await assert.rejects(removeWorktree(current, 99), /no recorded worktree #99/u);

    writeFileSync(join(path, 'scratch.txt'), 'unsaved\n');
    await assert.rejects(removeWorktree(current, 1), /has uncommitted or untracked changes/u);
    rmSync(join(path, 'scratch.txt'));

    const refusals: Array<[(state: any) => void, (state: any) => void, RegExp]> = [
      [
        (state) => (state.panes.find((p: any) => p.pane_id === rootPaneId).agent = 'claude'),
        (state) => delete state.panes.find((p: any) => p.pane_id === rootPaneId).agent,
        /agent claude in w\d+:p1 is still running/u,
      ],
      [
        (state) =>
          (state.workspaces.find((w: any) => w.workspace_id === workspaceId).checkout_path =
            fx.repo),
        (state) =>
          (state.workspaces.find((w: any) => w.workspace_id === workspaceId).checkout_path = path),
        /Herdr maps workspace w\d+ to .*repo, not/u,
      ],
      [
        (state) => (state.lookup = 'fail'),
        (state) => delete state.lookup,
        /Herdr workspace lookup failed/u,
      ],
    ];
    for (const [apply, revert, reason] of refusals) {
      updateWorktreeState(fx, apply);
      await assert.rejects(removeWorktree(current, 1), reason);
      updateWorktreeState(fx, revert);
    }

    current.pi.sessionId = 'session-b';
    await current.pi.emit('session_start', { reason: 'new' });
    await assert.rejects(
      removeWorktree(current, 1),
      /no recorded worktree #1 in this conversation/u,
    );
    assert.ok(existsSync(path));
    assert.deepEqual(worktreeEvents(current), ['intent', 'created']);
  });

  it('removes clean checkouts and deletes only a merged branch', async () => {
    const current = await createHarness(0);
    const fx = setupWorktrees(current);
    const merged = (await createWorktree(current, 'Merged')).details.worktree;
    const unmerged = (await createWorktree(current, 'Unmerged')).details.worktree;
    for (const worktree of [merged, unmerged]) {
      writeFileSync(join(worktree.path, `${worktree.id}.txt`), 'work\n');
      git(worktree.path, 'add', '.');
      git(worktree.path, 'commit', '-qm', 'work');
    }
    git(fx.repo, 'merge', '-q', '--no-ff', '-m', 'merge', merged.branch);

    assert.match(
      (await removeWorktree(current, 1)).content[0].text,
      /^removed worktree #1 .* deleted \(merged into main\)\.$/u,
    );
    assert.match(
      (await removeWorktree(current, 2)).content[0].text,
      /^removed worktree #2 .* kept: not merged into main\.$/u,
    );
    assert.ok(!existsSync(merged.path) && !existsSync(unmerged.path));
    assert.equal(git(fx.repo, 'branch', '--list', merged.branch), '');
    assert.notEqual(git(fx.repo, 'branch', '--list', unmerged.branch), '');
    assert.equal(
      (await current.pi.execute('herdr_worktrees', { action: 'list' })).content[0].text,
      `no recorded worktrees in this conversation (2 removed, not shown; kept branches: ${unmerged.branch})`,
    );
  });

  it('deletes no branch after session replacement and keeps the unresolved outcome visible', async () => {
    const current = await createHarness(0);
    const fx = setupWorktrees(current);
    const worktree = (await createWorktree(current, 'Fix X')).details.worktree;
    commitIn(worktree.path, 'w.txt');
    git(fx.repo, 'merge', '-q', worktree.branch);
    const marker = join(current.dir, 'merge-base-started');
    wrapGit(
      current,
      `fs.writeFileSync(${JSON.stringify(marker)}, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);`,
    );
    const removing = removeWorktree(current, 1);
    await waitFor(() => existsSync(marker), 'ancestry check');
    current.pi.sessionId = 'session-b';
    await current.pi.emit('session_start', { reason: 'new' });
    await assert.rejects(removing, /branch was NOT deleted and its outcome is unresolved/u);
    assert.notEqual(git(fx.repo, 'branch', '--list', worktree.branch), '');

    current.pi.sessionId = 'session-a';
    await current.pi.emit('session_start', { reason: 'resume' });
    const listed = (await current.pi.execute('herdr_worktrees', { action: 'list' })).content[0]
      .text;
    assert.match(
      listed,
      new RegExp(`#1 removed: ${worktree.branch}\n[^]*branch outcome unresolved`, 'u'),
    );
    assert.match((await injectedPrompt(current))!, /1 removed with branch outcome unresolved/u);
  });

  it('keeps a branch whose tip moved after the ancestry check', async () => {
    const current = await createHarness(0);
    const fx = setupWorktrees(current);
    const worktree = (await createWorktree(current, 'Fix X')).details.worktree;
    commitIn(worktree.path, 'w.txt');
    git(fx.repo, 'merge', '-q', worktree.branch);
    // The source checkout moves to another branch holding a newer commit that main lacks.
    git(fx.repo, 'checkout', '-q', '-b', 'other');
    const newer = commitIn(fx.repo, 'other.txt');
    wrapGit(
      current,
      `git('-C', ${JSON.stringify(fx.repo)}, 'update-ref', 'refs/heads/${worktree.branch}', '${newer}');`,
    );
    assert.match(
      (await removeWorktree(current, 1)).content[0].text,
      /^removed worktree #1 .* kept: branch or main moved before deletion\.$/u,
    );
    assert.equal(git(fx.repo, 'rev-parse', worktree.branch), newer);
  });

  it('never records a creation outcome into a session that replaced its own', async () => {
    const current = await createHarness(0);
    const fx = setupWorktrees(current);
    updateWorktreeState(fx, (state) => (state.createDelayMs = 300));
    const creating = createWorktree(current, 'Fix X');
    await waitFor(() => worktreeState(fx).calls?.length === 1, 'create call');
    current.pi.sessionId = 'session-b';
    await current.pi.emit('session_start', { reason: 'new' });
    await assert.rejects(creating, /session changed; the creation outcome was not recorded/u);
    assert.deepEqual(worktreeEvents(current), ['intent']);
  });
});

describe.sequential('herdr quota context hygiene', () => {
  const WARNING_TEXT =
    'astra: low; preserve orchestration capacity, shift suitable work, and tell the user if alternatives are constrained. Do not buy or enable another provider automatically.';

  /** A history shaped like an old session: persisted steer warnings plus lookalike traffic. */
  function oldHistory(): any[] {
    return [
      { role: 'user', content: WARNING_TEXT, timestamp: 1 },
      {
        role: 'custom',
        customType: 'pi-herdr-quota-warning',
        content: `${WARNING_TEXT}\n5% left`,
        display: false,
        timestamp: 2,
      },
      {
        role: 'custom',
        customType: 'pi-herdr-watch',
        content: 'watch #1 fired',
        display: true,
        timestamp: 3,
      },
      {
        role: 'custom',
        customType: 'pi-herdr-limits',
        content: '/limits output',
        display: true,
        timestamp: 4,
      },
      {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'on it' }],
        timestamp: 5,
      },
      {
        role: 'custom',
        customType: 'pi-herdr-quota-context',
        content: 'stale snapshot',
        display: false,
        timestamp: 6,
      },
    ];
  }

  const retained = (history: any[]): any[] =>
    history.filter(
      (m) => m.customType !== 'pi-herdr-quota-warning' && m.customType !== 'pi-herdr-quota-context',
    );

  it('scrubs persisted quota messages without appending a snapshot while active', async () => {
    const current = await createHarness(0, { promoted: false });
    await current.pi.commands.get('orchestrate')!.handler('', current.pi.ctx);
    const history = oldHistory();
    const before = JSON.parse(JSON.stringify(history));
    const results = (await current.pi.emit('context', { messages: history })) as Array<
      { messages?: any[] } | undefined
    >;
    const out = results.find((r) => r?.messages)?.messages;
    assert.ok(out, 'the active hook returns a message list');
    assert.equal(
      out.filter((m) => m.customType === 'pi-herdr-quota-warning').length,
      0,
      'persisted warnings are gone',
    );
    assert.equal(
      out.filter((m) => m.customType === 'pi-herdr-quota-context').length,
      0,
      'no snapshot is appended',
    );
    assert.deepEqual(
      out,
      retained(before),
      'identical-prose user text, watch and historical /limits messages are retained in order',
    );
    assert.deepEqual(history, before, 'the input history is not mutated');
  });

  it('still scrubs persisted quota messages without a snapshot when orchestration is off', async () => {
    const current = await createHarness(0, { promoted: false });
    const history = oldHistory();
    const before = JSON.parse(JSON.stringify(history));
    const results = (await current.pi.emit('context', { messages: history })) as Array<
      { messages?: any[] } | undefined
    >;
    const out = results.find((r) => r?.messages)?.messages;
    assert.ok(out, 'the off hook filters instead of returning undefined');
    assert.deepEqual(
      out,
      retained(before),
      'warnings and snapshots are dropped; user, watch, /limits and assistant messages stay',
    );
    assert.deepEqual(history, before, 'the input history is not mutated');
  });
});

describe('herdr_select tool', () => {
  it("asks Jev from the agent-dir config with the session's model and registry facts", async () => {
    const current = await createHarness(8);
    delete process.env.TYPESAFE_API_KEY;
    writeFileSync(
      join(current.dir, 'typesafe.json'),
      JSON.stringify({ apiKeyFile: 'typesafe.key' }),
    );
    writeFileSync(join(current.dir, 'typesafe.key'), 'ts-test-key');
    const models = [
      { provider: 'openai-codex', id: 'gpt-6.1-sol', input: ['text', 'image'], auth: true },
      { provider: 'zai', id: 'glm-5.3', input: ['text'], auth: false },
    ];
    const ctx = {
      ...current.pi.ctx,
      model: models[0],
      getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
      modelRegistry: {
        find: (provider: string, id: string) =>
          models.find((m) => m.provider === provider && m.id === id),
        hasConfiguredAuth: (model: { auth: boolean }) => model.auth,
        getAll: () => models,
        getApiKeyForProvider: async () => undefined,
      },
    };
    const states: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.typesafe.ai/v1/systemone')
        return new Response('{}', { status: 500 });
      const body = JSON.parse(String(init?.body));
      states.push(body.state);
      const labels = Object.keys(body.questions.allocation?.criteria ?? {});
      const probabilities = (pick: string, all: string[]) =>
        Object.fromEntries(
          all.map((label) => [label, label === pick ? 1 - 0.01 * (all.length - 1) : 0.01]),
        );
      const answers = body.questions.allocation
        ? {
            allocation: {
              type: 'choice',
              choice: 'pi_gpt_6_1_sol',
              confidence: 0.9,
              probabilities: probabilities('pi_gpt_6_1_sol', labels),
            },
          }
        : {
            difficulty: {
              type: 'choice',
              choice: 'easy',
              confidence: 0.9,
              probabilities: probabilities('easy', [
                'easy',
                'medium',
                'hard',
                'insufficient_context',
              ]),
            },
            quick_inline: { type: 'noul', noul: 0.1 },
            visual: { type: 'noul', noul: 0.1 },
          };
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers,
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
    };
    try {
      const tool = current.pi.tools.get('herdr_select')!;
      const result = await tool.execute(
        'test',
        { task: 'Rename a variable' },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.details.outcome, 'selected');
      assert.deepEqual(result.details.selection.launch, [
        'pi',
        '--model',
        'openai-codex/gpt-6.1-sol',
      ]);
      assert.equal(states[0].orchestrator.model, 'openai-codex/gpt-6.1-sol');
      // Registry facts: missing catalog entries and missing auth exclude Pi candidates.
      assert.ok(!('pi_glm_5_3' in states[1].options) && !('pi_gpt_6_astra' in states[1].options));
      assert.ok('pi_gpt_6_1_sol' in states[1].options);
      assert.ok(!JSON.stringify(result).includes('ts-test-key'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('zai_quota tool', () => {
  it("uses Pi's zai credentials for tool and command, and forwards cancellation", async () => {
    const current = await createHarness(8, { promoted: false });
    assert.ok(current.pi.getActiveTools().includes('zai_quota'));
    const ctx = {
      ...current.pi.ctx,
      modelRegistry: {
        getApiKeyForProvider: async (provider: string) => {
          assert.equal(provider, 'zai');
          return 'test-zai-key';
        },
      },
    };
    const tool = current.pi.tools.get('zai_quota')!;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-zai-key');
      return new Response(
        JSON.stringify({
          success: true,
          code: 200,
          data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 12 }] },
        }),
      );
    };
    try {
      const result = await tool.execute('test', {}, undefined, undefined, ctx);
      assert.match(result.content[0].text, /1 week.*12%/);
      assert.equal(result.details.windows[0].usedPercent, 12);
      await current.pi.commands.get('zai-quota')!.handler('', ctx);
      assert.match(current.pi.notices.at(-1)!.message, /1 week.*12%/);
      const controller = new AbortController();
      globalThis.fetch = async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          controller.abort();
        });
      await assert.rejects(
        tool.execute('test', {}, controller.signal, undefined, ctx),
        /cancelled/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('claude_quota tool', () => {
  it('reports scoped usage without promotion and forwards cancellation', async () => {
    const current = await createHarness(8, { promoted: false });
    assert.ok(current.pi.getActiveTools().includes('claude_quota'));
    writeFileSync(
      join(current.dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          limits: [
            {
              kind: 'weekly_scoped',
              percent: 89,
              resets_at: '2026-09-26T16:00:00Z',
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        }),
      );
    try {
      const result = await current.pi.execute('claude_quota');
      assert.match(result.content[0].text, /Fable.*89%/);
      assert.equal(result.details.windows[0].usedPercent, 89);
      await current.pi.commands.get('claude-quota')!.handler('', current.pi.ctx);
      assert.match(current.pi.notices.at(-1)!.message, /Fable.*89%/);
      const controller = new AbortController();
      globalThis.fetch = async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          controller.abort();
        });
      await assert.rejects(current.pi.execute('claude_quota', {}, controller.signal), /cancelled/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('codex_quota tool', () => {
  const QUOTA_BODY = {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 92,
      limit_window_seconds: 604800,
      reset_after_seconds: 158464,
    },
    secondary_window: null,
  };

  it('checks quota without promotion and forwards cancellation', async () => {
    const current = await createHarness(8, { promoted: false });
    assert.ok(current.pi.getActiveTools().includes('codex_quota'));
    const originalFetch = globalThis.fetch;
    writeFileSync(
      join(current.dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'test-token' } }),
    );
    globalThis.fetch = async () => new Response(JSON.stringify(QUOTA_BODY));
    try {
      const response = await current.pi.execute('codex_quota');
      assert.match(response.content[0].text, /92% of 7d/);
      assert.equal(response.details.primary.usedPercent, 92);
      const controller = new AbortController();
      globalThis.fetch = async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          controller.abort();
        });
      await assert.rejects(current.pi.execute('codex_quota', {}, controller.signal), /cancelled/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
