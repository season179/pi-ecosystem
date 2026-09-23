# Automatic memory: Jev gating + local Hindsight

Status: implemented, tested, and **activated** (shared bank `pi-memory` configured after
user approval; first use creates the bank lazily). No real-conversation bank data exists:
development used no live banks, and the one live validation (below) used a disposable
synthetic bank that was deleted afterwards.

## What it does

pi-memory can now remember and recall across sessions without the agent calling
`remember`/`recall`:

- **Jev** (TypeSafe `systemOne`) decides *whether* to recall. It also classifies
  each new source unit (a verbatim span of a message): worth keeping or not,
  and where it applies.
- **Code** builds the recall query and the tags deterministically.
- **Hindsight** (local, loopback-only HTTP API 0.10.x) extracts facts, stores
  them, and ranks recall results.

The local file stores, their injection and their tools are unchanged.

## Triggers

| Trigger | When | Awaited? | Result lands |
| --- | --- | --- | --- |
| prompt | First provider request carrying a new user message (including steering/queued messages) | Yes, bounded by 4 s total | Same request |
| periodic | Every `periodicEveryRequests` (default 4) tool-loop continuations of one run; at most one check in flight | No | First request after it completes |
| run-end | `agent_settled` (fires once, after retries), over the messages collected from `agent_end` | No; bounded by 8 s | Retain only: no recall, no extra model request |

The run-end check judges only messages not already judged, so the final
assistant completion (and a last user correction) is captured without waiting
for another prompt.

Retention is asynchronous. At most one retain request is in flight, and at
most one coalesced job waits behind it. At `session_shutdown`, `flush` waits at
most **3 s in total** for the run-end judgment and then drains the whole retain
chain, including the coalesced pending job. Whatever is still unfinished at
the deadline is reported in one warning, not silently dropped:

- judged units never sent;
- a retain cancelled in flight (outcome unknown);
- final messages not judged in time.

Recalled memory is scoped to the run:

- it is re-injected transiently into each request of that run;
- it never enters session history;
- it is dropped at the next prompt unless a fresh check recalls again.

## Shared bank, applicability and provenance

**Storage.** One Pi-owned bank (`pi-memory` by default) holds memories from
every project. Projects are not given separate banks: a project entry can
only opt out, and a per-project `bank` is rejected. Other banks, such as
Hermes's and any existing stores, are never read or written.

**Units.** Each fresh user or assistant message (bounded to 1,500 characters,
secret-redacted on a best-effort basis) is split into verbatim *source units*:
lines first, then sentences. Code fences stay whole. A message with more than 8
spans stays one whole unit. Nothing is rewritten, so no corrected preference
is ever fabricated.

For each unit, Jev answers two questions, and sees the full message and
recent conversation as context:

- `unit_k` (`choice`): which label applies to this span.
- `scope_k` (`noul`): does this span hold on its own, in any project, with no
  project-specific name, path, host, secret or convention and no condition
  elsewhere in the message that it omits?

At most 12 units are judged per check. Messages are taken **oldest first**, and
only those that fit are marked judged. The rest are deferred to the next check
(bounded catch-up within the 12-message transcript window). A deferred message
that leaves the window before any check could judge it is counted as
`dropped unjudged` in status.

| Jev label | Stored as | Tags (stable only) |
| --- | --- | --- |
| `user_preference` | user-wide preference | `pi-memory:user-wide` |
| `transferable_lesson` | transferable lesson | `pi-memory:transferable`, `pi-memory:project:<key>` |
| `project_fact` | project-specific fact | `pi-memory:project-fact`, `pi-memory:project:<key>` |
| `not_durable` | not stored | — |

`<key>` is the first 16 hex digits of the project identity hash.

**Conservative policy** (`classifyUnit`):

