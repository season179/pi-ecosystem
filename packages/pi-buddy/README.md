# @season179/pi-buddy

Gives [pi](https://github.com/badlogic/pi-mono) a sparring partner: a separate
model that discusses, debates, pushes back, and fact-checks — like a candid
senior colleague. The buddy sees the full session transcript and has
**read-only** access to the repository (`read`, `grep`, `find`, `ls`) and the
web (`lookup_docs` via DeepWiki, `read_webpage` via agent-browser). It can
verify claims against actual files and current documentation — beyond both
models' knowledge cutoffs — but it can never write, click, or act.

## How it works

**BUDDY CONSULT (agent-requested)** — the main agent calls the
`consult_buddy` tool with a stance:

| Stance | Behavior |
|---|---|
| `discuss` | Open exploration: tradeoffs, alternatives, second-order effects |
| `debate` | Steelmans the case *against* the proposal before giving a verdict |
| `fact_check` | Verifies claims against real files; cites VERIFIED / CONTRADICTED / UNVERIFIABLE |
| `review` | Quality review of recent work, ordered by severity |

**BUDDY CONSULT (user-requested)** — `/buddy <question>` asks the buddy
directly and injects the answer into the next turn for the agent to read.

**BUDDY ADVISORY (auto, watchdog)** — if the agent works 3 turns without
consulting the buddy, the buddy investigates **in the background while the
agent keeps working** — like a colleague who checks his suspicion before
interrupting. `PASS` verdicts are suppressed (no noise). Real concerns are
steered in when the verdict lands, with staleness framing (`Reviewed ~N
turn(s) ago...`); if the run already ended, the concern is queued for your
next prompt — the agent is never auto-woken.

**BUDDY ADVISORY (auto, run-end)** — runs of ≥ 2 turns that never consulted
the buddy get a quiet background review at completion (same PASS-suppression).
Together with the watchdog and requested consults, you should rarely need
`/buddy`.

**Web fact-checking** — the buddy prefers evidence in this order: repository
first, `lookup_docs` (DeepWiki, for open-source repos) second, `read_webpage`
third. `read_webpage` exposes only read verbs (open/wait/snapshot/get text) in
an isolated `pi-buddy` browser session — no click, fill, type, or eval.
Fetched web content is treated as data to evaluate, never instructions.

**Memory** — the buddy is still stateless per call, but the harness injects a
small, inspectable memory block from `~/.pi/agent/buddy-memory/`:

- `global.md` — stable notes about Season's preferences/corrections
- `projects/<slug>.md` — durable project facts not already documented in-repo

The buddy has **no write tool**. Instead, harvested consultations (`consult_buddy`
and `/buddy`) may include structured lines such as `LESSON[project]: ...` or
`RETRACT: ...`; the harness strips those lines before the agent sees the
answer, applies bounded/deduped writes, and shows a small notice. Memory notes
are injected only into requested consultations. Watchdog and run-end advisories
are never harvested and do not receive memory notes, but their last ~10 verdicts
are injected as an in-session digest so the buddy can notice its own track
record.

Curate memory with `/buddy-memory` or edit/delete lines directly. To reset a
scope: `/buddy-memory clear global` or `/buddy-memory clear project`.

## Configuration

- Default buddy model: `zai/glm-5.2`. Override: `pi --buddy-model provider/id`.
- The buddy model must exist in your pi model registry with a valid API key.

## Telemetry

Each consultation appends one JSONL record to
`~/.pi/agent/buddy-telemetry.jsonl` (local only, best-effort, never breaks a
consultation): source (`tool`/`command`/`watchdog`), stance, outcome
(`ok`/`pass`/`concern`/`error`/`discarded`), trigger (`turns`/`run_end` for
watchdog records), `turnsElapsed` (verdict staleness), rounds, tool-call
count, transcript size, provider-reported token usage, answer length, memory
block size (`memoryChars`), retry metadata (`attempts`, `retried`), harvest
counts (`lessons`, `retractions`, `retractMisses`), and duration.
`discarded` means a background verdict was dropped because the session shut
down or was replaced mid-investigation.

Token telemetry has two layers:

- `transcriptTokens` is a chars/4 heuristic for the rendered transcript only;
  it is useful as a context-pressure estimate before provider formatting.
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
  `reasoningTokens`, `totalTokens`, and `costUsd` come from pi-ai's
  provider-reported `AssistantMessage.usage`, summed across all Buddy model
  calls in the consultation. `reasoningTokens` is a subset of `outputTokens`,
  not an additive category. `finalRoundInputTokens` and
  `finalRoundTotalTokens` report only the final model call, which is useful for
  seeing how large the final tool-loop context became.

`costUsd` depends on pi-ai model pricing metadata. The default
`zai/glm-5.2` reports real token counts but currently has zero pricing metadata,
so `costUsd: 0` is expected for that model.

Health signals to watch:

- **watchdog pass:concern ratio** — mostly `pass` with occasional `concern`
  is healthy; all `concern` means it is noisy, all `pass` forever means the
  threshold or prompt needs tuning.
- **consult frequency** — no `tool` records across real sessions means the main
  agent is not consulting; strengthen `promptGuidelines`.
- **toolCalls** — frequent `fact_check`/`review` with `toolCalls: 0` means the
  buddy is armchair-guessing instead of verifying.
- **totalTokens / finalRoundTotalTokens** — provider-reported Buddy token use;
  use this to spot expensive multi-round consults and large final contexts.
- **costUsd** — only meaningful for models with nonzero pricing metadata; it is
  expected to be `0` for the default `zai/glm-5.2` model.
- **totalMs** — how much latency the buddy adds per consultation.
- **outcome: error** — surfaces failures that would otherwise be invisible
  (especially silent watchdog failures).
- **lessons per consultation** — should stay low; if it climbs, the learning
  prompt is too eager. Tune the prompt before raising caps.
- **retractMisses** — the buddy is hallucinating or misremembering a lesson;
  inspect the memory files.

```bash
# Quick look: outcomes by source
jq -r '[.source,.outcome]|join(" ")' ~/.pi/agent/buddy-telemetry.jsonl | sort | uniq -c

# Recent provider-reported token usage
jq -r '[.ts,.source,.outcome,(.totalTokens//"-"),(.finalRoundTotalTokens//"-"),(.costUsd//"-")] | @tsv' ~/.pi/agent/buddy-telemetry.jsonl | tail
```

## Development

```bash
npm run build   # compile
npm test        # build + vitest (pure logic: transcript, trimming, memory, PASS detection)
```

Smoke test in a scratch directory:

```bash
pi -e packages/pi-buddy/src/extensions/buddy.ts
```

See `PLAN.md` for the full design rationale.
