import { join } from 'node:path';
import { expect } from 'vitest';
import type { ExtensionOptions } from '../src/extension.js';
import { CONTEXT_TYPE } from '../src/retrieval.js';
import { config, extensionFixture, jev, persisted, Server, typesafe } from './helpers.js';

export async function until(condition: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Synthetic retrieval did not reach expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export const hold = () => {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
};
export function retrievalFixture(
  root: string,
  answers: Parameters<typeof jev>[0] = [0.9],
  options: ExtensionOptions = {},
  server = new Server(),
  manager = persisted(root),
) {
  const agentDir = join(root, 'agent');
  typesafe(agentDir);
  process.env.TYPESAFE_API_KEY = 'synthetic-assessment-key';
  const assessment = jev(answers);
  const ext = extensionFixture(manager, server, {
    configPath: config(root),
    agentDir,
    mode: 'read-only',
    assessmentFetch: assessment.fetch,
    ...options,
  });
  let timestamp = 1_800_000_000_000;
  return {
    root,
    server,
    manager,
    assessment,
    ext,
    agentDir,
    async send(text: string) {
      const user = { role: 'user' as const, content: text, timestamp: ++timestamp };
      const emitted = ext.emit('message_end', { type: 'message_end', message: user } as any);
      manager.appendMessage(user); // Pi persists only after its extension handlers return.
      await emitted;
      return user;
    },
    async ready() {
      await until(() => ext.memoryStatus.includes('selected'));
    },
    async stage() {
      const result = await ext.emit('turn_end', {
        type: 'turn_end',
        outcome: 'completed',
        toolResults: [{}],
        context: { pendingMessages: [] },
      } as any);
      expect(result?.continue).toBeUndefined();
      const draft = result?.entries?.[0];
      if (draft)
        manager.appendCustomMessageEntry(
          draft.customType,
          draft.content,
          draft.display,
          draft.details,
        );
      return draft;
    },
    async release() {
      return ext.emit('context', {
        type: 'context',
        messages: manager.buildSessionContext().messages,
      } as any);
    },
  };
}
export const recalls = (server: Server) =>
  server.calls.filter((c) => c.url.pathname.endsWith('/memories/recall'));
export const contexts = (manager: ReturnType<typeof persisted>) =>
  manager.getBranch().filter((e) => e.type === 'custom_message' && e.customType === CONTEXT_TYPE);
