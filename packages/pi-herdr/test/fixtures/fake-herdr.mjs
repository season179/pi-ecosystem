#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const behavior = process.env.FAKE_HERDR_BEHAVIOR ?? 'ok';
const delayMs = Number(process.env.FAKE_HERDR_DELAY_MS ?? '0');
const args = process.argv.slice(2);
const metadataLog = process.env.FAKE_HERDR_METADATA_LOG;
const logMetadata = (phase) => {
  if (metadataLog) appendFileSync(metadataLog, `${JSON.stringify({ phase, args })}\n`);
};
if (args[0] === 'pane' && args[1] === 'report-metadata') {
  logMetadata('start');
  const delay = args.includes('--display-agent')
    ? Number(process.env.FAKE_HERDR_METADATA_DELAY_MS ?? '0')
    : 0;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  logMetadata('applied');
  process.exit(); // report-metadata succeeds with an empty body, not JSON.
}

if (args[0] === 'notification') {
  const logPath = process.env.FAKE_HERDR_NOTIFICATION_LOG;
  if (logPath) appendFileSync(logPath, `${JSON.stringify(args)}\n`);
  const notificationDelayMs = Number(process.env.FAKE_HERDR_NOTIFICATION_DELAY_MS ?? '0');
  if (notificationDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, notificationDelayMs));
  }
  if (process.env.FAKE_HERDR_NOTIFICATION_EXIT_CODE) {
    process.exitCode = Number(process.env.FAKE_HERDR_NOTIFICATION_EXIT_CODE);
  }
  process.exit();
}

// Optional worktree state for `worktree create|remove`, `workspace list` and
// `pane list`, backed by real git in the state's `repo`. Re-read on every call.
const worktreeFile = process.env.FAKE_HERDR_WORKTREE_FILE;
if (worktreeFile && ['worktree', 'workspace', 'pane'].includes(args[0])) {
  const state = JSON.parse(readFileSync(worktreeFile, 'utf8'));
  const save = () => writeFileSync(worktreeFile, JSON.stringify(state));
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const fail = (code, message, exitCode = 1) => {
    console.error(JSON.stringify({ error: { code, message } }));
    process.exit(exitCode);
  };
  const command = `${args[0]} ${args[1]}`;
  if (command === 'worktree create') {
    state.calls = [...(state.calls ?? []), args];
    save();
    if (state.createDelayMs > 0) await new Promise((r) => setTimeout(r, state.createDelayMs));
    if (state.create === 'stall') {
      setInterval(() => {}, 60_000);
      await new Promise(() => {});
    } else if (state.create === 'error') fail('worktree_create_failed', 'branch already exists');
    else {
      const branch = flag('--branch');
      const path = join(state.root, branch.replaceAll('/', '-'));
      execFileSync(
        'git',
        ['-C', state.repo, 'worktree', 'add', '-b', branch, path, flag('--base')],
        {
          stdio: 'ignore',
        },
      );
      const id = `w${state.workspaces.length + 1}`;
      const pane = { pane_id: `${id}:p1`, terminal_id: `term-${id}`, workspace_id: id };
      state.workspaces.push({ workspace_id: id, checkout_path: path });
      state.panes.push(pane);
      save();
      const reported = state.create === 'wrong-branch' ? `${branch}-other` : branch;
      console.log(
        JSON.stringify({
          result: {
            type: 'worktree_created',
            worktree: { path, branch: reported, open_workspace_id: id, is_linked_worktree: true },
            workspace: { workspace_id: id },
            root_pane: { pane_id: pane.pane_id, terminal_id: pane.terminal_id, cwd: path },
          },
        }),
      );
    }
  } else if (state.lookup === 'fail') {
    fail('server_unavailable', 'herdr: server unavailable', 3);
  } else if (command === 'worktree remove') {
    const id = flag('--workspace');
    const workspace = state.workspaces.find((w) => w.workspace_id === id);
    if (!workspace) fail('workspace_not_found', `workspace ${id} not found`);
    try {
      execFileSync('git', ['-C', state.repo, 'worktree', 'remove', workspace.checkout_path], {
        stdio: 'ignore',
      });
    } catch {
      fail('dirty_worktree_requires_force', 'worktree has changes');
    }
    state.workspaces = state.workspaces.filter((w) => w !== workspace);
    state.panes = state.panes.filter((p) => p.workspace_id !== id);
    save();
    console.log(
      JSON.stringify({
        type: 'worktree_removed',
        path: workspace.checkout_path,
        workspace_id: id,
        forced: false,
      }),
    );
  } else if (command === 'workspace list') {
    const workspaces = state.workspaces.map((w) => ({
      workspace_id: w.workspace_id,
      worktree: { checkout_path: w.checkout_path, repo_root: state.repo },
    }));
    console.log(JSON.stringify({ result: { type: 'workspace_list', workspaces } }));
  } else if (command === 'pane list') {
    const id = flag('--workspace');
    const panes = state.panes.filter((p) => id === undefined || p.workspace_id === id);
    console.log(JSON.stringify({ result: { panes } }));
  } else {
    fail('unsupported', `fake herdr does not support ${command}`, 2);
  }
  process.exit();
}

