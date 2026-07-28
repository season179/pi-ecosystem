# @season179/pi-herdr

A pi extension that lets a pi orchestrator running **inside
[herdr](https://github.com/season179/herdr)** register **non-blocking
watches** on other agents, pane output, or bounded commands and get
**woken** when they finish — so an orchestrator can dispatch work and then
end its turn instead of blocking on `--wait` loops.

A watch fires **once**. Agent and output watches spawn a single
`herdr ... wait` child, leaving target resolution, occupant pinning, and
snapshot matching to herdr. Command watches spawn `/bin/sh -c` directly and
fire on any numeric exit code, including non-zero. On fire the extension
wakes the idle orchestrator via `triggerTurn` (or steers it mid-turn),
delivering a compact card with the condition, elapsed time, note, and
bounded evidence tail.

## Watch modes

- `agent` — requires an agent `target`; waits for herdr lifecycle states.
- `output` — requires a pane `target` and exactly one literal `match` or
  Rust-syntax `regex`. Herdr searches the existing pane snapshot
  immediately when the watch is armed.
- `command` — requires a non-empty `command` and a positive `timeoutMs`.
  The command inherits pi-herdr's cwd and environment, runs under the
  predictable POSIX `/bin/sh -c` contract, and reports its exit code.
  Commands are never written to telemetry because they may contain secrets.

Prefer command mode for CI runs, builds, and deploys; it needs no pane or
sentinel. If an output sentinel is genuinely needed, print the status
inline, for example `…; printf '\n__TAG_%s__\n' "$?"`. Never assign to
`status` first: it is read-only in zsh and aborts the rest of the command.
Keep the `%s` placeholder in the typed command so its echo cannot
false-match the sentinel regex.

## Activation

The extension registers nothing outside herdr (`HERDR_ENV=1` +
`HERDR_PANE_ID`, stamped by herdr on every pane). Inside herdr the
watch tools start **inactive**, because pi also runs as workers,
planners, and reviewers in panes — those must not grow watch tools.

An agent becomes the orchestrator by being asked. Just tell it:

> You are the orchestrator — dispatch this to the workers.

It calls the always-active `herdr_orchestrate` tool, which activates
`herdr_watch` / `herdr_unwatch` / `herdr_watches` mid-conversation.

Alternatives: `PI_HERDR_ORCHESTRATOR=1 pi` (or
`herdr pane split --env PI_HERDR_ORCHESTRATOR=1`) auto-promotes at
launch for scripted setups; `/orchestrate` promotes by hand, and
`/orchestrate off` demotes and stops all armed watches.

## Status

Complete and live-smoked (2026-07-28): watch manager with
SIGTERM→SIGKILL kill path, delivery policy + wake budget, wake cards,
footer chip, `/watches`, toasts, telemetry. Not yet exercised live:
`/watches` interactive UI, toasts, output-mode watches, wake-budget
degradation.

Design decisions, findings, and known hazards:
[docs/DESIGN.md](./docs/DESIGN.md).

## Config

Optional `~/.pi/agent/herdr.json` (defaults in code, loud error on unknown
or mistyped fields):

```json
{
  "maxWatches": 8,
  "wakeBudget": 20,
  "includeTailLines": 20,
  "toastOn": ["blocked"],
  "telemetryPath": "~/.pi/agent/herdr-telemetry.jsonl"
}
```

- `maxWatches` — concurrent armed watches (capacity guard).
- `wakeBudget` — maximum consecutive attempted idle wakes without interactive or RPC input; resets when such input arrives, and `0` disables auto-wake.
- `includeTailLines` — tail lines attached to the wake card; `0` disables.
- `toastOn` — herdr states that also fire a desktop toast.
- `telemetryPath` — JSONL sink per fired watch; `""` disables.

When a positive wake budget is exhausted, watch cards continue to arrive
without starting an idle turn. The footer and watch list expose the budget
state, and the first suppressed idle wake in each attendance epoch sends a
desktop notification.

## License

MIT
