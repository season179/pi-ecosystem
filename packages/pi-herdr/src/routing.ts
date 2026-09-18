/** External policy only: no credentials, shell templates, dispatch, or history writes. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./types.js";
import { validateQuotaConfig, type QuotaConfig } from "./quota-source.js";
import type { QuotaReport } from "./quota.js";

export type Difficulty = "easy" | "general" | "hardest";
export type Harness = "pi" | "claude" | "codex";
export type Protection = "standard" | "claude-auto" | "codex-approve-for-me";
/** Launch reasoning effort. Higher levels (xhigh/max) are rejected by policy: this selector never launches reasoning above high. */
export type ReasoningEffort = "low" | "medium" | "high";
export interface RoutingProfile {
	id: string;
	harness: Harness;
	provider?: string;
	model: string;
	family: string;
	enabled: boolean;
	capabilities: string[];
	/** Absent difficulty means unsuitable. Lower rank means better task fit. */
	suitability: Partial<Record<Difficulty, number>>;
	/** Editable cost/time preference, used after equal fit and family balance. */
	preference: number;
	protection: Protection;
	/** Ordered, direct fallback IDs; never recursively traversed. */
	fallbacks: string[];
	/** Reserved route: excluded from baseline and budget selection; reachable only as a configured fallback target or through an explicit user choice. */
	fallbackOnly?: boolean;
	/** Exact effort level passed to the native launch flags; a launch setting, not a runtime cap on the worker. */
	reasoningEffort?: ReasoningEffort;
	planning?: {
		source: string;
		date: string;
		intelligenceIndex?: number;
		costNote?: string;
		quotaNote?: string;
		capabilityNote?: string;
	};
}
export interface RoutingConfig {
	version: 1;
	historyWindow: number;
	familyShares: Record<string, number>;
	profiles: RoutingProfile[];
	quota?: QuotaConfig;
}
export interface RouteRequest {
	difficulty: Difficulty;
	requiredCapabilities?: string[];
	risky?: boolean;
	profileId?: string;
	/** Explicit one-off user choice, including when policy is unavailable. */
	override?: RoutingProfile;
	allowFallback?: boolean;
	/** Agent judgment based on an inspected snapshot; never an explicit-user override. */
	budgetChoice?: { profileId: string; reason: string; snapshotId: string };
}
/** Caller-observed readiness, not declarations copied from policy. Unknown blocks. */
export interface RouteAvailability {
	harness: Harness;
	provider?: string;
	model: string;
	available: boolean;
	authenticated: boolean;
	capabilities: string[];
	protection: Protection;
	bypassPermissions: boolean;
	/** A known zero blocks. Omission means unknown, not unlimited. */
	remainingQuota?: number;
	reason?: string;
}
/** Actual worker starts, oldest first. Queries and failed launches do not count. */
export interface RouteAssignment { family: string }
export interface RouteSelection {
	profile: RoutingProfile;
	source: "policy" | "explicit" | "fallback" | "budget";
	budgetReason?: string;
	fallbackOf?: string;
	warnings: string[];
}
export class RoutingError extends ConfigError {
	constructor(message: string) {
		super(message);
		this.name = "RoutingError";
	}
}

const DIFFICULTIES = ["easy", "general", "hardest"] as const;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const MODEL_IDENTIFIER = /^[a-zA-Z0-9@][a-zA-Z0-9._/@:-]*$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SETUP = `Review ${fileURLToPath(new URL("../docs/herdr-routing.example.json", import.meta.url))} and ${fileURLToPath(new URL("../docs/herdr-routing.schema.json", import.meta.url))}; create or fix this file with your verified launch identifiers. No defaults were assumed.`;

