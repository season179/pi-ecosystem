import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import extension from '../src/extensions/index.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Delivery = { message: any; options: any };

class Host {
  readonly tools = new Map<string, any>();
  readonly handlers = new Map<string, Handler[]>();
  readonly messages: Delivery[] = [];
  readonly waiters: Array<(delivery: Delivery) => void> = [];
  readonly ctx: ExtensionContext;
  constructor(cwd: string) {
    this.ctx = { cwd, hasUI: false } as ExtensionContext;
  }
  registerTool(tool: any): void {
    this.tools.set(tool.name, tool);
  }
  on(name: string, handler: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }
  sendMessage(message: any, options: any): void {
    const delivery = { message, options };
    this.messages.push(delivery);
    this.waiters.shift()?.(delivery);
  }
  nextMessage(): Promise<Delivery> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async emit(name: string, fields: Record<string, unknown> = {}): Promise<void> {
    for (const handler of this.handlers.get(name) ?? [])
      await handler({ type: name, ...fields }, this.ctx);
  }
  async call(name: string, params = {}, signal?: AbortSignal): Promise<any> {
    return this.tools.get(name).execute('test-call', params, signal, undefined, this.ctx);
  }
}

let host: Host;
let dir: string;
const pidFiles: string[] = [];

/** Shell snippet: start a sleeper in a new session (unreachable by group signals) that inherits stdout/stderr. */
function detachedHolder(): string {
  const file = join(dir, `holder-${pidFiles.length}.pid`);
  pidFiles.push(file);
  const script =
    "const c=require('node:child_process').spawn('sleep',['30'],{detached:true,stdio:'inherit'});" +
    "require('node:fs').writeFileSync(process.argv[1],String(c.pid));c.unref()";
  return `'${process.execPath}' -e "${script}" '${file}'`;
}

function killRecordedPid(file: string): void {
  try {
    process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'shell-watch-')));
  vi.stubEnv('HERDR_ENV', '');
  vi.stubEnv('HERDR_PANE_ID', '');
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  writeFileSync(join(dir, 'herdr.json'), JSON.stringify({ wakeBudget: 1, telemetryPath: '' }));
  host = new Host(dir);
  extension(host as unknown as ExtensionAPI);
  await host.emit('session_start');
});

