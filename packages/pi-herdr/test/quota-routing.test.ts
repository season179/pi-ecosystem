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
			assert.throws(() => selectRoute(config, { ...request, budgetChoice: { ...request.budgetChoice, profileId: id } }, ready, [], quota), /exhausted/);
			assert.match(routeBlock(config.profiles.find(p => p.id === id)!, { difficulty: "general" }, ready, quota)!, /exhausted/);
		}
	});
});
