import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { loadRoutingConfig, routeBlock, RoutingError, selectRoute, validateRoutingConfig, type RouteAvailability, type RoutingConfig, type RoutingProfile } from "../src/routing.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "herdr-routing-"));
	dirs.push(dir);
	return dir;
}
function example(): RoutingConfig {
	return validateRoutingConfig(JSON.parse(readFileSync(new URL("../docs/herdr-routing.example.json", import.meta.url), "utf8")));
}
function ready(profiles: RoutingProfile[]): RouteAvailability[] {
	return profiles.map(p => ({ harness: p.harness, ...(p.provider ? { provider: p.provider } : {}), model: p.model,
		available: true, authenticated: true, capabilities: [...p.capabilities], protection: p.protection, bypassPermissions: false }));
}
function profile(c: RoutingConfig, id: string): RoutingProfile { return c.profiles.find(p => p.id === id)!; }
const general = { difficulty: "general" as const, requiredCapabilities: ["text"] };

describe("routing policy loader", () => {
	it("has actionable missing/invalid errors, never supplies defaults or echoes malformed secrets", () => {
		const dir = directory();
		assert.throws(() => loadRoutingConfig(dir), e => e instanceof RoutingError && e.message.includes(join(dir, "herdr-routing.json")) && e.message.includes("example.json"));
		writeFileSync(join(dir, "herdr-routing.json"), '{"credential":"test-secret",');
		assert.throws(() => loadRoutingConfig(dir), e => e instanceof RoutingError && /invalid JSON/.test(e.message) && !e.message.includes("test-secret"));
	});
	it("represents all eight profiles with exact launch identifiers and reloads every call", () => {
		const dir = directory();
		const path = join(dir, "herdr-routing.json");
		const config = example();
		assert.equal(config.profiles.length, 8);
		assert.equal(profile(config, "pi-glm").provider, "zai");
		assert.equal(profile(config, "pi-sol").model, "gpt-5.6-sol");
		assert.equal(profile(config, "pi-astra").provider, "openai-codex");
		writeFileSync(path, JSON.stringify(config));
		const first = loadRoutingConfig(dir);
		config.historyWindow = 7;
		profile(config, "pi-glm").enabled = false;
		writeFileSync(path, JSON.stringify(config));
		const next = loadRoutingConfig(dir);
		assert.equal(next.historyWindow, 7);
		assert.equal(profile(next, "pi-glm").enabled, false);
		assert.equal(profile(first, "pi-glm").enabled, true);
	});
	it("rejects unknown fields, unsafe launch values, malformed fields and broken references", () => {
		const invalid: Array<(c: any) => void> = [
			c => { c.version = 2; }, c => { c.historyWindow = 0; }, c => { c.historyWindow = 1.5; },
			c => { c.familyShares = { astra: 0, glm: 0, fable: 0 }; }, c => { c.familyShares.astra = -1; },
			c => { c.profiles[0].id = c.profiles[1].id; }, c => { c.profiles[0].family = "missing"; },
			c => { c.profiles[0].fallbacks = ["missing"]; }, c => { c.profiles[0].fallbacks = [c.profiles[0].id]; },
			c => { c.apiKey = "secret"; }, c => { c.profiles[0].command = "claude"; },
			c => { c.profiles[0].model = "$(touch /tmp/never)"; }, c => { c.profiles[0].model = "--dangerously-skip-permissions"; },
			c => { c.profiles[0].model = "fable*"; }, c => { c.profiles[0].protection = "bypassPermissions"; },
			c => { c.profiles[2].protection = "claude-auto"; }, c => { delete c.profiles[3].provider; },
			c => { c.profiles[0].provider = "anthropic"; }, c => { c.profiles[0].enabled = "true"; },
			c => { c.profiles[0].suitability = {}; }, c => { c.profiles[0].suitability.hardest = NaN; },
			c => { c.profiles[0].capabilities = ["text", "text"]; },
			c => { c.profiles[0].planning.date = "2026-02-30"; }, c => { c.profiles[0].planning.apiKey = "secret"; },
			c => { c.profiles[0].fallbackOnly = "yes"; }, c => { c.profiles[0].reasoningEffort = "xhigh"; },
			c => { c.profiles[3].reasoningEffort = "max"; },
		];
		for (const mutate of invalid) { const c = example(); mutate(c); assert.throws(() => validateRoutingConfig(c), RoutingError); }
		for (const value of [null, [], {}, "policy"]) assert.throws(() => validateRoutingConfig(value), RoutingError);
	});
	it("preserves native @ and colon model IDs with exact readiness matching", () => {
		const schema = JSON.parse(readFileSync(new URL("../docs/herdr-routing.schema.json", import.meta.url), "utf8"));
		const pattern = new RegExp(schema.$defs.modelIdentifier.pattern);
		for (const model of ["@cf/zai-org/glm-5.3", "z-ai/glm-5.3:batch"]) {
			const c = example();
			profile(c, "pi-glm").model = model;
			assert.ok(pattern.test(model));
			assert.equal(validateRoutingConfig(c).profiles.find(p => p.id === "pi-glm")!.model, model);
			assert.equal(selectRoute(c, { ...general, profileId: "pi-glm" }, ready(c.profiles)).profile.model, model);
		}
		for (const model of ["--model", "model;id", "$(command)", "model*", "model name"]) assert.equal(pattern.test(model), false);
	});
	it("returns detached policy copies", () => {
		const c = example();
		const copy = validateRoutingConfig(c);
		copy.profiles[0]!.capabilities.push("other");
		assert.ok(!c.profiles[0]!.capabilities.includes("other"));
	});
	it("reserves both Astra profiles, caps Sol/Opus effort, and keeps GLM/Sol fallbacks away from Astra", () => {
		const c = example();
		for (const id of ["pi-astra", "codex-astra", "claude-opus-5"]) assert.equal(profile(c, id).fallbackOnly, true, `${id} must be fallbackOnly`);
		for (const id of ["pi-sol", "codex-sol", "claude-opus-5"]) assert.equal(profile(c, id).reasoningEffort, "high", `${id} must launch at high effort`);
		const astraIds = c.profiles.filter(p => p.family === "astra").map(p => p.id);
		for (const p of c.profiles.filter(p => p.family === "sol" || p.family === "glm")) {
			for (const edge of p.fallbacks) assert.ok(!astraIds.includes(edge), `${p.id} must not fall back directly to Astra`);
		}
		assert.deepEqual(profile(c, "claude-fable").fallbacks, ["claude-opus-5", "codex-astra"]);
		const groups = c.quota!.groups;
		assert.deepEqual(groups.find(g => g.id === "fable")!.windows, ["primary", "secondary", "claude-weekly-scoped-fable"]);
		assert.equal(groups.find(g => g.id === "opus")!.windows, undefined);
		const claudeProfiles = groups.filter(g => g.provider === "claude").flatMap(g => g.profiles);
		assert.equal(new Set(claudeProfiles).size, claudeProfiles.length);
	});
});