afterEach(async () => {
  await host.emit('session_shutdown');
  // Only descendants this file started on purpose, by the pid they reported.
  while (pidFiles.length > 0) {
    const file = pidFiles.pop() as string;
    if (existsSync(file)) killRecordedPid(file);
  }
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function run(command: string, extra = {}): Promise<Delivery> {
  const completed = host.nextMessage();
  await host.call('shell_watch', { command, timeoutMs: 3000, ...extra });
  return completed;
}

describe('general shell watches', () => {
  it('defers invalid config errors until session start and fails closed', async () => {
    writeFileSync(join(dir, 'herdr.json'), '{invalid');
    const fresh = new Host(dir);
    assert.doesNotThrow(() => extension(fresh as unknown as ExtensionAPI));
    assert.ok(fresh.tools.has('shell_watch'));
    await assert.rejects(fresh.emit('session_start'), /not valid JSON/u);
    await assert.rejects(
      fresh.call('shell_watch', { command: 'exit 0', timeoutMs: 100 }),
      /no active session/u,
    );
    await fresh.emit('session_shutdown');
  });

  it('exposes shell tools without Herdr or orchestration and launches in the session cwd', async () => {
    assert.deepEqual([...host.tools.keys()].sort(), [
      'shell_unwatch',
      'shell_watch',
      'shell_watches',
    ]);
    const { message, options } = await run(
      "pwd; printf 'output\\n'; printf 'diagnostic\\n' >&2; exit 7",
    );
    assert.match(message.content, /shell watch #1 command completed \(exit 7\)/u);
    assert.ok(message.content.includes(dir));
    assert.match(message.content, /output/u);
    assert.match(message.content, /diagnostic/u);
    assert.equal(message.details.exitCode, 7);
    assert.equal(message.details.outcomeKind, 'fired');
    assert.deepEqual(options, { deliverAs: 'steer', triggerTurn: true });
    assert.ok(message.details.durationMs >= 0);
  });

  it('returns immediately, lists armed jobs, and stops only the selected command', async () => {
    const first = await host.call('shell_watch', { command: 'exec sleep 30', timeoutMs: 30000 });
    const second = await host.call('shell_watch', { command: 'exec sleep 30', timeoutMs: 30000 });
    assert.equal(
      (await host.call('shell_watches')).details.records.filter((r: any) => r.status === 'armed')
        .length,
      2,
    );
    await assert.rejects(
      host.call('shell_unwatch', { id: first.details.watchId, all: true }),
      /exactly one/u,
    );
    const stopped = await host.call('shell_unwatch', { id: first.details.watchId });
    assert.deepEqual(stopped.details.stoppedIds, [first.details.watchId]);
    const records = (await host.call('shell_watches')).details.records;
    assert.equal(records.find((r: any) => r.id === second.details.watchId).status, 'armed');
    assert.deepEqual(host.messages, []);
    await host.call('shell_unwatch', { all: true });
  });

  it('reports timeout distinctly from a normal exit and wakes once', async () => {
    const { message } = await run('exec sleep 30', { timeoutMs: 50 });
    assert.match(message.content, /timed out/u);
    assert.equal(message.details.outcomeKind, 'timeout');
    assert.equal(host.messages.length, 1);
  });

  it('honors wake:false, busy steering, wake budget, and user-input reset', async () => {
    assert.equal((await run('exit 0', { wake: false })).options.triggerTurn, false);
    await host.emit('agent_start');
    assert.equal((await run('exit 0')).options.triggerTurn, true);
    assert.equal((await host.call('shell_watches')).details.wakesUsed, 0);
    await host.emit('agent_settled');
    assert.equal((await run('exit 0')).options.triggerTurn, true);
    assert.equal((await run('exit 0')).options.triggerTurn, false);
    await host.emit('input', { source: 'extension' });
    assert.equal((await run('exit 0')).options.triggerTurn, false);
    await host.emit('input', { source: 'interactive' });
    assert.equal((await run('exit 0')).options.triggerTurn, true);
  });

  it('terminates jobs on replacement and shutdown without stale reports or automatic restart', async () => {
    await host.call('shell_watch', { command: 'exec sleep 30', timeoutMs: 30000 });
    await host.emit('session_start');
    assert.deepEqual((await host.call('shell_watches')).details.records, []);
    assert.deepEqual(host.messages, []);
    await host.call('shell_watch', { command: 'exec sleep 30', timeoutMs: 30000 });
    await host.emit('session_shutdown');
    await host.emit('session_shutdown');
    assert.deepEqual(host.messages, []);
    await assert.rejects(
      host.call('shell_watch', { command: 'exit 0', timeoutMs: 3000 }),
      /no active session/u,
    );
  });

  it('does not launch invalid or already-cancelled calls', async () => {
    await assert.rejects(
      host.call('shell_watch', { command: 'exit 0', timeoutMs: 0 }),
      /positive finite integer/u,
    );
    await assert.rejects(
      host.call('shell_watch', { command: '  ', timeoutMs: 100 }),
      /non-empty command/u,
    );
    await assert.rejects(
      host.call('shell_watch', { command: 'exit 0', timeoutMs: 100 }, AbortSignal.abort()),
      /cancelled/u,
    );
    assert.deepEqual((await host.call('shell_watches')).details.records, []);
  });

  it.skipIf(process.platform === 'win32')(
    'delivers nothing and keeps the wake budget when unwatch stops a command during its post-exit drain',
    async () => {
      const holder = detachedHolder();
      const file = pidFiles.at(-1) as string;
      const started = await host.call('shell_watch', {
        command: `${holder}; exit 4`,
        timeoutMs: 10000,
      });
      await waitFor(() => existsSync(file));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = (await host.call('shell_watches')).details.records[0];
      assert.equal(before.status, 'armed');
      assert.deepEqual(host.messages, []);

      const stopping = host.call('shell_unwatch', { id: started.details.watchId });
      // End the drain early by removing the pipe holder; the stop was already accepted.
      await waitFor(() => existsSync(file));
      killRecordedPid(file);
      const stopped = await stopping;

      assert.deepEqual(stopped.details.stoppedIds, [started.details.watchId]);
      const after = await host.call('shell_watches');
      assert.equal(after.details.records[0].status, 'stopped');
      assert.equal(after.details.wakesUsed, 0);
      assert.deepEqual(host.messages, []);
      // The budget of one idle wake is still available to the next completion.
      assert.equal((await run('exit 0')).options.triggerTurn, true);
      assert.equal(host.messages.length, 1);
    },
  );

  it('bounds completion output even for a single enormous line', async () => {
    const { message } = await run("head -c 20000 /dev/zero | tr '\\000' x");
    assert.ok(message.content.length < 10000);
    assert.match(message.content, /bounded tail/u);
  });
});
