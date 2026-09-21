import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { assessQuota, QuotaMonitor, quotaEvidence, quotaSummary } from "../src/quota.js";
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
	it("replays the GLM screenshot: burst burn on an ahead-of-pace window is surplus, not conserve", () => {
		const glm: QuotaGroup = { id: "glm", provider: "zai", source: "api", profiles: ["pi-glm", "pi-glm-flash"] };
		const observed = Date.parse("2026-09-18T08:51:52Z");
		const sample: QuotaSample = { observedAt: observed, accountKey: "g".repeat(64), windows: [
			{ id: "primary", usedPercent: 20, resetsAt: Date.parse("2026-09-18T09:39:13Z"), windowMinutes: 300 },
			{ id: "secondary", usedPercent: 23, resetsAt: Date.parse("2026-09-19T17:57:50Z"), windowMinutes: 10080 },
			{ id: "zai-mcp", usedPercent: 0, resetsAt: 1790186270000, windowMinutes: 43200 },
		] };
		const previous: QuotaSample = { ...sample, observedAt: Date.parse("2026-09-18T08:18:37Z"), windows: sample.windows.map(w => ({ ...w, usedPercent: w.id === "primary" ? 5 : w.id === "secondary" ? 20 : 0 })) };
		const b = assessQuota(glm, { attemptedAt: observed, sample, previous, failed: false }, observed);
		assert.equal(b.pressure, "surplus", "both applicable windows are far ahead of even pace");
		const weekly = b.windows.find(w => w.id === "secondary")!;
		// Descriptive burst evidence survives; it just no longer overrides pacing.
		assert.ok(Math.abs(weekly.burnPercentPerHour! - 5.41) < 0.01);
		assert.ok(Math.abs(weekly.projectedExhaustionHours! - 14.22) < 0.02);
		assert.ok(Math.abs(weekly.evenPaceRemainingPercent! - 19.7) < 0.05);
		const primary = b.windows.find(w => w.id === "primary")!;
		assert.ok(Math.abs(primary.burnPercentPerHour! - 27.07) < 0.01);
		assert.ok(Math.abs(primary.evenPaceRemainingPercent! - 15.78) < 0.02);
	});
	it("still conserves on burn that would exhaust before reset when not ahead of even pace", () => {
		const s = makeSample(60); s.windows[0]!.resetsAt = now + 58.8 * 3_600_000; // even pace 35% vs usable 40%: in band
		const previous: QuotaSample = { ...s, observedAt: now - 1_800_000, windows: s.windows.map(w => ({ ...w, usedPercent: 30 })) };
		const fable: QuotaGroup = { id: "fable", provider: "claude", source: "cli", profiles: ["claude-fable"] };
		const b = assessQuota(fable, { ...entry(s), previous }, now);
		assert.equal(b.windows[0]!.burnPercentPerHour, 60);
		assert.equal(b.pressure, "conserve");
	});
	it("treats burn without a pacing reference as descriptive only, never pressure", () => {
		const s = makeSample(40); s.windows[0] = { id: "secondary", usedPercent: 40, resetsAt: now + 10 * 3_600_000 };
		const previous = { ...makeSample(10, now - 1_800_000), windows: [{ id: "secondary", usedPercent: 10, resetsAt: now + 10 * 3_600_000 }] };
		const b = assessQuota({ ...group, reservePercent: 0 }, { ...entry(s), previous }, now);
		assert.equal(b.windows[0]!.burnPercentPerHour, 60);
		assert.equal(b.windows[0]!.projectedExhaustionHours, 1);
		assert.equal(b.pressure, "normal");
	});
	it("treats Claude model-scoped allowance as known only via an explicitly mapped, currently fresh scoped window", () => {
		const fable: QuotaGroup = { id: "fable", provider: "claude", source: "cli", profiles: ["claude-fable"] };
		const summary = (b: ReturnType<typeof assessQuota>) => quotaSummary({ snapshotId: "s", checkedAt: now, groups: [b], binding: "" });
		const scopedSample = makeSample(50);
		scopedSample.windows.push({ id: "claude-weekly-scoped-fable", usedPercent: 84, resetsAt: now + day, windowMinutes: 10080 });
		// Defaults with only shared windows: unknown, disclosed as not reported in this reading.
		const aggregate = assessQuota(fable, entry(), now);
		assert.equal(aggregate.modelScopedAllowanceUnknown, true);
		assert.match(summary(aggregate), /not reported in this reading/);
		// Unrelated tertiary/extra windows are not proof of model-scoped coverage.
		const unrelated = makeSample(50);
		unrelated.windows.push({ id: "tertiary", usedPercent: 10, resetsAt: now + day, windowMinutes: 10080 }, { id: "some-other-extra", usedPercent: 0, resetsAt: now + day, windowMinutes: 43200 });
		assert.equal(assessQuota(fable, entry(unrelated), now).modelScopedAllowanceUnknown, true);
		// Scoped window reported but not mapped: stays unknown, disclosed as not mapped.
		const unmapped = assessQuota(fable, entry(scopedSample), now);
		assert.equal(unmapped.modelScopedAllowanceUnknown, true);
		assert.deepEqual(unmapped.unmappedScopedWindows, ["claude-weekly-scoped-fable"]);
		assert.match(summary(unmapped), /reported in this reading \(claude-weekly-scoped-fable\) are not mapped/);
		// Mapped but absent from the reading, reset-passed, or in a stale sample: unknown.
		const mapped: QuotaGroup = { ...fable, windows: ["primary", "secondary", "claude-weekly-scoped-fable"] };
		assert.equal(assessQuota(mapped, entry(makeSample(50)), now).modelScopedAllowanceUnknown, true);
		const passed = makeSample(50);
		passed.windows.push({ id: "claude-weekly-scoped-fable", usedPercent: 84, resetsAt: now - 1, windowMinutes: 10080 });
		assert.equal(assessQuota(mapped, entry(passed), now).modelScopedAllowanceUnknown, true);
		const staleScoped = makeSample(50);
		staleScoped.windows.push({ id: "claude-weekly-scoped-fable", usedPercent: 84, resetsAt: now + day, windowMinutes: 10080 });
		assert.equal(assessQuota(mapped, entry(staleScoped), now + QUOTA_INTERVAL_MS).modelScopedAllowanceUnknown, true, "a stale sample is not current model-scoped evidence");
		// Explicitly mapped and currently fresh: known.
		const fresh = assessQuota(mapped, entry(scopedSample), now);
		assert.equal(fresh.modelScopedAllowanceUnknown, false);
		assert.deepEqual(fresh.unmappedScopedWindows, []);
		// No sample at all: unknown, not silently known.
		assert.equal(assessQuota(fable, undefined, now).modelScopedAllowanceUnknown, true);
		assert.equal(assessQuota(group, entry(), now).modelScopedAllowanceUnknown, false, "non-Claude providers have no scoped-limit concept here");
	});
});

