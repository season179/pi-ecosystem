import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { launchArguments, piAvailability, readAssignments, registerRoutingTool, routingGuidance } from "../src/routing-tool.js";
import type { RoutingConfig, RoutingProfile } from "../src/routing.js";
import { QuotaMonitor } from "../src/quota.js";

const profile: RoutingProfile = {
	id: "pi-test", harness: "pi", provider: "test", model: "text-model", family: "test",
	enabled: true, capabilities: ["text"], suitability: { easy: 0, general: 1 },
	preference: 0, protection: "standard", fallbacks: [],
};
const config: RoutingConfig = { version: 1, historyWindow: 20, familyShares: { test: 1 }, profiles: [profile] };
let dir: string;
let original: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-herdr-routing-tool-"));
	original = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify(config));
});
afterEach(() => {
	if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = original;
	rmSync(dir, { recursive: true, force: true });
});

function harness(quota?: QuotaMonitor) {
	let tool: any;
	let active = true;
	let sessionId = "session-one";
	let authenticated = true;
	const entries: any[] = [];
	const handlers = new Map<string, () => void>();
	const models = [
		{ provider: "test", id: "text-model", input: ["text"] },
		{ provider: "test", id: "image-model", input: ["text", "image"] },
	];
	const ctx = {
		sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getApiKeyAndHeaders: async () => authenticated ? { ok: true, apiKey: "secret-never-output" } : { ok: false, error: "missing" },
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerTool: (value: any) => { tool = value; },
		on: (event: string, callback: () => void) => { handlers.set(event, callback); },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	registerRoutingTool(pi, { isActive: () => active, quota });
	return {
		ctx, entries,
		execute: (params: unknown) => tool.execute("call", params, undefined, undefined, ctx),
		setActive: (value: boolean) => { active = value; },
		setSession: (value: string) => { sessionId = value; },
		setAuth: (value: boolean) => { authenticated = value; },
		shutdown: () => handlers.get("session_shutdown")?.(),
	};
}

describe.sequential("routing tool consumer boundary", () => {
	it("inspects fresh evidence, makes a budget choice, records the reason and blocks confirmed exhaustion", async () => {
		let calls = 0;
		const quota = new QuotaMonitor({ agentDir: dir,
			config: () => ({ groups: [{ id: "budget", provider: "codex", source: "oauth", profiles: [profile.id] }] }),
			collect: async () => { calls++; return { observedAt: Date.now(), windows: [{ id: "secondary", usedPercent: 25, resetsAt: Date.now() + 86400000, windowMinutes: 10080 }] }; },
		});
		quota.start();
		try {
			const h = harness(quota);
			const inspected = await h.execute({ action: "inspect", difficulty: "easy" });
			assert.equal(inspected.details.candidates[0].blocked, null);
			assert.equal(inspected.details.quota.groups[0].state, "fresh");
			assert.equal(h.entries.length, 0);
			const reason = "This route fits the task and has ample capacity before tomorrow's reset.";
			const selected = await h.execute({ action: "select", difficulty: "easy", budgetChoice: { profileId: profile.id, reason, snapshotId: inspected.details.quota.snapshotId } });
			assert.equal(selected.details.source, "budget");
			await h.execute({ action: "record", selectionId: selected.details.selectionId, target: "worker" });
			assert.equal(h.entries[0].data.budgetReason, reason);
			await h.execute({ action: "exhausted", profileId: profile.id });
			await assert.rejects(h.execute({ action: "select", difficulty: "easy", profileId: profile.id }), /exhausted/);
			await assert.rejects(h.execute({ action: "select", difficulty: "easy", override: { ...profile, id: "alias" } }), /exhausted/);
			assert.equal(calls, 1);
		} finally { quota.stop(); }
	});

	it("reloads policy on every selection without counting previews or exposing credentials", async () => {
		const h = harness();
		const first = await h.execute({ action: "select", difficulty: "easy" });
		assert.equal(first.details.profile.model, "text-model");
		assert.equal(h.entries.length, 0);
		assert.ok(!JSON.stringify(first).includes("secret-never-output"));
		writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify({ ...config, profiles: [{ ...profile, model: "image-model", capabilities: ["text", "image"] }] }));
		const next = await h.execute({ action: "select", difficulty: "easy", requiredCapabilities: ["image"] });
		assert.equal(next.details.profile.model, "image-model");
		assert.equal(first.details.profile.model, "text-model");
		assert.equal(h.entries.length, 0);
	});

	it("records only a reported dispatch, deduplicates retries, and does not inherit fork history", async () => {
		const h = harness();
		const { details } = await h.execute({ action: "select", difficulty: "easy" });
		const params = { action: "record", selectionId: details.selectionId, target: "worker" };
		await h.execute(params);
		await h.execute(params);
		assert.equal(readAssignments(h.ctx).length, 1);
		await assert.rejects(h.execute({ ...params, target: "different" }), /another target/);
		h.setSession("fork");
		assert.equal(readAssignments(h.ctx).length, 0);
		await assert.rejects(h.execute(params), /Unknown or expired/);
	});

	it("invalidates pending selections on shutdown and rejects inactive use", async () => {
		const h = harness();
		const { details } = await h.execute({ action: "select", difficulty: "easy" });
		h.shutdown();
		await assert.rejects(h.execute({ action: "record", selectionId: details.selectionId, target: "worker" }), /expired/);
		h.setActive(false);
		await assert.rejects(h.execute({ action: "select", difficulty: "easy" }), /Activate/);
	});

	it("blocks unresolved Pi auth and cannot turn configured image hints into model support", async () => {
		const h = harness();
		h.setAuth(false);
		await assert.rejects(h.execute({ action: "select", difficulty: "easy" }));
		h.setAuth(true);
		writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify({ ...config, profiles: [{ ...profile, capabilities: ["text", "image"] }] }));
		await assert.rejects(h.execute({ action: "select", difficulty: "easy", requiredCapabilities: ["image"] }));
		const observed = await piAvailability(h.ctx, [profile]);
		assert.deepEqual(observed[0]?.capabilities, ["text"]);
		const missing = await piAvailability(h.ctx, [{ ...profile, provider: undefined }]);
		assert.equal(missing[0]?.available, false);
		assert.throws(() => launchArguments({ ...profile, provider: undefined }), /exact provider/);
	});

	it("allows an explicit checked one-off override with invalid policy and reports that fact", async () => {
		const h = harness();
		writeFileSync(join(dir, "herdr-routing.json"), "{ invalid");
		assert.match(routingGuidance(dir), /setup required/);
		await assert.rejects(h.execute({ action: "select", difficulty: "easy" }));
		const result = await h.execute({ action: "select", difficulty: "easy", override: profile });
		assert.equal(result.details.source, "explicit");
		assert.ok(result.details.configWarning);
	});

	it("requires native evidence for external routes and emits protected argument arrays", async () => {
		const h = harness();
		const external: RoutingProfile = { ...profile, id: "claude-test", harness: "claude", provider: undefined, model: "external-model", protection: "claude-auto" };
		writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify({ ...config, profiles: [external] }));
		await assert.rejects(h.execute({ action: "select", difficulty: "easy", risky: true }));
		const result = await h.execute({ action: "select", difficulty: "easy", risky: true, externalChecks: [{ harness: "claude", model: "external-model", available: true, authenticated: true, capabilities: ["text"], protection: "claude-auto", bypassPermissions: false, evidence: "native help supports auto; auth status ready; exact model checked" }] });
		await assert.rejects(h.execute({ action: "select", difficulty: "easy", externalChecks: [{ harness: "claude", model: "different-model", available: true, authenticated: true, capabilities: ["text"], protection: "claude-auto", bypassPermissions: false, evidence: "Checked a different model" }] }));
		assert.deepEqual(result.details.launchArgs, ["--model", "external-model", "--permission-mode", "auto"]);
		assert.deepEqual(launchArguments({ ...external, harness: "codex", protection: "codex-approve-for-me" }), ["--model", "external-model", "--approve-for-me"]);
	});
});
