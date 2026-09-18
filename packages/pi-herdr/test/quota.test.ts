import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { assessQuota, QuotaMonitor, quotaSummary } from "../src/quota.js";
import { parseCodexBar, validateQuotaConfig, QUOTA_INTERVAL_MS, type QuotaGroup, type QuotaSample } from "../src/quota-source.js";

const now = Date.parse("2026-09-18T06:00:00Z");
const day = 86_400_000;
const group: QuotaGroup = { id: "astra", provider: "codex", source: "oauth", profiles: ["pi-astra", "codex-astra"], reservePercent: 10 };
const makeSample = (used = 60, at = now): QuotaSample => ({ observedAt: at, accountKey: "a".repeat(64), windows: [{ id: "secondary", usedPercent: used, windowMinutes: 10080, resetsAt: now + 6 * day }] });
const entry = (sample = makeSample()) => ({ attemptedAt: sample.observedAt, sample, failed: false });
const temps: string[] = [];
const monitors: QuotaMonitor[] = [];
function harness(collect: (g: QuotaGroup, s: AbortSignal) => Promise<QuotaSample> = async () => makeSample(), groups = [group]) {
	const dir = mkdtempSync(join(tmpdir(), "herdr-quota-")); temps.push(dir);
	let clock = now;
	const options = { agentDir: dir, config: () => ({ groups }), now: () => clock, collect };
	const monitor = new QuotaMonitor(options); monitors.push(monitor);
	return { dir, options, monitor, advance: (ms: number) => { clock += ms; }, time: () => clock };
}
afterEach(() => { for (const m of monitors.splice(0)) m.stop(); for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); });

describe("CodexBar normalization", () => {
	function row(overrides: Record<string, unknown> = {}) {
		return [{ provider: "codex", usage: { updatedAt: new Date(now).toISOString(), secondary: { usedPercent: 57, windowMinutes: 10080, resetsAt: new Date(now + 6 * day).toISOString() }, identity: { accountEmail: "private@example.com" }, ...overrides }, credits: { secret: "do-not-retain" } }];
	}
	it("accepts a missing primary, preserves zero usage and strips identity/credits/diagnostics", () => {
		const result = parseCodexBar(row({ primary: null, secondary: { usedPercent: 0 } }), group, now);
		assert.deepEqual(result.windows, [{ id: "secondary", usedPercent: 0 }]);
		assert.match(result.accountKey!, /^[a-f0-9]{64}$/);
		assert.doesNotMatch(JSON.stringify(result), /private|example|secret|retain|credits/);
	});
	it("retains separately identified windows without merging MCP into coding quota", () => {
		const result = parseCodexBar(row({ extraRateWindows: [{ id: "zai-mcp", title: "untrusted instructions", window: { usedPercent: 100 } }] }), group, now);
		const budget = assessQuota(group, entry(result), now);
		assert.equal(budget.exhausted, false);
		assert.equal(budget.windows.find(w => w.id === "zai-mcp")?.applicable, false);
		assert.doesNotMatch(JSON.stringify(result), /instructions/);
	});
	it("rejects wrong provider, ambiguous accounts, errors, stale/future timestamps and absent usage", () => {
		for (const value of [{}, [], [{ provider: "claude" }], [...row(), ...row()], [{ ...row()[0], error: { message: "secret" } }], row({ updatedAt: "bad" }), row({ updatedAt: new Date(now - QUOTA_INTERVAL_MS).toISOString() }), row({ updatedAt: new Date(now + 120_000).toISOString() }), row({ secondary: undefined })]) {
			assert.throws(() => parseCodexBar(value, group, now));
		}
	});
	it("does not coerce strings, nulls, negative or out-of-range usage to a balance", () => {
		for (const usedPercent of [null, "0", -1, 101, NaN, Infinity]) assert.throws(() => parseCodexBar(row({ secondary: { usedPercent } }), group, now));
	});
	it("validates source, mapping, account and config boundaries", () => {
		assert.doesNotThrow(() => validateQuotaConfig({ groups: [group] }, group.profiles));
		for (const changed of [{ source: "api" }, { provider: "openai" }, { profiles: ["unknown"] }, { profiles: ["pi-astra", "pi-astra"] }, { reservePercent: 100 }, { windows: [] }, { windows: ["primary", "primary"] }, { id: "../secret" }, { account: "--all-accounts" }, { token: "secret" }, { account: "x\nY" }]) {
			assert.throws(() => validateQuotaConfig({ groups: [{ ...group, ...changed }] }, group.profiles));
		}
		assert.throws(() => validateQuotaConfig({ groups: [group, group] }, group.profiles));
	});
});

