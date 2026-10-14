# @season179/pi-herdr

A [Pi](https://github.com/earendil-works/pi) extension with general background shell watches and conversational orchestration inside [Herdr](https://github.com/season179/herdr). `/orchestrate` supplies the workflow and one-shot non-blocking watches. The agent delegates to visible workers, reads their temporary reports, verifies delivery, and quits finished workers while keeping their panes reusable.

Each watch settles once with a fired, timeout, error, or stopped outcome. Agent and output watches run one detached `herdr agent wait` or `herdr pane wait-output` child; command watches run one detached `/bin/sh -c` child. A wake-enabled watch within budget requests a new turn while Pi is idle and is delivered as steering while Pi is busy. Otherwise its card is delivered without starting an idle turn. Explicitly stopped watches produce no card.

## Requirements and Installation

- Node.js 22 or newer.
- Pi. General shell watches do not require Herdr or orchestration activation.
- For orchestration: Herdr in the same environment on `PATH`, with its Pi integration installed (`herdr integration install pi`) for reliable agent lifecycle state.
- macOS or Linux. Command mode uses `/bin/sh -c`, and cancellation uses POSIX process-group signals. Native Windows support is not implemented or verified.

The package is not yet published to npm. From a `pi-ecosystem` checkout:

```bash
npm install
npm run build --workspace @season179/pi-herdr
pi install /absolute/path/to/pi-ecosystem/packages/pi-herdr
```

The package manifest loads `./index.js`, a stable shim that imports the compiled bundle from `dist/`. Rebuild after source changes. Compatibility was last checked against Herdr 0.8.2; no Herdr version range is enforced.

## General Shell Watches

These tools are available immediately in any Pi session, including outside Herdr:

- `shell_watch` — launch an authorized foreground `command` with a required `timeoutMs`, optional `note`, and optional `wake` (default `true`). Returns immediately; on completion delivers exit status, duration, and a bounded output tail. Continue other work or end the turn instead of polling.
- `shell_unwatch` — terminate one command by `id`, or all shell commands with `all: true`. This kills the owned process group, not just notifications; stopped watches produce no card.
- `shell_watches` — inspect shell watch records and wake budget on demand, not in a polling loop.

Example tool arguments:

```json
{
  "command": "node index.mjs export --team 'East Malaysia Team'",
  "timeoutMs": 1800000,
  "note": "Check report.json and PostgreSQL storage after completion"
}
```

Commands run under `/bin/sh -c` in the calling session's working directory, inheriting Pi's environment, with no stdin. Supply the actual foreground command, without `&` or `nohup`. These tools launch jobs; they **cannot attach to existing PIDs**. Command completion is not proof of application-level success: check the exit code and output artifacts. For complete logs, redirect output to a file; cards include only the last 10 lines, capped at 8,000 characters. Output is untrusted and may appear in session history; never print secrets.

Shell watches use the existing process manager and delivery policy, but have independent IDs, capacity, and wake counters from Herdr watches. `maxWatches` and `wakeBudget` in `herdr.json` configure both families independently (defaults: 8 concurrent jobs, 20 attempted idle wakes). Interactive/RPC input resets the budget. `wake: false` and an exhausted/zero budget still deliver a card without starting an idle turn. Shell watches do not invoke Herdr, select workers, or write Herdr telemetry. `/orchestrate off` and `herdr_unwatch` do not affect shell jobs; use `shell_unwatch` instead.

**Lifetime:** keep the Pi session open. Timeout, explicit stop, reload, session replacement, or shutdown terminate the owned process group with SIGTERM, escalating to SIGKILL after five seconds. These are session-owned bounded jobs, not durable daemons: they are not restored or automatically restarted. Print mode exits after its turn and does not keep watches alive. The report is the command's own exit: when it exits, anything still running in its process group (`cmd &`, whether or not it still holds the command's output) is terminated the same way, and the real exit code is reported, never a timeout. The watch settles once the group is empty and the output has drained, so a command with no lingering children settles immediately. Descendants that deliberately detach into their own session or process group (`setsid`, daemonizers) are out of reach and keep running unsupervised; the watch releases the output pipes they inherited after the five-second grace and settles, so they cannot block completion reports, reload, or shutdown.

**Configuration errors fail closed:** every Pi session validates `~/.pi/agent/herdr.json` on session start, with or without Herdr. An invalid file (bad JSON, unknown keys, wrong types) is reported as a session-start extension error naming the file, and the shell tools then reject every call with `no active session` until the file is fixed and the session is reloaded. Nothing launches with silently substituted defaults.

## Activation

The Herdr-specific extension registers nothing unless both `HERDR_ENV=1` and a non-empty `HERDR_PANE_ID` are present; the shell tools above are independent. In a managed Herdr pane it registers commands and handlers, but the model-facing Herdr watch tools start inactive because Pi also runs as workers, planners, and reviewers in panes.

