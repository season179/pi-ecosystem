# Brief: ext worker (extension entry + policy)

Read `briefs/COMMON.md` first (and HERDR.md §4–§6 carefully). You own
EXACTLY these files under `packages/pi-herdr/`:

- `src/policy.ts`
- `src/extensions/herdr.ts`
- `test/policy.test.ts`

All other modules exist by now (types, config, telemetry, herdr-cli,
watches, render, commands) — import and use them per the COMMON.md
contracts. Read their actual source before wiring.

## src/policy.ts

Per contract. Semantics:

- Always `deliverAs: "steer"` (steer is queued mid-turn; when idle,
  `triggerTurn` decides whether it wakes the agent).
- `triggerTurn` = `wake && (wakeBudget === 0 ? false : wakesUsed < wakeBudget)`.
  Note: wakeBudget 0 means auto-wake disabled entirely.
- `countsAsWake` = `triggerTurn && !agentBusy` (only an actual idle wake
  consumes budget).

## src/extensions/herdr.ts

Default-export factory. Structure:

1. **Guard**: if `process.env.HERDR_ENV !== "1"` or no
   `process.env.HERDR_PANE_ID`, register nothing and return.
2. **Config**: `loadHerdrConfig(getAgentDir())` at factory time
   (`getAgentDir` is exported by `@earendil-works/pi-coding-agent`).
   Let ConfigError propagate — pi reports extension load errors loudly,
   which is what we want.
3. **State** (module-scope within factory closure):
   - `manager: WatchManager | undefined` — created in `session_start`,
     torn down in `session_shutdown` (`await manager.shutdown()`).
     NEVER create children at factory time (extensions doc rule).
   - `agentBusy: boolean` — set true on `agent_start`, false on
     `agent_settled` (also false on `session_start`).
   - `wakesUsed: number` — reset on `session_start`.
   - `uiCtx` — stash the latest `ctx` from event handlers for
     `ctx.ui.setStatus` calls; guard with `ctx.hasUI`.
4. **Footer chip**: after every registry change or outcome, compute
   `formatStatusChip(armedCount)` and `ctx.ui.setStatus("herdr", chip)`
   (undefined clears it).
5. **Tools** (all TypeBox params, `executionMode: "sequential"`):
   - `herdr_watch` — params: target (string), mode (optional
     "agent"|"output", default "agent"), until (optional string[]),
     match/regex (optional strings), timeoutMs (optional number), note
     (optional string), wake (optional boolean, default true).
     Execute: manager must exist (else throw "no active session");
     build WatchSpec, `manager.start(spec)`; update footer; return
     content: `watch #<id> armed on <target> (<condition summary>) — you
     will be woken when it fires; continue other work or end your turn.`
     Description (steering — include verbatim):
     "Register a non-blocking watch on a herdr agent or pane. You will
     be woken with a report when it fires — do NOT poll `herdr agent
     read` in a loop, and NEVER run `herdr agent wait` or `agent prompt
     --wait` through bash (that blocks your whole turn). The pattern:
     prompt the worker WITHOUT --wait, then herdr_watch it, then end
     your turn or do other work."
   - `herdr_unwatch` — params: id (number) or all (optional boolean).
     Kills the waiter; returns what was stopped. Note in the description
     that a stopped watch delivers no report.
   - `herdr_watches` — no params; returns `formatWatchLine` for every
     record (armed and recent history), or "no watches".
   - Tool results must respect pi truncation conventions (these are all
     small strings; just don't dump raw JSON blobs — summarize).
6. **onOutcome handler** (the wake path — this is the heart):
   - If record.status === "stopped" → telemetry only, no message.
   - Fetch tail when `config.includeTailLines > 0` and mode is "agent"
     and outcome.kind is "fired": `runHerdr(["agent","read",
     spec.target,"--source","recent-unwrapped","--lines",
     String(config.includeTailLines)])` — best-effort; on failure pass
     undefined tail. For "output" mode use the matched snapshot already
     inside `outcome.json` (pass it through formatWatchCard via outcome).
   - `const d = decideDelivery({wake: spec.wake, agentBusy, wakesUsed,
     wakeBudget: config.wakeBudget})`;
     if `d.countsAsWake` increment `wakesUsed`.
   - `pi.sendMessage({customType: "pi-herdr-watch", content:
     formatWatchCard(record, outcome, tail), display: true, details:
     {record, outcomeKind: outcome.kind}}, {deliverAs: d.deliverAs,
     triggerTurn: d.triggerTurn})`.
   - Toast: if outcome.kind === "fired" and the settled agent state (from
     outcome.json, when present) is in `config.toastOn`, best-effort
     `runHerdr(["notification","show", "<target> <state>", "--sound",
     "request"])`. Never let toast failures propagate.
   - Telemetry: one record — watchId, target, mode, kind, durationMs,
     triggerTurn, countsAsWake, wakesUsed.
   - Update footer chip.
   - Wrap the WHOLE handler body in try/catch; on error, best-effort
     sendMessage of a short failure note (no rethrow).
7. **Lifecycle**:
   - `session_start`: shutdown any old manager, create fresh one with
     config + onOutcome, reset wakesUsed/agentBusy, clear footer.
   - `session_shutdown`: `await manager.shutdown()`, clear footer.
   - Do NOT capture a turn's `ctx.signal` anywhere near watch children.
8. **Command**: call `registerWatchesCommand(pi, {list, stop})` (from
   `../commands.js`) once at factory time (safe — it only registers).

## test/policy.test.ts

Cover: wake=false → no trigger; budget exhausted → no trigger;
budget 0 → no trigger ever; busy+wake → triggerTurn true but
countsAsWake false; idle+wake+budget → both true.

(The extension entry itself is exercised in live smoke later — no unit
test required for herdr.ts, but it MUST compile in the full build.)

## Done

Full `npm run build -w @season179/pi-herdr` and the ENTIRE package test
suite (`npx vitest run packages/pi-herdr`) must be green — you are the
integration point. Report per COMMON.md, including any contract
mismatches you had to reconcile against the real files.
