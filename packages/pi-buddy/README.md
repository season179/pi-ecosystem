# @season179/pi-buddy

Gives [Pi](https://github.com/badlogic/pi-mono) a sparring partner: a second model that discusses, debates, pushes back, and fact-checks — like a candid senior colleague.

The buddy sees the full session transcript and has **read-only** access to the repository (`read`, `grep`, `find`, `ls`) and the web (`lookup_docs` via DeepWiki, `read_webpage` via agent-browser). It can verify claims against actual files and current documentation — beyond both models' knowledge cutoffs — but it can never write, click, or act.

## Motivation

Buddy was originally inspired by [Hermes Agent's Mixture of Agents](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents): a second model's perspective measurably improves answers, but Hermes' reference models run without tool or web access, so they can only recall, not verify. Buddy gives the second opinion read-only tools and internet access so it can check claims against the actual code and current documentation. The watchdog mode comes from a different observation: I'm most effective when I'm pair programming, because a colleague catches my mistakes while I'm still making them. Buddy reviews in the background, in real time, for the same reason.

## Installation

```bash
pi install npm:@season179/pi-buddy
```

Requirements:

- The buddy model (default `zai/glm-5.2`) must exist in your Pi model registry with a valid API key. No provider is used unless you configure it.
- Optional: the [agent-browser](https://github.com/vercel-labs/agent-browser) CLI on your PATH, for `read_webpage`. Without it, the buddy still verifies against the repository and DeepWiki.

## How It Works

The buddy gets involved four ways:

| Trigger | What happens |
|---|---|
| `consult_buddy` tool | The main agent requests a consultation mid-run, with a stance |
| `/buddy <question>` | You ask directly; renders immediately when the agent is idle, otherwise queues for your next prompt |
| Watchdog (automatic) | After 3 turns without a consult, the buddy investigates in the background while the agent keeps working |
| Run-end (automatic) | Runs of ≥ 2 turns that never consulted get a quiet background review at completion |

Stances for `consult_buddy`:

| Stance | Behavior |
|---|---|
| `discuss` | Open exploration: tradeoffs, alternatives, second-order effects |
| `debate` | Steelmans the case *against* the proposal before giving a verdict |
| `fact_check` | Verifies claims against real files; cites VERIFIED / CONTRADICTED / UNVERIFIABLE |
| `review` | Quality review of recent work, ordered by severity |

Automatic reviews are designed to be quiet. Buddy submits a structured verdict instead of relying on prose `PASS` parsing. Passes are suppressed entirely; concerns remain private candidates until Buddy revalidates them against an exact, stable current transcript snapshot. If the agent or user produces another message, starts or finishes a tool, runs a shell command, or changes the session tree during that check, publication is deferred and retried at the next stable boundary. Only a currently confirmed or replaced recommendation is delivered; a resolved candidate disappears. If the run already ended, a confirmed concern is queued for your next prompt — the agent is never auto-woken.

Each delivered concern has a short ID. The main agent can use `give_buddy_feedback` to mark it `fixed` or `rebutted` with a reason, independently of cadence feedback. Future watchdog checks receive a compact, branch-aware concern history so they do not repeat settled concerns without new evidence. This adds no extra Buddy call and survives reload, resume, fork, tree navigation, and compaction within the session.

**Evidence order** — repository first, `lookup_docs` (DeepWiki, for open-source repos) second, `read_webpage` third. `read_webpage` exposes only read verbs (open/wait/snapshot/get text) in an isolated browser session — no click, fill, type, or eval. Fetched web content is treated as data to evaluate, never instructions.

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

- **Models** — a priority failover chain (ascending). Buddy retries the current model on transient failures, then falls back to the next. `perModelRetries: 0` means immediate failover. For a single-session override, use `pi --buddy-model provider/id`.
- **Output caps** — Buddy caps visible output so verdicts stay tight: 2048 tokens for automatic reviews, 4096 for requested consults (defaults). Values below 1024 are ignored; `null` disables a cap. Automatic reviews must finish with the structured verdict tool; an incomplete prose answer is an error and is never published. Buddy never requests extended thinking, so the cap bounds the answer directly.

## Enable / Disable

Buddy is on by default when installed. Control it per Pi process:

- `/buddy off`, `/buddy on`, `/buddy status` — in-memory switch, sticky across session switches in that process, never persisted.
- `pi --buddy-disabled` — seeds the initial state for headless or non-interactive runs.

When off, automatic reviews are skipped and `consult_buddy` refuses model calls. `/buddy-memory` stays available since it only touches local files.

## Telemetry

Each consultation appends one JSONL record to `~/.pi/agent/buddy-telemetry.jsonl` (local only, best-effort): source, stance, outcome, tool-call count, provider-reported token usage and cost, retry/failover metadata, concern-history counts, and duration. `watchdog_commit` rows record whether a private candidate was delivered, resolved, or deferred by concurrent activity. Feedback rows record concern IDs and `fixed`/`rebutted` dispositions when supplied.

```bash
jq -r '[.source,.outcome]|join(" ")' ~/.pi/agent/buddy-telemetry.jsonl | sort | uniq -c
```

See [TELEMETRY.md](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-buddy/TELEMETRY.md) for the full field reference and the health signals worth watching.

## Local Development

```bash
npm run build   # compile
npm test        # vitest (pure logic: transcript, trimming, memory, watchdog commit races)
```

Smoke test from the repo, in a scratch directory:

```bash
pi -e packages/pi-buddy/src/extensions/buddy.ts
```

See [PLAN.md](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-buddy/PLAN.md) for the full design rationale.

The extension is organized around three stateful capabilities: `BuddySession`,
`ConsultationWorkflow`, and `AutomaticReview`. Pi-specific registration stays in
the composition root. Contributors should use the
[domain language](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-buddy/CONTEXT.md)
and preserve the boundaries recorded in the
[architecture decision](https://github.com/season179/pi-ecosystem/blob/main/packages/pi-buddy/docs/adr/0001-capability-first-domain-modules.md).

## Compatibility

- Pi: tested with 0.80.x. Pi itself requires Node >= 22.19.
- Node.js: >= 22 required; developed and tested on Node 24.
- OS: developed and tested on macOS only. Nothing is intentionally platform-specific, but Linux and Windows are untested.

## Security

Pi extensions execute with your user permissions. The buddy's tools are read-only by construction — no write or edit, read-only shell commands, read-only browser verbs — but it sends your session transcript and repository excerpts to whichever model providers you configure. Fetched web content is treated as untrusted data, never as instructions. Review the source before installing.
