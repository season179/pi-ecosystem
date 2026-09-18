# Buddy telemetry reference

Consultations, feedback, and lifecycle events append JSONL records to
`~/.pi/agent/buddy-telemetry.jsonl` (local only, best-effort). Every row has
`v: 1` and an ISO `ts` write timestamp. Telemetry metadata callback/write failures
never change consultation results or replace their original errors. Source-specific
outcome validation still fails the consultation when its protocol is invalid.
No raw transcript or headline payloads are added by lifecycle telemetry.

## Correlation and cadence

All record kinds may carry these fields (optional for older callers/records):

- `sessionId` — Pi's session ID, not a session path or working directory.
- `runId` — one low-level `agent_start`, not one user task. Retries and follow-ups
  are separate runs; raw input and user bash are not runs.
- `policyRevision` — currently `jev-triage-v1`; keep policy cohorts separate (including prior `held-candidate-v1` rows).
- `initialCadence` — starting cadence configured for this session (default 3).
- `effectiveCadence` — cadence when the consultation/lifecycle context was captured;
  on run summaries it is the cadence at run start.

Consultation context is copied at invocation, before any await. Explicit request
context replaces the default callback, so detached work retains its origin even
if a later run starts before it finishes. Consultation and commit rows can also
carry `originRunId` (initial investigation), `deliveryRunId` (delivery/revalidation
run), and `windowRunId` (the held candidate's single subsequent delivery window).
These are deliberately distinct; do not reattribute by completion timestamp.
The composition root captures feedback context when feedback is recorded, not
backdated to the concern's origin.

## Consultation fields

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

## Lifecycle rows

Commit rows (`type: "watchdog_commit"`) contain `outcome` (`delivered`,
`resolved`, or `deferred`), `reviewRevision`, `commitRevision`, and
`revalidationCount`. Deferred rows include `reason` (`activity` or `error`).
`delivered` means a **handoff to Pi**, not observed insertion or acceptance.
A `resolved` outcome means candidate suppression, including superseded,
irrelevant, disproved, or already-in-progress advice. It does not establish that
a defect was fixed and is not a `fixed` Concern Disposition.
`discarded` consultation outcomes mean background work was aborted (for example,
disable, session replacement, or shutdown), not that the candidate was disproved.
Watchdog/background reviews retry once on transient provider failures by default
before falling back or recording an error; configured retries can override this.

Candidate rows (`type: "watchdog_candidate"`) have `trigger`, `concernId`,
`ageMs` (candidate age at the transition), optional `originRunId`/`windowRunId`,
and a discriminated `event`:

- `held` — unvalidated candidate retained in Buddy, not delivered/open in Concern
  history. Recorded once at the transition, without a fabricated commit revision.
- `expired` — candidate released without publication; required `reason` is
  `window_closed`, `attempts_exhausted`, `session_reset`, `shutdown`, or `disabled`.
  Expiry is not a pass verdict, suppression decision, or fixed disposition.

Insertion rows (`type: "watchdog_inserted"`) contain `trigger`, `concernId`,
optional `originRunId`/`deliveryRunId`, and optional ISO `handedOffAt`.
They mean a newly handed-off `buddy-review` message was observed at `message_end`.
They do **not** prove the model/user read or accepted it. Attribution comes from
the captured handoff, never a later current-run pointer; historical messages do
not reconstruct insertion rows. Join by session and Concern ID; use the captured
delivery run where available. `ts - handedOffAt` approximates handoff-to-observation
gap, not attention time.

Run rows (`type: "buddy_run"`) require `runId`, `turns`, ISO `startedAt`/`endedAt`,
`outcome` (`ended` or `incomplete`), and `finalCadence`. `turns` counts observed
`turn_end` events. Normal `agent_end` produces one summary; teardown may close an
unfinished run once as `incomplete`. `effectiveCadence` is the start value and
`finalCadence` is the end value; neither supplies per-turn cadence exposure.

## Jev routing rows

`type: "jev_triage"` is separate from Buddy consultations and commit verdicts:

- `phase`: `periodic` (pre-investigation) or `candidate` (pre-revalidation).
- `outcome`: `skip`, `review`, `audit`, `suppress`, `fallback`, `cancelled`, or `stale`.
- `reason` when applicable: `config`, `no_key`, `error`, `deadline`, `malformed`, or `incomplete`.
- `model`: configured Jev model when configuration is valid; not the Buddy model.
- `totalMs`: routing duration, including config/key reads and the parsed-result wait.
- `opportunity`: session/tree-local periodic opportunity number, independent of candidate checks. Every `auditEvery` opportunities bypasses Jev. Off/on does not restart the audit counter.
- `concernId`: candidate identity for candidate checks, when present.
- Standard session/run/policy/cadence correlation captured before awaiting Jev.

`skip` means the periodic reviewer was not invoked; it does not mark the run
consulted, so otherwise-eligible run-end review remains available. `suppress`
means the candidate's relevance decision was accepted by the unchanged active
coordinator snapshot, releasing the slot without a full revalidation invocation.
It neither increments the held candidate's actual-review invocation budget nor
creates a Buddy `pass`, `resolved`, Concern Disposition, or `watchdog_commit` row.
It does not prove the original defect fixed. Candidate suppression proposals
invalidated before commit are `stale`, not `suppress`.

`review` routes to normal Buddy (including `incomplete` bounded context).
`audit` bypasses Jev; `fallback` preserves normal review when triage is unavailable.
`cancelled`/`stale` do not authorize replacement review calls. Disabled/missing
configuration does not emit Jev rows. SDK/request/response/provider-error bodies
are never logged; warnings contain only bounded reason codes and are shown at
most once per reason per session/tree reset. Footer and `/buddy status` show the
last state. These rows are best-effort routing observations, not provider accuracy
or a complete billing ledger; Jev token/cost totals are not currently recorded.

Keep Jev outcomes separate from consultation pass/concern/resolved ratios. Compare
actual reviewer invocations per periodic opportunity and report audits, fallback,
cancellation and stable candidate suppression separately. Skipping a call is not
proof it had no value; audits and real usage evaluation remain important.

## Token telemetry

Two layers:

- `transcriptTokens` is a chars/4 heuristic for the rendered transcript only;
  useful as a context-pressure estimate before provider formatting. Automatic
  watchdog/run-end reviews use a smaller recent-context transcript budget than
  requested consultations.
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
  `reasoningTokens`, `totalTokens`, and `costUsd` come from pi-ai's
  provider-reported `AssistantMessage.usage`, summed across the returned Buddy
  tool-loop's model calls. Failed attempts/retries do not necessarily return
  usage, so these are recorded totals, not a complete billing ledger.
  `reasoningTokens` is a subset of `outputTokens`, not an additive category. `finalRoundInputTokens` and
  `finalRoundTotalTokens` report only the final model call, which is useful for
  seeing how large the final tool-loop context became.

Missing token fields mean **unknown**, not zero. `attempts` counts consultation
attempts (including retry/failover), not every underlying tool-loop model request;
`rounds` describes the returned tool loop and is absent on failure.

`costUsd` depends on pi-ai model pricing metadata. The default `zai/glm-5.2`
reports real token counts but currently has zero pricing metadata, so
`costUsd: 0` is expected for that model.

## Health signals

- **watchdog pass:concern:resolved ratio** — describes review decisions, not
  accuracy or recall. `resolved` counts candidates suppressed by current-state
  revalidation; inspect evidence to judge whether suppression was appropriate.
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
- **totalMs** — consultation time, not measured user waiting. Detached work can
  overlap main-agent work; do not sum durations as user latency.
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

## Comparing frequency and resource use

Use `100 * count / sum(buddy_run.turns)` on a matched set of correlated runs;
report low-level run counts and incomplete-run counts alongside the denominator.
Count **all automatic consultation invocations**, including run-end reviews,
revalidations, failures and discards. Keep attempts and tool-loop rounds separate.
Compare recorded `totalTokens` and **observed insertions** per 100 turns, with
handoffs, holds, expiry and suppression reported separately. Missing token usage
must remain visible rather than being interpreted as free calls.

Split by policy and starting cadence, then inspect effective cadence at launch,
trigger, review phase and Buddy model. Run summaries have no model/per-turn cadence
exposure: model-specific numerators over cohort turns are contributions to that
cohort's rate, **not** model-specific exposure-normalized rates. Insertion rows have
no model either; join an unambiguous revalidation by session/Concern/delivery run
or report unknown. Preserve retry/failover labels; a consultation's `model` is the
successful (or last attempted) Buddy model, not the main agent's model.

Lower counts alone are not improvement: a held single slot can prevent fresh
checks, and an expired candidate may never reach the main agent. Feedback is
fixed/rebutted/**unknown**, not an accuracy, recall or benefit score. Compare
bounded evidence-backed samples separately; do not infer correctness from passes
or `resolved` rows.

### Legacy and missing-data limits

Older rows remain unchanged. Missing session/run IDs or policy/cadence metadata
are legacy/unknown; do not infer a cohort from dates, the current config, or row
order. A handoff without an insertion row has **unknown insertion**, not confirmed
non-insertion. Missing dispositions are unknown, not false positives. Missing run
summaries (including crashes or best-effort write failures) mean missing exposure;
exclude unjoinable events from normalized rates and report them separately. Do not
mix legacy raw counts with new denominators or reconstruct old runs from calls.

Telemetry cannot establish whether the model acted on an inserted warning, whether
an unreported defect existed, or how much user time Buddy saved. Optional context
or writer failures can leave gaps even on the new policy.

## Quick queries

```bash
# Outcomes by source or event type
jq -r '[.type // .source,.outcome]|join(" ")' ~/.pi/agent/buddy-telemetry.jsonl | sort | uniq -c

# Recent provider-reported token usage
jq -r '[.ts,.source,.outcome,(.totalTokens//"-"),(.finalRoundTotalTokens//"-"),(.costUsd//"-")] | @tsv' ~/.pi/agent/buddy-telemetry.jsonl | tail
```
