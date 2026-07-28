/**
 * Shared types for pi-herdr.
 *
 * These are the hard cross-worker contracts: every other module
 * (herdr-cli, watches, policy, render, commands, the extension) imports
 * from here. Keep this file export-only — no runtime logic, no extra
 * exports beyond what the contract in briefs/COMMON.md lists.
 */

/** A watch either waits on an agent's lifecycle or on a pane's output. */
export type WatchMode = "agent" | "output";

/**
 * Declarative description of one non-blocking watch. Built from
 * `herdr_watch` tool input and turned into CLI args by `buildWatchArgs`.
 */
export interface WatchSpec {
	target: string; // agent name or pane id
	mode: WatchMode;
	until?: string[]; // agent mode only; herdr defaults if absent
	match?: string; // output mode: literal substring
	regex?: string; // output mode: Rust regex (mutually exclusive with match)
	timeoutMs?: number; // passed to herdr --timeout; absent = indefinite
	note?: string; // orchestrator's reminder, echoed in the wake card
	wake: boolean; // may this watch triggerTurn an idle agent?
}

/** Lifecycle of a watch record as seen by the orchestrator. */
export type WatchStatus = "armed" | "fired" | "stopped";

/**
 * The public, immutable view of a watch (no handles to the child process).
 * Handed to renderers, commands, and the delivery policy.
 */
export interface WatchRecordPublic {
	id: number;
	spec: WatchSpec;
	startedAt: number; // epoch ms
	status: WatchStatus;
}

/** Why a watch's child exited: natural fire, timeout, kill, or error. */
export type OutcomeKind = "fired" | "timeout" | "killed" | "error";

/**
 * Result of a watch's child process closing. `onOutcome` receives this for
 * every close, including kills. `json`/`errorJson` are parsed when the CLI
 * emitted JSON so downstream code never re-parses.
 */
export interface WatchOutcome {
	kind: OutcomeKind;
	exitCode: number | null;
	durationMs: number;
	stdout: string; // raw CLI stdout (may be JSON)
	stderr: string;
	json?: unknown; // parsed stdout JSON when parseable
	errorJson?: unknown; // parsed stderr JSON when parseable
}

/**
 * Optional `~/.pi/agent/herdr.json` contents, with code defaults. Unknown
 * keys or wrong types are rejected loudly via `ConfigError`.
 */
export interface HerdrConfig {
	maxWatches: number; // default 8
	wakeBudget: number; // default 20; 0 disables auto-wake
	includeTailLines: number; // default 20; 0 disables tail fetch
	toastOn: string[]; // default ["blocked"]
	telemetryPath: string; // default "~/.pi/agent/herdr-telemetry.jsonl", "" disables
}

/** Thrown by `loadHerdrConfig` for unknown keys, wrong types, or bad JSON. */
export class ConfigError extends Error {}
