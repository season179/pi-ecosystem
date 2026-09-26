# pi-hindsight: replacement and shared-memory plan

Current checkpoint: 2026-09-26. **Stages 4–8 are authorized and in progress, not complete.** The user personally applied 359 migration items (10 quarantined) and restarted the service with global/retain concurrency 4/2. The replacement Pi package and latest Claude source-curation guard are locally installed; the old writer is disabled but its package/data remain. Four migration parents have failed on provider HTTP 429/code 1302 and await separately authorized recovery. Full exact/extracted verification and live host acceptance are outstanding; old-package removal is blocked. See the [audit record](HINDSIGHT-DATA-AUDIT.md), [routing record](HINDSIGHT-BANK-ROUTING.md) and [package status/limits](../packages/pi-hindsight/README.md).

Earlier dated implementation and baseline sections below are historical evidence, not current installation/authorization claims. **Do not repeat real migration apply, restart/signal the service, mutate production operations, or delete original data/backups under this plan.** Recovery needs coordinator authorization. While the provider is throttled, further live model tests are paused; offline/local loading checks may continue. No push is authorized.

The selected target is a new, thin **pi-hindsight** package derived from the official Pi integration, replacing pi-memory after verification. Claude Code uses the official integration. Both share one bank per repository; Jev gates proactive retrieval, and telemetry measures usefulness as well as operation health.

This is the current plan, not a chronology. It supersedes conflicting recommendations in the [study](HINDSIGHT-STUDY.md), [integration comparison](HINDSIGHT-INTEGRATION-COMPARISON.md) and [earlier improvement plan](HINDSIGHT-IMPROVEMENT-PLAN.md). Their source findings and historical snapshots remain supporting evidence.

## Authorization and decision status

- Selected goals: official-derived Pi replacement, official Claude integration, per-repository sharing, coherent automatic Retain, deliberate Reflect and page search/read, Jev-gated additional Reflect, scoped corrections, and migration of both legacy sources.
- The sequence below combines those goals with recommended safeguards and verification steps. Exact implementation, defaults and policies are not all user-approved; unresolved choices are listed explicitly.
- Documentation and existing pi-memory changes were committed separately. Stages 1–3 were subsequently authorized: audit/protection, routing plus empty-bank creation for this repository, and replacement-package implementation with isolated staging verification. Live cutover and later stages require separate approval.
- Beyond the completed scoped work above, this plan alone does not authorize further installation, migration, uninstall, bank mutation, provider/config/version change, network operation, push or release. No instruction files were edited.

## Current completion status and verification limits

- **Implemented, verified offline:** bounded automatic background retrieval. Initial foreground wait ≤6 seconds; periodic gate/key/Jev work ≤2 seconds, then Reflect foreground ≤6 seconds. The same requests may continue for at most 90 seconds total from dispatch, honoring lower configured deadlines. One owned opportunity, low budget, capped attempts, no retry/Recall fallback or induced turn.
- **Delivery:** each eligible boundary snapshots the successful scope answers already available; a hung sibling cannot withhold healthy context. Selection locally cancels unused sibling requests and freezes one message, without a grace timer, new call or self-cancellation failure pause. Ready late context is staged after a natural tool-bearing turn, then released only into a fresh same-request model context. Image-normalization notes use the pinned host grammar plus exact original text, not arbitrary prefix matching. Discarded late drafts have explicit status and do not consume delivered-injection slots. A receipt means released to context, not provider use. New prompts never receive unreleased old results. Short one-answer requests can finish without memory.
- **Evidence safety:** staged drafts do not strip assistant evidence. Echo provenance starts at the chronological release receipt. Local curation cancels pending retrieval separately from PATCH and persistently filters prior automatic injections, retaining historical echo provenance without rewriting sources or claiming universal deletion.
- **Installed:** `@season179/pi-hindsight@26.9.0` from the local workspace, plus the newest bundled Claude guard. Existing host sessions were not reloaded. Pi-only `harnesses.pi.reflectTimeoutMs: 90000` is set in both shared/project and global config files (0600); this changes neither foreground waiting nor Claude/service model settings.
- **Verified loading:** rerun against built `006f6de`: fresh Pi 0.87.1 SDK manifest loading in off/read-only/read-write modes, five tools, no load errors, off-mode Reflect and read-only Retain refusals, zero HTTP/model calls. No existing sessions were reloaded. Installed guard + real pinned official Stop hook against an isolated loopback mock passed cutoff, forwarding and curated-source refusal. These are host/code checks, **not live memory-service acceptance**.
- **Tests:** 55 package tests, typecheck, build and diff checks pass after the independent review fixes; the prior offline pack check also passed. Independent review of `7f5fd17` confirmed a hung-sibling delivery bug and three smaller findings. Re-review closed all four in `006f6de` and independently reran 55 tests/typecheck; code is accepted **offline for the next stage**, not accepted as a completed cutover. The non-blocking cosmetic status observation is intentionally unchanged. Live natural-turn automatic usefulness and final Pi↔Claude/global/history/page/correction acceptance remain unverified for this rollout.
- **Migration:** real manifest `~/.hindsight/migrations/2026-09-26T145053594Z-apply/manifest.jsonl`. Coordinator owns full readonly verification and failed-operation diagnosis. Last full exact verification: **107/359**. Coordinator's 16:36 UTC census: **112 completed / 4 failed / 243 pending**; these counts are not a new poll or equivalent to exact verification. Four failed parents exhausted child retries on provider rate capacity; no agent repair/resubmission performed by this implementation. Prior synthetic repeat-import passed; a real repeat apply has **not** been performed and must not be claimed.
- **Pressure relief / background acceptance:** durable backup `~/.hindsight/backups/20260926T163324Z-pressure-relief/`. Restoration has **not** been executed and is mandatory before final acceptance. At least two failed page refreshes were observed via an existing own-bank list; production background health remains unresolved. Recovery scripts are under review; no retries authorized. A cross-bank nonmanifest terminal SQL query was denied in the review session and must not be rerun or routed through another worker/tool.
- **Preserved:** original curated files, legacy bank, backups and disabled pi-memory package. Backup of completion config/guard/settings changes: `~/.hindsight/backups/20260926T160100Z-completion/`. Old-package uninstall requires all 359 exact/extracted plus coordinator final review.

