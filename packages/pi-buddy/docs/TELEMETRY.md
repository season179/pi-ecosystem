# Buddy telemetry reference

Each consultation appends one JSONL record to `~/.pi/agent/buddy-telemetry.jsonl`
(local only, best-effort, never breaks a consultation).

## Fields

- `source` — `tool` (consult_buddy), `command` (/buddy), or `watchdog`
- `stance` — requested stance, `watchdog`, or `watchdog-revalidation`
- `outcome` — `ok` / `pass` / `concern` / `resolved` / `error` / `discarded`
- `trigger` — `turns` or `run_end` for watchdog records
- `turnsElapsed` — turns completed while the initial detached review was running
- `reviewPhase` — `review` for the initial candidate or `revalidation` for the commit check
- `reviewRevision`, `revalidationRevision`, `revalidationCount` — activity revisions and attempt count for the versioned watchdog protocol
- `rounds`, `toolCalls` — tool-loop depth and tool-call count
- `answerChars`, `truncated` — answer length and whether it hit the output-token cap
- `memoryChars` — injected durable-memory block size
- `concernId` — ID of the watchdog candidate/concern: present on initial-review rows with a `concern` outcome and on all revalidation rows, including `resolved` rows where the candidate was suppressed rather than delivered
- `openConcerns`, `fixedConcerns`, `rebuttedConcerns` — session concern-history counts injected into the consultation
- `concernHistoryChars` — size of the injected concern-history digest
- `attempts`, `retried`, `modelsAttempted`, `failoverUsed`, `modelFailures` — retry/failover metadata
- `lessons`, `retractions`, `retractMisses` — memory harvest counts
- `totalMs` — consultation duration

Feedback rows (`type: "feedback"`) may also contain `concernId` and
`concernDisposition` (`fixed` or `rebutted`) when the agent records how a
watchdog concern was settled.

Commit rows (`type: "watchdog_commit"`) contain `outcome` (`delivered`,
`resolved`, or `deferred`), `reviewRevision`, `commitRevision`, and
`revalidationCount`. Deferred rows include `reason` (`activity` or `error`).
`discarded` consultation outcomes mean a background verdict was dropped because
the session shut down or was replaced mid-investigation.
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

- **watchdog pass:concern:resolved ratio** — mostly `pass` with occasional
  `concern` is healthy; `resolved` measures candidates correctly suppressed by
  current-state revalidation.
- **watchdog_commit deferred rate** — frequent `activity` deferrals indicate
  reviews are colliding with active work; every eventual delivery should have a
  stable commit revision.
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
- **concern dispositions** — audit whether concerns are marked fixed or rebutted,
  and whether later advisories repeat an issue whose disposition was already in
  the injected history.
- **lessons per consultation** — should stay low; if it climbs, the learning
  prompt is too eager. Tune the prompt before raising caps.
- **retractMisses** — the buddy is hallucinating or misremembering a lesson;
  inspect the memory files.

## Quick queries

```bash
# Outcomes by source or event type
jq -r '[.type // .source,.outcome]|join(" ")' ~/.pi/agent/buddy-telemetry.jsonl | sort | uniq -c

# Recent provider-reported token usage
jq -r '[.ts,.source,.outcome,(.totalTokens//"-"),(.finalRoundTotalTokens//"-"),(.costUsd//"-")] | @tsv' ~/.pi/agent/buddy-telemetry.jsonl | tail
```
