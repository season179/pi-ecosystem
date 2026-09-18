import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { assessQuota, type QuotaReport } from "../src/quota.js";
import { routeBlock, selectRoute, validateRoutingConfig, type RouteAvailability, type RoutingConfig } from "../src/routing.js";

function fixture() {
	const config: RoutingConfig = validateRoutingConfig(JSON.parse(readFileSync(new URL("../docs/herdr-routing.example.json", import.meta.url), "utf8")));
	const ready: RouteAvailability[] = config.profiles.map(p => ({ harness: p.harness, provider: p.provider, model: p.model, available: true, authenticated: true, capabilities: p.capabilities, protection: p.protection, bypassPermissions: false }));
	const now = Date.now();
	const group = { id: "astra", provider: "codex" as const, source: "oauth" as const, profiles: ["pi-astra", "codex-astra"], reservePercent: 10 };
	config.quota = { groups: [group] };
	const quota: QuotaReport = { snapshotId: "snapshot-one", checkedAt: now, binding: "configured", groups: [assessQuota(group, { attemptedAt: now, failed: false, sample: { observedAt: now, windows: [{ id: "secondary", usedPercent: 60, windowMinutes: 10080, resetsAt: now + 6 * 86400000 }] } }, now)] };
	const request = { difficulty: "general" as const, requiredCapabilities: ["text"], budgetChoice: { profileId: "pi-glm", reason: "Conserve Astra for orchestration; GLM fits this general implementation task.", snapshotId: quota.snapshotId } };
	return { config, ready, quota, request };
}

function claudeReport(scopedUsed: number) {
	const now = Date.now();
	const sample = { attemptedAt: now, failed: false, sample: { observedAt: now, windows: [
		{ id: "primary", usedPercent: 0, windowMinutes: 300, resetsAt: now + 3 * 3600000 },
		{ id: "secondary", usedPercent: 51, windowMinutes: 10080, resetsAt: now + 25 * 3600000 },
		{ id: "claude-weekly-scoped-fable", usedPercent: scopedUsed, windowMinutes: 10080, resetsAt: now + 25 * 3600000 },
	] } };
	const fable = { id: "fable", provider: "claude" as const, source: "cli" as const, profiles: ["claude-fable"], windows: ["primary", "secondary", "claude-weekly-scoped-fable"] };
	const opus = { id: "opus", provider: "claude" as const, source: "cli" as const, profiles: ["claude-opus-5"] };
	return { fable, opus, quota: { snapshotId: "claude-snapshot", checkedAt: now, binding: "configured", groups: [assessQuota(fable, sample, now), assessQuota(opus, sample, now)] } as QuotaReport };
}

describe("budget-informed routing", () => {
	it("selects a suitable GLM worker with a reason without editing baseline policy", () => {
		const { config, ready, quota, request } = fixture();
		const before = JSON.stringify(config);
		const selected = selectRoute(config, request, ready, [], quota);
		assert.equal(selected.profile.id, "pi-glm"); assert.equal(selected.source, "budget");
		assert.equal(selected.budgetReason, request.budgetChoice.reason);
		assert.equal(JSON.stringify(config), before);
	});
	it("does not interpret a budget choice as explicit user authority to bypass suitability", () => {
		const { config, ready, quota, request } = fixture();
		assert.throws(() => selectRoute(config, { ...request, difficulty: "hardest" }, ready, [], quota), /unsuitable/);
		assert.throws(() => selectRoute(config, { ...request, profileId: "pi-glm" }, ready, [], quota), /combined/);
		assert.throws(() => selectRoute(config, { ...request, budgetChoice: { ...request.budgetChoice, reason: "" } }, ready, [], quota), /reason/);
	});
	it("requires current fresh applicable evidence, not stale snapshots or prose notes", () => {
		const { config, ready, quota, request } = fixture();
		assert.throws(() => selectRoute(config, request, ready), /snapshot/);
		assert.throws(() => selectRoute(config, request, ready, [], { ...quota, snapshotId: "new" }), /snapshot/);
		assert.throws(() => selectRoute(config, request, ready, [], { ...quota, checkedAt: Date.now() - 1800001 }), /snapshot/);
		quota.groups[0]!.state = "unavailable";
		assert.throws(() => selectRoute(config, request, ready, [], quota), /fresh/);
	});
	it("does not borrow a different group's freshness for a stale target subscription", () => {
		const { config, ready, quota, request } = fixture();
		quota.groups.push({ ...quota.groups[0]!, id: "glm", provider: "zai", profiles: ["pi-glm"], state: "stale" });
		assert.throws(() => selectRoute(config, request, ready, [], quota), /Chosen profile.*stale/);
	});
	it("never bypasses image support, authentication, enabled state or risky-work protection", () => {
		for (const change of ["image", "auth", "disabled", "risky"] as const) {
			const { config, ready, quota, request } = fixture();
			if (change === "auth") ready.find(r => r.provider === "zai" && r.model === "glm-5.3")!.authenticated = false;
			if (change === "disabled") config.profiles.find(p => p.id === "pi-glm")!.enabled = false;
			assert.throws(() => selectRoute(config, { ...request, ...(change === "image" ? { requiredCapabilities: ["image"] } : {}), ...(change === "risky" ? { risky: true } : {}) }, ready, [], quota), /blocked/);
		}
	});
	it("blocks exhausted subscriptions even for explicit choices and shares the block across harnesses", () => {
		const { config, ready, quota, request } = fixture(); quota.groups[0]!.exhausted = true;
		const alias = { ...config.profiles.find(p => p.id === "pi-astra")!, id: "one-off-alias" };
		assert.throws(() => selectRoute(config, { difficulty: "general", override: alias }, ready, [], quota), /exhausted/);
		for (const id of ["pi-astra", "codex-astra"]) {
			assert.throws(() => selectRoute(config, { difficulty: "general", profileId: id }, ready, [], quota), /exhausted/);
			assert.throws(() => selectRoute(config, { ...request, budgetChoice: { ...request.budgetChoice, profileId: id } }, ready, [], quota), /reserved|exhausted/);
			assert.match(routeBlock(config.profiles.find(p => p.id === id)!, { difficulty: "general" }, ready, quota, false, true)!, /exhausted/);
		}
	});
});

