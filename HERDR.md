# pi-herdr: Async Watches so Pi Can Orchestrate Inside Herdr

Date: 2026-07-28
Status: **DRAFT — for review**. Not yet implemented.
Working name: `pi-herdr` (placeholder). Supersedes the generic `JOBS.md`
draft (deleted same day) after Season clarified the target: pi runs as the
orchestrator **inside herdr**, so herdr — not a pi extension — owns the
workers.

## 1. The Idea

herdr (`~/Personal/herdr`, ogulcancelik/herdr) is an agent multiplexer:
workspaces → tabs → panes, with recognized coding agents in panes
(21 kinds, `pi` included) and semantic lifecycle states
(`idle | working | blocked | done | unknown`). Critically, it exposes the
whole session to agents through the `herdr` CLI / socket API, and ships
`SKILL.md` teaching any agent to use it: split panes, `agent start`,
`agent prompt --wait`, `agent wait --until`, `agent read`, `pane run`,
`pane wait-output`, `pane read`.

How Claude Code orchestrates in herdr today (the green `1 shell` chip in
Season's screenshot): CC prompts a worker, then runs a **blocking wait**
(`herdr agent wait reviewer --timeout ...`) in a *background shell*. CC
keeps working; when the wait exits, CC's harness injects a task
notification and wakes it. herdr does the hard part (lifecycle detection,
settled-state waits); CC contributes one generic primitive — a background
process whose exit wakes the model.

pi has everything except that primitive. Via bash + SKILL.md, pi can
already split panes, start workers, prompt them, and read output. But a
blocking `herdr agent wait` freezes pi's whole turn: it can't parallelize
across workers, can't talk to Season meanwhile, and idles a paid model on
a `sleep`. This extension adds the missing half: **non-blocking watches on
herdr events that wake pi when they fire** — using
`pi.sendMessage(..., { triggerTurn })`, the same verified primitive from
the feasibility research.

Division of labor, deliberately lopsided:

- **herdr owns**: worker processes (visible panes Season can watch and
  grab!), agent detection, lifecycle states, waits with pinning and stall
  detection, output capture/reads, worktrees, focus/UX.
- **pi-herdr owns**: registering watches, waking pi with a compact event
  card, steering the orchestration loop.
- **bash + SKILL.md own**: every synchronous herdr operation. We wrap
  nothing that already works.

## 2. What herdr Provides (inventory, verified 2026-07-28)

From `SKILL.md`, `website/src/content/docs/socket-api.mdx`, and the
installed CLI (`~/.local/bin/herdr`):

1. **Layout + agents**: `pane split --current --direction right --cwd
   "$PWD" --no-focus`; `agent start <name> --kind <pi|claude|codex|...>
   --pane <id>` (returns when the agent is detected and input-ready, 30s
   default). Named agents (`reviewer`, `worker-auth`) are stable targets.
2. **Prompting**: `agent prompt <target> "<text>" [--wait [--until STATE]
   [--timeout MS]]` — atomic text+Enter, bracketed-paste aware. `--wait`
   waits for the first settled `idle|done|blocked`; a prompt from a
   non-working state must produce a lifecycle change within 5s or returns
   `agent_prompt_stalled` (no indefinite hang).
3. **Waits**: `agent wait <target> [--until STATE] [--timeout MS]` —
   server-owned, event-driven, **pins the resolved pane occupant** so a
   replacement agent can't satisfy the wait. `pane wait-output <id>
   --match <text>|--regex <pattern>` for raw-output conditions (checks
   existing snapshot first, so already-present output matches).
4. **Reads**: `agent read <target> --source recent-unwrapped --lines N`
   (also `visible|recent|detection`, `--format ansi`). Known limit:
   alternate-screen agents lose scrollback; SKILL.md's fallback is asking
   the worker to write its answer to a file.
5. **Events over the socket** (`~/.config/herdr/herdr.sock`, JSONL):
   `events.subscribe` / `events.wait` — long-lived push stream, e.g.
   `{"type":"pane.agent_status_changed","pane_id":"w1:p1",
   "agent_status":"blocked"}`; also `pane.exited`, `pane.output_matched`,
   `pane.created`, worktree/workspace/tab lifecycle.
6. **Human-facing notifications**: `herdr notification show <title>
   [--body ...] [--sound done|request]` — toasts in the herdr UI.
7. **Presentation metadata**: `pane.report_metadata` — display-only
   title/state-labels/tokens rendered in herdr's sidebar (80-char caps,
   TTL, seq guards).
8. **Caller context**: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`
   injected into every managed pane. SKILL.md's guardrail: do nothing
   unless `HERDR_ENV=1`.
9. **First-party pi integration already installed**
   (`~/.pi/agent/extensions/herdr-agent-state.ts`, managed by herdr,
   v6): the **outbound** half — hooks `session_start` / `agent_start` /
   `agent_settled` / `session_shutdown` and reports pi's state via
   `pane.report_agent` over short-lived socket connections. It's both
   the proof-of-pattern and the reason herdr can classify pi panes.
   pi-herdr is the **inbound** half; the two stay separate files (the
   integration is overwritten on every herdr update).

## 3. The Gap, Precisely

| Orchestration step | pi today | with pi-herdr |
|---|---|---|
| Split pane, start worker | bash + CLI ✅ | unchanged |
| Send brief | bash + CLI ✅ | unchanged |
| Wait for worker to settle | ❌ blocks the turn | `herdr_watch` → go idle → woken |
| Watch tests/server output in a pane | ❌ blocks | `herdr_watch` (output mode) |
| React to `blocked` worker needing input | ❌ only by polling | woken with state card |
| Read result, judge, next brief | bash + CLI ✅ | unchanged |

## 4. Proposed Decisions

1. **Inbound bridge only; wrap nothing synchronous.** The herdr SKILL.md
   gets installed as a pi skill (M1) and carries all CLI knowledge. The
   extension registers only watch-management tools. Smaller surface, no
   drift when herdr's CLI evolves.
2. **v1 watch mechanism: one waiter child per watch**, i.e. the extension
   spawns `herdr agent wait <target> --until ... --timeout ...` (or
   `pane wait-output`) and reacts to its exit + JSON. Rationale: the CLI
   already owns the semantics we'd otherwise reimplement on the raw
   socket — target resolution, **occupant pinning**, stall detection,
   settled-state defaults. Watches are few (2–5 workers), so a process
   each is nothing. v2 candidate: one persistent `events.subscribe`
   connection (the installed integration shows the socket pattern in ~40
   lines).
3. **Wake-on-fire by default.** Delivery: `steer` while pi is mid-turn;
   `triggerTurn: true` when idle. Session wake budget (default 20) as the
   runaway backstop, degrading to `nextTurn` + footer badge. Watches fire
   **once** and are removed — re-watching is an explicit orchestrator
   decision, which is the anti-loop property (pi-buddy PLAN.md §6.3
   lesson).
4. **Watches survive Esc.** Each watch owns its own `AbortController`;
   never capture the turn's `ctx.signal`. Esc aborts pi's turn, not the
   herd. Cancel is explicit (`herdr_unwatch`, `/watches`).
5. **Dormant outside herdr — and dormant in workers until promoted.**
   Factory registers nothing unless `HERDR_ENV=1` && `HERDR_PANE_ID`
   set (same guard as SKILL.md and the installed integration). Inside
   herdr, the watch tools exist but start **inactive** — herdr stamps
   every pane with the same env, and pi also runs as workers, planner,
   and reviewer in panes; those must not grow watch tools or wake
   paths. Orchestrator-ness matches Season's actual workflow — you
   *ask* an agent to be the orchestrator, mid-conversation — via
   runtime promotion (pi's dynamic-tool API: `setActiveTools`
   applied additively during tool execution):
   - `herdr_orchestrate` — the only always-active tool (tiny, no
     params); its description says to call it only when the user
     explicitly asks for orchestration. Calling it activates
     `herdr_watch`/`herdr_unwatch`/`herdr_watches`.
   - `PI_HERDR_ORCHESTRATOR=1` at launch auto-promotes (for scripted
     starts). `/orchestrate` promotes by hand; `/orchestrate off`
     demotes and stops all armed watches.
   Promotion is sticky for the process. Waiter children spawn only
   from `session_start` onward; all killed in `session_shutdown`.
   Residual risk, accepted: a worker *could* wrongly call
   `herdr_orchestrate` if its prompt suggests orchestration — but
   "being asked" is precisely what defines the orchestrator here, so
   the tool description is the guard.
6. **Event card is compact; evidence stays in herdr.** The wake message
   carries target, settled state (or matched line), elapsed, and the
   watch's `note` (orchestrator's own reminder of why it was watching).
   (Amended from "old→new state": `herdr agent wait` reports only the
   settled state, and the prior state is almost always `working` —
   tracking it isn't worth extra machinery.)
   Optionally the last ~20 lines via `agent read` (config, default on).
   The orchestrator reads more only where it has doubts — the
   read-economy rule: if the orchestrator re-reads everything its workers
   produce, the parallelism savings evaporate.
7. **Tell Season too, not just pi.** On fire, optionally
   `herdr notification show "reviewer blocked" --sound request` (config,
   default on for `blocked`, off for others). herdr's sidebar already
   shows states; the toast is for eyes-elsewhere moments.
8. **Anti-poll + anti-block steering.** Tool descriptions state: "you
   will be woken — do not poll `agent read` in a loop, and never run
   `herdr agent wait` or `--wait` prompts through bash; that blocks your
   turn. Prompt without `--wait`, then `herdr_watch`."
9. **Pi extension, not a herdr plugin** (Season's question, 2026-07-28).
   Both ends of the feature live inside the pi process: tools must be
   registered via `pi.registerTool`, and the wake must go through
   `pi.sendMessage` (delivery policy, wake budget, renderer,
   session-scoped cleanup). herdr plugins do have event hooks
   (`HERDR_PLUGIN_EVENT_JSON` on e.g. `pane.agent_status_changed`), but
   their only channel into pi is typing into the pane — fake user text,
   no delivery policy, keystroke hazards if a dialog is up, and no
   leash when the pi session ends. The extension needs nothing
   plugin-shaped from herdr: the public CLI and socket already expose
   everything ("agents can use herdr too" is herdr's own design). The
   v2 `events.subscribe` idea is a transport swap inside the extension,
   not a plugin.

## 5. Tool Contract

`pi.registerTool`, sequential execution (registry mutations stay
race-free).

**`herdr_watch`** — parameters:

- `target` (string, required): unique live agent name or pane ID
  (`w1:p3`).
- `mode` (`"agent" | "output"`, default `"agent"`): lifecycle wait vs
  `pane wait-output`.
- `until` (string[], optional, agent mode): states to settle on; default
  = herdr's settled defaults (`idle|done|blocked`).
- `match` / `regex` (string, output mode): condition for
  `pane wait-output`.
- `timeoutMs` (number, optional): passed through to the CLI; on expiry
  pi is woken with a `timeout` card (a watch that can't end silently —
  Monitor's "silence is not success" lesson).
- `note` (string, optional): echoed back in the card ("auth worker,
  brief #2, expect tests green").
- `wake` (boolean, default true).

Result (immediate): watch id + "you will be woken; continue other work or
end your turn."

**`herdr_unwatch`** — watch id or `all`. Kills the waiter child.

**`herdr_watches`** — list: id, target, condition, elapsed, note. Exists
for the model (survives compaction); `/watches` duplicates it for Season
with a kill picker.

Wake card (rendered via `registerMessageRenderer`, `customType:
"herdr-watch"`):

```
watch #2 "reviewer" settled: working → blocked after 3m41s
note: reviewing auth diff, expect questions about session.ts
last lines: <~20 lines from agent read, recent-unwrapped>
```

## 6. Orchestration Steering (promptSnippet / promptGuidelines)

The loop to teach:

1. Split a sibling pane (`--no-focus`, preserve cwd); `agent start` with
   a meaningful unique name.
2. Brief it with `agent prompt <name> "<brief>"` — **no `--wait`**.
3. `herdr_watch` the worker with a `note`; start the next worker or end
   the turn. Never block the turn on herdr waits.
4. On wake: `blocked` → read, answer with `agent prompt` or
   `agent send-keys`, re-watch. `idle|done` → read the result, judge,
   next brief or dismantle.
5. Herd small: 2–3 concurrent workers; you must review everything you
   dispatch. Max 2 re-briefs per task, then take it over yourself — the
   anti-retry-spiral rail.
6. Panes you created are yours to close when done; never close panes,
   tabs, or workspaces you didn't create (SKILL.md safety rules bind the
   orchestrator as much as any agent).

## 7. Config

Optional `~/.pi/agent/herdr.json` (defaults in code, loud error on
unknown/mistyped fields, tilde expansion):

```json
{
  "maxWatches": 8,
  "wakeBudget": 20,
  "includeTailLines": 20,
  "toastOn": ["blocked"],
  "telemetryPath": "~/.pi/agent/herdr-telemetry.jsonl"
}
```

Telemetry per fired watch: target, condition, wait duration, delivery
mode, wake-or-not, time-to-reaction. Answers M4's question: do wakes make
pi a working herder or a spammy one?

## 8. Milestones

1. **Skill + manual smoke (no code)**: install herdr `SKILL.md` as a pi
   skill (`~/.pi/agent/skills/herdr/`); drive a full synchronous
   orchestration by hand inside herdr — pi splits a pane, starts a
   worker (`--kind pi` or glm via pi), prompts, reads. Confirms the CLI
   layer and detection work with pi as the caller. Finding budget: what
   breaks in SKILL.md when the caller is pi rather than CC.
   ✅ Done 2026-07-28. Skill installed (copied from
   `~/Personal/herdr/SKILL.md`; refresh manually on herdr updates).
   Smoke ran in an isolated named session (`herdr --session pi-m1-smoke
   server` headless): pi-in-a-pane loaded the skill on explicit mention,
   passed the `HERDR_ENV` guard, did CLI discovery per SKILL.md, then
   completed both loops cleanly — (a) pane split → `pane run` →
   `pane wait-output --match` → `pane read` → `pane close`, correct
   output reported; (b) `agent start worker --kind pi` → `agent prompt
   --wait` → `agent read` → `pane close`, worker's answer ("391")
   extracted correctly. Cost ≈ $0.29 orchestrator + $0.04 worker (sub
   quota). Findings: (1) the installed herdr 0.7.5 ignores the
   `HERDR_SESSION` env var — use the global `--session` flag (docs
   describe newer behavior); (2) the herdr↔pi outbound integration works
   in named sessions too (`agent_session` + lifecycle reporting drove
   `--wait` correctly); (3) pi's TUI renders in the main buffer, so
   `recent-unwrapped` reads capture full transcripts — the
   alternate-screen fallback (§2.4) was not needed; (4) SKILL.md's
   "run the group without a subcommand" discovery step exits code 2 by
   design, which pi's bash tool displays as a failed command — cosmetic
   only, caused no confusion; (5) the blocking gap is confirmed: both
   waits ran inside pi's bash tool and pinned the orchestrator's turn
   for their full duration — exactly what `herdr_watch` (M2) removes.
2. **Watch layer** — ✅ Done 2026-07-28. Built in `packages/pi-herdr`
   exactly as specified (kill path keyed on the close event, plus a
   shutdown latch so `start()` after `shutdown()` throws); 55 unit
   tests green against the fake-herdr fixture behind `PI_HERDR_COMMAND`.
   Built by three pi workers in herdr panes (glm-5.2 scaffold,
   gpt-5.6-sol core+ext, k3 render/commands), reviewed by a fresh
   gpt-5.6-sol instance (2 majors + 2 accepted minors, all fixed), with
   this doc's author orchestrating and independently verifying.
3. **Wake + UX** — ✅ Done 2026-07-28 (built alongside M2; one live
   smoke passed). sendMessage delivery policy + wake budget (consumed
   only after a successful send); message renderer; footer chip
   (`herdr: N watches`); `/watches` command; toasts; `session_shutdown`
   cleanup; steering text. Live smoke: extension loaded via `pi -e` in
   a herdr pane, `herdr_watch` armed on a working agent, fired on
   settle after 48.8s, wake card carried the worker's final output via
   the tail fetch, `triggerTurn` woke the idle orchestrator, telemetry
   record complete. Not yet exercised live: `/watches` interactive UI,
   toasts, output-mode watches, wake-budget degradation.
4. **Dogfood**: a week of real orchestration — pi herding two workers in
   herdr panes on pi-ecosystem tasks. Judge with telemetry + feel:
   wake usefulness, poll incidence, blocked-handling quality. Then
   decide whether v2 moves the transport to `events.subscribe`.

## 9. Non-Goals (v1)

- Wrapping synchronous herdr CLI commands as pi tools (bash + skill
  suffice; wrapper drift is a real cost)
- Raw socket protocol client / `events.subscribe` transport (v2)
- Generic non-herdr background jobs (the deleted JOBS.md scope — herdr
  panes *are* the visible background shells; `pane run` +
  `herdr_watch` output-mode covers servers/tests/builds)
- Starting/managing worker *processes* ourselves (herdr's job)
- Cross-session watch persistence; watching panes in other herdr
  sessions
- Changes to the herdr-managed integration file (`herdr-agent-state.ts`)

## 10. Known Hazards

1. **Blocking-wait temptation**: the model may still run `herdr agent
   wait` via bash out of habit (it's in SKILL.md). Steering must
   explicitly redirect to `herdr_watch`; consider a `user_bash`-style
   `tool_call` guard that rewrites/warns on `herdr agent wait|--wait` in
   bash (pi-guard shows the hook pattern).
2. **Stale-session publication**: capture session identity at watch
   registration; drop or re-queue the wake if the session changed
   (pi-buddy tracker pattern).
3. **Occupant replacement**: herdr pins waits to the resolved occupant —
   if the worker exits and something else takes the pane, the wait fails
   rather than lying. Surface that failure state in the card verbatim.
4. **`unknown` state**: herdr says it "does not prove completion" — the
   card must pass it through as-is, steering tells the orchestrator to
   read before judging.
5. **Wake loops**: bounded by one-shot watches + wake budget; telemetry
   watches it anyway.
6. **CLI drift**: pin nothing; parse only documented JSON fields, and on
   parse failure deliver the raw CLI output in the card instead of
   guessing (herdr updates weekly; the SKILL.md "binary is the
   authority" rule applies to the harness too).
7. **Bare model names resolve wrong** (learned 2026-07-28): `pi --model
   gpt-5.6-sol` pattern-matched an unauthenticated provider
   (azure-openai-responses) and the worker sat at a login prompt while
   looking "started". Always start workers with qualified ids
   (`openai-codex/gpt-5.6-sol`, `zai/glm-5.2`, `kimi-coding/k3`) and
   verify the first prompt actually gets processed.
8. **Arm-after-prompt race** (learned 2026-07-28): after `agent prompt`
   returns there is a window where the worker still reads `idle` (it
   hasn't started working yet); a wait armed in that window satisfies
   `--until idle` immediately and fires on the *pre-work* idle. Observed
   live during the M1 smoke. For bash-level orchestration the atomic
   `agent prompt … --wait` sidesteps it entirely. For `herdr_watch`
   (prompt via bash, then arm the watch) the window still exists —
   steering should tell the orchestrator to treat an instant fire with
   an unchanged transcript as suspect and re-watch, until herdr grows a
   sequence-pinned wait (`state_change_seq` is already in `agent get`).
