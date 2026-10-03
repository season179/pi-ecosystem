import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_TYPE, DELIVERY_TYPE, BACKGROUND_MAX_MS } from '../src/retrieval.js';
import {
  config,
  exchange,
  extensionFixture,
  message,
  sdk,
  Server,
  typesafe,
  persisted,
  jev,
} from './helpers.js';
import { contexts, hold, recalls, retrievalFixture, until } from './retrieval-support.js';
import { Type } from '@earendil-works/pi-ai';
import { readHistory } from '../src/history.js';

const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(join(tmpdir(), 'hindsight-late-'));
  roots.push(r);
  return r;
};
afterEach(() => {
  vi.useRealTimers();
  delete process.env.TYPESAFE_API_KEY;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const toolReply = () => ({
  ...message(''),
  stopReason: 'toolUse' as const,
  content: [{ type: 'toolCall' as const, id: 'wait-1', name: 'synthetic_work', arguments: {} }],
});

it('real Pi: normalized image input is assessed; terminating tools never release staged memory or create extra turns', async () => {
  const r = root(),
    server = new Server(),
    manager = persisted(r),
    agentDir = join(r, 'agent');
  typesafe(agentDir);
  process.env.TYPESAFE_API_KEY = 'synthetic-key';
  const assessment = jev([0.9]);
  const subject = await sdk(
    r,
    server,
    manager,
    [toolReply(), message(server.reflectText)],
    { agentDir, assessmentFetch: assessment.fetch, mode: 'read-only' },
    [
      {
        name: 'synthetic_work',
        label: 'work',
        description: 'terminating work',
        parameters: Type.Object({}),
        async execute() {
          await until(() => assessment.calls.length === 1);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { content: [{ type: 'text', text: 'done' }], details: undefined, terminate: true };
        },
      },
    ],
  );
  try {
    await subject.session.prompt('Inspect this image', {
      images: [
        {
          type: 'image',
          data: Buffer.from('not an image').toString('base64'),
          mimeType: 'image/x-invalid',
        },
      ],
    });
    expect(recalls(server)[0].body.query).toContain('[Image omitted:');
    expect(assessment.calls[0].body.state.current_request).toContain('[Image omitted:');
    expect(subject.requests).toHaveLength(1);
    expect(contexts(manager)).toHaveLength(1);
    expect(
      manager.getBranch().some((e) => e.type === 'custom' && e.customType === DELIVERY_TYPE),
    ).toBe(false);
    await subject.session.prompt('Unrelated next request');
    expect(JSON.stringify(subject.requests[1])).not.toContain(server.reflectText);
    expect(readHistory(manager).turns.at(-1)?.content).toBe(server.reflectText);
  } finally {
    await subject.dispose();
  }
});

it.each(['new_user', 'edit', 'compaction', 'scope', 'session', 'settle', 'restart'] as const)(
  '%s prevents a stale draft from first release',
  async (change) => {
    const f = retrievalFixture(root());
    await f.send('original task');
    await f.ready();
    await f.stage();
    let ext = f.ext;
    if (change === 'new_user') await f.send('new task');
    if (change === 'edit')
      f.manager.appendContextEdit(
        f.manager.getBranch().find((e) => e.type === 'message' && e.message.role === 'user')!.id,
        { content: 'edited task' },
      );
    if (change === 'compaction') f.manager.appendCompaction('summary', f.manager.getLeafId()!, 100);
    if (change === 'scope') config(f.root, { bankId: 'coding-agent::other' });
    if (change === 'session') await ext.emit('session_before_switch');
    if (change === 'settle') await ext.emit('agent_settled');
    if (change === 'restart')
      ext = extensionFixture(f.manager, f.server, {
        configPath: config(f.root),
        mode: 'read-only',
      });
    const result = await ext.emit('context', {
      type: 'context',
      messages: f.manager.buildSessionContext().messages,
    } as any);
    expect(JSON.stringify(result.messages)).not.toContain(f.server.reflectText);
    await f.ext.emit('session_shutdown');
  },
);

it('abort after release invalidates context persistently; curation also hides it on earlier branches', async () => {
  const f = retrievalFixture(root());
  const abort = new AbortController();
  Object.defineProperty(f.ext.ctx, 'signal', { value: abort.signal });
  await f.send('original');
  await f.ready();
  await f.stage();
  const before = f.manager.getLeafId()!;
  expect(JSON.stringify((await f.release()).messages)).toContain(f.server.reflectText);
  abort.abort();
  const restarted = extensionFixture(f.manager, f.server, {
    configPath: config(f.root),
    mode: 'read-write',
  });
  expect(
    JSON.stringify(
      (
        await restarted.emit('context', {
          type: 'context',
          messages: f.manager.buildSessionContext().messages,
        } as any)
      ).messages,
    ),
  ).not.toContain(f.server.reflectText);
  // Curation uses the same persistent mechanism and is authoritative after tree navigation.
  f.manager.appendMessage(message('complete reply'));
  f.server.facts.set('f', {
    id: 'f',
    type: 'world',
    text: 'old',
    document_id: 'source',
    state: 'valid',
  });
  await restarted.tool('hindsight_manage_fact', {
    action: 'edit',
    fact_id: 'f',
    expected_text: 'old',
    document_id: 'source',
    text: 'corrected',
  });
  f.manager.branch(before);
  expect(
    JSON.stringify(
      (
        await restarted.emit('context', {
          type: 'context',
          messages: f.manager.buildSessionContext().messages,
        } as any)
      ).messages,
    ),
  ).not.toContain(f.server.reflectText);
});

it('a newer message cancels unowned preflight/Recall; settlement does not count as a service failure', async () => {
  const f = retrievalFixture(root(), [0.9, 0.9]);
  const held = hold();
  f.server.before = (c) => (c.url.pathname.endsWith('/memories/recall') ? held.promise : undefined);
  await f.send('older');
  await until(() => recalls(f.server).length === 1);
  await f.ext.emit('agent_settled');
  expect(f.ext.memoryStatus).toContain('not delivered');
  f.server.before = undefined;
  await f.send('newer');
  await f.ready();
  held.release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.assessment.calls).toHaveLength(1);
  await f.stage();
  await f.release();
  expect(f.ext.memoryStatus).toContain('injected');
  await f.ext.emit('agent_settled');
});

it('hard total lifetime cancels ready but undelivered work without injecting later', async () => {
  const f = retrievalFixture(root());
  await f.send('original');
  await f.ready();
  vi.useFakeTimers();
  // The timer was created before fake timers: create a fresh job under the fake clock.
  await f.ext.emit('agent_settled');
  const held = hold();
  f.server.before = () => held.promise;
  const pending = f.send('fresh');
  await vi.advanceTimersByTimeAsync(BACKGROUND_MAX_MS);
  await pending;
  held.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(await f.stage()).toBeUndefined();
  expect(contexts(f.manager)).toHaveLength(0);
  await f.ext.emit('session_shutdown');
});

it('real Pi steering and queued follow-ups each start assessment with completed pairs only', async () => {
  const r = root(),
    server = new Server(),
    manager = persisted(r),
    agentDir = join(r, 'agent');
  typesafe(agentDir);
  process.env.TYPESAFE_API_KEY = 'synthetic-key';
  const assessment = jev([0.9, 0.9, 0.9]);
  const subject = await sdk(
    r,
    server,
    manager,
    [toolReply(), message('answer to steering'), toolReply(), message('answer to follow-up')],
    { agentDir, assessmentFetch: assessment.fetch, mode: 'read-only' },
    [
      {
        name: 'synthetic_work',
        label: 'work',
        description: 'work',
        parameters: Type.Object({}),
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { content: [{ type: 'text', text: 'done' }], details: undefined };
        },
      },
    ],
    async (index) => {
      if (index === 0) {
        await until(() => assessment.calls.length === 1);
        await subject.session.steer('steering request');
        await subject.session.followUp('follow-up request');
      }
      if (index === 1) await until(() => assessment.calls.length === 2);
      if (index === 2) await until(() => assessment.calls.length === 3);
    },
  );
  try {
    await subject.session.prompt('initial request');
    expect(assessment.calls.map((c) => c.body.state.current_request)).toEqual([
      'initial request',
      'steering request',
      'follow-up request',
    ]);
    expect(assessment.calls[1].body.state.recent_conversation).toEqual([]);
    expect(assessment.calls[2].body.state.recent_conversation).toEqual([
      { user: 'steering request', assistant: 'answer to steering' },
    ]);
    expect(subject.requests).toHaveLength(4);
    expect(JSON.stringify(subject.requests[3])).toContain(server.reflectText);
    expect(contexts(manager)).toHaveLength(1);
  } finally {
    await subject.dispose();
  }
});

it('release chronology preserves prior evidence and strips only memory-derived later capture', async () => {
  const r = root(),
    server = new Server(),
    manager = persisted(r),
    text = server.reflectText;
  exchange(manager, 'original');
  manager.appendCustomMessageEntry(CONTEXT_TYPE, text, true, {
    hindsight: { deliveryId: 'late', late: true, echoTexts: [text] },
  });
  manager.appendMessage(message(text));
  const ext = extensionFixture(manager, server, { configPath: config(r) });
  await ext.emit('agent_settled');
  const before = server.documents.get(`conversation:${manager.getSessionId()}`)!;
  expect(before).toContain(text);
  manager.appendCustomEntry(DELIVERY_TYPE, { action: 'release', id: 'late' });
  manager.appendCustomEntry(DELIVERY_TYPE, { action: 'invalidate', ids: ['late'] });
  manager.appendMessage(message(`After release ${text}`));
  await ext.emit('agent_settled');
  expect(
    server.documents.get(`conversation:${manager.getSessionId()}`)!.startsWith(before + '\n'),
  ).toBe(true);
  expect(server.retains.at(-1)!.body.items[0].content).toContain('[memory-derived text omitted]');
  expect(server.retains.at(-1)!.body.items[0].content).not.toContain(text);
});