/** Read afresh at activation and before every new selection. Never writes a file. */
export function loadRoutingConfig(agentDir: string): RoutingConfig {
	const path = join(agentDir, "herdr-routing.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "read error";
		throw new RoutingError(`Cannot read ${path} (${code}). ${SETUP}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		// Do not echo malformed JSON: it could contain an accidentally pasted secret.
		throw new RoutingError(`${path}: invalid JSON. ${SETUP}`);
	}
	try {
		return validateRoutingConfig(value);
	} catch (error) {
		throw new RoutingError(`${path}: ${(error as Error).message} ${SETUP}`);
	}
}

/** Strict schema validation plus cross-reference checks; returns an independent copy. */
export function validateRoutingConfig(value: unknown): RoutingConfig {
	const c = record(value, "config", ["version", "historyWindow", "familyShares", "profiles", "quota"]);
	check(c.version === 1, "config.version must be 1");
	check(Number.isSafeInteger(c.historyWindow) && Number(c.historyWindow) > 0,
		"config.historyWindow must be a positive safe integer");
	const shares = record(c.familyShares, "config.familyShares");
	check(Object.keys(shares).length > 0, "config.familyShares must not be empty");
	for (const [family, share] of Object.entries(shares)) {
		identifier(family, "familyShares key", LABEL);
		check(nonNegative(share), "familyShares values must be finite non-negative numbers");
	}
	const total = Object.values(shares).reduce<number>((n, v) => n + Number(v), 0);
	check(Number.isFinite(total) && total > 0, "familyShares must have a positive finite total");
	check(Array.isArray(c.profiles) && c.profiles.length > 0, "config.profiles must be a non-empty array");
	const profiles = (c.profiles as unknown[]).map((p, i) => validateProfile(p, `profiles[${i}]`));
	const ids = new Set(profiles.map(p => p.id));
	check(ids.size === profiles.length, "profiles must have unique IDs");
	for (const p of profiles) {
		check(Object.hasOwn(shares, p.family), `profile ${p.id}: family missing from familyShares`);
		for (const id of p.fallbacks) {
			check(id !== p.id && ids.has(id), `profile ${p.id}: fallback must name another configured profile`);
		}
	}
	if (c.quota !== undefined) {
		try { validateQuotaConfig(c.quota, [...ids]); }
		catch (error) { throw new RoutingError(error instanceof Error ? error.message : "Invalid quota configuration"); }
	}
	return structuredClone(value) as RoutingConfig;
}

function validateProfile(value: unknown, at: string): RoutingProfile {
	const p = record(value, at, ["id", "harness", "provider", "model", "family", "enabled", "capabilities", "suitability", "preference", "protection", "fallbacks", "fallbackOnly", "reasoningEffort", "planning"]);
	identifier(p.id, `${at}.id`, LABEL);
	identifier(p.family, `${at}.family`, LABEL);
	identifier(p.model, `${at}.model`, MODEL_IDENTIFIER);
	check(["pi", "claude", "codex"].includes(String(p.harness)), `${at}.harness must be pi, claude, or codex`);
	if (p.harness === "pi") identifier(p.provider, `${at}.provider`);
	else check(p.provider === undefined, `${at}.provider is only valid for Pi; external harness auth is harness-owned`);
	check(typeof p.enabled === "boolean", `${at}.enabled must be boolean`);
	strings(p.capabilities, `${at}.capabilities`);
	strings(p.fallbacks, `${at}.fallbacks`);
	const suitability = record(p.suitability, `${at}.suitability`, DIFFICULTIES);
	check(Object.keys(suitability).length > 0, `${at}.suitability must name at least one difficulty`);
	for (const v of Object.values(suitability)) check(nonNegative(v), `${at}.suitability ranks must be finite non-negative numbers`);
	check(nonNegative(p.preference), `${at}.preference must be a finite non-negative number`);
	check(p.protection === "standard" || (p.harness === "claude" && p.protection === "claude-auto") ||
		(p.harness === "codex" && p.protection === "codex-approve-for-me"), `${at}.protection is not supported by this harness; bypass modes are forbidden`);
	check(p.fallbackOnly === undefined || typeof p.fallbackOnly === "boolean", `${at}.fallbackOnly must be boolean`);
	check(p.reasoningEffort === undefined || ["low", "medium", "high"].includes(String(p.reasoningEffort)), `${at}.reasoningEffort must be low, medium, or high; this policy never launches reasoning above high`);
	if (p.planning !== undefined) {
		const notes = record(p.planning, `${at}.planning`, ["source", "date", "intelligenceIndex", "costNote", "quotaNote", "capabilityNote"]);
		check(typeof notes.source === "string" && notes.source.trim().length > 0, `${at}.planning.source is required`);
		check(typeof notes.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(notes.date) &&
			Number.isFinite(Date.parse(notes.date)) && new Date(notes.date).toISOString().slice(0, 10) === notes.date, `${at}.planning.date must be a valid YYYY-MM-DD date`);
		if (notes.intelligenceIndex !== undefined) check(nonNegative(notes.intelligenceIndex), `${at}.planning.intelligenceIndex must be non-negative`);
		for (const key of ["costNote", "quotaNote", "capabilityNote"]) {
			check(notes[key] === undefined || typeof notes[key] === "string", `${at}.planning.${key} must be text`);
		}
	}
	return structuredClone(value) as RoutingProfile;
}

/** Select descriptive policy data only. This function does not authorize any action. */
export function selectRoute(
	config: RoutingConfig | undefined,
	request: RouteRequest,
	availability: readonly RouteAvailability[],
	history: readonly RouteAssignment[] = [],
	quota?: QuotaReport,
): RouteSelection {
	if (config) config = validateRoutingConfig(config);
	record(request, "request", ["difficulty", "requiredCapabilities", "risky", "profileId", "override", "allowFallback", "budgetChoice"]);
	check(DIFFICULTIES.includes(request.difficulty), "request.difficulty must be easy, general, or hardest");
	if (request.requiredCapabilities !== undefined) strings(request.requiredCapabilities, "request.requiredCapabilities");
	for (const key of ["risky", "allowFallback"] as const) {
		check(request[key] === undefined || typeof request[key] === "boolean", `request.${key} must be boolean`);
	}
	check(!(request.profileId !== undefined && request.override !== undefined), "Choose profileId OR override, not both");
	if (request.profileId !== undefined) identifier(request.profileId, "request.profileId", LABEL);
	check(Array.isArray(availability), "availability must be an array of observed readiness");
	check(Array.isArray(history) && history.every(h => h && typeof h.family === "string"), "history must contain assignment families, oldest first");
	const explicit = request.profileId !== undefined || request.override !== undefined;
	let preferred: RoutingProfile | undefined;
	if (request.budgetChoice !== undefined) {
		check(!explicit, "budgetChoice cannot be combined with an explicit user choice");
		const choice = record(request.budgetChoice, "budgetChoice", ["profileId", "reason", "snapshotId"]);
		identifier(choice.profileId, "budgetChoice.profileId", LABEL);
		check(typeof choice.reason === "string" && choice.reason.trim().length >= 10 && choice.reason.length <= 1000 && !/[\x00-\x1f\x7f]/.test(choice.reason), "budgetChoice requires a concise task-and-budget reason (10–1000 characters)");
		check(quota !== undefined && choice.snapshotId === quota.snapshotId && Date.now() - quota.checkedAt < 30 * 60_000, "Quota snapshot changed or expired; inspect again before a budget choice");
		check(quota.groups.some(g => g.state === "fresh" && g.windows.some(w => w.applicable && w.state === "fresh")), "Budget choice requires fresh applicable quota evidence; use baseline routing when unknown");
		preferred = config?.profiles.find(p => p.id === choice.profileId);
		check(preferred !== undefined, "Budget choice must name a configured profile");
		const targetBudget = quota.groups.find(g => g.profiles.includes(preferred!.id));
		check(!targetBudget || (targetBudget.state === "fresh" && targetBudget.windows.some(w => w.applicable && w.state === "fresh")), "Chosen profile's quota is unavailable/stale; inspect again or use baseline routing, not another group's freshness");
	} else if (request.override !== undefined) {
		preferred = validateProfile(request.override, "request.override");
		check(!config?.profiles.some(p => p.id === preferred!.id), "override ID already exists in config; use profileId instead");
		check(preferred.fallbacks.every(id => config?.profiles.some(p => p.id === id)), "override fallbacks require configured profile IDs");
	} else if (request.profileId !== undefined) {
		preferred = config?.profiles.find(p => p.id === request.profileId);
		check(preferred !== undefined, "Unknown profileId; load/fix herdr-routing.json or supply an explicit one-off override");
	} else {
		check(config !== undefined, `Routing policy is unavailable. ${SETUP} An explicit one-off override remains possible.`);
		const window = history.slice(-config.historyWindow);
		const total = Object.values(config.familyShares).reduce((n, v) => n + v, 0);
		const deficit = (p: RoutingProfile) => config!.familyShares[p.family]! / total -
			(window.length ? window.filter(h => h.family === p.family).length / window.length : 0);
		preferred = config.profiles.filter(p => !policyBlock(p, request, false)).sort((a, b) =>
			a.suitability[request.difficulty]! - b.suitability[request.difficulty]! ||
			deficit(b) - deficit(a) || a.preference - b.preference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
		check(preferred !== undefined, "No enabled profile fits difficulty, capabilities, and required protections; review policy or make an explicit safe choice");
	}
	// A one-off alias of a configured route still consumes the same subscription.
	const effectiveQuota = request.override && config && quota ? {
		...quota,
		groups: quota.groups.map(g => ({ ...g, profiles: config.profiles.some(p => g.profiles.includes(p.id) &&
			p.harness === request.override!.harness && p.provider === request.override!.provider && p.model === request.override!.model)
			? [...g.profiles, request.override!.id] : g.profiles })),
	} : quota;
	const block = (p: RoutingProfile, overrideFit: boolean, req = request) =>
		routeBlock(p, req, availability, effectiveQuota, overrideFit);
	const reason = block(preferred, explicit);
	const result = (p: RoutingProfile, source: RouteSelection["source"], warnings: string[], fallbackOf?: string): RouteSelection => ({
		profile: structuredClone(p), source, ...(fallbackOf ? { fallbackOf } : {}), warnings,
	});
	if (!reason) {
		if (request.budgetChoice) return { ...result(preferred, "budget", ["Budget-informed choice changes preferences only; report the reason. Baseline policy was not edited."]), budgetReason: request.budgetChoice.reason };
		const warnings = explicit ? ["Explicit user choice overrides suitability and share preferences, not authorization or safety checks."] : [];
		if (preferred.fallbackOnly) warnings.push(`${preferred.id} is reserved (fallback-only): direct use is an explicit user choice, not a baseline or budget route.`);
		return result(preferred, explicit ? "explicit" : "policy", warnings);
	}
	// Do not quietly replace the model's budget judgment with a quota-blind fallback.
	if (request.budgetChoice) throw new RoutingError(`Budget choice ${preferred.id} blocked: ${reason}. Inspect and reconsider; never bypass constraints.`);
	const failures = [`${preferred.id}: ${reason}`];
	if (!explicit || request.allowFallback === true) {
		// A fallback must not drop protections requested by the original profile.
		const fallbackRequest = { ...request, risky: request.risky === true || preferred.protection !== "standard" };
		for (const id of preferred.fallbacks) {
			const fallback = config?.profiles.find(p => p.id === id);
			if (!fallback) continue;
		// fallbackOnly targets are legitimate here: that is their configured purpose.
		const why = routeBlock(fallback, fallbackRequest, availability, effectiveQuota, false, true);
			if (!why) return result(fallback, "fallback", [`Fallback from ${preferred.id}: ${reason}. Selected ${fallback.id}; report this deviation.`], preferred.id);
			failures.push(`${id}: ${why}`);
		}
	}
	throw new RoutingError(`No eligible route. ${failures.join("; ")}. Verify readiness/auth and protections, or configure an eligible fallback; never bypass approvals.`);
}

/** Same hard checks for inspect and select; quota comes from the collector, not tool inputs. */
export function routeBlock(p: RoutingProfile, r: RouteRequest, availability: readonly RouteAvailability[], quota?: QuotaReport, explicit = false, asFallback = false): string | undefined {
	return policyBlock(p, r, explicit, asFallback) ?? readinessBlock(p, r, availability) ??
		(quota?.groups.some(g => g.profiles.includes(p.id) && g.exhausted) ? "confirmed subscription quota exhausted" : undefined);
}

function policyBlock(p: RoutingProfile, r: RouteRequest, explicit: boolean, asFallback = false): string | undefined {
	if (!p.enabled) return "disabled in routing policy";
	if (!explicit && !asFallback && p.fallbackOnly) return "reserved (fallback-only): excluded from baseline and budget selection; reachable only as a configured fallback target or an explicit user choice";
	if (r.risky && p.protection === "standard") return "risky work requires Claude auto review or Codex approve-for-me protections";
	if (!explicit && p.suitability[r.difficulty] === undefined) return "unsuitable for required difficulty";
	if ((r.requiredCapabilities ?? []).some(c => !p.capabilities.includes(c))) return "required capability absent from policy hints";
	return undefined;
}
function readinessBlock(p: RoutingProfile, r: RouteRequest, observations: readonly RouteAvailability[]): string | undefined {
	const matches = observations.filter(a => a && a.harness === p.harness && a.provider === p.provider && a.model === p.model && a.protection === p.protection);
	if (matches.length !== 1) return "readiness unknown or ambiguous for exact harness/provider/model/protection";
	const a = matches[0]!;
	if (a.bypassPermissions !== false) return "permission bypass is enabled or unknown";
	if (a.available !== true) return "harness/model unavailable; verify installation and model access";
	if (a.authenticated !== true) return "authentication unavailable; log in with the selected harness/provider";
	if (!Array.isArray(a.capabilities) || (r.requiredCapabilities ?? []).some(c => !a.capabilities.includes(c))) return "required capability not verified at runtime";
	if (a.remainingQuota !== undefined && (!nonNegative(a.remainingQuota) || a.remainingQuota === 0)) return "known quota exhausted or invalid";
	return undefined;
}
function record(value: unknown, at: string, keys?: readonly string[]): Record<string, unknown> {
	check(typeof value === "object" && value !== null && !Array.isArray(value), `${at} must be an object`);
	const obj = value as Record<string, unknown>;
	if (keys) check(Object.keys(obj).every(k => keys.includes(k)), `${at} has unknown fields; credentials and executable templates are not accepted`);
	return obj;
}
function identifier(value: unknown, at: string, pattern = IDENTIFIER): void {
	check(typeof value === "string" && pattern.test(value), `${at} must be an exact identifier, not a label, glob, flag, or shell expression`);
}
function strings(value: unknown, at: string): void {
	check(Array.isArray(value), `${at} must be an array`);
	for (const item of value) identifier(item, at, LABEL);
	check(new Set(value).size === value.length, `${at} must not contain duplicates`);
}
function nonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new RoutingError(message);
}
