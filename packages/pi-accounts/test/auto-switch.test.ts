import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import { CodexAutoSwitch, type AutoSwitchAccess, type QuotaChecker } from "../src/auto-switch.js";
import { checkCodexQuota, parseCodexQuota } from "../src/codex-quota.js";
import { createMockContext } from "./support.js";

const baseTime = 2_000_000_000_000;
const error = (message = "You have hit your ChatGPT usage limit. Try again in ~60 min.", provider = "openai-codex") => ({
  message: { role: "assistant", provider, stopReason: "error", errorMessage: message, content: [] },
  toolResults: [], messageEntryId: "failed-entry",
}) as never;
const boundary = (outcome = "error", canContinue = true) => ({ outcome, context: { canContinue, contextEntries: [], llmMessages: [] } }) as never;

async function fixture(quota?: QuotaChecker) {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const credential = { type: "oauth", access: "fixture", refresh: "fixture", expires: baseTime };
  await store.write({ version: 1, providers: { "openai-codex": {
    accounts: { backup: credential, other: credential }, autoSwitch: { primary: "default", fallback: "backup" },
  } } });
  const session = SessionManager.inMemory(process.cwd());
  let selected: string | null = null;
  let now = baseTime;
  let checks = 0;
  const switches: string[] = [];
  const controller = new AbortController();
  const access: AutoSwitchAccess = {
    session, sessionId: session.getSessionId(), signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
    selected: () => selected,
    activate: async name => { switches.push(name); selected = name === "default" ? null : name; return true; },
  };
  const checker: QuotaChecker = async (ctx, signal) => {
    checks++;
    return quota ? quota(ctx, signal) : { exhausted: true, resetAt: now + 60_000 };
  };
  const clock = () => now;
  const create = () => new CodexAutoSwitch(store, access, checker, clock);
  const sut = create();
  const context = createMockContext({ model: { provider: "openai-codex", id: "codex" }, sessionManager: session });
  return { store, session, sut, create, ...context, switches, controller,
    select: (name: string | null) => { selected = name; }, advance: (ms: number) => { now += ms; },
    get checks() { return checks; }, get selected() { return selected; },
  };
}

test("primary → fallback → primary at the next request after reset; survives session resume", async () => {
  const f = await fixture();
  assert.equal(await f.sut.prepare(f.ctx), true);
  assert.equal(f.checks, 0); // No quota polling before healthy requests.
  f.sut.observe(error());
  assert.deepEqual(await f.sut.recover(boundary(), f.ctx), { continue: true });
  assert.equal(f.selected, "backup");
  const resumed = f.create();
  assert.equal(await resumed.prepare(f.ctx), true);
  assert.deepEqual(f.switches, ["backup"]);
  f.advance(61_001);
  assert.equal(await resumed.prepare(f.ctx), true);
  assert.equal(f.selected, null);
  assert.deepEqual(f.switches, ["backup", "default"]);
  assert.equal(f.checks, 1);
  assert.ok(!JSON.stringify(f.session.getEntries()).includes('"access"'));
});

test("both exhausted stops continuation and subsequent prompts until earliest reset", async () => {
  const f = await fixture();
  await f.sut.prepare(f.ctx);
  f.sut.observe(error());
  await f.sut.recover(boundary(), f.ctx);
  await f.sut.prepare(f.ctx);
  f.sut.observe(error());
  assert.equal(await f.sut.recover(boundary(), f.ctx), undefined);
  assert.match(f.notifications.at(-1)?.message ?? "", /Both ChatGPT accounts are exhausted.*reset/s);
  f.sut.beginPrompt();
  assert.equal(await f.sut.prepare(f.ctx), false);
  assert.deepEqual(f.switches, ["backup"]);
  assert.equal(f.checks, 2);
});