describe("compact quota evidence for inspect", () => {
	const text = (budget: ReturnType<typeof assessQuota>, shared: string[] = []) => quotaEvidence(budget, shared).join("\n");
	it("shows usable allowance, reset timing, pacing and burn only for fresh applicable windows", () => {
		const previous = makeSample(58, now - 3_600_000);
		const budget = assessQuota(group, { attemptedAt: now, failed: false, sample: makeSample(60), previous }, now);
		const lines = text(budget, ["sol"]);
		assert.match(lines, /^- astra \(codex; one subscription shared with sol\): fresh, pressure/m);
		const window = lines.split("\n").find(l => l.trimStart().startsWith("secondary:"))!;
		for (const fact of ["40% left", "30% usable after reserve", "resets 2026-09-24T06:00:00Z", "6.0d", "even-pace reference", "burn 2.0%/h", "15.0h"]) assert.ok(window.includes(fact), fact);
		assert.match(lines, /missing windows \(unknown, not unlimited\): primary/);
		assert.doesNotMatch(lines, /HISTORICAL/);
	});
	it("labels stale, reset-passed and unavailable readings historical without usable figures", () => {
		const stale = text(assessQuota(group, entry(), now + QUOTA_INTERVAL_MS + 1));
		assert.match(stale.split("\n")[0]!, /^- astra .*stale/);
		assert.match(stale, /HISTORICAL/);
		assert.match(stale, /was 40% left/);
		assert.doesNotMatch(stale, /usable after reserve|burn|pressure/);
		assert.match(stale, /! astra: quota stale/);
		const passed = text(assessQuota(group, entry({ ...makeSample(), windows: [{ id: "secondary", usedPercent: 60, resetsAt: now - 1 }] }), now));
		assert.match(passed, /HISTORICAL.*reset passed/);
		assert.match(passed, /was 40% left/);
		assert.match(passed, /missing windows .*secondary/);
		assert.match(passed, /! astra: reset passed/);
		const unavailable = text(assessQuota(group, { attemptedAt: now, failed: true, sample: makeSample() }, now));
		assert.match(unavailable, /^- astra \(codex\): unavailable/m);
		assert.match(unavailable, /HISTORICAL: unavailable reading/);
		assert.match(text(assessQuota(group, undefined, now)), /^- astra \(codex\): unknown .*observed never/m);
	});
	it("keeps exhaustion, scoped-limit caveats and unapplied windows visible", () => {
		const exhausted = text(assessQuota(group, entry(), now, true));
		assert.match(exhausted, /EXHAUSTED/);
		assert.match(exhausted, /! astra: exhausted/);
		const opus: QuotaGroup = { id: "opus", provider: "claude", source: "cli", profiles: ["claude-opus-5"] };
		const sample: QuotaSample = { observedAt: now, windows: [{ id: "primary", usedPercent: 10 }, { id: "claude-weekly-scoped-fable", usedPercent: 5 }, { id: "tertiary", usedPercent: 0 }] };
		const lines = text(assessQuota(opus, entry(sample), now));
		assert.match(lines, /reported but not applied to this group: claude-weekly-scoped-fable, tertiary/);
		assert.match(lines, /not mapped for this group/);
		assert.match(lines, /not model-specific headroom/);
		assert.doesNotMatch(lines, /^  claude-weekly-scoped-fable:/m, "unmapped scoped windows are never presented as this group's allowance");
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
