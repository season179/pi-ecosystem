# pi-herdr design: Async Watches so Pi Can Orchestrate Inside Herdr

Created 2026-07-28 (condensed from the root-level HERDR.md draft after
M1–M3 shipped; full original in git history at commit `f5b0d80`). Last
source/package audit: 2026-08-23. This is design and decision history, not a
current Herdr CLI reference. The v1 implementation exists and its automated
suite passes 94 tests on macOS; retained live evidence covers selected paths,
not the entire surface. See **Status and evidence** below.

## The idea

[herdr](https://github.com/season179/herdr) is an agent multiplexer:
workspaces → tabs → panes, recognized coding agents (pi included),
semantic lifecycle states
(`idle | working | blocked | done | unknown`), all exposed to agents via
the `herdr` CLI / socket API plus a SKILL.md teaching its use.

pi can already do every synchronous orchestration step through bash +
that skill: split panes, `agent start`, `agent prompt`, `agent read`.
The one missing primitive is what Claude Code gets from background
shells: a **non-blocking wait**. A bash `herdr agent wait` or long-running
CI command keeps Pi's turn open — no parallelism across workers and no
conversation with Season until the child returns. The waiting child generates
no model tokens, but orchestration remains blocked end to end. pi-herdr adds
that missing half: watches on Herdr events and bounded, model-initiated
commands that can request a new Pi turn via
`pi.sendMessage(..., { triggerTurn })`.

Division of labor, deliberately lopsided:

- **herdr owns**: worker processes (visible panes Season can watch and
  grab), agent detection, lifecycle states, waits with occupant pinning
  and stall detection, output reads, worktrees, focus/UX.
- **pi-herdr owns**: registering watches, bounded command-watch children,
  waking pi with a compact event card, steering the orchestration loop.
- **bash + SKILL.md own**: every synchronous herdr operation. We wrap
  nothing that already works; command mode exists only for work that must
  finish asynchronously and wake the orchestrator.

Current compatibility check (Herdr 0.8.2, protocol 20): managed pane
processes receive `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`;
`agent wait` is server-owned, event-driven, and pins the resolved occupant;
`pane wait-output` searches the selected existing snapshot immediately; and
the API still exposes `events.subscribe`. v1 gates registration only on
`HERDR_ENV` plus `HERDR_PANE_ID`, invokes `herdr` from `PATH`, and depends on
the CLI contracts for waits, reads, and notifications. It does not open
`HERDR_SOCKET_PATH` directly; `events.subscribe` remains a v2 candidate.

Herdr's current agent instructions are available dynamically through
`herdr --skill`; no static Herdr skill was installed on the audited machine.
The Herdr-managed Pi integration is the separate outbound half and reported
`pi: current (v8)` during the 2026-08-23 audit.

## Decisions

1. **Inbound bridge only; wrap nothing synchronous.** Current Herdr
   instructions come from the harness context or `herdr --skill`. The
   extension does not wrap synchronous Herdr operations; its model-facing
   surface is one promotion tool plus watch management. Smaller surface,
   less drift when Herdr's CLI evolves.
2. **v1 watch mechanism: one child per watch** — spawn
   `herdr agent wait`/`pane wait-output` for Herdr targets, or fixed
   `/bin/sh -c` for a bounded command, then react to its exit. The CLI owns
   target resolution, occupant pinning, stall detection, and settled-state
   defaults. WatchManager owns command timeouts and the shared
   SIGTERM→grace→SIGKILL lifecycle. The design assumes few concurrent
   children; the configurable default capacity is 8 armed watches, while
   completed/stopped records remain in session history. A persistent
   `events.subscribe` connection remains the v2 candidate for Herdr-backed
   watches.
3. **Wake-on-fire by default, with a consecutive unattended-wake
   budget.** Every card uses `deliverAs: "steer"`. For a wake-enabled
   delivery with positive budget remaining, `triggerTurn` is requested; Pi
   starts a turn when idle and treats the same delivery as steering when busy.
   The counter increments only for granted deliveries decided while Pi is
   idle; deliveries decided while Pi is busy do not increment it. The
   default is 20 and resets at session start or the next `interactive`/`rpc`
   input (an attendance epoch). One-shot watches and explicit re-arming are
   the primary anti-loop property. At positive-budget exhaustion, cards stay
   visible without starting an idle turn, and the first suppressed idle wake
   in the epoch requests a best-effort Herdr notification. Budget zero
   disables automatic idle wakes, not card delivery.
4. **Watches survive Esc.** Watch children are not connected to the current
   turn's `ctx.signal`. WatchManager owns timeout, stop, and close directly.
   Explicit stop, orchestrator demotion, session replacement/shutdown, or a
   command timeout sends SIGTERM to the process group and escalates to
   SIGKILL after the grace period.
5. **Dormant outside herdr — and dormant in workers until promoted.**
   Factory registers nothing without `HERDR_ENV=1` + `HERDR_PANE_ID`.
   Inside herdr the watch tools start **inactive**: pi also runs as
   workers/planner/reviewer in panes, and herdr stamps every pane with
   the same env. Orchestrator-ness matches Season's actual workflow —
   you *ask* an agent to be the orchestrator, mid-conversation — via
   runtime promotion (dynamic-tool API, additive `setActiveTools`
   during tool execution):
   - `herdr_orchestrate` — the only always-active tool; its description
     says to call it only when the user explicitly asks. Calling it
     activates `herdr_watch`/`herdr_unwatch`/`herdr_watches`.
   - `PI_HERDR_ORCHESTRATOR=1` auto-promotes at launch (scripted
     starts); `/orchestrate` promotes by hand, `/orchestrate off`
     demotes and stops all armed watches.
   Promotion persists across Pi session changes in the same process until
   `/orchestrate off`; demotion stops armed watches and removes the watch
   tools. Process exit also clears it. Accepted residual risk: a worker whose
   prompt suggests orchestration could self-promote — "being asked" is
   precisely what defines the orchestrator here.
6. **Event card is compact; evidence stays in Herdr.** Cards contain a
   bounded target/command summary, outcome, elapsed time, optional note, and
   available evidence. Successful agent watches optionally fetch
   `includeTailLines` through `agent read --source recent-unwrapped`, capped
   at 20 rendered lines. Command outcomes always attach the last 10 combined
   stdout/stderr lines. Command text/output is omitted from JSONL telemetry,
   but a 60-character command summary and output tail appear in the persisted
   session card; secrets do not belong there. Output-card parsing covers Herdr
   0.8.2's `result.matched_line` field in unit tests, but remains unverified
   against a live 0.8.2 process. The read-economy rule remains: re-reading
   every worker transcript erases the context savings.
7. **Tell the human too:** a successfully fired agent watch can request a
   best-effort Herdr notification when its state appears in `toastOn`
   (default `blocked`).
8. **Anti-poll + anti-block steering** in the tool descriptions: never
   run `herdr agent wait` or `--wait` prompts through bash; prompt
   without `--wait`, then `herdr_watch`. Prefer command mode for CI,
   builds, and deploys so completion and the exit code require neither a
   pane nor a model-authored sentinel.
9. **Pi extension, not a herdr plugin.** Both ends live inside the pi
   process (`registerTool`, `sendMessage` delivery policy, renderer,
   session cleanup); a herdr plugin's only channel into pi is typing
   into the pane. The v2 events.subscribe idea is a transport swap
   inside the extension, not a plugin.

Tool contract, steering text, and config now live in the code
(`src/extensions/herdr.ts`) and README — this doc no longer duplicates
them.

## CI watching

Command mode was added after a real CI output watch silently failed to
produce its sentinel. The pane command ran `gh run watch`, then assigned
its exit code to `status`; zsh defines `status` as a read-only special
parameter, so the shell aborted before printing the sentinel. The output
watch correctly waited forever, but the fire-and-forget pane error was not
visible to the orchestrator. A command watch removes this fragile protocol:
it runs the CI command directly, is always bounded by a required timeout,
and fires with the numeric exit code whether that code is zero or non-zero.

Output watches remain appropriate for genuine pane-output conditions. When
a sentinel is unavoidable, print `"$?"` inline and retain a `%s` placeholder
in the typed command so the echoed command cannot match its own sentinel.

## Status and evidence

- **Automated status (2026-08-23):** 94 tests pass in 7 files on macOS;
  TypeScript checks pass; the stable package `index.js` imports successfully.
  Tests use a fake-Herdr executable, and POSIX process/signal cases are skipped
  on Windows, so this is not a live Herdr or Windows smoke.
- **Retained live evidence:** the contemporaneous 2026-07-28 record describes
  one agent watch firing after 48.8 seconds, tail retrieval, a `triggerTurn`
  request, and a telemetry write. Current local telemetry also contains agent
  and command outcomes, so dogfooding has started. Telemetry proves requested
  delivery decisions, not that a UI rendered or Pi actually began a turn.
- **Still unverified live:** `/watches` interaction, state-triggered
  notifications, output mode, current budget-exhaustion UX, and
  SIGTERM→SIGKILL escalation. The 0.8.2 `matched_line` response shape is
  unit-tested but not live-smoked.
- **M4 (dogfood):** in progress. Existing usage does not prove the planned
  week-long evaluation or a final v2 transport decision.

Historical 2026-07-28 smoke notes used Herdr 0.7.5 and a manually copied
SKILL.md. That version ignored `HERDR_SESSION`, and its bare command-group help
exited 2. Those are historical observations, not current requirements: Herdr
0.8.2 documents `HERDR_SESSION` socket resolution and supplies instructions
through `herdr --skill`. A regular Pi TUI transcript was readable through
`recent-unwrapped` in that smoke, but this is not guaranteed for every TUI
mode.

## Non-goals (v1)

Wrapping synchronous CLI commands as tools; raw socket client (v2);
unbounded or persistent generic background-job management; managing herdr
worker processes ourselves; cross-session watches; touching the
herdr-managed `herdr-agent-state.ts`. Bounded, model-initiated command
watches are intentionally in scope, but they are one-shot observations,
not a general process supervisor.

## Known hazards

1. **Blocking-wait temptation**: the model may still run `herdr agent
   wait` via bash out of habit (it's in SKILL.md); steering redirects.
   Possible future rail: a `tool_call` guard on `agent wait|--wait` in
   bash (pi-guard shows the hook pattern).
2. **Stale-session publication:** each session's manager captures a
   generation token. Session replacement/shutdown increments it; old outcomes
   skip card delivery but still receive a best-effort telemetry record.
3. **Occupant replacement**: herdr pins waits to the resolved occupant —
   the wait fails rather than lying; the card surfaces that verbatim.
4. **`unknown` state** "does not prove completion" — passed through
   as-is; steering says read before judging.
5. **Wake loops**: bounded by one-shot watches + wake budget.
6. **CLI drift:** tolerate unknown fields, but test the exact response fields
   used for rendered values. An unrecognized yet valid JSON shape can omit a
   state or display truncated JSON; it is not equivalent to parse failure.
7. **Bare model patterns can select an unintended provider** (historical
   2026-07-28 incident): one unqualified pattern matched an unauthenticated
   provider and left the worker at a login prompt. For reproducible work, use
   a provider-qualified ID from the current Pi catalog and verify that the
   first prompt is processed.
8. **Arm-after-prompt race** (learned 2026-07-28): after `agent prompt`
   returns there's a window where the worker still reads `idle`; a wait
   armed there satisfies `--until idle` on the *pre-work* idle. Atomic
   `prompt --wait` sidesteps it for bash; for `herdr_watch`, treat an
   instant fire with an unchanged transcript as suspect and re-watch —
   until herdr grows a sequence-pinned wait (`state_change_seq` already
   exists in `agent get`).