test("temporary rate limits, unavailable quota checks, and unrelated errors never rotate accounts", async () => {
  for (const message of ["401 unauthorized", "503 service unavailable", "context length exceeded", "usage_not_included"]) {
    const f = await fixture();
    await f.sut.prepare(f.ctx);
    f.sut.observe(error(message));
    assert.equal(await f.sut.recover(boundary(), f.ctx), undefined);
    assert.equal(f.checks, 0);
    assert.deepEqual(f.switches, []);
  }
  const allowed = await fixture(async () => ({ exhausted: false }));
  await allowed.sut.prepare(allowed.ctx);
  allowed.sut.observe(error()); // Pi normalizes ordinary 429s to exactly this message.
  assert.equal(await allowed.sut.recover(boundary(), allowed.ctx), undefined);
  assert.deepEqual(allowed.switches, []);
  const unavailable = await fixture(async () => { throw new Error("usage endpoint unavailable"); });
  await unavailable.sut.prepare(unavailable.ctx);
  unavailable.sut.observe(error());
  await assert.rejects(unavailable.sut.recover(boundary(), unavailable.ctx), /unavailable/);
  assert.deepEqual(unavailable.switches, []);
});

test("aborts, stale owners, changed selection, and other providers cannot trigger failover", async () => {
  for (const scenario of ["aborted", "changed", "provider", "shutdown"] as const) {
    const f = await fixture();
    await f.sut.prepare(f.ctx);
    f.sut.observe(error(undefined, scenario === "provider" ? "anthropic" : "openai-codex"));
    if (scenario === "changed") f.select("other");
    if (scenario === "shutdown") f.controller.abort();
    assert.equal(await f.sut.recover(boundary(scenario === "aborted" ? "aborted" : "error"), f.ctx), undefined);
    assert.deepEqual(f.switches, []);
    assert.equal(f.checks, 0);
  }
  let finish!: (value: { exhausted: boolean }) => void;
  const f = await fixture(() => new Promise(resolve => { finish = resolve; }));
  await f.sut.prepare(f.ctx);
  f.sut.observe(error());
  const pending = f.sut.recover(boundary(), f.ctx);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.controller.abort();
  finish({ exhausted: true });
  assert.equal(await pending, undefined);
  assert.deepEqual(f.switches, []);
});

test("unknown reset uses a bounded retry, not a busy loop; no continuation without canContinue", async () => {
  const f = await fixture(async () => ({ exhausted: true }));
  await f.sut.prepare(f.ctx);
  f.sut.observe(error());
  assert.equal(await f.sut.recover(boundary("error", false), f.ctx), undefined);
  assert.equal(f.selected, "backup");
  assert.match(f.notifications.at(-1)?.message ?? "", /Reset time unknown.*Send another prompt/);
  assert.equal(await f.sut.recover(boundary(), f.ctx), undefined);
  f.advance(299_999);
  await f.sut.prepare(f.ctx);
  assert.equal(f.selected, "backup");
  f.advance(1);
  await f.sut.prepare(f.ctx);
  assert.equal(f.selected, null);
});

test("manual out-of-pair account pauses policy; disabled and malformed policies do not select another account", async () => {
  const f = await fixture();
  f.select("other");
  assert.equal(await f.sut.prepare(f.ctx), true);
  assert.deepEqual(f.switches, []);
  await f.sut.command("off", f.ctx);
  f.select("backup");
  assert.equal(await f.sut.prepare(f.ctx), true);
  assert.deepEqual(f.switches, []);
  await f.store.updateProvider("openai-codex", state => ({ ...state, autoSwitch: { primary: "missing", fallback: "backup" } }));
  await assert.rejects(f.sut.prepare(f.ctx), /missing/);
  assert.deepEqual(f.switches, []);
});

