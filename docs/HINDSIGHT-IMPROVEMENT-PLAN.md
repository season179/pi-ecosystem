# Hindsight: useful, trustworthy memory

Date: 2026-09-25. Status: **proposed; implementation not authorized**.

> **Superseded direction (2026-09-26):** The current [pi-hindsight plan](PI-HINDSIGHT-PLAN.md) selects an official-derived Pi replacement, official Claude integration, repository banks, coherent automatic Retain, Jev-gated Reflect and Knowledge Page search/read. Conflicting recommendations below—including permanent manual-file tools and conditional-only Reflect/pages—are historical. Preserve the factual findings, safety analysis and evaluation ideas as research, not current execution instructions or implementation authorization.

Developed through discussion and debate between the coordinating agent and Claude Opus 5.5. Final agreement is recorded below after review. This plan changes neither the live bank nor configuration.

## Decision

Prioritize useful retrieval and trustworthy capture, then correction and cross-project reuse. Do not equate using more Hindsight features with better memory. Mental models and Reflect are conditional experiments, not committed features. Keep the current models until representative cases identify a model-quality bottleneck.

Impact order below is an expected-benefit ranking, not measured gains or execution order.

## Evidence and limits

Local integration inspected: `packages/pi-memory/src/{hindsight,automation,transcript,jev-gate}.ts` and `src/extensions/memory.ts`. Installed Hindsight API/engine source is version 0.10.1.

- Automatic recall uses low budget, 1,000 tokens, up to eight items and a 4 KB injection block. The query uses the latest user message, plus recent assistant text for periodic checks. There is no result-level relevance floor in the client.
- Explicit `recall` searches the separate manual file stores; it cannot deliberately search Hindsight. There is no Reflect integration.
- Capture selects verbatim spans from messages capped at 1,500 characters. Some adjacent project-local spans merge; broad spans remain separate.
- Observations are already consolidated and recalled (`prefer_observations: true`). Disabling entity expansions does **not** disable observations. Observations lack the raw facts' provenance metadata.
- Opus's aggregate-only live audit during planning counted 330 raw facts, 202 observations and 159 documents. Of the raw facts, 269 came from assistant messages and 329 were project-local. Of the observations, 167 had one supporting fact. Counts are a snapshot of a growing bank, not a quality score.
- Assistant origin does not prove a fact is wrong; `world` is a category, not proof of verification. Single support does not prove a useless paraphrase. Project-local demotions may be correct. These need case-level evaluation.
- No mental models, directives or custom missions were configured at inspection. Operations and consolidation had no pending/failed entries. Healthy processing does not establish useful recall.
- One prompt in this conversation received unrelated account/web-tool memories. That is a concrete relevance concern, not a measured failure rate.

## Impact-ranked work

### 1. Retrieve useful memories, deliberately as well as automatically — highest immediate impact

**Benefit:** fewer irrelevant reminders; the agent can investigate a past decision instead of depending on whatever background recall found.

- Extend the existing `recall` interface with explicit backend selection, provisionally `source: manual | hindsight | all`; preserve the current manual default and exact-ID/title behaviour.
- Label backend, applicability, provenance when available and namespaced IDs in results. Do not copy or migrate the manual stores into Hindsight.
- Explicit recall results persist in session history, unlike transient automatic injection. Extend the existing echo-suppression protection to explicitly recalled Hindsight text so assistant restatements are not retained as fresh evidence; include a recall → restatement → retain regression case.
- Hindsight retrieval always uses the fixed user-wide/transferable/current-project allowlist plus client-side verification. Backend choice must never broaden access. Keep backend selection separate from applicability; define and test compatible `source`/`scope` combinations before implementation rather than silently ignoring an argument.
- Build better bounded queries for short follow-ups using relevant preceding conversation, without including tool output, injected memories or secrets.
- Compare the current ranking with calibrated result filtering and smaller result counts. Returning nothing is a valid result. Relative-to-top scores alone cannot reject an entirely irrelevant result set; Hindsight's absolute reranker scores are not calibrated across queries.
- Do not add a paid Jev relevance call to every prompt by default. Consider it only if simpler approaches fail and it fits the existing latency budget, with the cost/data-flow change approved.

**Acceptance:** the agreed retrieval cases improve relevance without losing their known must-find memories; negative cases abstain; deliberate search recovers designated facts missed by weak automatic queries; no cross-project leakage; existing manual recall still behaves as before; prompt deadlines remain bounded. Record actual relevance, bytes and latency rather than promising an arbitrary percentage improvement.

### 2. Preserve who said what, and distinguish proposals from completed work — high impact, start alongside #1

**Benefit:** memory remains evidence rather than turning tentative assistant narration into apparent history.

