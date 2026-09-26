# pi-hindsight: replacement and shared-memory plan

Current direction: 2026-09-26. **Planning only; implementation and migration are not authorized.**

The selected target is a new, thin **pi-hindsight** package derived from the official Pi integration, replacing pi-memory after verification. Claude Code uses the official integration. Both share one bank per repository; Jev gates proactive retrieval, and telemetry measures usefulness as well as operation health.

This is the current plan, not a chronology. It supersedes conflicting recommendations in the [study](HINDSIGHT-STUDY.md), [integration comparison](HINDSIGHT-INTEGRATION-COMPARISON.md) and [earlier improvement plan](HINDSIGHT-IMPROVEMENT-PLAN.md). Their source findings and historical snapshots remain supporting evidence.

## Authorization and decision status

- Selected goals: official-derived Pi replacement, official Claude integration, per-repository sharing, coherent automatic Retain, deliberate Reflect and page search/read, Jev-gated additional Reflect, scoped corrections, and migration of both legacy sources.
- The sequence below combines those goals with recommended safeguards and verification steps. Exact implementation, defaults and policies are not all user-approved; unresolved choices are listed explicitly.
- Documentation consolidation and separate commits of this plan and the existing pi-memory changes are authorized. Execution of the replacement/migration plan requires separate approval.
- No installation, migration, uninstall, bank mutation, provider/config/version change, network operation, push or release is authorized by this plan. No instruction files are edited now.

## Current state and verification limits

- Official `@vectorize-io/hindsight-coding-agents` **0.7.0** is installed for Claude: staged hooks, skill and user-scope MCP registration are present.
- The missing `~/.hindsight/coding-agent.json` was fixed in a separate authorized repair: self-hosted `http://127.0.0.1:8888`, file mode **0600**. Claude hook/MCP settings needed no repair.
- The actual staged resolver maps this repository root and its `packages` subdirectory to `coding-agent::pi-ecosystem`. The default uses the repository basename and resolves linked worktrees; this does not prove collision-safe routing for every repository.
- Read-only API checks reported healthy service, connected database and API **0.10.1**. Registered MCP initialization and tools-list passed; no tool calls were made.
- **Actual hooks, Retain and Reflect have not been exercised.** A fresh Claude session/MCP reconnect is still needed for end-to-end verification. Normal sessions can retain history, manage banks/pages, ingest Git history, survey code and update the runtime; review those defaults before testing.
- pi-memory remains installed. No pi-hindsight package or migration exists yet; the existing mixed-project `pi-memory` bank is untouched.
- The service uses pg0-managed real **PostgreSQL 18.1 on port 5433**, separate from Homebrew PostgreSQL 18 on 5432. No database move is needed; 8888 is the integration API, not a database port.
- Local repair evidence: `/tmp/hindsight-claude-fix-report.md` (ephemeral report; the durable verified facts are summarized above). No live checks are repeated by this documentation task.

## Sequential delivery plan — after separate execution approval

### 1. Back up, audit sources and reproduce the upstream defect

- Back up curated files, relevant configuration and the old bank before any approved data changes. Inventory available source documents/host sessions, dates, routing, corrections, invalidations and deletions without replaying them.
- Recheck the chosen upstream version and pin the implementation baseline; do not assume the audited defect persists in newer versions.
- The [comparison's source trace](HINDSIGHT-INTEGRATION-COMPARISON.md#pi-blocker-run-local-messages-used-as-a-cumulative-document) concerns integration **0.7.0 / Pi 0.87.1**: run-local `agent_end.messages` can replace a cumulative Hindsight conversation document. This risks retained evidence, not deletion of local Pi chat history.
- Reproduce with a deterministic multi-run mocked-client regression before fixing it, then recheck the pinned upstream behavior. An executable reproduction has not yet been run.
- Audit source coverage first: replay cannot recover context that selected spans never captured unless original host sessions still exist.

### 2. Establish one shared bank per repository

- Repository A: Pi + Claude → bank A; repository B: Pi + Claude → bank B. Do not split banks by harness or place every repository in one bank.
- Define compatible routing/naming, worktree/subdirectory handling, source/document identities, tags, observation scopes and Knowledge Page configuration across both integrations.
- Avoid repository-basename collisions with explicit unique mappings or another reviewed shared identity scheme. Do not assume `coding-agent::{gitProject}` is globally unique.
- Preserve harness, speaker and source attribution without blocking Claude-origin evidence behind Pi-only kind-tag filters. Shared access does not turn agent claims into verified facts.
- Keep the old mixed-project bank unchanged and outside unrestricted official-integration access. Cross-project/global knowledge routing is a separate unresolved decision.

### 3. Build the thin, pinned official-derived Pi package

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

## Decisions still required before rollout

- Global/cross-project knowledge destination and retrieval scope.
- Worker capture/exclusion and Claude-path redaction; detailed transcript boundaries and processing limits.
- Initial/periodic gate interaction, cadence, turn definition, budgets/cooldowns and legacy internal Recall preference.
- Knowledge Page refresh policy, shared official-config ownership and compatibility handling.
- External defaults: Git/history ingestion, codebase surveys, automatic runtime updates and their privacy/cost implications.
- Curation/source consistency across replay, permanent-deletion semantics, explicit/automatic deduplication and operation-status tracking horizon.
- Exact migration/rollback mechanics, evaluation thresholds and telemetry storage/privacy policy. These are design choices, not authorization to execute.

## Supporting evidence

- [Hindsight study](HINDSIGHT-STUDY.md): extraction, documents, scopes, source expansion, curation reset and page freshness caveats.
- [Official integration comparison](HINDSIGHT-INTEGRATION-COMPARISON.md): pinned source trace, default behavior, cancellation and cross-harness constraints.
- [Earlier improvement plan](HINDSIGHT-IMPROVEMENT-PLAN.md): historical alternatives, safety checks and small-case evaluation ideas; its conflicting product direction is superseded.
- [Official coding-agent integration](https://hindsight.vectorize.io/sdks/integrations/coding-agents): upstream reference; recheck the selected version before implementation rather than treating historical research as a current compatibility guarantee.