## Historical pre-cutover state

- Official `@vectorize-io/hindsight-coding-agents` **0.7.0** is installed for Claude: staged hooks, skill and user-scope MCP registration are present.
- The missing `~/.hindsight/coding-agent.json` was fixed in a separate authorized repair: self-hosted `http://127.0.0.1:8888`, file mode **0600**. Claude hook/MCP settings needed no repair.
- An explicit official `mapPathToBank` entry routes this repository (root, subdirectories, linked worktrees) to the empty bank `coding-agent::season179:pi-ecosystem`. Other repositories still use the basename default, which is not collision-safe.
- Read-only API checks reported healthy service, connected database and API **0.10.1**. Registered MCP initialization and tools-list passed; no tool calls were made.
- **Actual hooks, Retain and Reflect have not been exercised.** A fresh Claude session/MCP reconnect is still needed for end-to-end verification. Normal sessions can retain history, manage banks/pages, ingest Git history, survey code and update the runtime; review those defaults before testing.
- pi-memory remains the active installed writer. `packages/pi-hindsight` now exists and passed an isolated local install plus real Pi 0.87.1 RPC/SDK loading with `--hindsight-mode off`; no real-profile activation or migration occurred. The old mixed-project bank was not modified by this implementation.
- The service uses pg0-managed real **PostgreSQL 18.1 on port 5433**, separate from Homebrew PostgreSQL 18 on 5432. No database move is needed; 8888 is the integration API, not a database port.
- Local repair evidence: `/tmp/hindsight-claude-fix-report.md` (ephemeral report; the durable verified facts are summarized above). No live checks are repeated by this documentation task.

## Sequential delivery plan — after separate execution approval

### 1. Back up, audit sources and reproduce the upstream defect

**Completed 2026-09-26:** private local backup, successful isolated database restore, verified file hashes and synthetic adapter-boundary reproduction. See [results and remaining risks](HINDSIGHT-DATA-AUDIT.md). Content-level replay suitability remains a migration prerequisite.

