import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelSlot, ReferenceToolName } from "./types.js";

// Per-turn timing telemetry for MoA. One JSON line is appended to the configured
// file per streamMoA turn, recording where the wall-clock went: auth, reference
// render, each reference's headers/first-token/settle, the pre-warm, and the
// aggregator's headers/first-token/done — plus token usage and cost per role.
// METADATA ONLY: no prompt or completion text ever reaches the file, so it is
// safe to share or feed to analysis. Everything here is best-effort and
// fire-and-forget — a telemetry failure must never affect the turn — and none of
// it runs unless the top-level `telemetryPath` config field is set, keeping the
// default byte-identical (no timers, no writes).
//
// The file is self-trimming: once it reaches `telemetryMaxBytes` (default 16 MB,
// 0 = unlimited), the oldest lines are dropped so the newest records that fit in
// half the cap survive. The rewrite goes through a `.tmp` sibling + atomic
// rename, so a crash mid-trim never corrupts the file. Steady-state disk usage
// stays between half the cap and the cap (+ one record).

export const DEFAULT_TELEMETRY_MAX_BYTES = 16 * 1024 * 1024;

// All times are integer milliseconds relative to the turn's start.
interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

interface ReferenceEntry {
	provider: string;
	model: string;
	startMs?: number;
	headersMs?: number;
	firstTokenMs?: number;
	settleMs?: number;
	stop?: string;
	keptChars?: number;
	usage?: UsageSnapshot;
	rounds?: number;
	toolCalls?: ReferenceToolCallSnapshot[];
	roundUsage?: ReferenceRoundUsageSnapshot[];
}

interface ReferenceToolCallSnapshot {
	round: number;
	name: ReferenceToolName;
	isError: boolean;
}

interface ReferenceRoundUsageSnapshot extends UsageSnapshot {
	round: number;
}

interface AggregatorEntry {
	requestStartMs?: number;
	headersMs?: number;
	firstTokenMs?: number;
	doneMs?: number;
	usage?: UsageSnapshot;
}

// Handed to the reference stream consumer so it can stamp request lifecycle
// moments without knowing about the collector.
export interface ReferenceTimer {
	requestStart(): void;
	headers(): void;
	firstToken(): void;
	setRounds(rounds: number): void;
	recordToolCall(info: { round: number; name: ReferenceToolName; isError: boolean }): void;
	recordRoundUsage(info: { round: number; usage: Usage }): void;
	settle(info: { stop: string; keptChars?: number; usage?: Usage }): void;
}

export interface AggregatorTimer {
	requestStart(): void;
	headers(): void;
	firstToken(): void;
	done(usage: Usage): void;
}

export class TurnTelemetry {
	private readonly t0 = performance.now();
	private readonly startedAt = new Date().toISOString();
	private readonly references: ReferenceEntry[] = [];
	private aggregator: AggregatorEntry = {};
	private outcome: "ok" | "error" | "aborted" = "ok";
	private aggregatorAuthMs?: number;
	private renderMs?: number;
	private referencePhaseMs?: number;
	private guidanceReused = false;
	private prewarm?: {
		startMs: number;
		settledMs?: number;
		blockedMs?: number;
		proceededCold?: boolean;
	};
	private placement?: string;
	private trailingFellBack = false;

	constructor(
		private readonly path: string,
		private readonly presetName: string,
		private readonly maxBytes: number,
	) {}

	private now(): number {
		return Math.round(performance.now() - this.t0);
	}

	markAggregatorAuthResolved(): void {
		this.aggregatorAuthMs = this.now();
	}

	setRenderMs(ms: number): void {
		this.renderMs = Math.round(ms);
	}

	setGuidanceReused(reused: boolean): void {
		this.guidanceReused = reused;
	}

	markReferencePhaseDone(): void {
		this.referencePhaseMs = this.now();
	}

	referenceTimer(index: number, slot: ModelSlot): ReferenceTimer {
		const entry: ReferenceEntry = {
			provider: slot.provider,
			model: slot.model,
		};
		this.references[index] = entry;
		return {
			requestStart: () => {
				entry.startMs ??= this.now();
			},
			headers: () => {
				entry.headersMs ??= this.now();
			},
			firstToken: () => {
				entry.firstTokenMs ??= this.now();
			},
			setRounds: (rounds) => {
				entry.rounds = rounds;
			},
			recordToolCall: (info) => {
				entry.toolCalls ??= [];
				entry.toolCalls.push({
					round: info.round,
					name: info.name,
					isError: info.isError,
				});
			},
			recordRoundUsage: (info) => {
				entry.roundUsage ??= [];
				entry.roundUsage.push({
					round: info.round,
					...snapshotUsage(info.usage),
				});
			},
			settle: (info) => {
				entry.settleMs = this.now();
				entry.stop = info.stop;
				entry.keptChars = info.keptChars;
				entry.usage = info.usage && snapshotUsage(info.usage);
			},
		};
	}