test("absent policy defaults to oc-codex → built-in login; off persists; missing oc-codex leaves login alone", async () => {
  const f = await fixture();
  const credential = { type: "oauth", access: "fixture", refresh: "fixture", expires: baseTime };
  await f.store.write({ version: 1, providers: { "openai-codex": { accounts: { "oc-codex": credential } } } });
  assert.equal(await f.sut.prepare(f.ctx), true);
  assert.equal(f.selected, "oc-codex"); // No /accounts-auto needed.
  f.sut.observe(error());
  assert.deepEqual(await f.sut.recover(boundary(), f.ctx), { continue: true });
  assert.equal(f.selected, null);
  f.advance(61_001);
  await f.sut.prepare(f.ctx);
  assert.equal(f.selected, "oc-codex");
  assert.deepEqual(f.switches, ["oc-codex", "default", "oc-codex"]);

  await f.sut.command("off", f.ctx);
  assert.equal((await f.store.readProviderAsync("openai-codex")).autoSwitch, false);
  f.select(null);
  await f.sut.prepare(f.ctx);
  assert.equal(f.selected, null);

  await f.store.write({ version: 1, providers: { "openai-codex": { accounts: {} } } });
  assert.equal(await f.sut.prepare(f.ctx), true);
  assert.equal(f.selected, null);
  assert.equal(f.switches.length, 3);
});

test("configure is atomic, supports built-in login in either role, and refuses changes while streaming", async () => {
  const f = await fixture();
  await assert.rejects(f.sut.command("missing default", f.ctx), /missing/);
  assert.deepEqual((await f.store.readProviderAsync("openai-codex")).autoSwitch, { primary: "default", fallback: "backup" });
  const busy = createMockContext({ isIdle: () => false });
  await f.sut.command("backup default", busy.ctx);
  assert.deepEqual(f.switches, []);
  await f.sut.command("backup default", f.ctx);
  const stored = await f.store.readProviderAsync("openai-codex");
  assert.equal(stored.active, "backup");
  assert.deepEqual(stored.autoSwitch, { primary: "backup", fallback: "default" });
  assert.equal(f.selected, "backup");
  await f.sut.prepare(f.ctx);
  f.sut.observe(error());
  assert.deepEqual(await f.sut.recover(boundary(), f.ctx), { continue: true });
  assert.equal(f.selected, null);
});

test("quota parsing considers both exhausted windows and never guesses missing allowance", () => {
  assert.deepEqual(parseCodexQuota({ rate_limit: { allowed: false, limit_reached: true,
    primary_window: { used_percent: 100, reset_after_seconds: 100 },
    secondary_window: { used_percent: 100, reset_at: baseTime / 1000 + 1000 },
  } }, baseTime), { exhausted: true, resetAt: baseTime + 1000_000 });
  assert.deepEqual(parseCodexQuota({ allowed: false, limit_reached: true,
    primary_window: { used_percent: 100, reset_at: baseTime + 60_000 },
  }, baseTime), { exhausted: true, resetAt: undefined }); // Millisecond timestamp must not strand the account.
  assert.deepEqual(parseCodexQuota({ allowed: true, limit_reached: false }), { exhausted: false });
  assert.deepEqual(parseCodexQuota({ allowed: false, limit_reached: true, primary_window: { used_percent: 100 } }), { exhausted: true, resetAt: undefined });
  for (const payload of [{}, { allowed: false }, { allowed: true, limit_reached: true }, { allowed: false, limit_reached: false }]) {
    assert.throws(() => parseCodexQuota(payload), /Unrecognized/);
  }
});

test("usage fetch uses effective session auth, blocks redirects, and sanitizes transport failures", async () => {
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "current-account" } })).toString("base64url")}.secret`;
  const { ctx } = createMockContext({ model: { provider: "openai-codex", id: "codex" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
  });
  const signal = new AbortController().signal;
  const result = await checkCodexQuota(ctx, signal, (async (url, options) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(options?.redirect, "error");
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(headers.get("ChatGPT-Account-ID"), "current-account");
    return Response.json({ allowed: true, limit_reached: false });
  }) as typeof fetch);
  assert.equal(result.exhausted, false);
  await assert.rejects(checkCodexQuota(ctx, signal, async () => { throw new Error(token); }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(token));
    assert.match(error.message, /Could not verify/);
    return true;
  });
});
