# pi-delegate: Orchestrator → Cheap-Worker Delegation (RETIRED)

Date: 2026-07-03 (retired 2026-07-28)
Status: **FAILED EXPERIMENT — RETIRED** (Season's verdict, 2026-07-28).
Reference-only, same standing as `TROIKA.md`.

> **Note to agents:** do not build on this design, load this package,
> refer to or copy its code, or propose orchestrator→cheap-worker
> delegation revivals (Season, 2026-07-28). It was built (M1–M3),
> dogfooded, and judged a failure. The package was never published to npm
> and is not installed in `~/.pi`; it remains in-tree only as a historical
> record and can be deleted at any time (git history keeps everything).
>
> **Why it failed** (Season, 2026-07-28): superseded by better tooling.
> Agent-multiplexer/ADE environments — herdr, Orca ADE — let pi delegate to
> *visible, managed* agents (real panes, lifecycle detection, human can
> watch and intervene) better than this extension's invisible headless
> worker subprocesses ever could. The goal lives on; this mechanism lost.
> Successor: `packages/pi-herdr` (see its `docs/DESIGN.md`).

## What it was

A `delegate` tool for the main pi agent: hand a well-scoped brief to a
cheap worker model (`zai/glm-5.2`) running as a headless `pi` subprocess,
with a git checkpoint before each run, a harness-run `verify` command
(mechanical verdict, never the worker's claim), a compact result contract
(no full diffs), and JSONL telemetry. A cost play: move tool-loop churn
onto a flat-rate model, keep the orchestrator's context small.

## Lessons worth keeping

- **Mechanical verification**: acceptance = harness-run command exit code,
  never the worker's self-report. (Carried from troika; carried on to
  pi-herdr's read-economy rule.)
- **Anti-retry-spiral rail**: max 2 delegations per task, then take over
  yourself — without it, bad days cost more than no delegation.
- **Context field is the classic delegation failure**: workers see no
  session history; the brief must carry conversation-derived constraints.
- **Kill paths**: `proc.killed` only records that a signal was *sent* —
  escalation must key on the actual close event; kill the process group so
  tool children die too. (Re-applied verbatim in pi-herdr's WatchManager.)
- **No recursive delegation**: a worker-marker env var guard, after a smoke
  harness bug fork-bombed ~1300 processes.

The full spec (tool contract, execution flow, steering, 2026-07-11
hardening addendum) is in git history — last full version at commit
`f5b0d80`.