	markPrewarmStart(): void {
		this.prewarm = { startMs: this.now() };
	}

	markPrewarmSettled(): void {
		if (this.prewarm) {
			this.prewarm.settledMs = this.now();
		}
	}

	setPrewarmWait(blockedMs: number, proceededCold: boolean): void {
		if (this.prewarm) {
			this.prewarm.blockedMs = Math.round(blockedMs);
			this.prewarm.proceededCold = proceededCold;
		}
	}

	setPlacement(placement: string): void {
		this.placement = placement;
	}

	markTrailingFallback(): void {
		this.trailingFellBack = true;
	}

	// Each aggregator attempt (primary, and the rare system-placement fallback)
	// gets a fresh entry; the record keeps the last attempt's numbers alongside
	// the trailingFellBack flag that says a retry happened.
	aggregatorTimer(): AggregatorTimer {
		const entry: AggregatorEntry = {};
		this.aggregator = entry;
		return {
			requestStart: () => {
				entry.requestStartMs = this.now();
			},
			headers: () => {
				entry.headersMs = this.now();
			},
			firstToken: () => {
				entry.firstTokenMs = this.now();
			},
			done: (usage) => {
				entry.doneMs = this.now();
				entry.usage = snapshotUsage(usage);
			},
		};
	}

	setOutcome(outcome: "error" | "aborted"): void {
		this.outcome = outcome;
	}

	// Drop the oldest lines once the file reaches the cap, keeping the newest
	// records that fit in half the cap (so the full read/rewrite happens once per
	// half-cap of growth, not on every emit). Cut on a line boundary so no torn
	// record survives; write to a `.tmp` sibling and rename for atomicity. Any
	// failure (including the file not existing yet) is swallowed — trimming must
	// never block the append.
	private async maybeTrim(): Promise<void> {
		if (this.maxBytes <= 0) {
			return;
		}
		try {
			const { size } = await stat(this.path);
			if (size < this.maxBytes) {
				return;
			}
			const content = await readFile(this.path, "utf-8");
			const keepFrom = content.length - Math.floor(this.maxBytes / 2);
			// Advance to the start of the first complete line within the kept tail.
			const boundary = content.indexOf("\n", Math.max(keepFrom, 0));
			const kept = boundary === -1 ? "" : content.slice(boundary + 1);
			const tmpPath = `${this.path}.tmp`;
			await writeFile(tmpPath, kept);
			await rename(tmpPath, this.path);
		} catch {
			// Best-effort: a failed trim never blocks the append.
		}
	}

	private async append(line: string): Promise<void> {
		try {
			await appendFile(this.path, line);
		} catch {
			await mkdir(dirname(this.path), { recursive: true });
			await appendFile(this.path, line);
		}
	}

	// Serialize the turn record and append it, without ever surfacing a failure.
	// A missing parent directory is created on first use.
	emit(): void {
		const line = `${JSON.stringify({
			v: 1,
			ts: this.startedAt,
			preset: this.presetName,
			outcome: this.outcome,
			totalMs: this.now(),
			aggregatorAuthMs: this.aggregatorAuthMs,
			renderMs: this.renderMs,
			referencePhaseMs: this.referencePhaseMs,
			guidanceReused: this.guidanceReused,
			references: this.references.filter((entry) => entry !== undefined),
			prewarm: this.prewarm,
			placement: this.placement,
			trailingFellBack: this.trailingFellBack,
			aggregator: this.aggregator,
		})}\n`;
		void (async () => {
			await this.maybeTrim();
			await this.append(line);
		})().catch(() => {
			// Telemetry is best-effort: never let a write failure reach the turn.
		});
	}
}

export function createTurnTelemetry(
	path: string | undefined,
	presetName: string,
	maxBytes: number = DEFAULT_TELEMETRY_MAX_BYTES,
): TurnTelemetry | undefined {
	if (path === undefined) {
		return undefined;
	}
	return new TurnTelemetry(expandHome(path), presetName, maxBytes);
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function snapshotUsage(usage: Usage): UsageSnapshot {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		costUsd: usage.cost.total,
	};
}
