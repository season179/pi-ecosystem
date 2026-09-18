# Pi compaction — build-first plan

Status: **build-first revision agreed by the coordinator and Claude Fable 5.1
on 2026-09-18: build the real extension, use it, and iterate. No separate
feasibility phase or go/no-go gate. Implementation authorized, including local
telemetry from the first usable version.**

After the user rejected the up-front feasibility phase, the coordinator revised
the delivery sequence and discussed that exact revision with Claude again.
Both agree on the build-first plan below.

## Goal

Build a fresh `@season179/pi-compaction` package in pi-ecosystem. Do not import
or copy local pi-jev. No dependency on or coupling with pi-memory.

Jev identifies stale tool calls/results. Prune those while keeping surviving
conversation text verbatim, deferring Pi's generated summary while pruning
suffices. Keep originals in the session archive for recall and restore.

Inspiration: [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction/tree/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0).
This is not a promise of never summarising, perfect semantic retention, a
particular compression ratio, or lower total cost. Find out through real use.

## Delivery: build → use → improve

### 1. Build the working extension end to end

Create the workspace package and connect candidate selection, conversation
skeleton, Jev scoring, paired-call/result pruning, threshold handling and
context replay. Include branch-local persistence, recall/restore, on/off and
basic status in the first usable version.

Start with the user's actual Pi runtime and current provider (OpenAI Codex),
not an all-provider feasibility matrix. Resolve actual API problems while
implementing. Raise concrete blockers when encountered, not hypothetical ones
as a separate project before building.

Write focused tests alongside the production code for pairing, preserved
narrative, request validation, cancellation and compaction fallback. No separate
prototype, research phase or written go/no-go prerequisite.

### 2. Install and use it in real Pi sessions

When implementation is authorized, build, install locally and verify activation.
Exercise actual Jev scoring and ordinary coding work using explicitly permitted
session data. Observe whether pruning defers summaries, whether the coding model
retains useful context, and whether recall and fallback work. Do not wait for a
bespoke offline evaluation harness before the first real trial.

Expose local diagnostics: decisions, before/after context estimates, provider
usage/cache hits, scoring latency, API usage/cost when available, recall calls
and fallback reasons. Do not log private session payloads. Label estimates as
estimates rather than provider measurements.

### 3. Fix and tune from observed behaviour

Tune selection, thresholds, headroom and batching using actual sessions and
failures. Turn discovered regressions into focused tests. Compare with vanilla
Pi on similar coding work: correctness, summary frequency, latency and total
cost matter—not just token reduction.

Exercise resume, fork, sibling branches, post-summary recovery and noninteractive
modes in the real implementation. Expand provider coverage and polish controls
as needed. Consider idle pre-emption later if real use justifies moving scoring
latency out of the turn; it is not another initial mode.

### 4. Finish package integration

Complete README, root build/test/pack wiring and real-interface validation.
Report what is implemented, installed and actually observed, plus limitations
and reload/new-session requirements. Choose CalVer at release time. No automatic
publishing or pushing.

## Local telemetry from the first usable version

Telemetry is part of implementation, not a later evaluation project. Store
bounded structured metadata locally with private permissions and retention limits;
never automatically upload it or record conversation bodies, commands, paths,
credentials or raw error responses. Offer explicit metadata export.

Record events for session/mode, committed scoring pass, subsequent provider
request outcome, summary, recall/restore, explicit feedback and error. Carry opaque
session/pass IDs, model/provider, extension version and configuration fingerprint.
Use bounded allowlisted fields rather than accepting arbitrary objects.

Measure:

- Candidates, keep/drop decisions and exclusion reasons; estimated reduction.
- Subsequent actual provider usage and context-window fraction; discrepancy from
  the pruned-payload estimate, with uncertainty clearly labelled.
- Scoring request counts and median/p95 latency; input/output/cache tokens and
  derived costs only when usage and pricing are available. Missing is not zero;
  token-price estimates are not subscription invoices or measured net savings.
