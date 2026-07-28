# pi-herdr design: Async Watches so Pi Can Orchestrate Inside Herdr

Date: 2026-07-28 (condensed from the root-level HERDR.md draft after
M1–M3 shipped; full original in git history at commit `f5b0d80`).
Status: **implemented and live-smoked** (M1–M3). Pending: M4 dogfood,
then decide the v2 `events.subscribe` transport.

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
CI command pins pi's whole turn — no parallelism across workers, no
talking to Season meanwhile, a paid model idling on a sleep. pi-herdr
adds exactly that missing half: watches on herdr events and bounded,
model-initiated commands that **wake pi when they fire**, via
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

Facts pi-herdr depends on (herdr 0.7.5; SKILL.md and the binary are the
authority, herdr updates weekly): every managed pane gets `HERDR_ENV=1`,
`HERDR_PANE_ID`, `HERDR_SOCKET_PATH` — identically, with no
orchestrator/worker distinction. `agent wait` is server-owned,
event-driven, pins the resolved occupant, and reports the settled state.
`pane wait-output` matches against the existing snapshot first. The
socket also offers `events.subscribe` (the v2 transport candidate). The
herdr-managed outbound integration `~/.pi/agent/extensions/
herdr-agent-state.ts` reports pi's state to herdr; pi-herdr is the
inbound half and the two stay separate files (herdr overwrites its own
on update).

## Decisions

1. **Inbound bridge only; wrap nothing synchronous.** The herdr SKILL.md
   is installed as a pi skill and carries all CLI knowledge; the
   extension registers only watch-management tools. Smaller surface, no
   drift when herdr's CLI evolves.
2. **v1 watch mechanism: one child per watch** — spawn
   `herdr agent wait`/`pane wait-output` for herdr targets, or fixed
   `/bin/sh -c` for a bounded command, then react to its exit. The CLI
   owns target resolution, occupant pinning, stall detection, and
   settled-state defaults. WatchManager owns command timeouts and the
   shared SIGTERM→grace→SIGKILL lifecycle. Watches remain few (2–5).
   v2 candidate for herdr-backed watches: one persistent
   `events.subscribe` socket connection.
3. **Wake-on-fire by default, with a consecutive unattended-wake
   budget.** `steer` mid-turn, `triggerTurn` when idle. The default budget
   is 20 attempted idle wakes; busy steering is free. It resets on
   `interactive` or `rpc` input and on session start. One-shot watches and
   explicit re-arming remain the primary anti-loop property. At positive-
   budget exhaustion, cards stay visible but do not trigger an idle turn,
   and the first suppressed idle wake in each attendance epoch sends a
   desktop warning. The implementation continues using
   `deliverAs: "steer"`; an idle, non-triggering custom card is appended
   to session context without starting a model turn. Budget zero deliberately
   disables auto-wake.
4. **Watches survive Esc.** Each watch owns its own `AbortController`;
   never capture the turn's `ctx.signal`. Cancel is explicit
   (`herdr_unwatch`, `/orchestrate off`, shutdown).
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
   Promotion is sticky for the process. Accepted residual risk: a
   worker whose prompt suggests orchestration could self-promote —
   "being asked" is precisely what defines the orchestrator here.
6. **Event card is compact; evidence stays in herdr.** Target, settled
   state (or matched line — `agent wait` doesn't report the prior
   state), elapsed, the orchestrator's own `note`, and by default the
   last ~20 lines via `agent read`. The read-economy rule: if the
   orchestrator re-reads everything its workers produce, the
   parallelism savings evaporate.
7. **Tell Season too**: optional herdr toast on fire (default on for
   `blocked` only).
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

## Status and durable findings

- **M1 (skill + manual smoke)** ✅ 2026-07-28. SKILL.md installed at
  `~/.pi/agent/skills/herdr/` (manual copy; refresh on herdr updates).
  Findings: herdr 0.7.5 ignores the `HERDR_SESSION` env var — use the
  global `--session` flag; pi's TUI renders in the main buffer so
  `recent-unwrapped` reads capture full transcripts; SKILL.md's
  bare-group discovery step exits code 2 by design (cosmetic); the
  blocking gap confirmed — bash waits pinned the turn end-to-end.
- **M2 (watch layer) + M3 (wake + UX)** ✅ 2026-07-28. Unit tests
  against a fake-herdr fixture (`PI_HERDR_COMMAND` seam); kill path
  keyed on the close event with a shutdown latch; each attempted idle wake
  is accounted immediately before fire-and-forget delivery. Live smokes:
  fire on settle, tail-
  carrying wake card, `triggerTurn` waking an idle orchestrator,
  telemetry record; conversational promotion verified (plain "you are
  the orchestrator" → `herdr_orchestrate` + `herdr_watch` in the same
  turn). Not yet exercised live: `/watches` interactive UI, toasts,
  output-mode watches, wake-budget degradation.
- **M4 (dogfood)** — pending: a week of real orchestration, judged with
  telemetry + feel (wake usefulness, poll incidence, blocked-handling
  quality). Then decide on the v2 transport.

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
2. **Stale-session publication**: session identity captured at watch
   registration; wakes from a previous session's watches are dropped.
3. **Occupant replacement**: herdr pins waits to the resolved occupant —
   the wait fails rather than lying; the card surfaces that verbatim.
4. **`unknown` state** "does not prove completion" — passed through
   as-is; steering says read before judging.
5. **Wake loops**: bounded by one-shot watches + wake budget.
6. **CLI drift**: parse only documented JSON fields; on parse failure
   deliver raw CLI output in the card instead of guessing.
7. **Bare model names resolve wrong** (learned 2026-07-28): `--model
   gpt-5.6-sol` pattern-matched an unauthenticated provider and the
   worker sat at a login prompt while looking "started". Always use
   qualified ids (`openai-codex/gpt-5.6-sol`, `zai/glm-5.2`,
   `kimi-coding/k3`) and verify the first prompt gets processed.
8. **Arm-after-prompt race** (learned 2026-07-28): after `agent prompt`
   returns there's a window where the worker still reads `idle`; a wait
   armed there satisfies `--until idle` on the *pre-work* idle. Atomic
   `prompt --wait` sidesteps it for bash; for `herdr_watch`, treat an
   instant fire with an unchanged transcript as suspect and re-watch —
   until herdr grows a sequence-pinned wait (`state_change_seq` already
   exists in `agent get`).
