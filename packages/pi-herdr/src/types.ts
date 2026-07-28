/**
 * Shared types for pi-herdr.
 *
 * These are the hard cross-module contracts: every other module
 * (herdr-cli, watches, policy, render, commands, the extension) imports
 * from here. Keep this file export-only — no runtime logic.
 */

/** A watch waits on an agent, pane output, or a bounded command. */
export type WatchMode = "agent" | "output" | "command";

interface WatchSpecShared {
	note?: string; // orchestrator's reminder, echoed in the wake card
	wake: boolean; // may this watch triggerTurn an idle agent?
}

/** Wait for a herdr agent lifecycle state. */
export interface AgentWatchSpec extends WatchSpecShared {
	mode: "agent";
	target: string;
	until?: string[]; // herdr defaults if absent
	timeoutMs?: number; // passed to herdr --timeout; absent = indefinite
	match?: never;
	regex?: never;
	command?: never;
}

interface OutputWatchSpecShared extends WatchSpecShared {
	mode: "output";
	target: string;
	timeoutMs?: number; // passed to herdr --timeout; absent = indefinite
	until?: never;
	command?: never;
}

/** Wait for exactly one literal or Rust-regex condition in pane output. */
export type OutputWatchSpec = OutputWatchSpecShared &
	(
		| { match: string; regex?: never }
		| { match?: never; regex: string }
	);

/** Run a bounded POSIX-shell command and fire whenever it exits. */
export interface CommandWatchSpec extends WatchSpecShared {
	mode: "command";
	command: string;
	timeoutMs: number;
	target?: never;
	until?: never;
	match?: never;
	regex?: never;
}

/** Declarative description of one non-blocking watch. */
export type WatchSpec = AgentWatchSpec | OutputWatchSpec | CommandWatchSpec;

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
