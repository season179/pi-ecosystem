# @season179/pi-herdr

A pi extension that lets a pi orchestrator running **inside
[herdr](https://github.com/season179/herdr)** register **non-blocking
watches** on other agents/panes and get **woken** when they settle — so an
orchestrator can dispatch a herd of workers and then end its turn instead
of blocking on `--wait` loops.

Each watch spawns a single `herdr ... wait` child process (the CLI already
owns target resolution, occupant pinning, and settled-state defaults) and
fires **once**: on fire the extension wakes the idle orchestrator via
`triggerTurn` (or steers it mid-turn), delivering a compact card with the
target, the state transition, the elapsed time, and the orchestrator's own
`note`. Evidence stays in herdr; the orchestrator reads more only when it
has doubts.

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
- `wakeBudget` — auto-wakes per session; `0` disables auto-wake.
- `includeTailLines` — tail lines attached to the wake card; `0` disables.
- `toastOn` — herdr states that also fire a desktop toast.
- `telemetryPath` — JSONL sink per fired watch; `""` disables.

## License

MIT