- Time/turns from pruning to the next summary, sample sizes and unfinished
  observations. Repeated threshold checks are not multiple summaries avoided.
- Fallback/error reason histograms; recall, restore and disable events linked to
  relevant passes. These are clues, not automatic bad-prune labels.
- Explicit `/compaction feedback bad-prune [pass]` for user-visible failures.
  It records a label and IDs without storing a narrative in the telemetry log.

Provide `/compaction report 7d` with counts, distributions, limitations and
observational pruning-on/off comparisons when both have been used. Compare
similar workloads and model/config versions; do not present this as a controlled
A/B test. Baseline collection does not require a shadow-mode rollout first.
Telemetry failure must not break coding; reports should expose collection gaps.

Use the report to guide fixes: low reduction → selection/scoring; slow passes →
batching/payload/deadlines; higher cost despite smaller requests → cache behaviour
and scoring overhead; estimator drift → pressure accounting; explicit bad prunes
→ inspect the corresponding local session decisions and add regression tests.
Low recall alone is not evidence of correct pruning.

## Architecture retained from the debate

Use ordinary modules, not a framework:

- **Policy/transform:** completed tool pairs, skeleton construction, stable
  identities, decisions, transformations and outgoing-size estimation.
- **Jev transport:** bounded requests, two keep-questions per candidate,
  validated responses, deadlines and cancellation.
- **Pi adapter:** pressure hooks, persisted branch-local decisions, context
  replay, controls and archive recovery.

### Scoring and transformations

- Send an ordered conversation skeleton: permitted narrative and bounded call
  arguments; replace output bodies with metadata. No full-output uploads or
  second-stage output excerpts initially.
- Ask whether the call and its full result must remain. Actions: keep the pair,
  replace a result with a recovery placeholder, or remove a completed pair.
- Preserve user/assistant narrative, recent complete turns, pins, instruction
  material and provider-atomic blocks. Retain ambiguous/incomplete pairs and
  unsupported multimodal groups. Do not break tool-call/result validity.
- Fit requests within verified service limits. If fitting or redaction removes
  essential decision context, skip the affected scoring rather than pretending
  the remaining skeleton is complete.
- Thresholds are tunable implementation choices. Neither the original's 0.5
  keep threshold nor pi-jev's 0.95 drop threshold is proven safety calibration.

### Pi pressure handling

Investigated runtime: **Pi 0.85.1**; workspace dependencies resolved to **0.80.10**
at investigation time. Target the actual runtime and declare the package's
minimum version without incidentally upgrading unrelated packages.

- `context` supports a non-destructive outgoing-message transform. Replay saved
  decisions locally here; no network scoring on ordinary requests.
- Score in `session_before_compact` on **threshold** pressure, before `context`.
  The public compaction return contract is summary plus `firstKeptEntryId`, not
  arbitrary replacement messages. Our design is an outgoing overlay, not
  canonical history replacement. Provider usage reflects the pruned request,
  so this can genuinely defer later summary pressure.
- Cancel threshold compaction only when a committed pass is newer than the
  triggering provider-usage observation and the current pruned request fits
  the headroom budget. Use causal identities, not timestamps alone.
- Post-run and prompt-time checks may reuse one pass against the same stale
  observation while the payload fits. A later provider response invalidates
  that pass as cancellation evidence. Without fresh eligible evidence for a
  new pass, continuing pressure falls through to normal compaction.
- Account for model window, output reservation, system/tool overhead, trailing
  messages and uncertainty. Unknown accounting means normal fallback.
- Never score or cancel manual `/compact` or overflow recovery. Leave Pi's
  compaction setting unchanged. Default summarisation receives originals.
- Do not add a custom summariser, shift summary boundaries, flatten history
  into a fake summary, monkeypatch private Pi methods or disable compaction.

### Persistence, recovery and controls