- A unit is kept only if `1 − p(not_durable) ≥ retainThreshold` (0.6).
- A broad label (user-wide or transferable) needs all of:
  - its own probability ≥ 0.7;
  - portability (`scope_k`) ≥ 0.8;
  - a *narrow* span. A span is not narrow if the message was truncated, the
    whole-message fallback was used, it exceeds 600 characters, it or the next
    span starts with a qualifier (`except`, `unless`, `but`, `only`, `if`,
    `when`…), or the previous span ends with `:`. So a rule is never split
    from its exception;
  - no deterministic project marker: `[REDACTED]`, a URL, a path or file name,
    or the project's name.
- User-wide also requires that the *user* wrote the unit.
- Anything else that is durable is stored project-local.
- A missing or malformed judgment for any unit voids the whole decision, so
  nothing is stored or recalled.
- Nothing becomes broad by default.

**Items.** A broad unit is its own Hindsight item. Adjacent project-local units
of one message are merged back into one verbatim substring. Every item has its
own tags and a fresh random `document_id`. A user-wide item therefore carries
only its own span, never project text from the same message. Provenance goes
into metadata, never tags:

- `applicability`
- `source_project`, `source_project_hash`
- `source_role`, `source_span`
- `source_session`
- `jev_label` (Jev's original top label per span, `;`-joined, before the
  policy was applied)
- `jev_probabilities` (including `portable=`)
- `jev_model`

**Recall scope.** The server filters with this `tag_groups`:

```json
[{ "or": [
  { "tags": ["pi-memory:user-wide"], "match": "any_strict" },
  { "tags": ["pi-memory:transferable"], "match": "any_strict" },
  { "tags": ["pi-memory:project-fact", "pi-memory:project:<current>"], "match": "all_strict" }
]}]
```

The client then re-checks every result's returned `tags`: exactly one kind tag,
and project facts only for the current project. A single missing or
out-of-scope result discards the **whole** response and emits a one-time
warning. A broad bank recall is never injected.

**Injection.** Each recalled item is labelled with its applicability:

- `(user-wide preference; stated in project X)`
- `(fact about this project)`
- `(lesson from project X; may apply here only if the situation matches)`

The advisory calls lessons from other projects hypotheses, not rules. The
whole block is untrusted background: at most 8 items and 4 KB, escaped and
ownership-tagged.

### Hindsight 0.10.1 behaviour this relies on (verified from installed source, read-only)

- **Item tags and metadata** are copied onto every extracted fact, and recall
  returns `tags` for every fact type (`fact_extraction.py:3270`,
  `http.py:5977`). Observations carry tags but **no metadata**
  (`consolidator.py:3362`). That is why provenance falls back to "this
  project", "another project" or "an earlier session".
- **Without `document_id`, all items of one request share one generated
  document** (`orchestrator.py:1537-1561`). Hence the fresh id per item. A
  fresh id can never match, and so never replace, an existing document.
- **Consolidation ("combined")**:
  - batches never mix tag sets (`consolidator.py:714`);
  - a fact can merge into an existing observation whose tags are a *superset*
    of the fact's, keeping the union of tags (`consolidator.py:2933, 2698`).

  Scope therefore survives because no Pi tag set is a subset of another
  scope's: each set has exactly one distinct kind tag, and every Pi write is
  tagged. Untagged facts written by other tools could merge into any
  observation, so **the bank must be written only by pi-memory**.
- **`tag_groups` strict leaves exclude untagged rows.** The filter applies to
  semantic, BM25, temporal and graph retrieval for all fact types
  (`search/tags.py:348-368`, `retrieval.py:239,675`). `tags` and `tag_groups`
  are mutually exclusive (`http.py:517`).
- **Chunks and source facts are not tag-filtered**
  (`memory_engine.py:9646,9260`). They are explicitly disabled in the request
  (`include: {entities: null, chunks: null, source_facts: null}`).
- **`prefer_observations: true`** makes recall drop any raw fact consolidated
  into an observation in the results, backfilling the freed slots
  (`memory_engine.py` step 4.8), so fact-plus-own-observation duplicates are
  not returned or injected.
