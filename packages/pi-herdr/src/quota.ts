import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import {
	collectQuota, finite, fingerprint, object, QUOTA_INTERVAL_MS,
	type QuotaConfig, type QuotaGroup, type QuotaSample, type QuotaWindow,
} from "./quota-source.js";

interface CacheEntry {
	attemptedAt: number;
	sample?: QuotaSample;
	previous?: QuotaSample;
	failed: boolean;
}
export interface WindowBudget extends QuotaWindow {
	applicable: boolean;
	state: "fresh" | "reset-passed";
	remainingPercent: number;
	usablePercent: number;
	remainingHours?: number;
	/** A pacing reference, not an assumed constant workload. */
	evenPaceRemainingPercent?: number;
	burnPercentPerHour?: number;
	projectedExhaustionHours?: number;
}
export interface QuotaBudget {
	id: string;
	provider: QuotaGroup["provider"];
	profiles: string[];
	state: "fresh" | "unknown" | "stale" | "unavailable";
	observedAt?: number;
	attemptedAt?: number;
	reservePercent: number;
	windows: WindowBudget[];
	missingWindows: string[];
	exhausted: boolean;
	pressure: "unknown" | "normal" | "conserve" | "surplus" | "low" | "exhausted";
	warnings: string[];
}
export interface QuotaReport {
	/** Changes with data/config, not with elapsed milliseconds. */
	snapshotId: string;
	checkedAt: number;
	groups: QuotaBudget[];
	binding: string;
}
const MAX_CACHE_BYTES = 64 * 1024;
const BINDING = "Subscription/profile bindings are explicitly configured, not inferred or verified from model names. Recheck bindings after account changes; native CLI and Pi account selection can differ.";