describe("pure route selection", () => {
	it("uses suitability before family shares; selects all eight via safe explicit references", () => {
		const c = example(), a = ready(c.profiles);
		assert.equal(selectRoute(c, { difficulty: "hardest" }, a, Array.from({ length: 50 }, () => ({ family: "fable" }))).profile.id, "claude-fable");
		assert.equal(selectRoute(c, { difficulty: "easy" }, a).profile.id, "pi-glm-flash");
		for (const p of c.profiles) assert.equal(selectRoute(c, { ...general, profileId: p.id }, a).profile.id, p.id);
	});
	it("gives Claude a share of general work without an explicit override", () => {
		const c = example(), a = ready(c.profiles);
		const history: Array<{ family: string }> = [];
		const selected = new Set<string>();
		for (let i = 0; i < c.historyWindow; i++) {
			const choice = selectRoute(c, general, a, history);
			assert.equal(choice.source, "policy");
			selected.add(choice.profile.id);
			history.push({ family: choice.profile.family });
		}
		assert.deepEqual(selected, new Set(["pi-sol", "pi-glm", "claude-fable"]));
	});
	it("keeps reserved routes out of baseline ranking regardless of shares or history", () => {
		const c = example(), a = ready(c.profiles);
		c.familyShares = { astra: 60, opus: 30, sol: 5, glm: 4, fable: 1 };
		const history: Array<{ family: string }> = [];
		for (let i = 0; i < 30; i++) {
			const choice = selectRoute(c, general, a, history);
			assert.equal(choice.source, "policy");
			assert.match(choice.profile.id, /^(pi-sol|codex-sol|pi-glm|claude-fable)$/);
			history.push({ family: choice.profile.family });
		}
		for (const id of ["pi-astra", "codex-astra", "claude-opus-5"]) {
			assert.match(routeBlock(profile(c, id), general, a), /fallback-only/);
		}
	});
	it("permits a fallbackOnly route as a direct fallback target and as an explicit user choice", () => {
		const c = example(), a = ready(c.profiles);
		a.filter(p => p.harness === "claude").forEach(p => { p.available = false; });
		const choice = selectRoute(c, { difficulty: "hardest" }, a);
		assert.equal(choice.source, "fallback");
		assert.equal(choice.fallbackOf, "claude-fable");
		const explicit = selectRoute(c, { ...general, profileId: "pi-astra" }, a);
		assert.equal(explicit.source, "explicit");
		assert.match(explicit.warnings.join(), /fallback-only/);
	});
	it("accepts medium and low effort values while rejecting values above high", () => {
		const c = example();
		c.profiles[3]!.reasoningEffort = "medium";
		validateRoutingConfig(c);
		c.profiles[3]!.reasoningEffort = "low";
		validateRoutingConfig(c);
	});
	it("requires native readiness for an underused Claude route instead of assuming it", () => {
		const c = example(), a = ready(c.profiles);
		const history = [{ family: "sol" }, { family: "glm" }];
		const unchecked = selectRoute(c, general, a.filter(p => p.harness !== "claude"), history);
		assert.equal(unchecked.source, "fallback");
		assert.equal(unchecked.fallbackOf, "claude-fable");
		assert.equal(unchecked.profile.id, "codex-astra");
		assert.match(unchecked.warnings.join(), /readiness unknown/);
		assert.equal(selectRoute(c, general, a, history).profile.id, "claude-fable");
	});
	it("groups both Sol harnesses and both GLMs over the configurable rolling window", () => {
		const c = example(), a = ready(c.profiles);
		c.historyWindow = 2;
		assert.equal(selectRoute(c, general, a).profile.id, "pi-sol");
		const history = [{ family: "fable", profileId: "claude-fable" }, { family: "sol", profileId: "codex-sol" }, { family: "sol", profileId: "pi-sol" }];
		assert.equal(selectRoute(c, general, a, history).profile.id, "pi-glm");
		assert.equal(selectRoute(c, general, a, [{ family: "glm" }, { family: "glm" }]).profile.id, "pi-sol");
		const original = structuredClone(history);
		selectRoute(c, general, a, history);
		assert.deepEqual(history, original);
	});
	it("uses deterministic ID ties rather than config order", () => {
		const c = example();
		profile(c, "codex-sol").preference = 0;
		const a = ready(c.profiles);
		assert.equal(selectRoute(c, general, a).profile.id, "codex-sol");
		c.profiles.reverse();
		assert.equal(selectRoute(c, general, a).profile.id, "codex-sol");
	});
	it("requires image in both hints and runtime metadata, never fills shares with unsuitable GLM", () => {
		const c = example(), a = ready(c.profiles);
		assert.equal(selectRoute(c, { ...general, requiredCapabilities: ["image"] }, a, [{ family: "astra" }]).profile.id, "pi-sol");
		assert.throws(() => selectRoute(c, { ...general, profileId: "pi-glm", requiredCapabilities: ["image"] }, a), /capability/);
		a.find(p => p.model === "glm-5.3-flash")!.capabilities = ["text"];
		assert.throws(() => selectRoute(c, { ...general, profileId: "pi-glm-flash", requiredCapabilities: ["image"] }, a), /not verified/);
	});
	it("honors fallback order, reports deviations, and rejects weaker difficulty/capability fallback", () => {
		const c = example(), a = ready(c.profiles);
		a.find(p => p.model === "gpt-5.6-sol" && p.harness === "pi")!.available = false;
		const choice = selectRoute(c, general, a);
		assert.equal(choice.profile.id, "pi-glm");
		assert.equal(choice.source, "fallback");
		assert.equal(choice.fallbackOf, "pi-sol");
		assert.match(choice.warnings.join(), /unavailable/);
		profile(c, "pi-sol").fallbacks = ["pi-glm-flash", "pi-glm"];
		assert.equal(selectRoute(c, general, a).profile.id, "pi-glm");
		assert.throws(() => selectRoute(c, { ...general, requiredCapabilities: ["image"] }, a), /No eligible route/);
	});
	it("does not recursively follow fallback graphs or choose unconfigured substitutes", () => {
		const c = example(), a = ready(c.profiles);
		profile(c, "pi-sol").fallbacks = ["pi-glm"];
		profile(c, "pi-glm").fallbacks = ["codex-sol"];
		for (const x of a.filter(p => p.harness === "pi")) x.available = false;
		assert.throws(() => selectRoute(c, general, a), /No eligible route/);
	});
	it("fails closed on disabled, absent, ambiguous, wrong-provider, unauthenticated, bypass, and exhausted observations", () => {
		for (const mutate of [
			(a: RouteAvailability[]) => { a.length = 0; },
			(a: RouteAvailability[]) => { a.push({ ...a.find(p => p.harness === "pi" && p.model === "gpt-6-astra")! }); },
			(a: RouteAvailability[]) => { a.find(p => p.harness === "pi" && p.model === "gpt-6-astra")!.provider = "openai"; },
			(a: RouteAvailability[]) => { a.find(p => p.harness === "pi" && p.model === "gpt-6-astra")!.authenticated = false; },
			(a: RouteAvailability[]) => { a.find(p => p.harness === "pi" && p.model === "gpt-6-astra")!.bypassPermissions = true; },
			(a: RouteAvailability[]) => { a.find(p => p.harness === "pi" && p.model === "gpt-6-astra")!.remainingQuota = 0; },
			(a: RouteAvailability[]) => { a.find(p => p.harness === "pi" && p.model === "gpt-6-astra")!.remainingQuota = -1; },
		]) {
			const c = example(), a = ready(c.profiles); mutate(a);
			assert.throws(() => selectRoute(c, { ...general, profileId: "pi-astra" }, a), RoutingError);
		}
		const c = example(), a = ready(c.profiles);
		profile(c, "pi-astra").enabled = false;
		assert.throws(() => selectRoute(c, { ...general, profileId: "pi-astra" }, a), /disabled/);
	});
	it("unknown quota stays eligible and static quota notes never become live balance", () => {
		const c = example(), a = ready(c.profiles);
		profile(c, "pi-sol").planning!.quotaNote = "Exhausted (old note)";
		assert.equal(selectRoute(c, general, a).profile.id, "pi-sol");
	});
	it("risky work cannot use Pi, even explicit overrides, and never downgrades protected fallbacks", () => {
		const c = example(), a = ready(c.profiles);
		assert.equal(selectRoute(c, { ...general, risky: true }, a).profile.id, "codex-sol");
		assert.throws(() => selectRoute(c, { ...general, risky: true, profileId: "pi-sol" }, a), /requires Claude/);
		for (const x of a.filter(p => p.harness === "codex")) x.available = false;
		profile(c, "codex-astra").fallbacks = ["pi-sol"];
		assert.throws(() => selectRoute(c, { ...general, profileId: "codex-astra", allowFallback: true }, a), /risky work/);
	});
	it("explicit selection only permits fallback when requested and rechecks fallback suitability", () => {
		const c = example(), a = ready(c.profiles);
		a.find(p => p.harness === "pi" && p.model === "gpt-6-astra")!.available = false;
		assert.throws(() => selectRoute(c, { ...general, profileId: "pi-astra" }, a), /No eligible route/);
		assert.equal(selectRoute(c, { ...general, profileId: "pi-astra", allowFallback: true }, a).source, "fallback");
	});
	it("supports a validated one-off without config, but not an override of disabled config IDs", () => {
		const c = example();
		const override = { ...profile(c, "pi-glm"), id: "one-off", fallbacks: [] };
		const a = ready([override]);
		const selection = selectRoute(undefined, { difficulty: "hardest", override }, a);
		assert.equal(selection.source, "explicit");
		const capped = { ...override, id: "one-off-capped", fallbackOnly: true, reasoningEffort: "high" as const };
		const cappedSelection = selectRoute(c, { ...general, override: capped }, ready([capped]));
		assert.equal(cappedSelection.source, "explicit");
		assert.equal(cappedSelection.profile.reasoningEffort, "high");
		assert.match(cappedSelection.warnings.join(), /fallback-only/);
		selection.profile.capabilities.push("other");
		assert.deepEqual(override.capabilities, ["text"]);
		assert.throws(() => selectRoute(undefined, { ...general, override, risky: true }, a), /requires Claude/);
		assert.throws(() => selectRoute(undefined, general, a), /policy is unavailable/);
		assert.throws(() => selectRoute(c, { ...general, override: profile(c, "pi-glm") }, a), /already exists/);
		assert.throws(() => selectRoute(c, { ...general, profileId: "pi-glm", override }, a), /OR override/);
	});
});
