#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const behavior = process.env.FAKE_HERDR_BEHAVIOR ?? 'ok';
const delayMs = Number(process.env.FAKE_HERDR_DELAY_MS ?? '0');
const args = process.argv.slice(2);

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
    if (state.lookupDelayMs > 0 && (agentCommand === 'get' || agentCommand === 'list')) {
      await new Promise((resolve) => setTimeout(resolve, state.lookupDelayMs));
    }
    const agents = state.agents ?? [];
    if (agentCommand === 'read') {
      console.log(state.read);
    } else if (agentCommand === 'wait') {
      console.log(JSON.stringify({ result: { agent: state.wait, type: 'agent_wait' } }));
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
