import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelSlot } from "./types.js";

// Per-turn timing telemetry for MoA. One JSON line is appended to the configured
// file per streamMoA turn, recording where the wall-clock went: auth, reference
// render, each reference's headers/first-token/settle, the pre-warm, and the
// aggregator's headers/first-token/done — plus token usage and cost per role.
// METADATA ONLY: no prompt or completion text ever reaches the file, so it is
// safe to share or feed to analysis. Everything here is best-effort and
// fire-and-forget — a telemetry failure must never affect the turn — and none of
// it runs unless the top-level `telemetryPath` config field is set, keeping the
// default byte-identical (no timers, no writes).

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
				entry.startMs = this.now();
			},
			headers: () => {
				entry.headersMs = this.now();
			},
			firstToken: () => {
				entry.firstTokenMs = this.now();
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
		void appendFile(this.path, line).catch(async () => {
			try {
				await mkdir(dirname(this.path), { recursive: true });
				await appendFile(this.path, line);
			} catch {
				// Telemetry is best-effort: never let a write failure reach the turn.
			}
		});
	}
}

export function createTurnTelemetry(
	path: string | undefined,
	presetName: string,
): TurnTelemetry | undefined {
	if (path === undefined) {
		return undefined;
	}
	return new TurnTelemetry(expandHome(path), presetName);
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
