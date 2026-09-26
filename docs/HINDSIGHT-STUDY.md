# Hindsight: how to use it properly here

Studied 2026-09-25. **Research, not implementation authorization.**

> **Superseded direction (2026-09-26):** The current [pi-hindsight plan](PI-HINDSIGHT-PLAN.md) selects an official-derived Pi replacement, official Claude integration, repository banks, coherent automatic Retain and Jev-gated Reflect. Conflicting recommendations below—including manual-file retrieval and deferred automatic Reflect—are historical, not current direction. Source findings and dated snapshots remain research evidence; implementation is not authorized here.

This study complements the [earlier improvement plan](HINDSIGHT-IMPROVEMENT-PLAN.md) and [integration comparison](HINDSIGHT-INTEGRATION-COMPARISON.md).

## Conclusion

Hindsight is an evidence-processing system, not just a vector store: source content → extracted facts and relationships → consolidated observations → retrieval, with optional reflective reasoning and maintained summaries. We already use extraction, consolidation and retrieval. The immediate opportunity is to give those operations better evidence and expose deliberate retrieval—not to enable every feature.

“Proper use” means preserving who said what, when, with what qualifications; retrieving the right evidence without leaking another project's content; correcting mistakes through their sources; and distinguishing accepted work from completed processing. A remembered claim is not verified truth, and a repeated assistant claim is not independent corroboration.

## What was checked

- Official conceptual documentation for retain, recall, reflect, observations and mental models; API documentation for those operations, banks, documents, individual-memory curation, operations and knowledge pages; Memory Defense; three cookbook patterns. Relevant configuration sections were cross-checked against installed source, not treated as an exhaustive deployment audit.
- Local integration: `packages/pi-memory/src/{hindsight,automation,transcript}.ts` and `src/extensions/memory.ts`.
- Installed Python package `hindsight_api_slim` **0.10.1**, plus live `/openapi.json`, which also reports **0.10.1**. Source root on this machine: `/Users/season/.local/share/hindsight-hermes/venv/lib/python3.11/site-packages/hindsight_api/`.
- Read-only health, bank configuration and aggregate status GETs. No private fact corpus was exported; no retain, reflect, reprocessing, curation or configuration calls were made for this study. Existing automatic Pi capture can still run independently.
- DeepWiki was consulted as secondary orientation. Its claim that expanded source facts/chunks are scope-filtered contradicted installed code and was rejected. Its public Pi integration example is not this repository's custom integration.

### Live snapshot—not a quality evaluation

The `pi-memory` bank reported 397 raw facts (307 world, 90 experience), 230 observations and 199 documents. Observations and automatic consolidation were enabled; extraction was `concise`; all three missions were unset; zero mental models and directives; `memory_defense` unset; `store_document_text: true`. There were zero pending/failed operations, but **two pending-consolidation memories** and zero failed consolidation. These counters describe different queues and must not be conflated. Counts change as ordinary sessions run.

## 1. Retain evidence, not disconnected conclusions

