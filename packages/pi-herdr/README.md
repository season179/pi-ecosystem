# @season179/pi-herdr

A [Pi](https://github.com/earendil-works/pi) extension for an orchestrator running inside [Herdr](https://github.com/season179/herdr). It registers one-shot, non-blocking watches for agent lifecycle states, pane-output matches, and bounded shell commands, allowing the orchestrator to end its turn instead of blocking in a wait loop.

Each watch settles once with a fired, timeout, error, or stopped outcome. Agent and output watches run one detached `herdr agent wait` or `herdr pane wait-output` child; command watches run one detached `/bin/sh -c` child. A wake-enabled watch within budget requests a new turn while Pi is idle and is delivered as steering while Pi is busy. Otherwise its card is delivered without starting an idle turn. Explicitly stopped watches produce no card.

## Requirements and Installation

- Node.js 22 or newer.
- Pi and Herdr in the same environment; `herdr` must resolve on `PATH`.
- Herdr's Pi integration installed (`herdr integration install pi`) for reliable agent lifecycle state.
- macOS or Linux. Command mode uses `/bin/sh -c`, and cancellation uses POSIX process-group signals. Native Windows support is not implemented or verified.

The package is not yet published to npm. From a `pi-ecosystem` checkout:

```bash
npm install
npm run build --workspace @season179/pi-herdr
pi install /absolute/path/to/pi-ecosystem/packages/pi-herdr
```

The package manifest loads `./index.js`, which re-exports the compiled extension from `dist/`. Rebuild after source changes. Compatibility was last checked against Herdr 0.8.2; no Herdr version range is enforced.

## Activation

The extension registers nothing unless both `HERDR_ENV=1` and a non-empty `HERDR_PANE_ID` are present. In a managed Herdr pane it registers commands and handlers, but the model-facing watch tools start inactive because Pi also runs as workers, planners, and reviewers in panes.

An agent becomes the orchestrator when you explicitly ask it, for example:

> You are the orchestrator — dispatch this to the workers.

The always-active `herdr_orchestrate` tool then enables `herdr_watch`, `herdr_unwatch`, and `herdr_watches`. Natural-language activation relies on the model following that tool instruction.

Alternatives:

- `PI_HERDR_ORCHESTRATOR=1 pi` auto-promotes at launch.
- `/orchestrate` promotes manually.
- `/orchestrate off` demotes and stops all armed watches.

Promotion persists across Pi session changes in the same process until explicit demotion or process exit.

## Watch Tools and Modes

`herdr_watch` defaults to `mode: "agent"`. Every mode accepts optional `note` and `wake` fields; `wake` defaults to `true`. A wake-disabled watch still delivers a card but never starts an idle turn.

- **`agent`** — requires a unique live agent name or pane ID in `target`. `until` defaults to Herdr's settled states (`idle`, `done`, or `blocked`). `timeoutMs` is optional; omitting it waits indefinitely.
- **`output`** — requires a pane ID in `target` and exactly one string `match` or Rust-syntax `regex`. Herdr searches its default recent snapshot immediately, so existing output can match. `timeoutMs` is optional. pi-herdr does not expose Herdr's snapshot-source, line-count, or raw-ANSI options.
- **`command`** — requires a non-empty shell `command` and a required `timeoutMs`. It runs as `/bin/sh -c` and inherits the Pi process's cwd and environment; there are no per-watch overrides. Any numeric exit code, including non-zero, is a completed outcome. Timeout or stop sends SIGTERM, then SIGKILL after a five-second grace period.

Every supplied timeout must be a positive integer no greater than 2,147,483,647 milliseconds.

`herdr_unwatch` stops one watch ID or all armed watches. `herdr_watches` lists records retained for the current Pi session, armed first. `/watches` provides an interactive list/stop picker when a UI is available. Watches do not survive a Pi session replacement or shutdown.

Prompt workers without `--wait`, then arm an agent watch. Never poll `herdr agent read` or run `herdr agent wait` / `agent prompt --wait` through Pi's bash tool:

```text
herdr agent prompt reviewer "Review the current diff and write the report to /tmp/review.md"
herdr_watch target=reviewer mode=agent
```

Prefer command mode for CI, builds, and deploys because it reports the exit code without a pane sentinel. If an output sentinel is unavoidable in a zsh pane, do not assign to `status`—it is read-only. Print `$?` inline, and keep a formatting placeholder in the typed command so echoed input cannot match its own sentinel:

```bash
some-command; printf '\n__TAG_%s__\n' "$?"
```

## Command Privacy

Command text is omitted from pi-herdr's JSONL telemetry, but a normalized prefix of up to 60 characters is shown in the arming response, watch lists, and delivered card. That card may be persisted in the Pi session and also includes the last 10 lines of command stdout/stderr. Do not put secrets directly in command text or output; pass them through protected environment variables or files.

## Configuration

Optional `~/.pi/agent/herdr.json`; unknown or mistyped fields fail loudly:

```json
{
  "maxWatches": 8,
  "wakeBudget": 20,
  "includeTailLines": 20,
  "toastOn": ["blocked"],
  "telemetryPath": "~/.pi/agent/herdr-telemetry.jsonl"
}
```

- `maxWatches` — maximum concurrently armed watches.
- `wakeBudget` — maximum consecutive attempted idle wakes without interactive or RPC input; that input resets the counter. `0` disables automatic idle wakes, not card delivery.
- `includeTailLines` — lines requested from `herdr agent read` after a fired agent watch; `0` disables that fetch. Rendering is capped at 20 lines. This does not disable command tails or raw CLI-error fallback tails.
- `toastOn` — agent lifecycle states that request a best-effort Herdr notification after a fired agent watch; default `blocked`.
- `telemetryPath` — best-effort JSONL sink for every watch-child outcome, including timeout, error, stop, and stale-session outcomes; `""` disables it. A leading `~/` is expanded. Command text and output are omitted, but agent/output targets are recorded.

When a positive wake budget is exhausted, cards continue to arrive without starting an idle turn. The footer and `herdr_watches` show the budget state. The first suppressed idle wake after session start or the latest interactive/RPC input requests one best-effort Herdr notification.

## Status and Compatibility

Implemented. As of 2026-08-23, 94 automated tests pass on macOS, TypeScript checks cleanly, and the stable package entrypoint imports successfully. Historical live evidence covers agent-watch settlement, agent-tail retrieval, a wake-card delivery request, and telemetry; current local telemetry also shows agent and command watches used in real sessions.

Not yet verified live: `/watches` interaction, state-triggered notifications, output-mode watches, current wake-budget exhaustion UX, and SIGTERM→SIGKILL escalation. Output-card parsing covers Herdr 0.8.2's documented `result.matched_line` field in unit tests, but output mode remains unverified against a live 0.8.2 process.

See the [design and decision history](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-herdr/docs/DESIGN.md) for architecture boundaries, retained evidence, and known hazards.

## Local Development

From the repository root:

```bash
npm run build --workspace @season179/pi-herdr
npm test --workspace @season179/pi-herdr
npm pack --workspace @season179/pi-herdr --dry-run
```

## Security

Pi extensions and watched commands execute with your user permissions. Agent/output targets, notes, outcomes, and bounded evidence may be persisted in Pi sessions and local telemetry. Command text/output is excluded from telemetry but can appear in persisted cards as described above. Watches are orchestration aids, not a sandbox or authorization boundary.

## License

MIT — see the repository [LICENSE](https://github.com/season179/pi-ecosystem/blob/main/LICENSE).