// Optional live-agent state for `agent get|list` (and `wait`/`read` when the
// file sets them). Re-read on every call so tests can change it mid-flight.
const agentsFile = process.env.FAKE_HERDR_AGENTS_FILE;
const agentCommand = args[0] === 'agent' ? args[1] : undefined;
let handled = false;
if (agentsFile && agentCommand) {
  const state = JSON.parse(readFileSync(agentsFile, 'utf8'));
  handled =
    agentCommand === 'get' ||
    agentCommand === 'list' ||
    (agentCommand === 'wait' && state.wait !== undefined) ||
    (agentCommand === 'read' && state.read !== undefined);
  if (handled) {
    if (agentCommand === 'list') logMetadata('lookup');
    if (state.lookupDelayMs > 0 && (agentCommand === 'get' || agentCommand === 'list')) {
      await new Promise((resolve) => setTimeout(resolve, state.lookupDelayMs));
    }
    const agents = state.agents ?? [];
    if (agentCommand === 'read') {
      console.log(state.read);
    } else if (agentCommand === 'wait') {
      let agent = state.wait;
      if (state.wait === 'current') {
        logMetadata('wait');
        const until = args.flatMap((arg, i) => (arg === '--until' ? [args[i + 1]] : []));
        const states = until.length ? until : ['idle', 'done', 'blocked'];
        const timeoutIndex = args.indexOf('--timeout');
        const deadline = timeoutIndex < 0 ? Infinity : Date.now() + Number(args[timeoutIndex + 1]);
        let waiting = false;
        while (true) {
          const current = JSON.parse(readFileSync(agentsFile, 'utf8'));
          agent = current.agents?.find((a) => a.name === args[2] || a.pane_id === args[2]);
          if (states.includes(agent?.agent_status)) break;
          if (!waiting) {
            logMetadata('waiting');
            waiting = true;
          }
          if (Date.now() >= deadline) {
            console.error(JSON.stringify({ error: { code: 'wait_timeout' } }));
            process.exit(1);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      console.log(JSON.stringify({ result: { agent, type: 'agent_wait' } }));
    } else if (state.lookup === 'hold-pipes') {
      // Hang, with a descendant that keeps the inherited pipes open after a kill.
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: ['ignore', 1, 2] });
      setInterval(() => {}, 1_000);
    } else if (state.lookup === 'hold-pipes-exited') {
      // Valid output and exit 0, but a descendant keeps the pipes open past the bound.
      console.log(JSON.stringify({ result: { agents, type: 'agent_list' } }));
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], {
        stdio: ['ignore', 1, 2],
      }).unref();
    } else if (state.lookup === 'fail') {
      console.error('herdr: server unavailable');
      process.exitCode = 3;
    } else if (agentCommand === 'list') {
      console.log(JSON.stringify({ result: { agents, type: 'agent_list' } }));
    } else {
      const agent = agents.find((a) => a.name === args[2] || a.pane_id === args[2]);
      if (agent) {
        console.log(JSON.stringify({ result: { agent, type: 'agent_info' } }));
      } else {
        console.error(
          JSON.stringify({
            error: { code: 'agent_not_found', message: `agent target ${args[2]} not found` },
          }),
        );
        process.exitCode = 1;
      }
    }
  }
}

if (!handled && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

switch (handled ? 'handled' : behavior) {
  case 'handled':
    break;
  case 'ok':
    console.log(
      JSON.stringify({
        id: 'x',
        result: { type: 'agent_info', echo: args },
      }),
    );
    break;
  case 'timeout-error':
    console.error(JSON.stringify({ error: { code: 'wait_timeout' } }));
    process.exitCode = 1;
    break;
  case 'stall': {
    const logPath = process.env.FAKE_HERDR_STALL_READY_LOG;
    process.on('SIGTERM', () => {
      if (logPath) appendFileSync(logPath, 'SIGTERM\n');
    });
    if (logPath) appendFileSync(logPath, 'ready\n');
    setInterval(() => {}, 60_000);
    break;
  }
  case 'bad-exit':
    console.error('not-json garbage from fake herdr');
    process.exitCode = 3;
    break;
  default:
    console.error(`unknown fake herdr behavior: ${behavior}`);
    process.exitCode = 2;
}