[Retain architecture](https://hindsight.vectorize.io/developer/retain) and [Retain API](https://hindsight.vectorize.io/developer/api/retain) emphasize contextual narratives and speaker-labelled, timestamped conversations. Extraction uses content, context and metadata to resolve people, dates and meaning.

Our integration already sends verbatim redacted spans with `User:`/`Assistant:` prefixes and `source_role` metadata. It does **not** pre-summarize them. However:

- Each input message is cut at 1,500 characters before selection. Qualifiers or conclusions after that boundary cannot reach extraction.
- Selected spans are normally separate items; only adjacent project-local spans in the same message merge. “Use that instead” can lose its referent, and a recommendation can lose the later rejection or condition.
- The project-local `context` calls the item “A fact” regardless of whether the assistant proposed, inferred or reported it. Roles exist, but certainty/status distinctions need to survive the extracted text and subsequent consolidation, not just remain in raw metadata.
- `TranscriptEntry` does not carry the original timestamp as a usable field. `automation.ts` supplies retain-time `now()` for every item. Hindsight resolves “yesterday” against that supplied date. Near-live capture usually agrees; delayed/resumed capture can anchor relative dates incorrectly. Preserve statement time when improving capture. This does **not** mean all existing dates or recency rankings are wrong: explicitly extracted occurrence dates also influence ranking.

Fragmentation does not disable the graph: entity resolution and semantic connections can still connect facts across items. The risk is lost referents, qualifications and extraction-time causal context that later retrieval cannot reliably reconstruct.

**Recommendation:** evaluate bounded, coherent, role- and time-labelled evidence units for project-local material. Keep user-wide/transferable items independently meaningful; never attach private project conversation to a broadly visible item merely to improve context. Do not blindly adopt the cookbook's full-transcript capture.

Source anchors: local `transcript.ts:17–19,74–119`, `automation.ts:100–106,947–1000`; installed `engine/retain/fact_extraction.py:1279–1300`, `engine/search/reranking.py:107–150`.

## 2. Documents and operation IDs solve different problems

[Documents](https://hindsight.vectorize.io/developer/api/documents) preserve sources; memories are extracted from them.

- Reusing `document_id` normally replaces that document's content and derived memories. It is not “add one more unrelated message.”
- `update_mode: append` supports growing documents; delta processing can skip unchanged chunks. This is an available alternative, not a recommendation to alter our scope model without evaluation.
- `operation_id` deduplicates an asynchronous submission. It is distinct from source identity. Safe retry requires preserving the original operation identity and request—not calling our helper again, which generates new operation and document IDs.
- Our fresh per-item document IDs deliberately avoid replacing prior evidence or grouping different visibility scopes in one source. The cost is no stable document-level deduplication across repeated submissions; observations do not erase duplicate original documents.

**Privacy correction:** the Retain API page says raw content is “never stored verbatim.” The Documents page and installed implementation contradict that blanket claim. `store_document_text` defaults to true and is true in this bank; source text is persisted. Do not assume extraction discards sensitive originals.

Source anchors: local `hindsight.ts:196–224`; installed `config.py:1679`; `engine/retain/orchestrator.py:2101–2103`.

## 3. Recall is retrieval; Reflect is another reasoning agent

[Recall](https://hindsight.vectorize.io/developer/api/recall) combines semantic, keyword, graph and temporal candidates, then ranks them. **`budget` controls search effort; `max_tokens` controls returned fact text.** Deeper search need not mean a larger prompt. Metadata and wrappers require separate size limits.

Our automatic path requests low effort, 1,000 tokens, up to eight items and a 4 KB rendered block, with each fact clipped at 600 characters. It requests `prefer_observations: true`: raw sources represented by a returned observation are suppressed and slots backfilled. This is useful, but not general semantic deduplication.

The ordinary Pi **`recall` tool searches only the separate manual file stores**, optionally ranked by Jev. It does not query Hindsight. Consequently an agent cannot deliberately investigate a past Hindsight-backed decision through its normal memory tool.

Other important retrieval details:

- A short follow-up such as “why?” is not a useful standalone search query. Our prompt-time query primarily uses the latest user text; preceding relevant context needs bounded handling.
- A best-ranked result need not be relevant. Installed 0.10.1 supports `min_scores`; `reranker`/`final` floors can produce an empty result set, whereas `semantic`/`keyword` floors constrain only their respective retrieval arms. No universal threshold is safe: the API explicitly warns that scores are not calibrated across queries.
- `trace: true` exposes retrieval/ranking phases for diagnosis. Use bounded, local traces during evaluation; they can contain private candidate content and should not become repository fixtures.
- Our extra display-time 600-character clipping can remove a qualification from an injected fact. This is separate from the capture classifier's qualifier guards. Prefer fewer intact facts or explicitly retrievable excerpts over treating a clipped sentence as a complete belief.
- Temporal recall is not an exhaustive date filter. An explicit `temporal_window` steers the temporal arm; other arms can still return out-of-window results. For replay, `query_timestamp` provides the historical query-time anchor.

**Recommendation:** scoped deliberate Hindsight search plus better automatic queries and abstention evaluation, preserving the existing manual tool semantics. Test actual answer usefulness and must-find/irrelevant cases, not just the number of recalled items.

Source anchors: local `hindsight.ts:123–179`, `automation.ts:63–66,432–442`, `transcript.ts:108–119`, `extensions/memory.ts:694–790`; installed `api/http.py:440–510`.

## 4. Observations are already doing the learning

[Observations](https://hindsight.vectorize.io/developer/observations) consolidate related facts, track supporting evidence and reconcile changing information. They are included in ordinary recall; Reflect is not required to obtain them.

`world` versus `experience` distinguishes perspective, not certainty. A `world` fact can be an unverified user or assistant claim. An observation can have only one supporting fact; its existence or proof count alone does not establish correctness. Our source-role metadata is not carried on observations, so attribution should survive in the content where it matters.

The missions are different controls:

| Control | Effect | Implication |
| --- | --- | --- |
| `retain_mission` | Adds extraction focus alongside built-in rules | Trial attribution, uncertainty and durable coding knowledge here first. |
| `observations_mission` | Replaces the built-in durable-knowledge rules | Not a harmless appended instruction; test merging, contradictions and qualifications. |
| `reflect_mission`, disposition, directives | Steer Reflect reasoning | Do not fix ordinary recall or establish programmatic authorization. |

A restrictive extraction mission can yield **zero facts from a successfully processed document**. Retain completion therefore does not prove the wanted memory is searchable. Mission changes also do not retroactively repair existing content without further processing.

Sources: [Bank configuration](https://hindsight.vectorize.io/developer/api/memory-banks), [zero-fact extraction](https://hindsight.vectorize.io/developer/retain#when-a-mission-excludes-everything-in-a-document).

## 5. Stable tags and strict scope checks are essential here

Our shared bank contains multiple projects for one user. Bank separation is available and the cookbooks use it for different users; that does not imply we should migrate this bank. Within our chosen shared-bank design, Pi's controlled write/read paths enforce project applicability.

Keep these distinctions explicit:

- `any`/`all` include untagged facts; strict variants exclude them for non-empty filters.
- `all_strict` means **contains every requested tag**, not exact set equality. `exact` is set equality.
- `observation_scopes: combined` uses the item's complete stable tag set. Session IDs belong in metadata here; making every session a new scope fragments consolidation.
- `shared` creates untagged observations across source tags. `per_tag` creates broader one-tag summaries. Neither is a safe drop-in for our kind-plus-project tags.
- Installed consolidation can consider observations with a superset of the source tags and unions tags on update. Pi's distinct kind tags prevent its valid scope sets from being subsets of one another. This relies on controlled compatible writers, not generic Hindsight tenant authorization.
- Expanded source facts are fetched by bank and IDs, and source chunks by IDs, without reapplying recall tag filters. Keep them disabled in ordinary shared-bank recall. A future evidence-inspection path must verify each source's applicability before exposing it.

**Documentation discrepancy:** [Retain API → observation scopes](https://hindsight.vectorize.io/developer/api/retain#observation_scopes) says `all_strict` matches exactly; its own [Recall API](https://hindsight.vectorize.io/developer/api/recall#all_strict--and-matching-excludes-untagged) correctly permits extra tags. Installed `engine/search/tags.py:74–86` uses containment; `engine/consolidation/consolidator.py:2696–2698,2933–2958` confirms the consolidation behavior. Expansion queries: `engine/memory_engine.py:9320–9326,9646–9652`.

## 6. Corrections must address sources and cached derivatives

The [Memories API](https://hindsight.vectorize.io/developer/api/memories) distinguishes:

- A changed preference: retain new evidence; consolidation can reconcile the change.
- A misextracted fact: edit the raw fact.
- A fact that should no longer be used: invalidate it reversibly.
- A systemic extraction problem: fix extraction policy, then consider explicitly approved reprocessing.

Only `world`/`experience` facts are curatable; observations are derived. Editing/invalidation affects dependent observations and can trigger background processing. It does not rewrite the original source document. **Reprocessing that document resets fact-level curation**, so a retired claim can be extracted again. Invalidation is not erasure.

Any Pi correction path also needs identity/scope checks, cache invalidation and clear treatment of other sessions' already-injected context. Never invalidate every supporting fact merely because an observation is wrong. Existing manual `remember update/delete` only changes its file store, not Hindsight.

Installed source: `engine/memory_engine.py:11691–11754`; behavior of reprocessing is also explicitly documented in the Memories API.

## 7. Observe asynchronous completion honestly

[Operations](https://hindsight.vectorize.io/developer/api/operations) distinguish pending, processing, completed, failed and cancelled work. Retain extraction and observation consolidation are separate operations. The live snapshot above illustrates why “no pending operations” cannot substitute for every consolidation counter.

Our integration reports accepted async retains as queued, but does not track them to completion. Add bounded status visibility before claiming saves succeeded. Then separately check whether facts were produced and consolidation completed where relevant. Do not replace this with indefinite polling, fixed sleeps or blind retries.

Memory Defense is an optional, per-bank redact/block layer; [the current OSS guide](https://hindsight.vectorize.io/developer/memory-defense) describes pattern-based sensitive-data detection, not a guarantee against prompt injection. It is unset here, does not repair historical data automatically, and would not replace redaction before data reaches Jev. A loopback Hindsight URL alone also says nothing about whether its model providers are remote.

## 8. Mental models and knowledge pages are useful only with a read path

A [mental model](https://hindsight.vectorize.io/developer/mental-models) is a maintained answer to a chosen recurring question. Creating/refreshing one runs Reflect; fetching the stored result is a cheap read. **Ordinary recall returns facts/observations, not mental models.** Merely creating one in the Control Plane will not change our current injection path.

[Knowledge pages](https://hindsight.vectorize.io/developer/api/knowledge-pages) organize these documents in a tree, with observation-only, incremental refresh defaults. Their tags are input filters as well as visibility labels: inventing a topic tag absent from source facts can produce an empty page.

If a recurring need warrants a trial:

- Start with one project-scoped question and an explicit Pi read path; do not use an untagged whole-bank summary.
- Review evidence and compare against deliberate recall plus the main agent.
- Budget refreshes; do not rebuild on every tiny retain by default.
- Do not equate `is_stale: false` with correctness. The [mental-model API](https://hindsight.vectorize.io/developer/api/mental-models#staleness-gating) documents that deletions are invisible to write-based freshness checks. Correction/removal needs explicit refresh and verification; old content cannot be assumed to disappear automatically.

[Reflect](https://hindsight.vectorize.io/developer/api/reflect) is appropriate for memory-grounded synthesis needing multiple retrieval steps. It returns evidence and usage, but introduces another model's reasoning, latency and processing cost. Its `max_tokens` bounds final output, not all internal retrieval or total spend. Keep it on-demand and evidence-gated, not a prerequisite for every answer. Citation IDs demonstrate retrieved sources, not semantic truth.

## What this adds to the existing plan

The existing retrieval/capture-first priority remains sound. Add these concrete checks to its small case set rather than starting another planning project:

1. Delayed message with a relative date: preserve original statement time.
2. A qualifier after character 600/1,500: neither injection nor capture should silently turn a conditional statement into an absolute one.
3. Irrelevant query and indirect must-find query: compare search effort independently from output size; inspect traces before tuning score floors.
4. An edited/invalidated fact followed by document reprocessing: explicitly handle curation reset.
5. A deleted source behind a mental model: verify content, not just its freshness flag, if models are ever adopted.

The [tool-learning cookbook](https://hindsight.vectorize.io/cookbook/recipes/tool-learning-demo) illustrates the right product goal: retain feedback and outcomes so subsequent choices improve. Its tiny example changes generation temperature between conditions and is not a controlled benchmark. Likewise, a growing bank is not proof that our assistant is becoming more useful.

**No code, bank configuration, stored memories, model providers or release versions were changed by this study.** The only authored deliverable is this reference; implementation remains a separate authorization.