An agent becomes the orchestrator when you explicitly ask it, for example:

> You are the orchestrator — dispatch this to the workers.

Use `/orchestrate` as the single entry point. It activates the bundled [workflow](skills/orchestration/SKILL.md), `herdr_select`, `herdr_watch`, `herdr_unwatch`, and `herdr_watches`, without starting a model turn or launching workers. Repeating it is idempotent. Unknown arguments are rejected.

Natural-language requests use the always-active `herdr_orchestrate` tool through the same activation path; this depends on the model following its explicit-request instruction. The tool returns immediate workflow guidance; subsequent agent runs receive scoped system-prompt guidance while active. The skill is hidden from automatic model invocation so installation does not assign every worker the orchestrator role. It uses progressive disclosure: only the compact core workflow is injected; recovery procedures live in a `references/` file with explicit read-when triggers. Injected guidance includes the skill's absolute directory so reference links work from any project cwd. Reference bodies are never eagerly injected.

- `PI_HERDR_ORCHESTRATOR=1 pi` remains an explicit opt-in for scripted orchestrator starts, including genuinely new sessions in that process. A saved `off` wins for its conversation; forks/parent-linked sessions ignore this default. Never propagate it into worker launches.
- `/orchestrate off` removes active guidance/tools and stops armed watches, including running command-watch children. It **does not quit workers** or erase prior conversation history. Resolve outstanding supervision deliberately.
- Reload/resume of the same conversation restores activation. A new conversation starts inactive unless explicitly configured; forks do not inherit activation or worker ownership. This replaces the old process-wide promotion behavior.
- **Restored role is not restored supervision.** Watches are not persisted. After reload/resume, reconcile actual worker identity and report evidence before rearming; do not assume all visible panes are owned.

Activation grants no operational permission beyond the user's request. No automatic worker launch, Git integration, task restart, push, or deployment is implemented.

## Worker Selection

The active orchestrator calls `herdr_select` before choosing between inline work and delegation, and again before each new worker launch. The tool launches nothing. It does not poll or cache quota.

Two TypeSafe Jev requests decide:

1. A task profile: difficulty, quick-inline probability, and whether the task needs images.
2. An allocation choice across inline work, every valid worker, `cannot_select`, and `needs_context`.

Jev weighs the tradeoffs: task fit, user preferences, capacity, reset timing, and the context cost of inline work. Code does four things only:

- It supplies exact facts.
- It checks Jev's answers.
- It enforces hard constraints: explicit `allowedOptions`, a known vision requirement, a missing catalog entry or auth, a missing `claude` executable, confirmed quota exhaustion, and the same model as the work under review/discussion/debate.
- It maps the chosen option to a launch model and harness defaults.

There is no score or pacing formula. `cannot_select` and `needs_context` are valid answers. Only a `failed` outcome allows a manual choice, for example when Jev is unavailable or the tool has a bug.

The workers are:

- Pi + `openai-codex/gpt-6.1-sol`.
- Claude Code + `claude-opus-5-5`.

Both are preferred defaults for most work, including easy work.

A premium model may take easy work. Each selection runs a fresh check of the Codex, Claude and Z.ai quota tools. A failed check counts as unknown capacity, not zero. Model identity ignores harness and provider prefixes. An ambiguous alias of the reviewed model is excluded conservatively. When launching a Pi worker, always use a provider-qualified model ID from the current Pi catalog and confirm the first prompt is processed: a bare model pattern can match an unauthenticated provider and leave the worker at a login prompt.