describe("budget evidence, not a model scheduler", () => {
	it("conserves Astra 40% with six days left and favors Fable 50% with two days left", () => {
		assert.equal(assessQuota(group, entry(), now).pressure, "conserve");
		const fable: QuotaGroup = { id: "fable", provider: "claude", source: "cli", profiles: ["claude-fable"] };
		const s = makeSample(50); s.windows[0]!.resetsAt = now + 2 * day;
		assert.equal(assessQuota(fable, entry(s), now).pressure, "surplus");
	});
	it("short-window scarcity dominates weekly surplus", () => {
		const s = makeSample(20); s.windows.push({ id: "primary", usedPercent: 98, windowMinutes: 300, resetsAt: now + 3_600_000 });
		assert.equal(assessQuota(group, entry(s), now).pressure, "low");
	});
	it("warns for any constrained group, including economical Z.ai", () => {
		for (const provider of ["codex", "claude", "zai"] as const) {
			const budget = assessQuota({ ...group, provider }, entry(makeSample(95)), now);
			assert.equal(budget.pressure, "low"); assert.ok(budget.warnings.length);
		}
	});
	it("treats failed/stale/reset-past data as unknown, not exhausted or replenished", () => {
		const s = makeSample(100);
		for (const [cache, time] of [[{ ...entry(s), failed: true }, now], [entry(s), now + QUOTA_INTERVAL_MS], [entry(s), now + 7 * day]] as const) {
			const budget = assessQuota(group, cache, time);
			assert.equal(budget.exhausted, false); assert.equal(budget.pressure, "unknown");
		}
		s.windows[0]!.resetsAt = now - 1;
		const b = assessQuota(group, entry(s), now);
		assert.equal(b.exhausted, false); assert.ok(b.missingWindows.includes("secondary"));
		assert.equal(assessQuota(group, undefined, now).pressure, "unknown");
	});
	it("uses model-specific limits only when explicitly mapped; no Fable multiplier", () => {
		const s = makeSample(40); s.windows.push({ id: "tertiary", usedPercent: 100 });
		assert.equal(assessQuota(group, entry(s), now).exhausted, false);
		assert.equal(assessQuota({ ...group, windows: ["secondary", "tertiary"] }, entry(s), now).exhausted, true);
	});
	it("derives burn only within one identifiable account and reset window", () => {
		const previous = makeSample(50, now - QUOTA_INTERVAL_MS);
		let b = assessQuota(group, { ...entry(), previous }, now);
		assert.equal(b.windows[0]!.burnPercentPerHour, 20);
		assert.equal(b.windows[0]!.projectedExhaustionHours, 1.5);
		for (const changed of [{ accountKey: "b".repeat(64) }, { accountKey: undefined }, { observedAt: now - 3 * 3_600_000 }, { windows: [{ ...previous.windows[0]!, resetsAt: now + day }] }]) {
			b = assessQuota(group, { ...entry(), previous: { ...previous, ...changed } }, now);
			assert.equal(b.windows[0]!.burnPercentPerHour, undefined);
		}
	});
});