- Back up curated files, relevant configuration and the old bank before any approved data changes. Inventory available source documents/host sessions, dates, routing, corrections, invalidations and deletions without replaying them.
- Recheck the chosen upstream version and pin the implementation baseline; do not assume the audited defect persists in newer versions.
- The [comparison's source trace](HINDSIGHT-INTEGRATION-COMPARISON.md#pi-blocker-run-local-messages-used-as-a-cumulative-document) concerns integration **0.7.0 / Pi 0.87.1**: run-local `agent_end.messages` can replace a cumulative Hindsight conversation document. This risks retained evidence, not deletion of local Pi chat history.
- A deterministic multi-run mocked-client regression now reproduces the defect in the source, published and installed 0.7.0 adapters. Positive controls passed; the desired history invariant fails as expected. No fix or live-server extraction test has been performed; recheck the selected baseline before implementation.
- Audit source coverage first: replay cannot recover context that selected spans never captured unless original host sessions still exist.

### 2. Establish one shared bank per repository

**Completed 2026-09-26 for this repository only:** explicit mapping and empty bank created, with no content, pages or model calls. Other repositories and cross-project routing remain open. See the [routing record](HINDSIGHT-BANK-ROUTING.md).

- Repository A: Pi + Claude → bank A; repository B: Pi + Claude → bank B. Do not split banks by harness or place every repository in one bank.
- Define compatible routing/naming, worktree/subdirectory handling, source/document identities, tags, observation scopes and Knowledge Page configuration across both integrations.
- Avoid repository-basename collisions with explicit unique mappings or another reviewed shared identity scheme. Do not assume `coding-agent::{gitProject}` is globally unique.
- Preserve harness, speaker and source attribution without blocking Claude-origin evidence behind Pi-only kind-tag filters. Shared access does not turn agent claims into verified facts.
- Keep the old mixed-project bank unchanged and outside unrestricted official-integration access. Cross-project/global knowledge routing is a separate unresolved decision.

### 3. Build the thin, pinned official-derived Pi package

**Implemented and staged 2026-09-26:** `@season179/pi-hindsight@26.9.0`, pinned official 0.7.0 core with license/provenance. Build/typecheck and 18 package tests passed; 58 existing memory tests also passed. Real Pi 0.87.1 loaded the compiled package from an isolated local installation with memory explicitly off and no package network attempts. Product default is **read-write with automatic capture**, but no real-profile installation/activation has occurred while the old writer is active.

The [package README](../packages/pi-hindsight/README.md) records capability limits: append-only persisted history and small durable cursor; ambiguous/divergent/forked histories, unknown writes and unsafe replay fail closed; structural/chronological echo filtering only; fact edit/invalidate/revert, **no permanent single-fact DELETE** in the verified API; source/derivative freshness is not guaranteed. An explicit endpoint is required before any memory access. No Jev gate, automatic injection, page setup, new telemetry or migration was implemented in Stage 3; Step 4 later added the gate and injection.

- Keep upstream changes small and reviewable; carry the history fix and required safeguards rather than rebuilding an unrelated adapter.
- Automatically Retain coherent conversation updates after completed replies. Hindsight extracts memories; Jev no longer selects spans for automatic retention.
- Append safely or replace with complete intended session evidence, never only the latest run. Preserve roles, statement timestamps, qualifications and source attribution.
- Recover evidence correctly across restart/resume, compaction and branch changes. An in-memory accumulator alone is insufficient; define durable source identity, replay boundaries and retry/deduplication behavior before choosing the fix.
- Provide deliberate **Reflect**, official Knowledge Page **search/read**, explicit **Retain**, and scoped correction/invalidation management. Do not expose a raw Hindsight Recall tool. Exact tool names and API shape remain open.
- Retire file-backed `recall`/`remember` in the replacement, not the valuable content they hold. Keep the current package/data available through migration and verification.
- Retain adds/extracts evidence; it is not precise edit/delete or guaranteed always-injection. Report accepted/queued work separately from completed extraction and consolidation.
- Revalidate identity, scope and current mode before correcting identified facts. Invalidation is reversible; permanent deletion requires a separate explicit confirmation. Do not blanket-delete an observation's supporting facts.
- Correction must address source consistency, cached injections and derived observations/pages: changing a fact does not rewrite its source, and reprocessing can recreate an obsolete claim.
- Preserve redaction before external processing, repository isolation, untrusted-memory framing, off/read-only controls, cancellation, bounded shutdown and echo suppression. Retrieved summaries/restatements must not become independent corroborating evidence.
- Pi safeguards do not automatically protect Claude hooks. Review Claude redaction and worker-session capture separately; a loopback API does not imply local model processing.

### 4. Add initial retrieval and periodic Jev-gated Reflect

**Implemented 2026-09-26 (staged, not activated):** see the [package README](../packages/pi-hindsight/README.md#automatic-retrieval). Pre-run `before_agent_start` only: ungated initial `low` Reflect at the first branch user entry; opted-in Jev Noul ≥ 0.7 at user-entry counts 5, 9, 13… (steering/follow-ups count, so values can be skipped). Persisted displayed untrusted custom message ≤ 4,000 chars, per-branch cap 8, exact-duplicate/empty suppression, capture echo exclusion. All async pre-run work under one 8 s wall (Jev ≤ 2 s, Reflect ≤ 6 s; only synchronous local config/git work is uninterruptible), not Esc-cancellable; each opportunity is frozen to its first mode/endpoint/bank/autoInject/scopes and rejected as stale on change. Per activation ≤ 8 Reflect and ≤ 32 Jev attempts counted before requests; reset on reload. Failures: no retry, 10-minute pause. `autoInject: pages|recall` disables retrieval rather than substituting; the legacy configurable internal Recall preference is **reconciled as not delivered**. Read-only mode retrieves; off does nothing. Verified only with synthetic/mock services; live usefulness is Stage 6.

- Initial relevant context uses Reflect as the intended first-prompt default. Every few turns, Jev checks whether additional memory would help; a positive gate invokes Reflect and injects bounded context, a negative gate does neither.
- Jev controls retrieval timing, not truthfulness or automatic retention. It cannot certify the correctness of Reflect's synthesized answer.
- Bound gate and Reflect deadlines, cost/token budgets, cooldowns and repeat injections. Background work and service failures must not stall normal work indefinitely; initial awaited work also needs a strict deadline.
- Define unavailable/cancelled/stale-result handling and avoid blind retries. Exact cadence, turn definition and interaction between initial retrieval and the periodic gate remain open.
- Reconcile the earlier configurable internal Recall preference explicitly; it is not approval to substitute raw Recall on every automatic path or expose it as a tool.

### 5. Enable observations and official Knowledge Pages

- Ensure automatic observation consolidation is enabled in repository banks with compatible scopes. Observations are derived interpretations, not guaranteed truth; no new manual consolidation tool is required.
- Follow official automated initial setup of predefined Knowledge Pages backed by mental models. Reuse existing compatible shared-bank setup and create missing pages rather than duplicating or overwriting the other harness's configuration.
- Page search/read is selected alongside Reflect. Begin with official topics; add custom topics only for demonstrated recurring needs.
- Define page/config ownership and ongoing refresh policy before rollout; automatic setup does not approve every upstream background feature.
- Corrections/deletions require refreshing and verifying affected pages and other derivatives. A non-stale flag alone does not establish that removed evidence disappeared. Exact refresh scheduling remains open.

### 6. Instrument operation health and evaluate actual usefulness

- Default telemetry to metadata, not raw prompts, conversations, memory content or credentials. Define bounded storage, access and retention before enabling it.
- Record gate decisions, Reflect outcomes, injection states, retention acceptance/completion/failure/unknown states, latency/errors and available token/cost data. Distinguish extraction from observation consolidation.
- Establish a small known-memory task baseline before tuning, with must-find, irrelevant-query, indirect-query, qualification, attribution, correction and isolation cases drawn from the supporting research.
- Sample real-session usefulness and missed useful retrieval (false negatives), comparing against a baseline such as gate-off behavior. Operational telemetry alone cannot reveal everything that should have been recalled.
- More calls, facts or observations do not prove better answers. Record uncertainty, user corrections and cost alongside usefulness; evaluation has not yet run.

### 7. Migrate two inputs without resurrecting obsolete knowledge

1. **Curated legacy files:** preserve content, scope, dates and provenance; route project knowledge to the matching repository bank.
2. **Existing Hindsight bank:** prefer original source documents or original host sessions where available and appropriate. Extracted facts, observations or Reflect summaries are derived-only fallbacks, explicitly labelled as such, not fresh independent evidence.

- Provide a dry run with destination/class counts and exclusions, stable source identities, repeat-import deduplication and a manifest of writes/outcomes. Preserve original files and the old bank for verification and rollback.
- Raw host sessions may contain secrets and tool output excluded by old span capture. Review boundaries and redact before processing; do not blindly replay full sessions.
- Carry corrections, invalidations and deletion intent through the migration. Re-extraction can change fact IDs: matching old IDs or replaying invalidations by ID alone is not sufficient. Define source/content reconciliation and verify that retired claims cannot reappear.
- Review each legacy `always` memory individually. Mandatory standing instructions belong in the appropriate actual project/global instruction files loaded by Pi/Claude; contextual decisions, history, preferences and lessons belong in Hindsight.
- Do not automatically promote every preference into a rule or assume Retain/Reflect guarantees instruction loading. Instruction placement/loading needs explicit review; none are edited now.
- The destination for global/cross-project contextual knowledge remains **open**. Do not silently drop it, force it into the current repository bank or broaden all project visibility.
- Settle explicit-Retain-plus-automatic-capture deduplication and source/curation consistency before claiming idempotent migration.

### 8. Verify, cut over and uninstall pi-memory last

- Verify Pi → Claude and Claude → Pi retrieval, unrelated-query abstention, repository isolation, basename collisions and worktree routing using approved non-sensitive/disposable cases first.
- Verify multi-run history survives resume/restart and compaction without destructive replacement or echo duplication; test original timestamps, attribution and qualified statements.
- Verify migration completeness, repeat-import behavior, corrections/invalidation/deletion non-resurrection, page access/refresh and scoped management. Accepted Retain alone is not evidence of searchable useful memories.
- Exercise outages, deadlines, cancellation/shutdown, worker policy, redaction and off/read-only behavior. Confirm the intended package/version is actually installed and active in a fresh host session, not merely built locally.
- During approved cutover, disable the old automatic writer before enabling replacement capture so both do not ingest the same Pi conversation. Keep rollback instructions and original data available.
- **Uninstall pi-memory last**, only after replacement, both migrations and cross-harness checks pass. Rollback must avoid simultaneous writers; code rollback does not undo bank mutations.

## Stage 5–8 decisions and implementation status (2026-09-26)

Implemented and tested in `packages/pi-hindsight`. Live since 2026-09-26 12:40–12:55 UTC, after a fresh backup: old writer frozen, shared/global configs, Claude guard, global hook and MCP, and explicit page setup for 11 empty banks. The real migration apply, the Pi install and the pi-memory uninstall are still pending authorization.

- **Global:** a read-only static bank `coding-agent::season179:global` in `~/.hindsight/coding-agent-global.json`. Pi gets parallel project and global Reflect plus `hindsight_reflect scope: global`. Claude gets a second official UserPromptSubmit hook and a second MCP server with its write tools denied. Contents: legacy-global curated notes and `user-wide` spans only. `$HOME`/`~/.pi` directory content is quarantined. Guaranteed `always` injection is intentionally lost.
- **External defaults:** `autoSeed`, `gitIngest`, `codebaseSurvey` and `autoUpdate` are off in the shared config. Page setup is explicit, via `scripts/setup-bank.mjs` for each bank.
- **Page refresh:** after verified curation, request a refresh of the bank's pages. Freshness is not verified.
- **Replay:** `captureSince` guards in both harnesses. Pi checks it in-extension. Claude uses a pinned wrapper around the official Stop hook that forwards unchanged stdin only for sessions starting at or after the cutoff; anything uncertain fails closed.
- **Telemetry:** bounded, metadata-only JSONL. Extraction, consolidation and queued states are recorded separately.
- **Migration:** `scripts/migrate-legacy.mjs`, dry run by default. Rules:
  - explicit `mapPathToBank` routing only; remote-less repositories get path-hash-suffixed bank names;
  - curated notes at their latest version;
  - old-bank spans as `document` strategy with provenance;
  - quarantine for edited/invalidated units, `not_durable` spans, unmapped or home/Pi directories, and spans matching retired note versions;
  - deterministic operation IDs; an existing document is verified identical or reported as a conflict;
  - a content-free 0600 manifest with expected payload hashes;
  - `--verify` fails unless every item is present, identical and extracted.
- **Old writer off:** pi-memory `config.json` `defaultMode: "off"` plus `automation.json` `enabled: false`, before replacement capture.

### Stage 6 synthetic baseline and migration rehearsal (2026-09-26, Hindsight 0.10.1)

Disposable, ownership-marked banks only, all deleted and verified absent afterwards. Metadata only; no real memory.

- **Baseline** (`scripts/eval-baseline.mjs`, gate-off Reflect, 14 cases): 13 answered.
  - Label agreement passed for must-find (Pi and Claude origin), qualifier, speaker/uncertainty attribution, unrelated abstention, both isolation directions, and edit/invalidate before and after curation.
  - The indirect-recall case hit its 150 s request deadline in the full run. Rerun alone on an idle server, it passed: 27.8 s structured, and 19.3 s and 31.7 s as ordinary low-budget Reflects.
- **Non-resurrection, a measured limitation:** re-retaining an *unchanged* source document after curation brings back both the edited value and the invalidated fact, in the facts, observations and page. Curation, consolidation and page refresh alone did not resurrect them.
  - The mitigations are to never resubmit curated sources: importer idempotence (existing documents are verified, never resubmitted), `captureSince` guards, quarantine of retired note versions, and Pi's session-local replay block after curation.
  - Follow-up (`01d244f`): before any append, Pi capture and the Claude Stop guard read the session source's facts (live `edited_at` plus the `state=invalidated` archive). They refuse replay after curation by any session or harness.
  - A real-hook disposable check passed: the fresh session was captured, one fact was edited, and the next Stop was refused. The document and operations were unchanged.
  - Permanent external deletion leaves no trace and is not covered.
- **Latency:** the service log's per-iteration timings show that idle low-budget Reflect is itself slow. Across 33 Reflects:
  - it ran a median of 3 agentic LLM iterations;
  - net LLM time (excluding queueing) was 18–76 s, median 27 s;
  - none finished under 6 s, and 6 finished under 20 s.
- Serialization adds on top of that: the global LLM cap was 1, and 15 of the 33 waited up to 59 s behind other LLM work.
- So Pi's 6 s automatic cap never succeeds on this provider, and the official hook's 20 s rarely does. Explicit `hindsight_reflect` (bounded by the configured tool deadline) is the working retrieval path.
- A reserved-headroom change is prepared but not active. It is `LLM_MAX_CONCURRENT` 4, with `RETAIN_`, `CONSOLIDATION_` and `MENTAL_MODEL_REFRESH_LLM_MAX_CONCURRENT` at 1 each, which is upstream's per-op composition, so interactive Reflect always keeps one slot. It sits in the service plist (backed up), and needs a service reload that was not permitted in this session.
- **API facts:** `GET /banks/{id}/profile` returns 410. Existence is checked with `GET /banks/{id}/config` (404 when missing), plus the exact `bank_id` in `GET /banks?q=` (`banks[].name` as the ownership marker). After DELETE, `/config` keeps answering 200 for about 20–30 s while the list already reflects the deletion. Fact detail uses `type`; list items use `fact_type`.
- **Import rehearsal** (8 synthetic sources, 3 disposable banks):
  - The dry run and apply routed 4 items (a project note and span, a global note and a user-wide span).
  - They quarantined `not_durable`, the retired-note match, the unmapped project and the unknown `source_role`.
  - `--verify` exited 1 before extraction, then 0 after the drain. A re-apply verified 4 items identical without resubmitting. A tag tamper made `--verify` exit 1 (`document tags mismatch`).
  - Plain Reflect on the migrated banks returned the expected facts (37–44 s) and never the retired value.
- **Apply gate** (`cfad3b5`): `--apply` requires `--expect <reviewed dry-run manifest>`. It refuses before any write if the recomputed plan differs in any field.

## Historical open decisions (resolved rollout choices recorded above)

Global routing, worker/off controls, capture cutoffs, source-curation guards, explicit page setup and local cutover sequence have since been decided and implemented. Offline code review is accepted. Remaining gates are migration recovery/completeness, pressure-setting restoration, background-operation health, live host usefulness under available provider capacity, and final coordinator cutover review. The original decision checklist follows for traceability:

- Global/cross-project knowledge destination and retrieval scope.
- Worker capture/exclusion and Claude-path redaction; detailed transcript boundaries and processing limits.
- Step 4 retrieval constants (cadence, 0.7 threshold, caps, cooldown) are provisional until Stage 6 evaluation; the initial/periodic interaction, turn definition and Recall reconciliation are settled in the package README.
- Knowledge Page refresh policy, shared official-config ownership and compatibility handling.
- External defaults: Git/history ingestion, codebase surveys, automatic runtime updates and their privacy/cost implications.
- Curation/source consistency across replay, permanent-deletion semantics, explicit/automatic deduplication and operation-status tracking horizon.
- Exact migration/rollback mechanics, evaluation thresholds and telemetry storage/privacy policy. These are design choices, not authorization to execute.

## Supporting evidence

- [Hindsight study](HINDSIGHT-STUDY.md): extraction, documents, scopes, source expansion, curation reset and page freshness caveats.
- [Official integration comparison](HINDSIGHT-INTEGRATION-COMPARISON.md): pinned source trace, default behavior, cancellation and cross-harness constraints.
- [Earlier improvement plan](HINDSIGHT-IMPROVEMENT-PLAN.md): historical alternatives, safety checks and small-case evaluation ideas; its conflicting product direction is superseded.
- [Official coding-agent integration](https://hindsight.vectorize.io/sdks/integrations/coding-agents): upstream reference; recheck the selected version before implementation rather than treating historical research as a current compatibility guarantee.