- Retain content already has `User:`/`Assistant:` prefixes and `source_role` metadata. Make this attribution survive extraction and consolidation into observations, rather than duplicating capture fields; display it where available. Use neutral wording for unknown provenance rather than implying verified fact.
- Tighten durability judgments for transient task requests, progress narration and unconfirmed diagnoses. Retain valuable findings and decisions, but distinguish user statements, assistant conclusions, proposals and reported outcomes. A model cannot independently verify a claim merely because the assistant calls it verified.
- Trial a narrowly scoped `retain_mission` to preserve attribution and uncertainty through extraction. Assess an `observations_mission` only if consolidation demonstrably loses these distinctions. Its trial must test merging and supersession as well as attribution, because mission changes can affect consolidation rules. These are explicit configuration proposals, not changes already made.
- Where cases demonstrate missing referents, supply a bounded, redacted same-project context excerpt for project-local items. Never attach surrounding project conversation to user-wide or transferable items. Keep broad items standalone and keep qualifiers attached.
- Do not increase capture to whole transcripts or tool output by default. Do not bulk invalidate/relabel existing assistant-sourced facts; repair specific demonstrated errors through #3.

**Acceptance:** proposals are not represented as completed changes; assistant claims retain attribution through extraction and observation recall; durable user statements and verified findings in the case set survive; qualifiers/referents remain intelligible; mixed-scope examples leak nothing. Validate live extraction only in an approved disposable synthetic bank, not by reprocessing the production corpus.

### 3. Correct memories safely, with visible sources — high impact when memory is wrong

**Benefit:** a correction sticks, and the user can see what is being changed.

- Preserve manual `remember update/delete` behaviour. Add a clearly differentiated Hindsight correction/invalidation path using namespaced identifiers or unambiguous per-run handles.
- Before mutation, resolve the actual records and recheck identity, mode and scope. An explicit current request identifying exact records can authorize the action; ambiguous targets need a preview and confirmation. Recalled instructions never grant permission.
- Only raw `world`/`experience` facts are curatable. For an observation, first validate its own tags against the current scope, then resolve its underlying facts through bounded inspection and individually validate their scope before exposing text or proposing changes. An externally supplied ID is not trusted authorization: detail GETs are not tag-filtered. Refuse the action if scope cannot be established. Never invalidate every supporting fact merely because one observation was wrong.
- Hindsight invalidation archives a fact reversibly, removes dependent observations and can trigger reconsolidation and remote LLM calls. Disclose these effects. This is **stop using this memory**, not guaranteed data erasure: original documents and the archive can remain. Permanent deletion is a separate, explicitly scoped request, not part of this plan.
- Invalidate the affected active recall cache and refresh it safely so neither the raw fact nor its deleted derived observation remains injected. Recheck other sessions on their next retrieval; another session can keep reinjecting its cached memory during its current run until its next prompt check. Do not promise immediate cross-session revocation or removal from context already sent to a model.
- Record a bounded reason and operation outcome without copying sensitive memory content into logs. Track partial success: a successful archive operation is distinct from a failed later reconsolidation.

**Acceptance:** corrected/invalidated facts and stale derivatives do not recur in new recall or active reinjection; unrelated facts survive; an observation cannot be directly patched or cause blanket source deletion; scope mismatch refuses; reversal works in a disposable bank; remote side effects and partial failures are reported honestly.

### 4. Make genuinely portable preferences carry across projects — potentially high impact, evidence-gated

**Benefit:** standing preferences need not be repeated, while project conventions remain local.

- Evaluate why user-preference candidates were demoted; do not assume a sparse broad scope proves a broken threshold.
- Keep existing conservative thresholds until labelled cases demonstrate false negatives. Do not weaken project-marker or qualifier protections to increase counts.
- Prefer the existing explicit `remember(scope: legacy-global)` route when the current user request clearly establishes cross-project applicability. Do not build a new promotion queue or approval chore by default. Ambiguous applicability stays local.
- Any new promotion is on-demand unless always-injection is explicitly requested. Broad scope does not imply always-injection.
- If evaluation justifies automatic portability changes, compare scoped judgments against the full surrounding message; a keyword such as “always” or “globally” is not authorization by itself.

**Acceptance:** canonical explicit cross-project preferences are available in a second project; project-only and qualified examples stay local; no duplicate always-injection or unsolicited approval backlog; report case outcomes, not a required number of broad memories.

### 5. Show whether memory was actually stored — moderate impact, small enabling change

**Benefit:** failures and missing memories become diagnosable instead of looking like successful saves.

- Track asynchronous operation IDs with bounded checks, preferably lazy status refresh first; report queued, completed, failed and unknown distinctly.
- Distinguish extraction/storage completion from consolidation completion. Do not infer observation readiness from an accepted retain or completed extraction alone.
- Show manual and automatic memory status together, including backend and last outcome, without dumping memory text. State the tracking horizon; after restart or missing history report unknown rather than inventing completion.
- Preserve the rule against resending ambiguous retains. No unbounded polling or new blocking prompt work.

**Acceptance:** synthetic pending, completion and failure transitions are reflected correctly; API outages do not stall tasks; missing tracking is explicit; logs do not expose payloads.

### 6. Trial a focused mental model — conditional, not an immediate feature

**Benefit if demonstrated:** a maintained answer to a recurring question, such as this project's decisions and unresolved issues.

