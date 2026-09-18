import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export interface QuotaGroup {
	id: string;
	provider: "codex" | "claude" | "zai";
	source: "oauth" | "cli" | "web" | "api";
	/** Explicit CodexBar account selector, never a credential. */
	account?: string;
	profiles: string[];
	/** Primary/secondary by default. Extras and model-specific limits require mapping. */
	windows?: string[];
	/** Percentage points kept for orchestration; advisory, not a hard block. */
	reservePercent?: number;
}
export interface QuotaConfig { groups: QuotaGroup[] }
export interface QuotaWindow {
	id: string;
	usedPercent: number;
	resetsAt?: number;
	windowMinutes?: number;
}
export interface QuotaSample {
	observedAt: number;
	/** Opaque identity for detecting account changes, not authentication proof. */
	accountKey?: string;
	windows: QuotaWindow[];
}
export const QUOTA_INTERVAL_MS = 30 * 60_000;
export const QUOTA_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
export function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Strict opt-in configuration. No URLs, credentials, argv or executable templates. */
export function validateQuotaConfig(value: unknown, profileIds: readonly string[]): asserts value is QuotaConfig {
	const check = (ok: unknown, message: string): void => { if (!ok) throw new Error(`quota: ${message}`); };
	check(object(value) && Object.keys(value).every(k => k === "groups"), "expected groups only");
	const groups = (value as QuotaConfig).groups;
	check(Array.isArray(groups) && groups.length > 0 && groups.length <= 16, "groups must contain 1–16 entries");
	const ids = new Set<string>();
	const mapped = new Set<string>();
	for (const group of groups) {
		check(object(group) && Object.keys(group).every(k => ["id", "provider", "source", "account", "profiles", "windows", "reservePercent"].includes(k)), "unknown group fields");
		check(typeof group.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(group.id) && !ids.has(group.id), "invalid or duplicate group id");
		ids.add(group.id);
		check(["codex", "claude", "zai"].includes(group.provider), "provider must be codex, claude or zai");
		check((group.provider === "zai" ? ["api"] : ["oauth", "cli", "web"]).includes(group.source), "source not supported by provider");
		check(group.account === undefined || (typeof group.account === "string" && group.account.trim().length > 0 && group.account.length <= 200 && !/[\x00-\x1f\x7f]/.test(group.account) && !group.account.startsWith("-")), "invalid account selector");
		check(Array.isArray(group.profiles) && group.profiles.length > 0, "profiles required");
		for (const id of group.profiles) {
			check(profileIds.includes(id) && !mapped.has(id), "profiles must name unique configured routes (one group per profile)");
			mapped.add(id);
		}
		check(group.windows === undefined || (Array.isArray(group.windows) && group.windows.length > 0 && group.windows.length <= 16 && new Set(group.windows).size === group.windows.length && group.windows.every(w => typeof w === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(w))), "invalid window IDs");
		check(group.reservePercent === undefined || (finite(group.reservePercent) && group.reservePercent >= 0 && group.reservePercent < 100), "reservePercent must be in [0,100)");
	}
}

/** Allowlisted fields only. Malformed/unavailable windows never mean unused allowance. */
export function parseCodexBar(value: unknown, group: QuotaGroup, now: number): QuotaSample {
	if (!Array.isArray(value)) throw new Error("invalid-response");
	const rows = value.filter(r => object(r) && r.provider === group.provider);
	if (rows.length !== 1 || !object(rows[0]) || rows[0].error || !object(rows[0].usage)) throw new Error("unavailable");
	const row = rows[0];
	const usage = row.usage as Record<string, unknown>;
	const observedAt = typeof usage.updatedAt === "string" ? Date.parse(usage.updatedAt) : NaN;
	if (!Number.isFinite(observedAt) || observedAt > now + 60_000 || now - observedAt >= QUOTA_INTERVAL_MS) throw new Error("stale-response");
	const windows: QuotaWindow[] = [];
	const add = (id: string, raw: unknown): void => {
		if (!object(raw) || !finite(raw.usedPercent) || raw.usedPercent < 0 || raw.usedPercent > 100) return;
		const reset = typeof raw.resetsAt === "string" ? Date.parse(raw.resetsAt) : NaN;
		windows.push({ id, usedPercent: raw.usedPercent,
			...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
			...(finite(raw.windowMinutes) && raw.windowMinutes > 0 ? { windowMinutes: raw.windowMinutes } : {}),
		});
	};
	for (const id of ["primary", "secondary", "tertiary"]) add(id, usage[id]);
	if (Array.isArray(usage.extraRateWindows)) {
		for (const extra of usage.extraRateWindows.slice(0, 16)) {
			if (object(extra) && typeof extra.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(extra.id) && !windows.some(w => w.id === extra.id)) add(extra.id, extra.window);
		}
	}
	if (!windows.length) throw new Error("no-windows");
	const identity = object(usage.identity) ? usage.identity : {};
	const account = typeof identity.accountEmail === "string" ? identity.accountEmail : typeof usage.accountEmail === "string" ? usage.accountEmail : typeof row.account === "string" ? row.account : undefined;
	return { observedAt, ...(account ? { accountKey: fingerprint([group.provider, account]) } : {}), windows };
}

export function codexBarCommand(): string {
	if (process.env.PI_HERDR_CODEXBAR) return process.env.PI_HERDR_CODEXBAR;
	const app = "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI";
	return process.platform === "darwin" && existsSync(app) ? app : "codexbar";
}

/** Bounded process group; no shell, raw diagnostics or credential access in Herdr. */
export async function collectQuota(group: QuotaGroup, signal: AbortSignal): Promise<QuotaSample> {
	const args = ["usage", "--provider", group.provider, "--source", group.source, "--format", "json", "--json-only", "--web-timeout", "15"];
	if (group.account) args.push("--account", group.account);
	const raw = await new Promise<string>((resolve, reject) => {
		if (signal.aborted) { reject(new Error("cancelled")); return; }
		const child = spawn(codexBarCommand(), args, { shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
		let output = "";
		let bytes = 0;
		let settled = false;
		const kill = (): void => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* Already exited. */ }
		};
		const finish = (error?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (error) { kill(); reject(new Error(error)); } else resolve(output);
		};
		const abort = (): void => finish("cancelled");
		const timer = setTimeout(() => finish("timeout"), QUOTA_TIMEOUT_MS);
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > MAX_OUTPUT_BYTES) finish("oversized-response");
			else output += chunk;
		});
		child.on("error", () => finish("cli-unavailable"));
		child.on("close", code => finish(code === 0 ? undefined : "provider-unavailable"));
		if (signal.aborted) abort();
	});
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new Error("invalid-response"); }
	return parseCodexBar(value, group, Date.now());
}
