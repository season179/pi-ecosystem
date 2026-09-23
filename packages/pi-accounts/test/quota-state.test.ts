import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { mergeCooldown, QUOTA_STATE_FILE, QuotaStateStore } from "../src/quota-state.js";
import { FileAccountStorageBackend } from "../src/storage.js";

const now = 2_000_000_000_000;
const provider = "openai-codex";
const cooldown = (retryAt: number, resetKnown = true) => ({ retryAt, resetKnown });

async function tempStores(count: number) {
  const root = await mkdtemp(join(tmpdir(), "pi-accounts-quota-"));
  const path = join(root, QUOTA_STATE_FILE);
  // Independent instances share nothing in memory, like separate Pi processes on one agent directory.
  const stores = Array.from({ length: count }, () => new QuotaStateStore(new FileAccountStorageBackend(path)));
  return { root, path, stores, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("concurrent writers on one file lose no updates and later reads see every account", async () => {
  const { path, stores, cleanup } = await tempStores(6);
  try {
    await Promise.all(stores.map((store, index) =>
      store.updateCooldowns(provider, current => ({ ...current, [`acct-${index}`]: cooldown(now + 60_000 * (index + 1)) }), now)));
    const { cooldowns, problem } = stores[0]!.readCooldowns(provider);
    assert.equal(problem, undefined);
    assert.deepEqual(Object.keys(cooldowns).sort(), stores.map((_, index) => `acct-${index}`).sort());
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
    assert.ok(!existsSync(`${path}.lock`), "lock released");
  } finally {
    await cleanup();
  }
});

test("expired cooldowns are pruned on write and a later writer cannot re-introduce them; unknown fields survive", async () => {
  const { path, stores: [a, b], cleanup } = await tempStores(2);
  try {
    await new FileAccountStorageBackend(path).withLockAsync(async () => ({ result: undefined, next: JSON.stringify({
      version: 1, note: "kept", providers: { [provider]: { extra: true, cooldowns: { old: { ...cooldown(now - 1), tag: "x" } } } },
    }) }));
    assert.deepEqual(Object.keys(a!.readCooldowns(provider).cooldowns), ["old"], "readers ignore expiry; callers compare retryAt");
    await b!.updateCooldowns(provider, current => ({ ...current, fresh: cooldown(now + 1) }), now);
    assert.deepEqual(Object.keys(b!.readCooldowns(provider).cooldowns), ["fresh"]);
    await a!.updateCooldowns(provider, current => current, now); // A never held a snapshot; on-disk state governs.
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(Object.keys(file.providers[provider].cooldowns), ["fresh"]);
    assert.equal(file.note, "kept");
    assert.equal(file.providers[provider].extra, true);
  } finally {
    await cleanup();
  }
});

test("unreadable or missing state fails open with a problem message; reset recreates the file", async () => {
  const { root, path, stores: [store], cleanup } = await tempStores(1);
  try {
    assert.deepEqual({ ...store!.readCooldowns(provider), cooldowns: Object.keys(store!.readCooldowns(provider).cooldowns) }, { cooldowns: [] });
    await mkdir(path);
    const unreadable = store!.readCooldowns(provider);
    assert.deepEqual(Object.keys(unreadable.cooldowns), []);
    assert.match(unreadable.problem ?? "", /could not be read.*retry cannot repair/s);
    await rm(path, { recursive: true });
    await store!.updateCooldowns(provider, () => ({ acct: cooldown(now + 1) }), now);
    await store!.reset(provider);
    assert.deepEqual(Object.keys(store!.readCooldowns(provider).cooldowns), []);
    assert.equal(store!.readCooldowns(provider).problem, undefined);
    assert.equal(JSON.parse(await readFile(join(root, QUOTA_STATE_FILE), "utf8")).version, 1);
  } finally {
    await cleanup();
  }
});

test("an expired known-reset entry cannot mask a fresh unknown-reset confirmation", async () => {
  const { stores: [store], cleanup } = await tempStores(1);
  try {
    await store!.updateCooldowns(provider, () => ({ acct: cooldown(now - 1) }), now - 10);
    const result = await store!.updateCooldowns(provider, current => {
      assert.deepEqual(Object.keys(current), [], "mutators never see expired entries");
      return { ...current, acct: mergeCooldown(current.acct, cooldown(now + 300_000, false)) };
    }, now);
    assert.deepEqual(result.acct, cooldown(now + 300_000, false));
  } finally {
    await cleanup();
  }
});

test("merging two confirmations of one exhaustion prefers a known reset, then the later time", () => {
  assert.deepEqual(mergeCooldown(undefined, cooldown(1)), cooldown(1));
  assert.deepEqual(mergeCooldown(cooldown(5, false), cooldown(2)), cooldown(2));
  assert.deepEqual(mergeCooldown(cooldown(2), cooldown(5, false)), cooldown(2));
  assert.deepEqual(mergeCooldown(cooldown(2), cooldown(5)), cooldown(5));
  assert.deepEqual(mergeCooldown(cooldown(5), cooldown(2)), cooldown(5));
  assert.deepEqual(mergeCooldown({ ...cooldown(9), identity: "a" }, { ...cooldown(2), identity: "b" }), { ...cooldown(2), identity: "b" });
});