- **Retrying the same `operation_id`** returns the original operation, so no
  duplicate work is created.

## Failure handling

The task always fails open. Scope and writes always fail closed.

| Situation | Behaviour |
| --- | --- |
| Bank not created yet (recall 404, `memory_engine.py:8073`) | Treated as empty, not an outage; the first retain creates the bank lazily |
| Hindsight down / timeout / 5xx | No memory for that check; one warning per outage episode; per-service cooldown 30 s doubling to 10 min; no Jev calls while either service cools down; recovers on the next opportunity without a restart |
| Jev down / timeout / malformed | Same cooldown; no decision is substituted; no recall and no retain |
| Missing TypeSafe key / malformed `typesafe.json` | One warning; not treated as an outage; nothing happens |
| Retain timeout, 5xx or malformed ack | Counted `unknown`, **never resent** (it may have been accepted) |
| Retain refused (unreachable, 4xx) | Counted `failed`; its units become judgeable again |
| Stale work (new run, cancellation, session replaced) | Result discarded; the previous run's recall never leaks into the next |
| Mode `read-only` | Recall only; units are not judged. The messages are sent once as recall context and marked considered, so they become `earlier` context and are **never retained later**, even after a switch to `read-write` |
| Mode `off`, config absent/disabled/malformed, non-loopback URL, identity unavailable | Zero service calls |
| Mode changed after the decision | Re-read at submit time; the write happens only in `read-write` |

Feedback loops are cut in three ways:

- owned injected blocks are stripped structurally before any excerpt is built;
- tool results are never judged;
- recalled text that the assistant echoes is replaced by
  `[recalled memory omitted]`, and units that are only an echo are dropped.

## Configuration

`<agentDir>/pi-memory/automation.json`; presence is the opt-in:

```json
{
  "version": 1,
  "bank": "pi-memory",
  "hindsightUrl": "http://127.0.0.1:8888",
  "retainThreshold": 0.6,
  "recallThreshold": 0.5,
  "periodicEveryRequests": 4,
  "projects": { "<identityHash>": { "enabled": false } }
}
```

- **Required:** `version`. Everything else is optional.
- **`hindsightUrl`:** loopback only (`127.0.0.1`, `localhost` or `[::1]`),
  with no credentials, query or fragment.
- **Jev settings:** model, timeout and key come from the shared `typesafe.json`
  (via `TYPESAFE_API_KEY` or `apiKeyFile`).
- **Status:** `/pi-memory status` shows the configuration, per-service health,
  the last check, the current run's recall, and retain counts (accepted,
  unknown, failed, dropped unjudged). Accepted retains are reported as "queued;
  not yet confirmed stored". "Reachable again" recovery notices render as info.

## Proposed defaults (tunable, not user-approved individually)

- `retainThreshold` is 0.6, `recallThreshold` is 0.5, the broad-scope
  confidence floor is 0.7, and the portability floor is 0.8.
- Periodic checks run every 4 continuations; at most 12 units are judged per
  check.
- Prompt deadline 4 s; periodic and run-end 8 s; retain 5 s; shutdown flush
  3 s total.

## Limitations

- **Bounded capture:** the run-end judgment and final retain get at most 3 s at
  shutdown; what misses it is reported, not stored. A backlog that overflows
  the 12-message window (for example, during a long outage cooldown) is counted
  as dropped, not recovered.
- **Splitting is lexical.** Span boundaries are lines and sentences, and the
  broad-scope checks are heuristics plus Jev judgment. A project detail stated
  with no marker and judged portable could still be stored user-wide.
  Qualified or long spans fall back to project-local.
- **No confirmation of storage:** retain is async and the operation is not
  polled.
- **Privacy:** every prompt check sends a bounded, redacted transcript excerpt
  to Jev (a remote paid API), and retained units go to local Hindsight.
  Redaction is best effort.
- **Observations lose provenance metadata:** the source falls back to what the
  tags say.
- **Classifier quality is unmeasured.** Jev's classification of real
  conversations has not been evaluated, because no live or paid calls were made
  during development.