function readJson(path: string): unknown {
	try {
		if (statSync(path).size > MAX_CACHE_BYTES) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch { return undefined; }
}
function timestamp(value: unknown): value is number {
	return finite(value) && value >= 0 && value <= 8.64e15;
}
function sample(value: unknown): QuotaSample | undefined {
	if (!object(value) || !timestamp(value.observedAt) || !Array.isArray(value.windows) || value.windows.length > 19) return;
	if (value.accountKey !== undefined && (typeof value.accountKey !== "string" || !/^[a-f0-9]{64}$/.test(value.accountKey))) return;
	const windows: QuotaWindow[] = [];
	for (const w of value.windows) {
		if (!object(w) || typeof w.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(w.id) || windows.some(v => v.id === w.id) || !finite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return;
		if (w.resetsAt !== undefined && !timestamp(w.resetsAt)) return;
		if (w.windowMinutes !== undefined && (!finite(w.windowMinutes) || w.windowMinutes <= 0)) return;
		windows.push({ id: w.id, usedPercent: w.usedPercent, ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }), ...(w.windowMinutes === undefined ? {} : { windowMinutes: w.windowMinutes }) });
	}
	return { observedAt: value.observedAt, ...(typeof value.accountKey === "string" ? { accountKey: value.accountKey } : {}), windows };
}
function readCache(path: string): CacheEntry | undefined {
	const raw = readJson(path);
	if (!object(raw) || !timestamp(raw.attemptedAt) || typeof raw.failed !== "boolean") return;
	return { attemptedAt: raw.attemptedAt, failed: raw.failed, sample: sample(raw.sample), previous: sample(raw.previous) };
}
function atomicWrite(path: string, value: unknown): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} finally { rmSync(temp, { force: true }); }
}
function keyFor(group: QuotaGroup): string {
	// Reserve/window/profile changes do not spend another provider poll.
	return fingerprint([group.provider, group.source, group.account ?? null, process.env.CODEXBAR_CONFIG ?? null, process.env.CODEX_HOME ?? null, process.env.CLAUDE_CONFIG_DIR ?? null, process.env.PI_HERDR_CODEXBAR ?? null]);
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Advisory arithmetic. Raw observations remain visible so the model can weigh actual work. */
export function assessQuota(group: QuotaGroup, cache: CacheEntry | undefined, now: number, observedExhaustion = false): QuotaBudget {
	const current = cache?.sample;
	const fresh = current !== undefined && now >= current.observedAt - 60_000 && now - current.observedAt < QUOTA_INTERVAL_MS;
	const state: QuotaBudget["state"] = cache?.failed ? "unavailable" : !current ? "unknown" : fresh ? "fresh" : "stale";
	const reserve = group.reservePercent ?? 0;
	const applicableIds = group.windows ?? ["primary", "secondary"];
	const windows = (current?.windows ?? []).map((w): WindowBudget => {
		const resetFuture = w.resetsAt !== undefined && w.resetsAt > now;
		const remainingPercent = 100 - w.usedPercent;
		const usablePercent = Math.max(0, remainingPercent - reserve);
		const remainingHours = resetFuture ? (w.resetsAt! - now) / 3_600_000 : undefined;
		const previous = cache?.previous;
		const previousWindow = previous?.windows.find(v => v.id === w.id);
		const elapsed = previous && current ? (current.observedAt - previous.observedAt) / 3_600_000 : 0;
		// No extrapolation across resets, accounts, missing identities or long sampling gaps.
		const comparable = current?.accountKey && current.accountKey === previous?.accountKey && elapsed >= 0.1 && elapsed <= 2 && previousWindow?.resetsAt !== undefined && previousWindow.resetsAt === w.resetsAt && w.usedPercent >= previousWindow.usedPercent;
		const burn = comparable ? (w.usedPercent - previousWindow!.usedPercent) / elapsed : undefined;
		return { ...w, applicable: applicableIds.includes(w.id), state: w.resetsAt !== undefined && !resetFuture ? "reset-passed" : "fresh", remainingPercent, usablePercent,
			...(remainingHours === undefined ? {} : { remainingHours }),
			...(remainingHours !== undefined && w.windowMinutes ? { evenPaceRemainingPercent: Math.min(100, remainingHours * 60 / w.windowMinutes * 100) } : {}),
			...(burn === undefined ? {} : { burnPercentPerHour: burn, ...(burn > 0 ? { projectedExhaustionHours: usablePercent / burn } : {}) }),
		};
	});
	const applicable = state === "fresh" ? windows.filter(w => w.applicable && w.state === "fresh") : [];
	const exhausted = observedExhaustion || applicable.some(w => w.usedPercent === 100);
	let pressure: QuotaBudget["pressure"] = applicable.length ? "normal" : "unknown";
	if (exhausted) pressure = "exhausted";
	else if (applicable.some(w => w.usablePercent <= 10)) pressure = "low";
	else if (applicable.some(w => (w.evenPaceRemainingPercent !== undefined && w.usablePercent + 10 < w.evenPaceRemainingPercent) || (w.projectedExhaustionHours !== undefined && w.remainingHours !== undefined && w.projectedExhaustionHours < w.remainingHours))) pressure = "conserve";
	else if (applicable.some(w => w.evenPaceRemainingPercent !== undefined && w.usablePercent > w.evenPaceRemainingPercent + 10)) pressure = "surplus";
	const warnings: string[] = [];
	if (["low", "conserve", "exhausted"].includes(pressure)) warnings.push(`${group.id}: ${pressure}; preserve orchestration capacity, shift suitable work, and tell the user if alternatives are constrained. Do not buy or enable another provider automatically.`);
	if (state !== "fresh") warnings.push(`${group.id}: quota ${state}; check CodexBar authentication/source. Last readings are historical, not routing evidence.`);
	if (windows.some(w => w.applicable && w.state === "reset-passed")) warnings.push(`${group.id}: reset passed; allowance unknown until the next scheduled check.`);
	return { id: group.id, provider: group.provider, profiles: [...group.profiles], state, ...(current ? { observedAt: current.observedAt } : {}), ...(cache ? { attemptedAt: cache.attemptedAt } : {}), reservePercent: reserve, windows, missingWindows: applicableIds.filter(id => !windows.some(w => w.id === id && w.state === "fresh")), exhausted, pressure, warnings };
}

export class QuotaMonitor {
	private timer?: NodeJS.Timeout;
	private controller?: AbortController;
	private pending?: Promise<QuotaReport>;
	private readonly dir: string;
	constructor(private readonly options: {
		agentDir: string;
		config: () => QuotaConfig | undefined;
		onUpdate?: (report: QuotaReport) => void;
		collect?: typeof collectQuota;
		now?: () => number;
	}) { this.dir = join(options.agentDir, "herdr-quota-cache"); }
	private now(): number { return (this.options.now ?? Date.now)(); }
	private groups(): QuotaGroup[] {
		try { return this.options.config()?.groups ?? []; } catch { return []; }
	}
	private cachePath(g: QuotaGroup): string { return join(this.dir, `${keyFor(g)}.json`); }
	private exhaustionPath(g: QuotaGroup): string { return join(this.dir, `${keyFor(g)}.exhausted.json`); }
	private isExhausted(g: QuotaGroup, cache: CacheEntry | undefined, now: number): boolean {
		const marker = readJson(this.exhaustionPath(g));
		return object(marker) && finite(marker.at) && finite(marker.until) && marker.at <= now && marker.until > now && !(cache?.sample && !cache.failed && cache.sample.observedAt > marker.at && cache.sample.accountKey === marker.accountKey);
	}
	read(): QuotaReport {
		const now = this.now();
		const groups = this.groups().map(g => {
			const cache = readCache(this.cachePath(g));
			return assessQuota(g, cache, now, this.isExhausted(g, cache, now));
		});
		return { snapshotId: fingerprint([this.groups().map(keyFor), groups.map(g => [g.id, g.profiles, g.state, g.observedAt, g.attemptedAt, g.exhausted, g.reservePercent, g.windows.map(w => [w.id, w.usedPercent, w.resetsAt, w.applicable, w.state])])]), checkedAt: now, groups, binding: BINDING };
	}
	start(): void {
		if (this.controller) return;
		this.controller = new AbortController();
		void this.refresh();
		this.timer = setInterval(() => { void this.refresh(); }, QUOTA_INTERVAL_MS);
		this.timer.unref();
	}
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.controller?.abort();
		this.controller = undefined;
	}
	/** Cache-coalesced: inspect/select never forces extra provider requests. */
	async refresh(): Promise<QuotaReport> {
		if (!this.controller) return this.read();
		if (this.pending) return this.pending;
		const controller = this.controller;
		const work = async (): Promise<QuotaReport> => {
			await Promise.all(this.groups().map(group => this.refreshGroup(group, controller.signal)));
			const report = this.read();
			if (!controller.signal.aborted && this.controller === controller) this.options.onUpdate?.(report);
			return report;
		};
		this.pending = work().catch(() => this.read()).finally(() => { this.pending = undefined; });
		return this.pending;
	}
	private async refreshGroup(group: QuotaGroup, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		const path = this.cachePath(group);
		const recent = (entry: CacheEntry | undefined) => entry && this.now() >= entry.attemptedAt && this.now() - entry.attemptedAt < QUOTA_INTERVAL_MS;
		if (recent(readCache(path))) return;
		const lock = `${path}.lock`;
		const ownerName = `${process.pid}.${randomUUID()}`;
		const ownerPath = join(lock, ownerName);
		const ownsLock = (): boolean => {
			try { const names = readdirSync(lock); return names.length === 1 && names[0] === ownerName; }
			catch { return false; }
		};
		let locked = false;
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			try {
				mkdirSync(lock, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
				// A contender returns cached/unknown data while another process refreshes;
				// never block an orchestrator on another process's lifetime.
				const names = readdirSync(lock);
				if (this.now() - statSync(lock).mtimeMs < 120_000 || names.length > 1) return;
				if (names.length === 1) {
					const match = /^(\d+)\.[a-f0-9-]{36}$/.exec(names[0]!);
					if (!match || alive(Number(match[1]))) return;
					// Unique owner filenames + non-recursive rmdir cannot delete a new
					// owner's lock if concurrent crash recovery wins the race.
					rmSync(join(lock, names[0]!), { force: true });
				}
				rmdirSync(lock);
				mkdirSync(lock, { mode: 0o700 });
			}
			writeFileSync(ownerPath, "", { mode: 0o600, flag: "wx" });
			locked = true;
			if (!ownsLock()) return;
			const old = readCache(path);
			if (recent(old)) return;
			const attemptedAt = this.now();
			// Persist the cooldown before I/O, including across a crashed CLI/process.
			atomicWrite(path, { ...old, attemptedAt, failed: true });
			try {
				const result = await (this.options.collect ?? collectQuota)(group, signal);
				if (signal.aborted || !ownsLock()) return;
				atomicWrite(path, { attemptedAt, sample: result, previous: old?.sample, failed: false });
			} catch { /* Cooldown and old observation retained; never log raw diagnostics. */ }
		} catch { /* Cache/CLI failure is unknown, not a routing failure. */ }
		finally {
			if (locked) {
				try { rmSync(ownerPath, { force: true }); rmdirSync(lock); }
				catch { /* Never remove another owner or override a collection result. */ }
			}
		}
	}
	/** Only confirmed subscription exhaustion, not generic rate limiting. No extra poll. */
	reportExhausted(profileId: string): void {
		const group = this.groups().find(g => g.profiles.includes(profileId));
		if (!group) throw new Error("No quota group configured for this profile");
		const now = this.now();
		const applicable = group.windows ?? ["primary", "secondary"];
		const futureResets = (readCache(this.cachePath(group))?.sample?.windows ?? []).filter(w => applicable.includes(w.id) && w.resetsAt !== undefined && w.resetsAt > now).map(w => w.resetsAt!);
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const accountKey = readCache(this.cachePath(group))?.sample?.accountKey;
		atomicWrite(this.exhaustionPath(group), { at: now, until: Math.min(now + QUOTA_INTERVAL_MS, ...futureResets), ...(accountKey ? { accountKey } : {}) });
		this.options.onUpdate?.(this.read());
	}
}

export function quotaSummary(report: QuotaReport): string {
	if (!report.groups.length) return "Quota monitoring is not configured; no live subscription data. See docs/QUOTA.md.";
	return report.groups.map(g => {
		const windows = g.windows.filter(w => w.applicable).map(w => `${w.id} ${Math.round(w.remainingPercent)}% left${w.resetsAt === undefined ? ", reset unknown" : `, reset ${new Date(w.resetsAt).toISOString()}`}${w.state === "reset-passed" ? " (historical)" : ""}`).join("; ");
		return `${g.id}: ${g.state}, ${g.pressure}; ${windows || "allowance unknown"}; reserve ${g.reservePercent}%; observed ${g.observedAt ? new Date(g.observedAt).toISOString() : "never"}${g.missingWindows.length ? `; missing ${g.missingWindows.join(",")}` : ""}`;
	}).join("\n");
}
