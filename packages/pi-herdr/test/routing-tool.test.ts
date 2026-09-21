import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
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
let dateNowMock: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-herdr-routing-tool-"));
	original = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify(config));
});
afterEach(() => {
	if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = original;
	dateNowMock?.mockRestore();
	dateNowMock = undefined;
	rmSync(dir, { recursive: true, force: true });
});

function harness(quota?: QuotaMonitor, extraModels: Array<{ provider: string; id: string; input: string[] }> = []) {
	let tool: any;
	let active = true;
	let sessionId = "session-one";
	let authenticated = true;
	const entries: any[] = [];
	const handlers = new Map<string, () => void>();
	const models = [
		{ provider: "test", id: "text-model", input: ["text"] },
		{ provider: "test", id: "image-model", input: ["text", "image"] },
		...extraModels,
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
	it("emits harness effort flags and accepts reserved/effort override fields", async () => {
		const h = harness();
		const result = await h.execute({ action: "select", difficulty: "easy", override: { ...profile, id: "one-off-capped", fallbackOnly: true, reasoningEffort: "high" } });
		assert.equal(result.details.source, "explicit");
		assert.match(result.details.warnings.join(), /fallback-only/);
		assert.deepEqual(result.details.launchArgs, ["--provider", "test", "--model", "text-model", "--thinking", "high"]);
		assert.deepEqual(launchArguments({ ...profile, harness: "claude", provider: undefined, protection: "claude-auto", reasoningEffort: "high" }), ["--model", "text-model", "--permission-mode", "auto", "--effort", "high"]);
		assert.deepEqual(launchArguments({ ...profile, harness: "codex", provider: undefined, protection: "codex-approve-for-me", reasoningEffort: "high" }), ["--model", "text-model", "--approve-for-me", "-c", "model_reasoning_effort=high"]);
		assert.deepEqual(launchArguments({ ...profile, harness: "codex", provider: undefined, protection: "standard", reasoningEffort: "low" }), ["--model", "text-model", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", "model_reasoning_effort=low"]);
		assert.deepEqual(launchArguments(profile), ["--provider", "test", "--model", "text-model"]);
	});
});

/** The eight-profile example policy with its five quota groups, fresh readings and native evidence for every external route. */
function eightProfileFixture(overrides: { quotaWindows?: (provider: string, now: number) => Array<{ id: string; usedPercent: number; resetsAt?: number; windowMinutes?: number }>; quotaGroups?: boolean } = {}) {
	const policy = JSON.parse(readFileSync(new URL("../docs/herdr-routing.example.json", import.meta.url), "utf8"));
	if (overrides.quotaGroups === false) delete policy.quota;
	writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify(policy));
	let clock = Date.parse("2026-09-20T04:00:00Z");
	// selectRoute judges snapshot currency with real Date.now() against quota.checkedAt;
	// pin Date.now to the fixture clock so the hardcoded evidence date cannot age out of the
	// 30-minute window. advance() moves both sides together, keeping expiry/freshness semantics real.
	dateNowMock = vi.spyOn(Date, "now").mockImplementation(() => clock);
	const windows = overrides.quotaWindows ?? ((provider: string, now: number) => provider === "codex"
		? [{ id: "secondary", usedPercent: 74, windowMinutes: 10080, resetsAt: now + 4 * 86400000 }]
		: provider === "claude"
			? [{ id: "primary", usedPercent: 0, windowMinutes: 300, resetsAt: now + 3 * 3600000 }, { id: "secondary", usedPercent: 0, windowMinutes: 10080, resetsAt: now + 5 * 86400000 }, { id: "claude-weekly-scoped-fable", usedPercent: 0, windowMinutes: 10080, resetsAt: now + 5 * 86400000 }]
			: [{ id: "primary", usedPercent: 1, windowMinutes: 300, resetsAt: now + 4 * 3600000 }, { id: "secondary", usedPercent: 1, windowMinutes: 10080, resetsAt: now + 6 * 86400000 }, { id: "zai-mcp", usedPercent: 0 }]);
	const quota = new QuotaMonitor({ agentDir: dir, config: () => JSON.parse(readFileSync(join(dir, "herdr-routing.json"), "utf8")).quota, now: () => clock,
		collect: async (group) => ({ observedAt: clock, accountKey: "b".repeat(64), windows: windows(group.provider, clock) }) });
	const h = harness(quota, [
		{ provider: "openai-codex", id: "gpt-5.6-sol", input: ["text", "image"] }, { provider: "openai-codex", id: "gpt-6-astra", input: ["text", "image"] },
		{ provider: "zai", id: "glm-5.3", input: ["text"] }, { provider: "zai", id: "glm-5.3-flash", input: ["text", "image"] },
	]);
	const evidence = "native help lists the protection flag; auth status ready; exact model listed";
	const externalChecks = [
		{ harness: "claude", model: "claude-fable-5-1", protection: "claude-auto" }, { harness: "claude", model: "claude-opus-5", protection: "claude-auto" },
		{ harness: "codex", model: "gpt-5.6-sol", protection: "codex-approve-for-me" }, { harness: "codex", model: "gpt-6-astra", protection: "codex-approve-for-me" },
	].map(c => ({ ...c, available: true, authenticated: true, capabilities: ["text", "image"], bypassPermissions: false, evidence }));
	return { ...h, quota, policy, externalChecks, advance: (ms: number) => { clock += ms; } };
}
const rowFor = (text: string, id: string) => text.split("\n").filter(line => line.startsWith(`- ${id}: `));
const lineFor = (text: string, prefix: string) => text.split("\n").find(line => line.startsWith(prefix));
const launchArgsIn = (text: string) => JSON.parse(lineFor(text, "launchArgs ")!.slice("launchArgs ".length));
const contentOf = (result: any): string => result.content.map((c: any) => c.text).join("");

describe.sequential("compact routing responses", () => {
	it("compact inspect keeps IDs, eligibility, quota evidence and sharing facts for all eight profiles; full JSON is explicit and bounded", async () => {
		const f = eightProfileFixture();
		f.quota.start();
		try {
			const base = { action: "inspect", difficulty: "general", requiredCapabilities: ["text"], externalChecks: f.externalChecks };
			const compact = await f.execute(base);
			const text = contentOf(compact);
			assert.equal(compact.details.candidates.length, 8);
			assert.ok(text.startsWith(`snapshotId ${compact.details.quota.snapshotId} `), "snapshot ID leads the compact text");
			for (const { profile, blocked } of compact.details.candidates) {
				const rows = rowFor(text, profile.id);
				assert.equal(rows.length, 1, `${profile.id} has exactly one row`);
				if (blocked) assert.ok(rows[0]!.includes(`BLOCKED (${blocked})`), `${profile.id} shows its block reason`);
				else assert.match(rows[0]!, /: eligible \|/);
				assert.ok(rows[0]!.includes(`${profile.harness} ${profile.provider ? `${profile.provider}/` : ""}${profile.model}`));
				assert.ok(rows[0]!.includes(`| ${profile.protection} |`));
			}
			assert.match(text, /candidates \(8; 4 eligible for general\)/);
			assert.match(rowFor(text, "pi-astra")[0]!, /BLOCKED \(reserved \(fallback-only\).*reserved\(fallback-only\)/);
			assert.match(rowFor(text, "codex-sol")[0]!, /effort high/);
			assert.match(text, /- astra \(codex; one subscription shared with sol\)/);
			assert.match(text, /- fable \(claude; one subscription shared with opus\)/);
			assert.match(text, /- glm \(zai\): fresh/);
			assert.match(text, /secondary: 26% left/);
			assert.match(text, /16% usable after reserve/);
			assert.match(text, /resets 2026-09-24T04:00:00Z/);
			assert.match(text, /missing windows \(unknown, not unlimited\): primary/);
			assert.match(text, /^  claude-weekly-scoped-fable: 100% left/m);
			assert.match(text, /not mapped for this group.*not model-specific headroom/);
			assert.match(text, /reported but not applied to this group: zai-mcp/);
			assert.match(text, /! astra: conserve; preserve orchestration capacity/);
			assert.doesNotMatch(text, /User-supplied planning inputs|"planning"|TRUNCATED/);
			const full = await f.execute({ ...base, verbosity: "full" });
			const fullText = contentOf(full);
			assert.match(fullText, /"planning"/);
			assert.ok(fullText.includes(`"snapshotId": "${compact.details.quota.snapshotId}"`));
			assert.deepEqual(full.details.candidates, compact.details.candidates, "details keep the same structure regardless of verbosity");
			assert.equal(full.details.quota.snapshotId, compact.details.quota.snapshotId);
			const reason = "GLM fits this general implementation task; conserve the shared Codex subscription for orchestration.";
			const selected = await f.execute({ action: "select", difficulty: "general", requiredCapabilities: ["text"], externalChecks: f.externalChecks, budgetChoice: { profileId: "pi-glm", reason, snapshotId: compact.details.quota.snapshotId } });
			const selectedText = contentOf(selected);
			assert.equal(selected.details.source, "budget");
			assert.ok(selectedText.includes(`selectionId ${selected.details.selectionId}`));
			assert.match(lineFor(selectedText, "route ")!, /pi-glm.*source budget/);
			assert.match(lineFor(selectedText, "launch ")!, /pi zai\/glm-5\.3.*standard/);
			assert.deepEqual(launchArgsIn(selectedText), selected.details.launchArgs);
			assert.deepEqual(launchArgsIn(selectedText), ["--provider", "zai", "--model", "glm-5.3"]);
			assert.ok(selectedText.includes(reason));
			for (const warning of selected.details.warnings) assert.ok(selectedText.includes(warning));
			assert.match(selectedText, /record selectionId/);
			assert.match(selectedText, /herdr_watch/);
			assert.doesNotMatch(selectedText, /"planning"|User-supplied/);
			const fullSelect = await f.execute({ action: "select", difficulty: "general", externalChecks: f.externalChecks, verbosity: "full" });
			assert.match(contentOf(fullSelect), /"launchArgs": \[/);
			assert.deepEqual(Object.keys(fullSelect.details).sort(), ["launchArgs", "profile", "selectionId", "source", "warnings"]);
			await f.execute({ action: "record", selectionId: selected.details.selectionId, target: "worker-glm" });
			assert.equal(readAssignments(f.ctx)[0]?.budgetReason, reason);
			assert.doesNotMatch(JSON.stringify([compact, full, selected, fullSelect]), /secret-never-output/);
		} finally { f.quota.stop(); }
	});

	it("re-evaluates task, readiness, policy and exhaustion under an unchanged quota snapshot", async () => {
		const f = eightProfileFixture();
		f.quota.start();
		try {
			const general = await f.execute({ action: "inspect", difficulty: "general", externalChecks: f.externalChecks });
			const easy = await f.execute({ action: "inspect", difficulty: "easy", externalChecks: f.externalChecks });
			assert.equal(easy.details.quota.snapshotId, general.details.quota.snapshotId);
			assert.match(rowFor(contentOf(general), "pi-glm-flash")[0]!, /BLOCKED \(unsuitable/);
			assert.match(rowFor(contentOf(easy), "pi-glm-flash")[0]!, /: eligible/);
			const risky = await f.execute({ action: "inspect", difficulty: "general", risky: true });
			assert.equal(risky.details.quota.snapshotId, general.details.quota.snapshotId);
			assert.match(rowFor(contentOf(risky), "pi-sol")[0]!, /BLOCKED \(risky work requires/);
			assert.match(rowFor(contentOf(risky), "codex-sol")[0]!, /BLOCKED \(readiness unknown or ambiguous/);
			assert.match(contentOf(risky), /candidates \(8; 0 eligible for general\)/);
			f.setAuth(false);
			const unauthenticated = await f.execute({ action: "inspect", difficulty: "general", externalChecks: f.externalChecks });
			assert.equal(unauthenticated.details.quota.snapshotId, general.details.quota.snapshotId);
			assert.match(rowFor(contentOf(unauthenticated), "pi-glm")[0]!, /BLOCKED \(authentication unavailable/);
			assert.match(rowFor(contentOf(unauthenticated), "claude-fable")[0]!, /: eligible/);
			f.setAuth(true);
			writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify({ ...f.policy, profiles: f.policy.profiles.map((p: any) => p.id === "pi-glm" ? { ...p, enabled: false } : p) }));
			const disabled = await f.execute({ action: "inspect", difficulty: "general", externalChecks: f.externalChecks });
			assert.equal(disabled.details.quota.snapshotId, general.details.quota.snapshotId);
			assert.match(rowFor(contentOf(disabled), "pi-glm")[0]!, /BLOCKED \(disabled in routing policy\).* disabled \|/);
			writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify(f.policy));
			await f.execute({ action: "exhausted", profileId: "claude-fable" });
			const exhausted = await f.execute({ action: "inspect", difficulty: "hardest", externalChecks: f.externalChecks });
			const text = contentOf(exhausted);
			assert.match(text, /EXHAUSTED/);
			assert.match(rowFor(text, "claude-fable")[0]!, /BLOCKED \(known quota exhausted or invalid\)/, "exhaustion propagates into readiness before the group check, as before");
			assert.match(rowFor(text, "claude-opus-5")[0]!, /BLOCKED \(reserved/, "reserved routes stay reserved in inspect");
			// A reported exhaustion marks the whole shared Claude subscription, so the configured fallback chain continues past Opus to Astra.
			const fallback = await f.execute({ action: "select", difficulty: "hardest", profileId: "claude-fable", allowFallback: true, externalChecks: f.externalChecks });
			const fallbackText = contentOf(fallback);
			assert.equal(fallback.details.fallbackOf, "claude-fable");
			assert.equal(fallback.details.profile.id, "codex-astra");
			assert.match(lineFor(fallbackText, "route ")!, /codex-astra.*source fallback.*fallbackOf claude-fable/);
			assert.match(lineFor(fallbackText, "launch ")!, /codex gpt-6-astra.*codex-approve-for-me.*fallback-only/);
			assert.deepEqual(launchArgsIn(fallbackText), fallback.details.launchArgs);
			for (const warning of fallback.details.warnings) assert.ok(fallbackText.includes(warning), "fallback provenance warning is carried verbatim");
			const explicit = await f.execute({ action: "select", difficulty: "general", profileId: "pi-astra" });
			assert.equal(explicit.details.source, "explicit");
			for (const warning of explicit.details.warnings) assert.ok(contentOf(explicit).includes(warning));
		} finally { f.quota.stop(); }
	});

	it("keeps stale and unconfigured quota visibly unusable and rejects budget choices built on it", async () => {
		const f = eightProfileFixture();
		f.quota.start();
		try {
			const fresh = await f.execute({ action: "inspect", difficulty: "general", externalChecks: f.externalChecks });
			f.quota.stop();
			f.advance(31 * 60_000);
			const stale = await f.execute({ action: "inspect", difficulty: "general", externalChecks: f.externalChecks });
			const text = contentOf(stale);
			assert.notEqual(stale.details.quota.snapshotId, fresh.details.quota.snapshotId);
			assert.match(lineFor(text, "- astra ")!, /stale/);
			assert.match(text, /HISTORICAL/);
			assert.match(text, /was 26% left/);
			assert.doesNotMatch(text, /usable after reserve|pressure conserve/);
			assert.match(text, /! glm: quota stale/);
			assert.match(rowFor(text, "pi-glm")[0]!, /: eligible/, "stale quota is unknown, not exhausted");
			await assert.rejects(f.execute({ action: "select", difficulty: "general", budgetChoice: { profileId: "pi-glm", reason: "Stale evidence must not justify a budget departure.", snapshotId: stale.details.quota.snapshotId } }), /fresh/);
		} finally { f.quota.stop(); }
		const unmonitored = eightProfileFixture({ quotaGroups: false });
		const text = contentOf(await unmonitored.execute({ action: "inspect", difficulty: "general", externalChecks: unmonitored.externalChecks }));
		assert.match(lineFor(text, "quota")!, /not configured/);
		assert.match(rowFor(text, "pi-glm")[0]!, /\| quota unmonitored$/);
	});

	it("marks truncated compact and full output as incomplete on a very large policy while IDs stay usable", async () => {
		const profiles = Array.from({ length: 400 }, (_, i) => ({ ...profile, id: `pi-test-${String(i).padStart(3, "0")}`, preference: i }));
		writeFileSync(join(dir, "herdr-routing.json"), JSON.stringify({ ...config, profiles }));
		const h = harness();
		const compact = await h.execute({ action: "inspect", difficulty: "easy" });
		const text = contentOf(compact);
		assert.equal(compact.details.candidates.length, 400);
		assert.match(text, /^snapshotId none/);
		assert.match(text, /candidates \(400; 400 eligible for easy\)/);
		const marker = /\[TRUNCATED[^\]]*?(\d+) of 400 candidate rows[^\]]*incomplete[^\]]*\]/.exec(text);
		assert.ok(marker, "compact truncation is named");
		const shown = Number(marker![1]);
		assert.ok(shown > 0 && shown < 400);
		assert.equal(text.split("\n").filter(line => /^- pi-test-\d+: eligible/.test(line)).length, shown, "the marker counts exactly the rows that survived");
		assert.match(text, /Nothing selected or recorded/);
		const full = await h.execute({ action: "inspect", difficulty: "easy", verbosity: "full" });
		assert.match(contentOf(full), /\[TRUNCATED[^\]]*incomplete/);
		assert.equal(full.details.candidates.length, 400);
		const selected = await h.execute({ action: "select", difficulty: "easy" });
		assert.equal(selected.details.profile.id, "pi-test-000");
		assert.doesNotMatch(contentOf(selected), /TRUNCATED/);
		await h.execute({ action: "record", selectionId: selected.details.selectionId, target: "worker" });
		assert.equal(readAssignments(h.ctx).length, 1);
	});
});