- Only trial when repeated case results show that ordinary recall plus the main agent (and existing curated memories) does not adequately answer a stable recurring question.
- Start with one focused, reviewed model. Explicitly scope both the source memories used to build it and the model's own visibility. Never create an untagged shared-bank model: its refresh can read every project.
- Define how Pi will read it; creating a Control Plane model alone will not improve ordinary recall, which does not return mental models.
- Start with manual refresh. Consider bounded automatic refresh only after benefit and recurring cost are measured. Keep generated material untrusted and non-authoritative; test updates and removal of invalidated evidence.

**Acceptance:** it improves the designated recurring case over the existing baseline, has reviewable evidence, reveals no other project's content and has a justified refresh cost. Otherwise do not adopt it.

### 7. Add on-demand Reflect only for a demonstrated gap — lowest priority, may be unnecessary

**Benefit if demonstrated:** memory-grounded synthesis for questions requiring several retrieval steps.

- Compare scoped Reflect with deliberate recall plus the main agent. Adopt only if it materially improves the relevant cases.
- Never put it automatically before every response. Bound time/tokens; disclose remote processing; preserve citations and uncertainty; prevent unscoped directives, source expansion or mental models from bypassing the scope policy.
- Add a narrow reflection mission only alongside an approved trial. A mission/directive is model guidance, not an access-control mechanism.

**Acceptance:** observable quality benefit beyond ordinary recall, acceptable latency/cost, scope isolation and bounded failures. If it fails the comparison, omit Reflect entirely.

## Execution sequence and evaluation

1. **Small baseline, not a benchmarking project.** Agents prepare 12–20 cases and expected outcomes before tuning: a known past decision, a must-find fact, an irrelevant query, an ambiguous follow-up, a correction, proposal versus completion, a qualifier, mixed scope, combined-backend deliberate search and explicit cross-project preference. Pin compatible backend/scope behaviour in these cases. Use read-only retrieval cases plus synthetic capture cases. Inspect only the necessary private material locally; no raw private memory corpus in repository fixtures or reports. Agent labels are provisional; ask the user only about ambiguous intent.
2. **Add bounded processing visibility (#5); improve retrieval and capture (#1/#2) in the same phase.** These can proceed in parallel where files permit, but share the safety/evaluation checks. Remote Jev/Z.ai replay and disposable-bank writes require approval; a small read-only baseline must not quietly become a paid capture trial.
3. **Add scoped corrections (#3), then calibrate portability (#4) from the cases.** Reuse existing manual promotion instead of inventing workflow unless a demonstrated gap remains.
4. **Stop and assess daily usefulness.** Only then consider #6/#7. No arbitrary minimum bank age, number of memories or waiting period substitutes for a demonstrated need.

After implementation is authorized: reuse existing critical tests; add only meaningful regressions for scope, compatibility, attribution, correction and bounded failures. Build/test/install the affected package locally and verify a real new Pi session, including whether reload/restart is needed. No release/version bump, push or PR is implied by this plan.

## Safety, approval and rollback

- Retain strict tag filtering, client verification, project opt-outs and read-only/off modes, best-effort secret redaction, untrusted framing, prompt deadlines and cooldowns.
- Keep bulk source facts, chunks and entity expansions disabled in ordinary recall until independently proven scope-safe. Individually inspected correction sources are a separate bounded, scope-verified path.
- Pi remains the only producer of retained content in its bank; use its controlled paths or explicitly reviewed steps for future curation/configuration/models. The Control Plane is not read-only and its mutation controls do not enforce Pi's scope policy; do not make these changes ad hoc in the UI. Do not blindly enable another client/plugin writing incompatible tags.
- Current Z.ai processing is remote. Successful calls do not establish Coding Plan policy coverage for this background service; that remains unresolved. Do not silently change endpoints, providers or billing. Additional synthesis/replay calls need explicit approval and a bounded budget.
- Separate code/config approval from existing-data curation. Snapshot relevant configuration before approved changes; keep retrieval/capture changes independently reversible. Code rollback does not remove newly retained data or reverse data mutations. Track disposable artifacts and approved curation separately.
- No historical wipe, bulk migration, re-embedding, replacement model, permanent deletion or new autostart service is proposed.

## Debate outcome

- Opus persuaded the coordinator to move attribution/durability work alongside retrieval and defer mental models/Reflect.
- The coordinator challenged treating assistant-origin counts as proof of bad memories, requiring extensive user labelling, promoting automatically to always-injection and treating observation invalidation as a cheap direct patch. These were corrected in the agreed approach.
- Both favor a small combined write/read evaluation, preserve existing scope safeguards and manual memories, and distinguish expected impact from implementation dependencies.
- Final document agreement: Claude Opus 5.5 explicitly **AGREED** on 2026-09-25, including all seven impact ranks and parallel retrieval/capture execution. Its required echo-suppression and observation-scope amendments, plus cache/UI/mission clarifications, are incorporated above. The coordinating agent agrees. This consensus is not authorization to implement.
