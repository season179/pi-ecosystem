import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";
import { TelemetryStore, type TelemetryInput, type TelemetryOptions } from "../src/telemetry.js";

const NOW = Date.UTC(2026, 8, 18, 12);
const DAY = 86_400_000;
const roots: string[] = [];
async function fixture(options: TelemetryOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-telemetry-"));
  roots.push(root);
  const directory = join(root, "telemetry");
  return { root, directory, store: new TelemetryStore(directory, { now: () => NOW, ...options }) };
}
async function exported(store: TelemetryStore, root: string, days = 7) {
  const path = join(root, `${randomUUID()}.json`);
  const result = await store.exportMetadata(path, days);
  assert.equal(result.available, true);
  const text = await readFile(path, "utf8");
  return { path, text, data: JSON.parse(text) as { events: Array<Record<string, any>> } };
}
function event(input: Partial<TelemetryInput> = {}): TelemetryInput {
  return { kind: "session", sessionId: "branch-A", ...input };
}
async function eventPaths(directory: string) {
  return (await readdir(directory)).filter(name => name.endsWith(".jsonl")).map(name => join(directory, name));
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("metadata-only local telemetry", () => {
  it("strips unknown fields recursively and never writes raw identifiers or payload secrets", async () => {
    const { root, directory, store } = await fixture();
    await store.record({
      kind: "pass", sessionId: "sensitive-session", passId: "sensitive-pass", model: "sk-secret-model",
      modelVersion: "sk-secret-model-version", provider: "sk-secret-provider", configFingerprint: "sk-secret-config",
      version: "26.9.0", outcome: "committed", mode: "on", reason: "threshold", fallback: false,
      timestamp: NOW - 10, payload: "sk-payload-secret", apiKey: "sk-api-secret", command: "cat /private/secrets",
      measures: { candidates: 2, dropped: 1, inputTokens: 0, outputTokens: -1, contextFractionMeasured: 101,
        latencyMs: Infinity, cost: 999, prompt: "nested-narrative-secret" },
      reasons: { pinned: 1, "sk-reason-secret": 4 },
      candidates: [{ id: "sk-candidate-secret", decision: "drop", reason: "recent", estimatedTokens: 10,
        command: "sk-command-secret", content: "sk-content-secret", callProbability: 0.4,
        resultProbability: NaN }],
      prices: { source: "provider_api_rates", inputPerMillionUsd: 2, apiKey: "sk-price-secret" },
      error: new Error("sk-error-secret"),
    } as unknown as TelemetryInput);
    const { text, data } = await exported(store, root);
    const raw = (await Promise.all((await eventPaths(directory)).map(path => readFile(path, "utf8")))).join("");
    for (const content of [text, raw]) {
      assert.doesNotMatch(content, /sk-|sensitive-|\/private\/secrets|nested-narrative|apiKey|command|payload|content/);
    }
    assert.equal(data.events.length, 1);
    const saved = data.events[0];
    assert.match(saved.sessionId, /^h_[0-9a-f]{64}$/);
    assert.equal(saved.version, "26.9.0");
    assert.deepEqual(saved.measures, { candidates: 2, dropped: 1, inputTokens: 0 });
    assert.deepEqual(saved.reasons, { pinned: 1 });
    assert.equal(saved.candidates[0].callProbability, 0.4);
    assert.equal(saved.candidates[0].resultProbability, undefined);
    assert.deepEqual(saved.prices, { source: "provider_api_rates", inputPerMillionUsd: 2 });
  });

  it("generates timestamps, stable domain-separated IDs, and bounds candidate samples", async () => {
    const { root, store, directory } = await fixture();
    const input = event({ kind: "pass", passId: "shared-id", configFingerprint: "shared-id",
      candidates: Array.from({ length: 300 }, (_, i) => ({ id: `candidate-${i}`, decision: "keep" })) });
    await store.record(input);
    await new TelemetryStore(directory, { now: () => NOW }).record(input);
    const { data } = await exported(store, root);
    assert.equal(data.events.length, 2);
    assert.equal(data.events[0].timestamp, NOW);
    assert.equal(data.events[0].candidates.length, 64);
    assert.equal(data.events[0].sessionId, data.events[1].sessionId);
    assert.equal(data.events[0].passId, data.events[1].passId);
    assert.notEqual(data.events[0].passId, data.events[0].configFingerprint);
    assert.notEqual(data.events[0].eventId, data.events[1].eventId);
  });

  it("rejects path-shaped session IDs, unknown kinds, invalid timestamps and unsafe values without throwing", async () => {
    const { store, root } = await fixture();
    for (const input of [
      event({ sessionId: "/Users/private/transcript.jsonl" }),
      event({ timestamp: Infinity }), event({ timestamp: NOW + DAY }),
      { kind: "raw-payload", sessionId: "A" }, null,
      Object.defineProperty({}, "kind", { get() { throw new Error("secret"); } }),
    ]) await assert.doesNotReject(() => store.record(input as TelemetryInput));
    await store.record(event({ version: "26.9.0-sk-secret", passId: "/private/path",
      model: "a model with narrative", measures: { turn: -1, inputTokens: 1.5 },
      prices: { source: "subscription" as any, inputPerMillionUsd: 2 } }));
    const { data, text } = await exported(store, root);
    assert.equal(data.events.length, 1);
    for (const key of ["version", "passId", "model", "measures", "prices"]) assert.equal(data.events[0][key], undefined);
    assert.doesNotMatch(text, /secret|private|subscription/);
    assert.match(await store.report(), /rejected inputs=6/);
  });

  it("aggregates observable usage, priced samples, latency, decisions and observational on/off groups", async () => {
    const { root, store } = await fixture();
    await store.record(event({ kind: "pass", passId: "pass-1", mode: "on", outcome: "committed",
      timestamp: NOW - 5000, measures: { candidates: 10, eligible: 8, kept: 3, dropped: 4, replaced: 1,
        excluded: 2, latencyMs: 600, contextBeforeTokensEstimate: 1000, contextAfterTokensEstimate: 600 },
      reasons: { pinned: 1, recent: 1 } }));
    for (const latency of [10, 20, 30, 40, 100]) {
      await store.record(event({ kind: "request", role: "scoring", mode: "on", outcome: "completed",
        measures: { latencyMs: latency, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        prices: { source: "provider_api_rates", inputPerMillionUsd: 2, outputPerMillionUsd: 10 } }));
    }
    await store.record(event({ kind: "request", role: "coding", passId: "pass-1", mode: "on", outcome: "completed",
      measures: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 500, cacheWriteTokens: 0,
        contextTokensMeasured: 650, contextFractionMeasured: 0.65 } }));
    await store.record(event({ kind: "request", role: "coding", mode: "off", outcome: "completed",
      measures: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }));
    const report = await store.report();
    assert.match(report, /Committed passes=1; commits without pass ID=0; pruned passes=1/);
    assert.match(report, /on: sessions=1, events=7, completed requests=6, summaries=0/);
    assert.match(report, /off: sessions=1, events=1, completed requests=1, summaries=0, input=0 \(n=1\)/);
    assert.match(report, /Candidate aggregates .* candidates=10 \(n=1\); eligible=8 \(n=1\); keep=3 \(n=1\); drop=4 \(n=1\)/);
    assert.match(report, /Candidate\/exclusion reasons: recent=1, pinned=1/);
    assert.match(report, /Estimated reduction tokens: median=400, p95=400 \(n=1\)/);
    assert.match(report, /context fraction: median=0.65, p95=0.65 \(n=1\)/);
    assert.match(report, /minus post-prune estimate: median=50, p95=50 \(n=1\)/);
    assert.match(report, /Scoring requests=5 \(completed=5\); request latency median=30ms, p95=100ms \(n=5\)/);
    assert.match(report, /Measured scoring usage .*uncached input=500 \(n=5\); reported input \(cache split unknown\)=unavailable \(n=0\); output=100 \(n=5\); cache read=0 \(n=5\)/);
    assert.match(report, /cost=\$0.002000 \(priced n=5\/5; API estimate, not invoice\)/);
    assert.match(report, /Measured coding usage .*cost=unavailable \(priced n=0\/2\)/);
    assert.equal((await exported(store, root)).data.events.length, 8);
  });

  it("keeps API-reported input totals separate from uncached input and never prices them", async () => {
    const { store, root } = await fixture();
    await store.record(event({ kind: "request", role: "scoring", outcome: "completed",
      measures: { latencyMs: 40, reportedInputTokens: 900, outputTokens: 12 },
      prices: { source: "provider_api_rates", inputPerMillionUsd: 2, outputPerMillionUsd: 10 } }));
    const report = await store.report();
    assert.match(report, /Measured scoring usage .*uncached input=unavailable \(n=0\); reported input \(cache split unknown\)=900 \(n=1\); output=12 \(n=1\)/);
    assert.match(report, /Measured scoring usage .*cost=unavailable \(priced n=0\/1\)/);
    assert.equal((await exported(store, root)).data.events[0].measures.reportedInputTokens, 900);
  });

  it("retains and reports measured context overflow while rejecting nonfinite or excessive fractions", async () => {
    const { store, root } = await fixture();
    const recordFraction = (contextFractionMeasured: number) => store.record(event({
      kind: "request", role: "coding", outcome: "completed", measures: { contextFractionMeasured },
    }));
    await recordFraction(1.25);
    assert.match(await store.report(), /context fraction: median=1.25, p95=1.25 \(n=1\)/);
    assert.equal((await exported(store, root)).data.events[0].measures.contextFractionMeasured, 1.25);

    await recordFraction(100);
    for (const value of [100.001, -0.1, Infinity, -Infinity, NaN]) await recordFraction(value);
    const { data } = await exported(store, root);
    assert.equal(data.events.length, 7);
    assert.deepEqual(data.events.flatMap(e => e.measures?.contextFractionMeasured === undefined ? [] :
      [e.measures.contextFractionMeasured]).sort((a, b) => a - b), [1.25, 100]);
    assert.match(await store.report(), /context fraction: median=50.625, p95=100 \(n=2\)/);
  });

  it("does not impute absent tokens, prices or measurements to zero", async () => {
    const { store } = await fixture();
    await store.record(event({ kind: "request", role: "coding", outcome: "completed",
      measures: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0 },
      prices: { source: "configured_api_rates", inputPerMillionUsd: 2 } }));
    await store.record(event({ kind: "request", role: "coding", outcome: "completed",
      measures: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      prices: { source: "configured_api_rates", inputPerMillionUsd: 2 } }));
    const report = await store.report();
    assert.match(report, /cache write=0 \(n=1\); cost=unavailable \(priced n=0\/2\)/);
    assert.match(report, /context tokens: unavailable \(n=0\)/);
    assert.match(report, /Estimated reduction tokens: unavailable \(n=0\)/);
  });

  it("keeps known-zero exclusion counts and zero cost distinguishable from unavailable data", async () => {
    const { store } = await fixture();
    await store.record(event({ kind: "pass", reasons: { pinned: 0, recent: 0 } }));
    await store.record(event({ kind: "request", role: "coding", outcome: "completed",
      measures: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      prices: { source: "provider_api_rates", inputPerMillionUsd: 2, outputPerMillionUsd: 10 } }));
    const report = await store.report();
    assert.match(report, /Candidate\/exclusion reasons: recent=0, pinned=0/);
    assert.match(report, /cost=\$0.000000 \(priced n=1\/1/);
  });

  it("counts actual summaries and reports time/turn sample sizes and right censoring", async () => {
    const { store } = await fixture();
    await store.record(event({ kind: "pass", passId: "p1", outcome: "committed", timestamp: NOW - 600_000,
      measures: { turn: 10, dropped: 2 } }));
    // Retrying the same commit is not another independent pruning observation.
    await store.record(event({ kind: "pass", passId: "p1", outcome: "committed", timestamp: NOW - 590_000,
      measures: { turn: 10, dropped: 2 } }));
    for (let i = 0; i < 5; i++) await store.record(event({ kind: "summary", outcome: "cancelled", reason: "threshold",
      timestamp: NOW - 500_000 + i, measures: { turn: 10 } }));
    await store.record(event({ kind: "summary", outcome: "completed", reason: "threshold", timestamp: NOW - 300_000,
      measures: { turn: 15 } }));
    await store.record(event({ kind: "pass", passId: "p2", outcome: "committed", timestamp: NOW - 120_000,
      measures: { turn: 17, replaced: 1 } }));
    await store.record(event({ kind: "session", outcome: "ended", measures: { turn: 19 } }));
    await store.record(event({ kind: "pass", sessionId: "branch-B", passId: "p1", outcome: "committed",
      timestamp: NOW - 600_000, measures: { turn: 0, dropped: 1 } }));
    await store.record(event({ kind: "request", sessionId: "branch-B", role: "coding", outcome: "completed" }));
    const report = await store.report();
    assert.match(report, /Committed passes=3; commits without pass ID=0; pruned passes=3; completed summaries=1/);
    assert.match(report, /Threshold cancellation checks=5; not summaries avoided/);
    assert.match(report, /eligible passes=3, observed=1, right-censored=2; time median=5min, p95=5min \(n=1\); turns median=5, p95=5 \(n=1\)/);
    assert.match(report, /Censored observation .*time median=6min, p95=10min \(n=2\); turns median=2, p95=2 \(n=1\)/);
  });

  it("links feedback, recall, restore and off only to the same session's existing earlier pass", async () => {
    const { store } = await fixture();
    await store.record(event({ kind: "pass", passId: "p1", outcome: "committed", timestamp: NOW - 1000,
      measures: { dropped: 1 } }));
    await store.record(event({ kind: "recall", passId: "p1" }));
    await store.record(event({ kind: "recall", sessionId: "branch-B", passId: "p1" }));
    await store.record(event({ kind: "restore", passId: "p1" }));
    await store.record(event({ kind: "mode", passId: "p1", mode: "off", outcome: "disabled" }));
    await store.record(event({ kind: "feedback", passId: "p1", outcome: "bad_prune" }));
    await store.record(event({ kind: "feedback", passId: "missing", outcome: "bad_prune" }));
    await store.record(event({ kind: "feedback", passId: "p1", outcome: "helpful" }));
    await store.record(event({ kind: "error", reason: "timeout", fallback: true }));
    await store.record(event({ kind: "pass", outcome: "failed", reason: "invalid_response", fallback: true }));
    const report = await store.report();
    assert.match(report, /recall: events=2, linked=1, unlinked=1, distinct passes=1/);
    assert.match(report, /restore: events=1, linked=1, unlinked=0, distinct passes=1/);
    assert.match(report, /off: events=1, linked=1, unlinked=0, distinct passes=1/);
    assert.match(report, /bad-prune: events=2, linked=1, unlinked=1, distinct passes=1/);
    assert.match(report, /Errors \(event samples\): .*timeout=1/);
    assert.match(report, /fallbacks: .*invalid_response=1/);
    assert.match(report, /Low recall does not establish quality/);
  });

  it("does not infer summary ordering from equal timestamps or compare post-summary usage to old pruning", async () => {
    const { store } = await fixture();
    await store.record(event({ kind: "summary", outcome: "completed", timestamp: NOW - 1000 }));
    await store.record(event({ kind: "pass", passId: "p1", outcome: "committed", timestamp: NOW - 1000,
      measures: { dropped: 1, contextAfterTokensEstimate: 1000 } }));
    assert.match(await store.report(), /eligible passes=1, observed=0, right-censored=1/);
    await store.record(event({ kind: "summary", outcome: "completed", timestamp: NOW - 500 }));
    await store.record(event({ kind: "request", passId: "p1", role: "coding", outcome: "completed",
      measures: { contextTokensMeasured: 100 } }));
    assert.match(await store.report(), /minus post-prune estimate: unavailable \(n=0\)/);
  });

  it("enforces retention and event capacity across restarts, and reports only the requested window", async () => {
    const { root, directory, store } = await fixture({ retentionDays: 7, maxEvents: 3 });
    await store.record(event({ timestamp: NOW - 8 * DAY }));
    for (let i = 5; i >= 0; i--) await store.record(event({ timestamp: NOW - i * DAY }));
    assert.equal((await eventPaths(directory)).length, 3);
    const reopened = new TelemetryStore(directory, { now: () => NOW, retentionDays: 7, maxEvents: 3 });
    const { data } = await exported(reopened, root);
    assert.deepEqual(data.events.map(e => e.timestamp), [NOW - 2 * DAY, NOW - DAY, NOW]);
    assert.match(await reopened.report(), /Observed timestamps: 2026-09-16T12:00:00.000Z → 2026-09-18T12:00:00.000Z; gaps\/eviction possible/);
    assert.equal((await exported(reopened, root, 1)).data.events.length, 2);
    const expired = new TelemetryStore(directory, { now: () => NOW + 8 * DAY, retentionDays: 7, maxEvents: 3 });
    assert.match(await expired.report(), /Events=0; sessions=0/);
    assert.equal((await eventPaths(directory)).length, 0);
  });

  it("enforces byte capacity and bounds the export; oversize single records are nonfatal", async () => {
    const { store, root, directory } = await fixture({ maxBytes: 1024 });
    for (let i = 0; i < 12; i++) await store.record(event({ timestamp: NOW - 100 + i, passId: `p-${i}` }));
    const sizes = await Promise.all((await eventPaths(directory)).map(async path => (await stat(path)).size));
    assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 1024);
    assert.ok(sizes.length > 0 && sizes.length < 12);
    const { text } = await exported(store, root);
    assert.ok(Buffer.byteLength(text) <= 1024 + 4096);
    await assert.doesNotReject(() => store.record(event({ candidates: Array.from({ length: 64 }, (_, i) => ({ id: `id-${i}`, decision: "keep" })) })));
    assert.match(await store.report(), /rejected inputs=1/);
  });

  it("keeps concurrent session records intact and converges to bounded capacity", async () => {
    const { root, directory, store } = await fixture({ maxEvents: 100 });
    const writers = Array.from({ length: 6 }, () => new TelemetryStore(directory, { now: () => NOW, maxEvents: 100 }));
    await Promise.all(writers.flatMap((writer, i) => Array.from({ length: 10 }, (_, j) =>
      writer.record(event({ sessionId: `session-${i}`, passId: `pass-${j}`, timestamp: NOW - 1000 + i * 10 + j })))));
    const { data } = await exported(store, root);
    assert.equal(data.events.length, 60);
    assert.equal(new Set(data.events.map(e => e.eventId)).size, 60);
    assert.equal(new Set(data.events.map(e => e.sessionId)).size, 6);
    const limited = Array.from({ length: 4 }, () => new TelemetryStore(directory, { now: () => NOW, maxEvents: 8 }));
    await Promise.all(limited.map((writer, i) => writer.record(event({ sessionId: `limited-${i}` }))));
    assert.ok((await eventPaths(directory)).length <= 8);
    assert.ok((await eventPaths(directory)).length > 0);
    assert.ok((await readdir(directory)).every(name => name.endsWith(".jsonl")));
  });

  it("supports genuinely separate processes without a shared in-memory lock", async () => {
    const { root, directory, store } = await fixture();
    const run = promisify(execFile);
    const tsc = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url));
    const source = fileURLToPath(new URL("../src/telemetry.ts", import.meta.url));
    const compiled = join(root, "compiled");
    await run(process.execPath, [tsc, "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "Bundler",
      "--skipLibCheck", "--strict", "--outDir", compiled, source]);
    const modulePath = join(compiled, "telemetry.mjs");
    await rename(join(compiled, "telemetry.js"), modulePath);
    await Promise.all(Array.from({ length: 4 }, (_, i) => run(process.execPath, ["--input-type=module", "--eval", `
      import { TelemetryStore } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      const store = new TelemetryStore(${JSON.stringify(directory)}, { now: () => ${NOW} });
      for (let n = 0; n < 8; n++) await store.record({ kind: "session", sessionId: "process-${i}", measures: { turn: n } });
    `])));
    const { data } = await exported(store, root);
    assert.equal(data.events.length, 32);
    assert.equal(new Set(data.events.map(e => e.sessionId)).size, 4);
    for (const sessionId of new Set(data.events.map(e => e.sessionId))) {
      assert.deepEqual(data.events.filter(e => e.sessionId === sessionId).map(e => e.measures.turn).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
    }
  }, 15_000);

  it("expires abandoned staging files, bounds oversize files, and leaves unknown files alone", async () => {
    const { store, directory } = await fixture();
    await store.record(event());
    const abandoned = join(directory, `.${randomUUID()}.pending`);
    await writeFile(abandoned, "partial", { mode: 0o600 });
    await utimes(abandoned, new Date(NOW - 600_000), new Date(NOW - 600_000));
    await writeFile(join(directory, `${NOW}-${randomUUID()}.jsonl`), "a".repeat(20_000), { mode: 0o600 });
    const unrelated = join(directory, "unrelated.txt");
    await writeFile(unrelated, "user-owned", { mode: 0o600 });
    const report = await store.report();
    assert.match(report, /Events=1; sessions=1/);
    assert.match(report, /trimmed this instance=2/);
    assert.equal(await readFile(unrelated, "utf8"), "user-owned");
    assert.equal((await readdir(directory)).length, 2);
  });

  it("skips corrupt/truncated lines and sanitizes valid tampered records again before export", async () => {
    const { store, root, directory } = await fixture();
    await store.record(event());
    const valid = (await eventPaths(directory))[0];
    const contents = JSON.parse(await readFile(valid, "utf8"));
    contents.payload = "sk-persisted-secret";
    contents.measures = { inputTokens: 3, rawError: "sk-persisted-error" };
    contents.model = "sk-unhashed-model";
    await writeFile(valid, `${JSON.stringify(contents)}\n`, { mode: 0o600 });
    for (const text of ["{truncated", "{}\n{}\n", JSON.stringify({ ...contents, schema: 2 }),
      JSON.stringify({ ...contents, sessionId: "raw-invalid-id" })]) {
      await writeFile(join(directory, `${NOW}-${randomUUID()}.jsonl`), text, { mode: 0o600 });
    }
    assert.match(await store.report(), /skipped\/corrupt files=4/);
    const { data, text } = await exported(store, root);
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].measures.inputTokens, 3);
    assert.doesNotMatch(text, /sk-|payload|rawError/);
  });

  it("creates private directory, record and export modes and refuses to overwrite exports", async () => {
    const { store, root, directory } = await fixture();
    await store.record(event());
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const path of await eventPaths(directory)) assert.equal((await stat(path)).mode & 0o777, 0o600);
    const { path, text } = await exported(store, root);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(path)).nlink, 1);
    assert.deepEqual(await store.exportMetadata(path), { available: false, exportedEvents: 0, reason: "destination_unavailable" });
    assert.equal(await readFile(path, "utf8"), text);
    const shared = join(root, "shared");
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    const unsafe = new TelemetryStore(shared, { now: () => NOW });
    await assert.doesNotReject(() => unsafe.record(event()));
    assert.match(await unsafe.report(), /unavailable \(local storage\)/);
    assert.equal((await stat(shared)).mode & 0o777, 0o755);
  });

  it("refuses directory/ancestor/export symlinks and ignores symlink or hardlinked event files", async () => {
    const { root, directory, store } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    const alias = join(root, "alias");
    await symlink(outside, alias);
    for (const path of [alias, join(alias, "nested")]) {
      const unsafe = new TelemetryStore(path, { now: () => NOW });
      await assert.doesNotReject(() => unsafe.record(event()));
      assert.match(await unsafe.report(), /unavailable \(local storage\)/);
    }
    assert.deepEqual(await readdir(outside), []);
    await store.record(event());
    const secret = join(outside, "secret");
    await writeFile(secret, "sk-outside-secret", { mode: 0o600 });
    const symlinkPath = join(directory, `${NOW}-${randomUUID()}.jsonl`);
    await symlink(secret, symlinkPath);
    const hardlinkPath = join(directory, `${NOW}-${randomUUID()}.jsonl`);
    await link(secret, hardlinkPath);
    assert.match(await store.report(), /skipped\/corrupt files=2/);
    assert.doesNotMatch((await exported(store, root)).text, /sk-outside-secret/);
    const destination = join(root, "export-link");
    await symlink(secret, destination);
    assert.equal((await store.exportMetadata(destination)).available, false);
    assert.equal((await store.exportMetadata(join(alias, "export.json"))).available, false);
    assert.equal(await readFile(secret, "utf8"), "sk-outside-secret");
    assert.ok((await lstat(symlinkPath)).isSymbolicLink());
  });

  it("detects replacement of an already-used directory and fails closed", async () => {
    const { root, directory, store } = await fixture();
    await store.record(event());
    await rename(directory, join(root, "moved"));
    await mkdir(directory, { mode: 0o700 });
    await assert.doesNotReject(() => store.record(event()));
    assert.deepEqual(await readdir(directory), []);
    assert.match(await store.report(), /unavailable \(local storage\)/);
    assert.deepEqual(await store.exportMetadata(join(root, "export.json")), {
      available: false, exportedEvents: 0, reason: "storage_unavailable",
    });
  });

  it("keeps I/O failure nonfatal without returning raw paths or error text", async () => {
    const { root } = await fixture();
    const path = join(root, "sk-secret-path");
    await writeFile(path, "a file is not a telemetry directory", { mode: 0o600 });
    const store = new TelemetryStore(join(path, "nested"), { now: () => NOW });
    await assert.doesNotReject(() => store.record(event()));
    const report = await store.report();
    assert.match(report, /unavailable \(local storage\)/);
    assert.match(report, /local I\/O failures=1/);
    assert.doesNotMatch(report, /sk-secret|ENOTDIR|Error:/);
    const invalidClock = new TelemetryStore(join(root, "clock"), { now: () => { throw new Error("sk-clock-secret"); } });
    await assert.doesNotReject(() => invalidClock.record(event()));
    assert.doesNotMatch(await invalidClock.report(), /sk-clock-secret/);
  });
});