- Persist applied decisions and pins as versioned custom session entries on
  the current branch. Keep score caches separate; cached probabilities are
  not fresh evidence for a different task. New user turns do not automatically
  resurrect every omitted output; recall/pins override applied decisions.
- Commit only if session, branch generation, candidates, configuration and
  cancellation state still match the scored snapshot. Discard stale work.
- Use session entry IDs for archive identity and tool-call IDs for pairing.
  Cloned context messages have no entry IDs; build archive mappings from branch
  entries and retain duplicated/unmatched tool-call IDs.
- `compaction_recall` supports bounded list/search/read, including originals
  older than a Pi summary while they remain in the branch. Reading pins the
  original. Deleted pairs must be discoverable without a placeholder ID.
- Static tool guidance explains omissions and recovery; result placeholders
  include archive IDs. No changing per-turn omission-count prompt.
- `/compaction`: on/off, status and restore first; add exact-payload local
  preview and explicitly paid score-only mode as controls are completed.
- Off restores active-context omissions, not history already replaced by Pi's
  summary. Compaction makes old decisions inactive without deleting the archive
  or branch-local pins. No new transcript database.

### Network and failure boundaries

- Explicit enablement before scoring; key presence alone does not activate it.
  Configuration remains self-contained. Use session data permitted for TypeSafe;
  this plan does not independently authorize live uploads or charges.
- Skeletons still contain sensitive narrative, paths and commands. Exclude
  obvious secrets and redact where safe; do not claim comprehensive scrubbing.
- Fixed official destination, no redirect credential leakage or payload/body
  logging, bounded requests/responses, concurrency and total deadline.
- Failed scoring produces no new decisions. Existing valid decisions may replay
  while enabled; insufficient reduction falls through to normal Pi compaction.

## Checks during implementation and real use—not before building

- Provider serialization, signed/reasoning blocks, multi-call groups, preserved
  narrative and valid pair deletion. Compare protocol/content invariants, not
  intermediate-message byte equality.
- Mid-tool-loop pressure; stale post-run/prompt-time checks; new usage requiring
  ordinary compaction over originals; manual and overflow behaviour.
- Incoming prompts and `before_agent_start` injections arrive after prompt-time
  compaction checks. Allow for this uncertainty and downstream context handlers;
  retain overflow recovery as the backstop.
- Cancellation, model/config changes, real sibling-branch isolation, reload,
  resume, fork, recall/pins after summaries and interactive/RPC behaviour.
- Fake responses help reproduce bugs but do not establish real token estimates,
  remote provider acceptance or Jev decision quality. Real use supplies that
  evidence; capture regressions as tests rather than claiming universal safety.

## Evidence and revision history

The earlier plan was agreed with Claude after two debate rounds and a final
review. Its architecture remains, including replay-only context, fresh-pass
threshold cancellation, no custom summariser, paired deletion and recoverable
originals. **The user's subsequent build-first direction supersedes its M0
feasibility phase and pre-product evaluation gates.**

Claude reviewed the revised build-first document and stated:

> I AGREE with the current `docs/COMPACTION-PLAN.md` as the implementation plan.

The coordinator agrees. Removing the gate changes when evidence arrives, not
what counts as evidence: implementation and actual use supply it. Optional
ordering suggestions are not additional prerequisites or agreed new restrictions.

Implementation source anchors to reverify as needed:

- Inspiration: `src/state.ts`, `src/compact.ts`, `hooks/fast-jev.ts` at the linked
  commit.
- Pi `dist/core/agent-session.js`: `_checkCompaction`,
  `_compactBeforeNextAssistantResponse`, `_runAutoCompaction`, `prompt`.
- Pi extension types and `emitContext`; session-manager branch/context building;
  compaction token estimation; agent-core loop ordering.

Implementation and local installation are now authorized. Build the real
end-to-end package with telemetry, not a feasibility study. Preserve unrelated
working-tree changes. No publishing, pushing or upstream changes are authorized;
remote scoring still requires explicit enablement and permitted session data.