## Evidence

- **Package tests:** 324 tests pass across 18 files. New coverage is in
  `packages/pi-memory/test/automation.test.ts`:
  - real Pi SDK sessions with fake Jev, Hindsight and provider;
  - unit tests of `MemoryAutomation` for applicability, provenance, scope,
    outages and stale work;
  - a single mixed-scope message, a rule with its exception, run-end capture
    with no later prompt, backlog catch-up and dropped accounting, read-only
    to read-write, and shutdown drain and reporting.
- **Mutation checks:**
  - removing the client-side scope check,
  - removing the user-role requirement,
  - removing the tag filter,
  - removing the confidence floor,
  - removing the portability check or the qualifier guard,
  - disabling run-end capture,
  - newest-first selection or marking unjudged messages judged,
  - not marking read-only messages considered,
  - removing dropped accounting,
  - flushing only the in-flight retain,
  - or silencing the shutdown report

  each fails a test.
- **Installed Pi 0.87.1 probe** loaded the package from its local path, with
  fetch fully faked and every other network call blocked:
  - recall reached the first provider request exactly once;
  - `tag_groups` carried the current project key;
  - the retain was async with an `operation_id`, a fresh `document_id`,
    project-fact tags and provenance metadata;
  - injected memory was excluded from the retain;
  - `agent_settled` fired and the run-end check (no recall question) retained
    the final assistant reply, with still exactly one provider request.
- **Live synthetic validation (2026-09-23, activation evidence):** one bounded
  end-to-end run against the real Jev API (`jev-1.13.0`) and real local
  Hindsight 0.10.1, through the built package's production automation loaded
  into an installed Pi 0.87.1 SDK session with a fake main provider capturing
  the assembled request. All service calls were real; only the chat model was
  faked. Isolated temp `agentDir`/cwds and a one-off disposable bank
  (`test-pi-memory-20260923-…`, verified absent first, deleted after).
  Results:
  - 8 real Jev gate calls (prompt + run-end per turn) produced well-formed
    judgments; a first-prompt recall abstention (0.47 < 0.5) correctly meant no
    recall, and task-chatter units were judged `not_durable` and not stored.
  - 4 async retains (fresh `document_id`, provenance metadata, stable tags
    only) were accepted; polling their `operation_id` in the test harness
    showed every operation `completed`. The first retain created the bank
    lazily; production code does not poll.
  - Tags and scope survived Hindsight extraction server-side: the retained
    user-wide preference came back tagged `pi-memory:user-wide` only, and
    project facts came back with `project-fact` + the source project key.
  - Cross-project isolation held on the wire: a second project's recall
    (its own key in `tag_groups`) returned only user-wide items — the other
    project's facts were excluded server-side and never injected.
  - The production assembler injected the recalled block (untrusted advisory,
    per-item applicability labels) into the capturing provider request; nothing
    recalled was persisted to session history, and no block was injected while
    the bank was empty.
  - Real-Jev robustness data point: an assistant's acknowledgment ("Understood,
    I will keep release notes concise") was labeled `user_preference` 0.60 but
    correctly demoted to project-local by the deterministic user-role guard.
  - Duplication observed in the first run (fixed the same day): extraction of
    one retained item yielded both a fact and an observation, and recall
    returned both, injecting the same preference twice. **Resolved narrowly**:
    every recall now sends `prefer_observations: true` (Hindsight 0.10.1
    `RecallRequest`), so the server drops raw facts consolidated into a
    returned observation and backfills the freed slots; a regression test
    pins the wire option, and a rerun of the live probe showed the preference
    recalled and injected exactly once (same-project and cross-project). This
    is not a semantic-dedup guarantee: distinct facts that were never
    consolidated together can still coexist in results.
  Limits: synthetic one-off traffic only — this is wiring evidence, not an
  evaluation of classification quality on real conversations, and it says
  nothing about long-run bank growth or consolidation behaviour.
