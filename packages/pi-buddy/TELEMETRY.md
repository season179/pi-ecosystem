# Buddy telemetry reference

Each consultation appends one JSONL record to `~/.pi/agent/buddy-telemetry.jsonl`
(local only, best-effort, never breaks a consultation).

## Fields

- `source` — `tool` (consult_buddy), `command` (/buddy), or `watchdog`
- `stance` — `discuss` / `debate` / `fact_check` / `review`
- `outcome` — `ok` / `pass` / `concern` / `stale_suppressed` / `error` / `discarded`
- `trigger` — `turns` or `run_end` for watchdog records
- `turnsElapsed` — verdict staleness (turns between snapshot and delivery)
- `rounds`, `toolCalls` — tool-loop depth and tool-call count
- `answerChars`, `truncated` — answer length and whether it hit the output-token cap
- `memoryChars` — injected memory block size
- `attempts`, `retried`, `modelsAttempted`, `failoverUsed`, `modelFailures` — retry/failover metadata
- `lessons`, `retractions`, `retractMisses` — memory harvest counts
- `totalMs` — consultation duration

`stale_suppressed` means an automatic concern landed too late to steer and did
not contain blocker markers. `discarded` means a background verdict was dropped
because the session shut down or was replaced mid-investigation.
Watchdog/background reviews retry once on transient provider failures before
falling back or recording an error.

## Token telemetry

Two layers:

- `transcriptTokens` is a chars/4 heuristic for the rendered transcript only;
  useful as a context-pressure estimate before provider formatting. Automatic
  watchdog/run-end reviews use a smaller recent-context transcript budget than
  requested consultations.
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
  `reasoningTokens`, `totalTokens`, and `costUsd` come from pi-ai's
  provider-reported `AssistantMessage.usage`, summed across all Buddy model
  calls in the consultation. `reasoningTokens` is a subset of `outputTokens`,
  not an additive category. `finalRoundInputTokens` and
  `finalRoundTotalTokens` report only the final model call, which is useful for
  seeing how large the final tool-loop context became.

`costUsd` depends on pi-ai model pricing metadata. The default `zai/glm-5.2`
reports real token counts but currently has zero pricing metadata, so
`costUsd: 0` is expected for that model.

## Health signals

- **watchdog pass:concern ratio** — mostly `pass` with occasional `concern`
  is healthy; all `concern` means it is noisy, all `pass` forever means the
  threshold or prompt needs tuning.
- **consult frequency** — no `tool` records across real sessions means the main
  agent is not consulting; strengthen `promptGuidelines`.
- **toolCalls** — frequent `fact_check`/`review` with `toolCalls: 0` means the
  buddy is armchair-guessing instead of verifying.
- **totalTokens / finalRoundTotalTokens** — provider-reported Buddy token use;
  use this to spot expensive multi-round consults and large final contexts.
- **truncated rate** — how often answers hit the output cap. If watchdog
  truncation climbs above ~10%, raise `outputMaxTokens.watchdog`; if mean
  `outputTokens` sits far below the cap, consider lowering it.
- **costUsd** — only meaningful for models with nonzero pricing metadata.
- **totalMs** — how much latency the buddy adds per consultation.
- **failoverUsed / modelsAttempted** — how often the configured primary model
  failed and which fallback succeeded.
- **outcome: error** — surfaces failures that would otherwise be invisible
  (especially silent watchdog failures).
- **outcome: stale_suppressed** — automatic concern suppressed for staleness;
  if this climbs, the watchdog is finding issues too late.
- **lessons per consultation** — should stay low; if it climbs, the learning
  prompt is too eager. Tune the prompt before raising caps.
- **retractMisses** — the buddy is hallucinating or misremembering a lesson;
  inspect the memory files.

## Quick queries

```bash
# Outcomes by source
jq -r '[.source,.outcome]|join(" ")' ~/.pi/agent/buddy-telemetry.jsonl | sort | uniq -c

# Recent provider-reported token usage
jq -r '[.ts,.source,.outcome,(.totalTokens//"-"),(.finalRoundTotalTokens//"-"),(.costUsd//"-")] | @tsv' ~/.pi/agent/buddy-telemetry.jsonl | tail
```
