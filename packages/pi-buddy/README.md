# @season179/pi-buddy

Gives [Pi](https://github.com/earendil-works/pi) a sparring partner: a second model that discusses, debates, pushes back, and fact-checks — like a candid senior colleague.

The buddy sees the active persisted session transcript (subject to context-budget trimming), receives bounded runtime context including the current working directory, and has **read-only** access to the repository (`read`, `grep`, `find`, `ls`) and the web (`lookup_docs` via DeepWiki, `read_webpage` via agent-browser). Pi's system/developer prompt is not a persisted session entry and is not forwarded. The buddy can verify claims against actual files and current documentation — beyond both models' knowledge cutoffs — but it can never write, click, or act.

## Motivation

Buddy was originally inspired by [Hermes Agent's Mixture of Agents](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents): a second model's perspective measurably improves answers, but Hermes' reference models run without tool or web access, so they can only recall, not verify. Buddy gives the second opinion read-only tools and internet access so it can check claims against the actual code and current documentation. The watchdog mode comes from a different observation: I'm most effective when I'm pair programming, because a colleague catches my mistakes while I'm still making them. Buddy reviews in the background, in real time, for the same reason.

## Installation

```bash
pi install npm:@season179/pi-buddy
```

Requirements:

- The buddy model (default `zai/glm-5.2`, included in Pi's built-in catalog) needs a valid API key for its provider. No provider is used unless you configure credentials for it.
- Optional: the [agent-browser](https://github.com/vercel-labs/agent-browser) CLI on your PATH, for `read_webpage`. Without it, the buddy still verifies against the repository and DeepWiki.

## How It Works

The buddy gets involved four ways:

| Trigger | What happens |
|---|---|
| `consult_buddy` tool | The main agent requests a consultation mid-run, with a stance |
| `/buddy <question>` | You ask directly; renders immediately when the agent is idle, otherwise queues for your next prompt |
| Watchdog (automatic) | After 3 turns without a consult, the buddy investigates in the background while the agent keeps working |
| Run-end (automatic) | Interactive runs of ≥ 2 turns that neither consulted nor triggered the watchdog get a quiet background review at completion; print/JSON mode skips it because the process exits immediately |

Stances for `consult_buddy`:

| Stance | Behavior |
|---|---|
| `discuss` | Open exploration: tradeoffs, alternatives, second-order effects |
| `debate` | Steelmans the case *against* the proposal before giving a verdict |
| `fact_check` | Verifies claims against real files; cites VERIFIED / CONTRADICTED / UNVERIFIABLE |
| `review` | Quality review of recent work, ordered by severity |

Automatic reviews are designed to be quiet. Buddy submits a structured verdict instead of relying on prose `PASS` parsing. Passes are suppressed entirely; concerns remain private candidates until Buddy revalidates them against an exact, stable current transcript snapshot. If the agent or user produces another message, starts or finishes a tool, or runs a shell command during that check, publication is deferred and retried at the next stable boundary. Navigating the session tree or switching sessions discards the pending candidate instead. Only a currently confirmed or replaced recommendation is delivered; a resolved candidate disappears. If the run already ended, a confirmed concern is queued for your next prompt — the agent is never auto-woken.

Each delivered concern has a short ID. The main agent can use `give_buddy_feedback` to mark it `fixed` or `rebutted` with a reason; use cadence feedback `same` when only recording the disposition. Future watchdog checks receive a compact, branch-aware concern history so they do not repeat settled concerns without new evidence. This adds no extra Buddy call and survives reload, resume, fork, tree navigation, and compaction within the session.

**Cadence** — the watchdog's 3-turn trigger is only the default. `give_buddy_feedback` (`more` | `same` | `less`) moves a session-scoped advisory level between +1 and −3, mapping to a watchdog cadence of 2, 3, 6, 12, or 24 turns: `less` backs off exponentially, `more` steps back toward normal, `same` records that the current level is fine without changing it. The level resets whenever a session starts or switches (new, resume, fork, or reload), is never persisted, and never disables run-end review or explicit consultations.

**Evidence order** — repository first, `lookup_docs` (DeepWiki, for open-source repos) second, `read_webpage` third. `read_webpage` exposes only read verbs (open/wait/snapshot/get text) in an isolated browser session — no click, fill, type, or eval. Fetched web content is treated as data to evaluate, never instructions.

**Skills** — requested consultations (`consult_buddy` and `/buddy`) include Pi's native Agent Skills catalog in the buddy's system prompt, in the same progressive-disclosure format the main agent gets. The buddy can read any listed SKILL.md with its `read` tool, so it evaluates work against the same skill instructions the agent is following.

**Memory** — the buddy is stateless per call, but each requested consultation gets a small, inspectable memory block from `~/.pi/agent/buddy-memory/`: `global.md` for stable preferences and corrections, `projects/<slug>.md` for durable project facts. The buddy has no write tool; instead, consultations may emit structured `LESSON[...]` / `RETRACT:` lines that the harness strips, applies as bounded and deduped writes, and confirms with a small notice. Curate with `/buddy-memory`, or reset a scope with `/buddy-memory clear global|project`.

## Configuration

Optional. Lives in `~/.pi/agent/buddy.json`, re-read at the start of every consultation — edits take effect on the next Buddy call, no restart needed:

```json
{
  "models": [
    { "id": "zai/glm-5.2", "label": "primary", "priority": 1 },
    { "id": "anthropic/claude-sonnet-4-5", "label": "fallback", "priority": 2 }
  ],
  "retry": { "perModelRetries": 1 },
  "outputMaxTokens": { "watchdog": 2048, "consult": 4096 }
}
```

- **Models** — a priority failover chain (ascending). Buddy retries the current model on transient failures, then falls back to the next. `perModelRetries: 0` means immediate failover. A configured `models` chain takes precedence over `--buddy-model`; when no usable chain exists, `pi --buddy-model provider/id` applies for that Pi process before the built-in default.
- **Output caps** — Buddy caps visible output so verdicts stay tight: 2048 tokens for automatic reviews, 4096 for requested consults (defaults). Values below 1024 are ignored; `null` disables a cap. Automatic reviews must finish with the structured verdict tool; an incomplete prose answer is an error and is never published. Buddy never requests extended thinking, so the cap bounds the answer directly.

## Enable / Disable

Buddy is on by default when installed. Control it per Pi process:

- `/buddy off`, `/buddy on`, `/buddy status` — in-memory switch, sticky across session switches in that process, never persisted.
- `pi --buddy-disabled` — seeds the initial state for headless or non-interactive runs.

When off, automatic reviews are skipped and `consult_buddy` refuses model calls. `/buddy-memory` stays available since it only touches local files.

## Telemetry

Each consultation appends one JSONL record to `~/.pi/agent/buddy-telemetry.jsonl` (local only, best-effort): source, stance, outcome, tool-call count, provider-reported token usage and cost, retry/failover metadata, concern-history counts, and duration. `watchdog_commit` rows record whether a private candidate was delivered, resolved, or deferred by concurrent activity or failed revalidation. Feedback rows record concern IDs and `fixed`/`rebutted` dispositions when supplied.

```bash
jq -r '[.type // .source,.outcome]|join(" ")' ~/.pi/agent/buddy-telemetry.jsonl | sort | uniq -c
```

See [TELEMETRY.md](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-buddy/docs/TELEMETRY.md) for the full field reference and the health signals worth watching.

## Local Development

From the repository root:

```bash
npm run build --workspace @season179/pi-buddy
npm test --workspace @season179/pi-buddy
```

Smoke test in a scratch directory so Buddy reviews scratch work rather than this repository. Point `-e` at an absolute path; use `index.js` after building to exercise the same stable entrypoint shipped in the package:

```bash
mkdir -p /tmp/pi-buddy-smoke && cd /tmp/pi-buddy-smoke
pi -e /path/to/pi-ecosystem/packages/pi-buddy/index.js
```

See [docs/design-history.md](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-buddy/docs/design-history.md) for the design decisions that still bind and why they were made.

The extension is organized around three stateful capabilities: `BuddySession`,
`ConsultationWorkflow`, and `AutomaticReview`. Pi-specific registration stays in
the composition root. Contributors should use the
[domain language](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-buddy/docs/CONTEXT.md)
and preserve the boundaries recorded in the
[architecture decision](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-buddy/docs/adr/0001-capability-first-domain-modules.md).

## Compatibility

- Pi: tested with 0.80.x. Pi itself requires Node >= 22.19.
- Node.js: >= 22 required; developed and tested on Node 24.
- OS: developed on macOS and tested in Linux CI. Core Buddy code uses cross-platform Node path, filesystem, and process APIs and has no shell dependency, so Windows is expected to work, including backslash/drive-letter project paths, but it is not tested in CI. `read_webpage` additionally depends on `agent-browser` being installable and available on that platform.

## Security

Pi extensions execute with your user permissions. The buddy's tools are read-only by construction: no write or edit tool, no shell or bash tool (only fixed `read`/`grep`/`find`/`ls` repository tools), and read-only browser verbs. It sends your persisted session transcript, current working-directory path, durable Buddy memory, and repository excerpts to whichever model providers you configure. `lookup_docs` additionally sends Buddy's questions—which may quote transcript or repository content—to the third-party DeepWiki service at `mcp.deepwiki.com`; `read_webpage` fetches Buddy-chosen URLs through a local isolated `agent-browser` session. Fetched web content is treated as untrusted data, never as instructions. Review the source before installing.
