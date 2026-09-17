import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { loadRoutingConfig, RoutingError, selectRoute, validateRoutingConfig, type RouteAvailability, type RoutingConfig, type RoutingProfile } from "../src/routing.js";

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
	it("represents all five profiles with exact launch identifiers and reloads every call", () => {
		const dir = directory();
		const path = join(dir, "herdr-routing.json");
		const config = example();
		assert.equal(config.profiles.length, 5);
		assert.equal(profile(config, "pi-glm").provider, "zai");
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
			c => { c.profiles[2].protection = "claude-auto"; }, c => { delete c.profiles[2].provider; },
			c => { c.profiles[0].provider = "anthropic"; }, c => { c.profiles[0].enabled = "true"; },
			c => { c.profiles[0].suitability = {}; }, c => { c.profiles[0].suitability.hardest = NaN; },
			c => { c.profiles[0].capabilities = ["text", "text"]; },
			c => { c.profiles[0].planning.date = "2026-02-30"; }, c => { c.profiles[0].planning.apiKey = "secret"; },
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
			assert.equal(validateRoutingConfig(c).profiles[3]!.model, model);
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
});

describe("pure route selection", () => {
	it("uses suitability before family shares; selects all five via safe explicit references", () => {
		const c = example(), a = ready(c.profiles);
		assert.equal(selectRoute(c, { difficulty: "hardest" }, a, Array.from({ length: 50 }, () => ({ family: "fable" }))).profile.id, "claude-fable");
		assert.equal(selectRoute(c, { difficulty: "easy" }, a).profile.id, "pi-glm-flash");
		for (const p of c.profiles) assert.equal(selectRoute(c, { ...general, profileId: p.id }, a).profile.id, p.id);
	});
	it("groups Codex/Pi Astra and both GLMs over the configurable rolling window", () => {
		const c = example(), a = ready(c.profiles);
		c.historyWindow = 2;
		assert.equal(selectRoute(c, general, a).profile.id, "pi-astra");
		const history = [{ family: "glm", profileId: "pi-glm-flash" }, { family: "astra", profileId: "codex-astra" }, { family: "astra", profileId: "pi-astra" }];
		assert.equal(selectRoute(c, general, a, history).profile.id, "pi-glm");
		assert.equal(selectRoute(c, general, a, [{ family: "glm" }, { family: "glm" }]).profile.id, "pi-astra");
		const original = structuredClone(history);
		selectRoute(c, general, a, history);
		assert.deepEqual(history, original);
	});
	it("uses deterministic ID ties rather than config order", () => {
		const c = example();
		profile(c, "codex-astra").preference = 0;
		const a = ready(c.profiles);
		assert.equal(selectRoute(c, general, a).profile.id, "codex-astra");
		c.profiles.reverse();
		assert.equal(selectRoute(c, general, a).profile.id, "codex-astra");
	});
	it("requires image in both hints and runtime metadata, never fills shares with unsuitable GLM", () => {
		const c = example(), a = ready(c.profiles);
		assert.equal(selectRoute(c, { ...general, requiredCapabilities: ["image"] }, a, [{ family: "astra" }]).profile.id, "pi-astra");
		assert.throws(() => selectRoute(c, { ...general, profileId: "pi-glm", requiredCapabilities: ["image"] }, a), /capability/);
		a.find(p => p.model === "glm-5.3-flash")!.capabilities = ["text"];
		assert.throws(() => selectRoute(c, { ...general, profileId: "pi-glm-flash", requiredCapabilities: ["image"] }, a), /not verified/);
	});
	it("honors fallback order, reports deviations, and rejects weaker difficulty/capability fallback", () => {
		const c = example(), a = ready(c.profiles);
		a.find(p => p.model === "gpt-6-astra" && p.harness === "pi")!.available = false;
		const choice = selectRoute(c, general, a);
		assert.equal(choice.profile.id, "codex-astra");
		assert.equal(choice.source, "fallback");
		assert.equal(choice.fallbackOf, "pi-astra");
		assert.match(choice.warnings.join(), /unavailable/);
		profile(c, "pi-astra").fallbacks = ["pi-glm-flash", "pi-glm"];
		assert.equal(selectRoute(c, general, a).profile.id, "pi-glm");
		assert.throws(() => selectRoute(c, { ...general, requiredCapabilities: ["image"] }, a), /No eligible route/);
	});
	it("does not recursively follow fallback graphs or choose unconfigured substitutes", () => {
		const c = example(), a = ready(c.profiles);
		profile(c, "pi-astra").fallbacks = ["pi-glm"];
		profile(c, "pi-glm").fallbacks = ["codex-astra"];
		for (const x of a.filter(p => p.harness === "pi")) x.available = false;
		assert.throws(() => selectRoute(c, general, a), /No eligible route/);
	});
	it("fails closed on disabled, absent, ambiguous, wrong-provider, unauthenticated, bypass, and exhausted observations", () => {
		for (const mutate of [
			(a: RouteAvailability[]) => { a.length = 0; },
			(a: RouteAvailability[]) => { a.push({ ...a[2]! }); },
			(a: RouteAvailability[]) => { a[2]!.provider = "openai"; },
			(a: RouteAvailability[]) => { a[2]!.authenticated = false; },
			(a: RouteAvailability[]) => { a[2]!.bypassPermissions = true; },
			(a: RouteAvailability[]) => { a[2]!.remainingQuota = 0; },
			(a: RouteAvailability[]) => { a[2]!.remainingQuota = -1; },
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
		profile(c, "pi-astra").planning!.quotaNote = "Exhausted (old note)";
		assert.equal(selectRoute(c, general, a).profile.id, "pi-astra");
	});
	it("risky work cannot use Pi, even explicit overrides, and never downgrades protected fallbacks", () => {
		const c = example(), a = ready(c.profiles);
		assert.equal(selectRoute(c, { ...general, risky: true }, a).profile.id, "codex-astra");
		assert.throws(() => selectRoute(c, { ...general, risky: true, profileId: "pi-astra" }, a), /requires Claude/);
		a.find(p => p.harness === "codex")!.available = false;
		profile(c, "codex-astra").fallbacks = ["pi-astra"];
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
		selection.profile.capabilities.push("other");
		assert.deepEqual(override.capabilities, ["text"]);
		assert.throws(() => selectRoute(undefined, { ...general, override, risky: true }, a), /requires Claude/);
		assert.throws(() => selectRoute(undefined, general, a), /policy is unavailable/);
		assert.throws(() => selectRoute(c, { ...general, override: profile(c, "pi-glm") }, a), /already exists/);
		assert.throws(() => selectRoute(c, { ...general, profileId: "pi-glm", override }, a), /OR override/);
	});
});