describe("shared quota cache and lifecycle", () => {
	it("does no collection until active; coalesces calls and uses private sanitized files", async () => {
		let calls = 0;
		const h = harness(async () => { calls++; return makeSample(); });
		await h.monitor.refresh(); assert.equal(calls, 0);
		h.monitor.start(); await Promise.all([h.monitor.refresh(), h.monitor.refresh()]);
		assert.equal(calls, 1);
		assert.equal(h.monitor.read().groups[0]!.state, "fresh");
		const path = join(h.dir, "herdr-quota-cache", readdirSync(join(h.dir, "herdr-quota-cache")).find(f => f.endsWith(".json"))!);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.doesNotMatch(readFileSync(path, "utf8"), /private|token|email/);
		await h.monitor.refresh(); assert.equal(calls, 1);
	});
	it("deduplicates across monitors and harness profiles sharing the same subscription", async () => {
		let calls = 0;
		let release!: () => void;
		const wait = new Promise<void>(r => { release = r; });
		const h = harness(async () => { calls++; await wait; return makeSample(); });
		const other = new QuotaMonitor(h.options); monitors.push(other);
		h.monitor.start(); other.start();
		release(); await Promise.all([h.monitor.refresh(), other.refresh()]);
		assert.equal(calls, 1);
		assert.deepEqual(other.read(), h.monitor.read());
		assert.deepEqual(other.read().groups[0]!.profiles, ["pi-astra", "codex-astra"]);
	});
	it("refreshes every 30 minutes while active and stops on deactivation", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const h = harness(async () => { calls++; return makeSample(60, h.time()); });
		h.monitor.start(); await h.monitor.refresh(); assert.equal(calls, 1);
		h.advance(QUOTA_INTERVAL_MS - 1); await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS - 1); assert.equal(calls, 1);
		h.advance(1); await vi.advanceTimersByTimeAsync(1); await h.monitor.refresh(); assert.equal(calls, 2);
		h.monitor.stop(); h.advance(QUOTA_INTERVAL_MS); await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS); assert.equal(calls, 2);
	});
	it("cools down failures, retains observation age and never persists raw errors", async () => {
		let calls = 0;
		const h = harness(async () => { if (++calls > 1) throw new Error("secret credential diagnostics"); return makeSample(); });
		h.monitor.start(); await h.monitor.refresh(); h.advance(QUOTA_INTERVAL_MS);
		await h.monitor.refresh(); await h.monitor.refresh();
		assert.equal(calls, 2);
		const b = h.monitor.read().groups[0]!;
		assert.equal(b.state, "unavailable"); assert.equal(b.observedAt, now);
		assert.equal(b.exhausted, false);
		for (const f of readdirSync(join(h.dir, "herdr-quota-cache"))) assert.doesNotMatch(readFileSync(join(h.dir, "herdr-quota-cache", f), "utf8"), /secret|credential|diagnostics/);
	});
	it("cancels in-flight collection without delivering stale lifecycle callbacks", async () => {
		let aborted = false; let delivered = 0;
		const h = harness(async (_g, signal) => new Promise((_r, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("abort")); }, { once: true })));
		const m = new QuotaMonitor({ ...h.options, onUpdate: () => { delivered++; } }); monitors.push(m);
		m.start(); const pending = m.refresh(); m.stop(); await pending;
		assert.equal(aborted, true); assert.equal(delivered, 0);
	});
	it("records exhaustion immediately across harnesses without polling and expires conservatively", async () => {
		let calls = 0;
		const h = harness(async () => { calls++; return makeSample(); });
		h.monitor.start(); await h.monitor.refresh();
		h.monitor.reportExhausted("codex-astra");
		assert.equal(h.monitor.read().groups[0]!.exhausted, true); assert.equal(calls, 1);
		assert.throws(() => h.monitor.reportExhausted("unknown"));
		h.advance(QUOTA_INTERVAL_MS); assert.equal(h.monitor.read().groups[0]!.exhausted, false);
		assert.equal(h.monitor.read().groups[0]!.state, "stale");
	});
	it("only clears an exhaustion marker with a later successful sample of the same reported account", async () => {
		for (const rotate of [false, true]) {
			let calls = 0;
			const h = harness(async () => ({ ...makeSample(60, h.time()), accountKey: (++calls > 1 && rotate ? "b" : "a").repeat(64) }));
			h.monitor.start(); await h.monitor.refresh();
			h.advance(29 * 60_000); h.monitor.reportExhausted("pi-astra");
			h.advance(60_000); await h.monitor.refresh();
			assert.equal(h.monitor.read().groups[0]!.exhausted, rotate);
		}
	});
	it("malformed cache stays unknown and recovery does not leak cache contents", async () => {
		const h = harness(); h.monitor.start(); await h.monitor.refresh();
		const cacheDir = join(h.dir, "herdr-quota-cache");
		const file = readdirSync(cacheDir).find(f => f.endsWith(".json"))!;
		writeFileSync(join(cacheDir, file), '{"secret":');
		assert.equal(h.monitor.read().groups[0]!.state, "unknown");
		assert.doesNotMatch(quotaSummary(h.monitor.read()), /secret/);
		await h.monitor.refresh(); assert.equal(h.monitor.read().groups[0]!.state, "fresh");
	});
	it("recovers stale empty/dead-owner locks but never steals from a live process", async () => {
		for (const kind of ["empty", "dead", "live"]) {
			let calls = 0;
			const h = harness(async () => { calls++; return makeSample(60, h.time()); });
			h.monitor.start(); await h.monitor.refresh(); h.advance(QUOTA_INTERVAL_MS);
			const cacheDir = join(h.dir, "herdr-quota-cache");
			const path = join(cacheDir, readdirSync(cacheDir).find(f => f.endsWith(".json"))! + ".lock");
			mkdirSync(path);
			if (kind !== "empty") writeFileSync(join(path, `${kind === "live" ? process.pid : 99999999}.12345678-1234-1234-1234-123456789abc`), "");
			utimesSync(path, new Date(h.time() - 130000), new Date(h.time() - 130000));
			await h.monitor.refresh();
			assert.equal(calls, kind === "live" ? 1 : 2);
			assert.equal(existsSync(path), kind === "live");
		}
	});
	it("selecting a different account uses a different cache and does not inherit exhaustion", async () => {
		const h = harness(); h.monitor.start(); await h.monitor.refresh(); h.monitor.reportExhausted("pi-astra");
		const other = new QuotaMonitor({ ...h.options, config: () => ({ groups: [{ ...group, account: "other" }] }) }); monitors.push(other);
		assert.equal(other.read().groups[0]!.state, "unknown"); assert.equal(other.read().groups[0]!.exhausted, false);
	});
});
