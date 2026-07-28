# pi-herdr build — COMMON BRIEF (read this first, then your own brief)

You are one of several agents building `@season179/pi-herdr` in parallel.
Follow this brief exactly. Where your judgment conflicts with a contract
here, follow the contract and flag the conflict in your final message.

## What pi-herdr is

A pi extension that lets a pi agent running INSIDE herdr (the terminal
agent multiplexer) register **non-blocking watches** on other agents/panes
and get **woken** when they fire. Full design: `HERDR.md` at the repo
root — read §4 (decisions), §5 (tool contract), §6 (steering) before
coding. herdr CLI reference: `~/.pi/agent/skills/herdr/SKILL.md`.

## Repo conventions

- Monorepo: `/Users/season/Personal/pi-ecosystem`, npm workspaces,
  TypeScript ESM (`"type": "module"`), Node >= 22.
- Root devDependencies already provide `typescript`, `vitest`,
  `@types/node`, `@earendil-works/pi-coding-agent` — do NOT add deps.
- Build: `npm run build -w @season179/pi-herdr`
  Test: `npx vitest run packages/pi-herdr` (from repo root).
- Style: mirror `packages/pi-worktree` and `packages/pi-buddy`. Tabs,
  double quotes, no default exports except the extension entry.
- Imports between our own files use `.js` extensions (ESM).
- **FORBIDDEN: do not read, reference, or copy anything from
  `packages/pi-delegate`.** It is a retired failed experiment.
- Tool/extension API reference:
  `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and
  `node_modules/@earendil-works/pi-coding-agent/examples/extensions/`
  (`todo.ts` for registerTool+TypeBox, `file-trigger.ts` for
  sendMessage, `truncated-tool.ts` for output truncation).

## File ownership (hard rule)

You may create/modify ONLY the files listed in YOUR brief. Other agents
own the rest concurrently. If you need a change in someone else's file,
say so in your final message instead of editing it.

## Shared contracts (exact exported signatures)

`src/types.ts` (owner: scaffold):

```typescript
export type WatchMode = "agent" | "output";

export interface WatchSpec {
	target: string;            // agent name or pane id
	mode: WatchMode;
	until?: string[];          // agent mode only; herdr defaults if absent
	match?: string;            // output mode: literal substring
	regex?: string;            // output mode: Rust regex (mutually exclusive with match)
	timeoutMs?: number;        // passed to herdr --timeout; absent = indefinite
	note?: string;             // orchestrator's reminder, echoed in the wake card
	wake: boolean;             // may this watch triggerTurn an idle agent?
}

export type WatchStatus = "armed" | "fired" | "stopped";

export interface WatchRecordPublic {
	id: number;
	spec: WatchSpec;
	startedAt: number;         // epoch ms
	status: WatchStatus;
}

export type OutcomeKind = "fired" | "timeout" | "killed" | "error";

export interface WatchOutcome {
	kind: OutcomeKind;
	exitCode: number | null;
	durationMs: number;
	stdout: string;            // raw CLI stdout (may be JSON)
	stderr: string;
	json?: unknown;            // parsed stdout JSON when parseable
	errorJson?: unknown;       // parsed stderr JSON when parseable
}

export interface HerdrConfig {
	maxWatches: number;        // default 8
	wakeBudget: number;        // default 20; 0 disables auto-wake
	includeTailLines: number;  // default 20; 0 disables tail fetch
	toastOn: string[];         // default ["blocked"]
	telemetryPath: string;     // default "~/.pi/agent/herdr-telemetry.jsonl", "" disables
}

export class ConfigError extends Error {}
```

`src/config.ts` (owner: scaffold):

```typescript
export const DEFAULT_CONFIG: HerdrConfig;
export function loadHerdrConfig(agentDir: string): HerdrConfig;
// reads <agentDir>/herdr.json if present; missing file => defaults.
// Unknown keys or wrong types => throw ConfigError with a message that
// names the bad key. Expand leading "~/" in telemetryPath to os.homedir().
```

`src/telemetry.ts` (owner: scaffold):

```typescript
export function appendTelemetry(path: string, record: Record<string, unknown>): void;
// no-op when path is "". mkdir -p the dirname, append one JSON line.
// MUST never throw (swallow all errors).
```

`src/herdr-cli.ts` (owner: core):

```typescript
export interface CliResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	json?: unknown;        // stdout parsed as JSON when parseable
	errorJson?: unknown;   // stderr parsed as JSON when parseable
}
export function herdrCommand(): string; // process.env.PI_HERDR_COMMAND ?? "herdr"
export function runHerdr(args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CliResult>;
// spawn(herdrCommand(), args, { shell: false }). Cap captured stdout and
// stderr at 1 MiB each (keep the tail). timeoutMs default 30000: on
// expiry kill the child and resolve with what was captured.
```

`src/watches.ts` (owner: core):

```typescript
export class CapacityError extends Error {}
export interface WatchManagerOptions {
	maxWatches: number;
	command?: string;      // default herdrCommand()
	onOutcome: (record: WatchRecordPublic, outcome: WatchOutcome) => void;
	// called on EVERY child close, including kills; record.status is
	// already updated ("fired" for natural close, "stopped" for
	// stop()/shutdown()) before the callback runs.
}
export function buildWatchArgs(spec: WatchSpec): string[]; // pure, exported for tests
export class WatchManager {
	constructor(opts: WatchManagerOptions);
	start(spec: WatchSpec): WatchRecordPublic;    // throws CapacityError when full
	stop(id: number | "all"): Promise<WatchRecordPublic[]>; // resolves when children closed
	list(): WatchRecordPublic[];                  // armed first, then by id
	get(id: number): WatchRecordPublic | undefined;
	shutdown(): Promise<void>;                    // stop("all"), idempotent
}
```

`src/policy.ts` (owner: ext):

```typescript
export interface DeliveryDecision {
	deliverAs: "steer";
	triggerTurn: boolean;
	countsAsWake: boolean; // true only when triggerTurn fires while agent is idle
}
export function decideDelivery(input: { wake: boolean; agentBusy: boolean; wakesUsed: number; wakeBudget: number }): DeliveryDecision;
```

`src/render.ts` (owner: ui):

```typescript
export function formatWatchCard(record: WatchRecordPublic, outcome: WatchOutcome, tail?: string): string;
export function formatWatchLine(record: WatchRecordPublic, nowMs: number): string;   // one line for lists
export function formatStatusChip(armedCount: number): string | undefined;            // undefined when 0
```

`src/commands.ts` (owner: ui):

```typescript
export interface WatchCommandDeps {
	list(): WatchRecordPublic[];
	stop(id: number | "all"): Promise<WatchRecordPublic[]>;
}
export function registerWatchesCommand(pi: ExtensionAPI, deps: WatchCommandDeps): void;
```

`src/extensions/herdr.ts` (owner: ext): default-export extension factory
wiring everything together.

## Definition of done (every worker)

1. `npm run build -w @season179/pi-herdr` exits 0.
   (Until the scaffold lands, `npx tsc --noEmit` on your files is enough —
   note it in your final message if you couldn't run the full build.)
2. `npx vitest run packages/pi-herdr/test/<your test files>` green.
3. Final message: files created, contract deviations (if any), anything
   you need from another worker. Keep it under 30 lines.
