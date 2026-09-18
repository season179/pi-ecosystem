# @season179/pi-herdr

A [Pi](https://github.com/earendil-works/pi) extension for conversational orchestration inside [Herdr](https://github.com/season179/herdr). `/orchestrate` supplies the workflow, editable worker routing, and one-shot non-blocking watches. The agent delegates to visible workers, reads their temporary reports, verifies delivery, and quits finished workers while keeping their panes reusable.

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

Use `/orchestrate` as the single entry point. It activates the bundled [workflow](skills/orchestration/SKILL.md), `herdr_route`, `herdr_watch`, `herdr_unwatch`, and `herdr_watches`, without starting a model turn or launching workers. Repeating it is idempotent. Unknown arguments are rejected.

Natural-language requests use the always-active `herdr_orchestrate` tool through the same activation path; this depends on the model following its explicit-request instruction. The tool returns immediate workflow guidance; subsequent agent runs receive scoped system-prompt guidance while active. The skill is hidden from automatic model invocation so installation does not assign every worker the orchestrator role. It uses progressive disclosure: only the compact core workflow is injected; routing exceptions and recovery procedures live in one-level `references/` files with explicit read-when triggers. Injected guidance includes the skill's absolute directory so reference links work from any project cwd. Reference bodies are never eagerly injected.

- `PI_HERDR_ORCHESTRATOR=1 pi` remains an explicit opt-in for scripted orchestrator starts, including genuinely new sessions in that process. A saved `off` wins for its conversation; forks/parent-linked sessions ignore this default. Never propagate it into worker launches.
- `/orchestrate off` removes active guidance/tools and stops armed watches, including running command-watch children. It **does not quit workers** or erase prior conversation history. Resolve outstanding supervision deliberately.
- Reload/resume of the same conversation restores activation. A new conversation starts inactive unless explicitly configured; forks do not inherit activation or worker ownership. This replaces the old process-wide promotion behavior.
- **Restored role is not restored supervision.** Watches are not persisted. After reload/resume, reconcile actual worker identity and report evidence before rearming; do not assume all visible panes are owned.

Activation grants no operational permission beyond the user's request. No automatic worker launch, Git integration, task restart, push, or deployment is implemented.

## Worker routing

Policy lives in `~/.pi/agent/herdr-routing.json` (or `herdr-routing.json` under `PI_CODING_AGENT_DIR`), separate from watch settings. See [setup, schema and examples](docs/ROUTING.md). The bundled example represents Claude Code, Codex CLI, and Pi profiles; no credentials or executable shell templates belong in it. Missing/invalid configuration gives an actionable setup message rather than guessed defaults.

The agent calls `herdr_route` before every new dispatch. It rereads policy and checks exact Pi model/auth/input support. Baseline selection uses suitability, soft family shares and preference. With quota monitoring configured, `inspect` exposes subscription windows and candidate blockers; the orchestrator can select a suitable model with a reasoned `budgetChoice` rather than follow fixed shares. Claude/Codex require agent-observed native model/auth/protection evidence supplied in `externalChecks`; an unknown check is not readiness. The tool does **not** launch processes or prove a live worker's permission settings. Verify installed native flags and effective startup settings before submitting work.

`select` returns a profile, fallback information, argument array and selection ID. `record` counts that ID only after the agent reports successful dispatch with a target. Repeated records are idempotent. Previews and failed starts do not count; session-stamped assignment history survives resume but is not inherited by forks. This small history is not a task database or proof of worker ownership/completion.

Configuration edits affect the next selection without rebuilding or restarting active workers. Explicit user choices override defaults, never capability or protection requirements. Budget choices do not bypass suitability either. Family shares are soft counts of recent assignments, not spend, runtime, or forced ratios for small batches; static quota notes are not live balances.

### Subscription quotas

Optional `quota.groups` binds profiles to CodexBar subscription sources for Codex, Claude and Z.ai. Active orchestrators refresh at activation and every **30 minutes**; a shared private cache coalesces checks across sessions. Workers never poll. `/limits` displays cached readings, reset times, pacing and reserves; `herdr_route inspect` also provides recent burn and candidate eligibility. Low/constrained/unknown readings warn without waking an idle model. Confirmed subscription exhaustion can be reported immediately without another poll.

Collection supplies facts; the orchestrator judges task needs and pending work. Capability/auth/protection/exhaustion checks stay in code. No automatic purchases, account switching, policy rewrites or work invented to consume quota. Account bindings are explicit configuration, not inferred from model names or synchronized with Pi's account picker. Missing model-specific windows are unknown—not a guessed multiplier.

See [quota setup, behavior and limitations](docs/QUOTA.md). CodexBar is an optional runtime dependency, not bundled. The extension finds its macOS app helper or `codexbar` on PATH; `PI_HERDR_CODEXBAR` can select an executable.

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

Implemented and locally installed. As of 2026-09-17, 130 tests pass in 10 files; TypeScript, isolated/installed builds, and package contents are checked. A real Herdr/Pi trial verified command and natural-language activation, delegation → automatic watch wake → report verification → delivery → graceful worker exit, hot routing edits, reload/resume/new/fork behavior, and normal installed-package discovery. See [validation and trial limits](docs/VALIDATION.md).

Existing sessions must `/reload` to load this build; then use `/orchestrate`. New sessions load it normally. No push, publication, or release is implied. Historical watch evidence also covers agent-tail retrieval, wake-card delivery requests, and telemetry.

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