describe("scoped Claude allowance granularity", () => {
	it("blocks only the Fable group when the scoped window is exhausted, keeping Opus on shared windows usable", () => {
		const config = validateRoutingConfig(JSON.parse(readFileSync(new URL("../docs/herdr-routing.example.json", import.meta.url), "utf8")));
		const ready: RouteAvailability[] = config.profiles.map(p => ({ harness: p.harness, provider: p.provider, model: p.model, available: true, authenticated: true, capabilities: p.capabilities, protection: p.protection, bypassPermissions: false }));
		const { fable, opus, quota } = claudeReport(100);
		assert.equal(quota.groups.find(g => g.id === "fable")!.exhausted, true);
		assert.equal(quota.groups.find(g => g.id === "opus")!.exhausted, false);
		assert.equal(quota.groups.find(g => g.id === "opus")!.modelScopedAllowanceUnknown, true);
		assert.match(routeBlock(config.profiles.find(p => p.id === "claude-fable")!, { difficulty: "hardest" }, ready, quota)!, /exhausted/);
		assert.equal(routeBlock(config.profiles.find(p => p.id === "claude-opus-5")!, { difficulty: "hardest" }, ready, quota, false, true), undefined);
		assert.throws(() => selectRoute(config, { difficulty: "hardest", profileId: "claude-fable" }, ready, [], quota), /exhausted/);
		const fallback = selectRoute(config, { difficulty: "hardest", profileId: "claude-fable", allowFallback: true }, ready, [], quota);
		assert.equal(fallback.source, "fallback");
		assert.equal(fallback.fallbackOf, "claude-fable");
		assert.equal(fallback.profile.id, "claude-opus-5");
		assert.equal(fallback.profile.reasoningEffort, "high");
	});
	it("keeps Fable usable when the scoped window has headroom, with the scoped window applied only to its group", () => {
		const config = validateRoutingConfig(JSON.parse(readFileSync(new URL("../docs/herdr-routing.example.json", import.meta.url), "utf8")));
		const ready: RouteAvailability[] = config.profiles.map(p => ({ harness: p.harness, provider: p.provider, model: p.model, available: true, authenticated: true, capabilities: p.capabilities, protection: p.protection, bypassPermissions: false }));
		const { quota } = claudeReport(40);
		assert.equal(quota.groups.find(g => g.id === "fable")!.exhausted, false);
		assert.equal(quota.groups.find(g => g.id === "fable")!.modelScopedAllowanceUnknown, false);
		assert.equal(selectRoute(config, { difficulty: "hardest" }, ready, [], quota).profile.id, "claude-fable");
	});
	it("rejects a budget choice for a reserved fallback-only route", () => {
		const config = validateRoutingConfig(JSON.parse(readFileSync(new URL("../docs/herdr-routing.example.json", import.meta.url), "utf8")));
		const ready: RouteAvailability[] = config.profiles.map(p => ({ harness: p.harness, provider: p.provider, model: p.model, available: true, authenticated: true, capabilities: p.capabilities, protection: p.protection, bypassPermissions: false }));
		const now = Date.now();
		const sol = { id: "sol", provider: "codex" as const, source: "oauth" as const, profiles: ["pi-sol", "codex-sol"], reservePercent: 10 };
		const quota: QuotaReport = { snapshotId: "sol-snapshot", checkedAt: now, binding: "configured", groups: [assessQuota(sol, { attemptedAt: now, failed: false, sample: { observedAt: now, windows: [{ id: "secondary", usedPercent: 72, windowMinutes: 10080, resetsAt: now + 6 * 86400000 }] } }, now)] };
		assert.throws(() => selectRoute(config, { difficulty: "general", budgetChoice: { profileId: "pi-astra", reason: "Trying to reserve-route via budget judgment is not a user choice.", snapshotId: quota.snapshotId } }, ready, [], quota), /reserved/);
	});
});