Claude Code launch suggestions default to `--permission-mode auto`. The orchestrator should normally use it, replacing that flag if the user requests another mode or environment policy prohibits auto. Auto retains permission checks; it is not `bypassPermissions`. Verify the effective mode after launch because auto may be unavailable. For a worker it is authorized to control, the orchestrator may choose the visible "Yes, and switch to auto mode" option after checking that the pending action is authorized; this also approves that action. Classifier denials, approval pauses, and policy restrictions must be inspected, not bypassed. No global Claude settings are changed. See [Claude's permission modes](https://code.claude.com/docs/en/permission-modes).

Jev settings follow the shared `~/.pi/agent/typesafe.json` convention (`model`, default `jev-1.13.0`; `timeoutMs`, default 3000 and at most 30000; `apiKeyFile`). `TYPESAFE_API_KEY` takes precedence. Requests go only to `https://api.typesafe.ai/v1/systemone` with bounded bodies and at most one retry. The whole call has a 30-second deadline and supports cancellation; a `timeoutMs` near 30000 leaves no time for the retry inside it. Error messages are fixed and never include keys or provider bodies.

Routing policies, `herdr_route`, `/limits` and quota caches were removed. Legacy files are ignored. Resumed sessions still filter automatic quota messages persisted by older versions.

`codex_quota` (available in managed panes) and `/codex-quota` read current usage using `$CODEX_HOME/auth.json`, or `~/.codex/auth.json`. Each call queries OpenAI's internal endpoint with a ten-second timeout; tool calls support cancellation. Missing credentials, invalid responses, and request failures are reported as errors. There is no polling, cache, or token refresh.

`claude_quota` and `/claude-quota` similarly report Claude's five-hour, weekly, and scoped model limits with absolute reset times. The default macOS login is read from Keychain (`Claude Code-credentials`); other platforms and custom `CLAUDE_CONFIG_DIR` profiles use `.credentials.json`. Custom profiles require that file and never fall back to the default account. Checks time out after ten seconds (Keychain reads after five), support tool cancellation, and report rate-limited requests as unavailable. No polling or token refresh.

`zai_quota` and `/zai-quota` read personal Z.ai Coding Plan usage from `api.z.ai`, using Pi's configured `zai` credentials. Coding windows and monthly MCP calls are reported separately, with server percentages and absolute reset times. The ten-second check supports tool cancellation; failed requests remain unavailable. No polling, caching, or team/China endpoint support.

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

Automated checks cover activation, session recovery, watch delivery and bundle reloads. An offline check against a real Pi SDK (the workspace devDependency by default, currently 1.0.1; `PI_SDK_ROOT` selects another install, and it has also passed against the managed Pi 1.1.0 install) verifies that the built bundle exposes shell tools outside Herdr, returns before command completion, and delivers exit status/output once while waking an idle session (synthetic model, no network calls). Live trials have covered selected Herdr/Pi paths only; see the limits below.

### Code activation: rebuild + `/reload`

The extension entry (`index.js`) is a stable shim that fingerprints the single-file bundle (`dist/herdr.bundle.js`, built by `npm run build`) by content and imports it under a query-busted URL. Pi's `/reload` re-invokes the factory, so a rebuilt bundle goes live in the same process; an unchanged bundle reuses the cached module graph. Pi's loader delegates `"type":"module"` `.js` entries to Node's process-wide ESM cache, which is why the runtime must be one bundle file behind a tiny, never-edit shim.

- Sessions started with the shim entry pick up every rebuild via `/reload` — no restart.
- Sessions still running a pre-2026-09-18 static entry module keep old code even after `/reload` (Node pins their entry module for the process lifetime): they need **one restart** to adopt the shim, after which reload works.
- Editing `index.js` itself always requires a restart; it is designed not to need further edits.

Note: `tsc` still emits the per-file tree under `dist/` (types, `.d.ts`, and legacy layout), but only `dist/herdr.bundle.js` is loaded at runtime. Debug the bundle/source, not `dist/extensions/herdr.js`.

Existing sessions must `/reload` to load this build. Shell tools are then available immediately; use `/orchestrate` only for worker orchestration. New sessions load it normally. No push, publication, or release is implied. Historical watch evidence also covers agent-tail retrieval, wake-card delivery requests, and telemetry.

Not yet verified live: `/watches` interaction, state-triggered notifications, output-mode watches, current wake-budget exhaustion UX, and SIGTERM→SIGKILL escalation. Output-card parsing covers Herdr 0.8.2's documented `result.matched_line` field in unit tests, but output mode remains unverified against a live 0.8.2 process.

## Local Development

From the repository root:

```bash
npm run build --workspace @season179/pi-herdr
npm test --workspace @season179/pi-herdr
# Offline real-SDK check: built bundle + idle wake, no external model calls.
# Default SDK: the workspace devDependency under node_modules (prints the version it used).
PI_OFFLINE=1 node packages/pi-herdr/scripts/check-shell-sdk.mjs
# Another installed Pi, such as the managed install the `pi` binary runs:
PI_SDK_ROOT=~/.pi/agent/install/releases/1.1.0/node_modules PI_OFFLINE=1 node packages/pi-herdr/scripts/check-shell-sdk.mjs
npm pack --workspace @season179/pi-herdr --dry-run
```

## Security

Pi extensions and watched commands execute with your user permissions. Agent/output targets, notes, outcomes, and bounded evidence may be persisted in Pi sessions and local telemetry. Command text/output is excluded from telemetry but can appear in persisted cards as described above. Watches are orchestration aids, not a sandbox or authorization boundary. `herdr_select` sends a bounded excerpt of the task and context, model labels, and quota percentages and reset times to TypeSafe. It never sends credentials.

## License

MIT — see the repository [LICENSE](https://github.com/season179/pi-ecosystem/blob/main/LICENSE).
