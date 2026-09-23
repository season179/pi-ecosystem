import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import accountsExtension from "../src/accounts.js";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import type { AccountProviderAdapter } from "../src/oauth.js";

test("real Pi loop retries the same prompt under fallback auth and returns to primary after reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-accounts-sdk-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    const credential = (access: string) => ({ type: "oauth", access, refresh: "fixture", expires: Date.now() + 3_600_000 });
    await store.write({ version: 1, providers: { "openai-codex": {
      active: "primary", accounts: { primary: credential("primary-token"), backup: credential("backup-token") },
      autoSwitch: { primary: "primary", fallback: "backup" },
    } } });
    const provider: AccountProviderAdapter = {
      id: "openai-codex", displayName: "OpenAI Codex", requiresApiKeyBridge: true, runtimeAuthMode: "api-key",
      oauth: { login: async () => credential("unused"), refresh: async current => current, toAuth: async current => ({ apiKey: current.access }) },
    };
    let now = Date.now();
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => accountsExtension(pi, {
        store, providers: [provider], now: () => now,
        checkQuota: async () => ({ exhausted: true, resetAt: now + 60_000 }),
      })],
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const registry = new ModelRegistry(modelRuntime);
    const model = registry.getAll().find(model => model.provider === "openai-codex");
    assert.ok(model);
    const manager = SessionManager.inMemory(root);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model,
      sessionManager: manager, settingsManager, resourceLoader, noTools: "all" }));
    await session.bindExtensions({});
    await session.prompt("/accounts-auto primary backup");
    const requests: string[] = [];
    let allExhausted = false;
    let cancelledRequests = 0;
    session.agent.streamFunction = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const auth = await registry.getApiKeyAndHeaders(model);
        assert.ok(auth.ok);
        // Like a real provider's fetch, do not send an already-aborted request.
        const aborted = options?.signal?.aborted;
        if (aborted) cancelledRequests++;
        else requests.push(auth.apiKey ?? "missing");
        const fail = requests.length === 1 || allExhausted;
        const message = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: fail ? [] : [{ type: "text", text: "done" }],
          stopReason: aborted ? "aborted" : fail ? "error" : "stop", errorMessage: aborted ? "Aborted" : fail ? "You have hit your ChatGPT usage limit." : undefined,
          timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } as any;
        stream.push(aborted || fail ? { type: "error", reason: aborted ? "aborted" : "error", error: message } : { type: "done", reason: "stop", message });
        stream.end();
      })().catch(error => { stream.end(); throw error; });
      return stream;
    };
    await session.prompt("one original request");
    assert.deepEqual(requests, ["primary-token", "backup-token"]);
    assert.equal(session.getLastAssistantText(), "done");
    assert.equal(session.messages.filter(message => message.role === "user").length, 1);
    const failed = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error");
    assert.ok(failed, "failed request remains in raw audit history");
    assert.ok(manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === failed.id && entry.replacement === null));
    now += 61_001;
    await session.prompt("next request");
    assert.deepEqual(requests, ["primary-token", "backup-token", "primary-token"]);
    allExhausted = true;
    await session.prompt("both accounts are now exhausted");
    assert.deepEqual(requests.slice(3), ["primary-token", "backup-token"]);
    await session.prompt("do not send a request while both cooldowns are active");
    assert.equal(requests.length, 5, "turn_start abort must prevent any exhausted-account request");
    assert.equal(cancelledRequests, 1);
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
