# Automatic memory: Jev gating + local Hindsight

Status: implemented, tested, **not activated**. No live bank data exists or was
touched during development. The feature stays off until
`<agentDir>/pi-memory/automation.json` exists.

## What it does

pi-memory can now remember and recall across sessions without the agent calling
`remember`/`recall`:

- **Jev** (TypeSafe `systemOne`) decides *whether* to recall. It also classifies
  each new message: worth keeping or not, and where it applies.
- **Code** builds the recall query and the tags deterministically.
- **Hindsight** (local, loopback-only HTTP API 0.10.x) extracts facts, stores
  them, and ranks recall results.

The local file stores, their injection and their tools are unchanged.

## Triggers

| Trigger | When | Awaited? | Result lands |
| --- | --- | --- | --- |
| prompt | First provider request carrying a new user message (including steering/queued messages) | Yes, bounded by 4 s total | Same request |
| periodic | Every `periodicEveryRequests` (default 4) tool-loop continuations of one run; at most one check in flight | No | First request after it completes |

Retention is asynchronous. At most one retain request is in flight, and at
most one coalesced job waits behind it. Recalled memory is scoped to the run:

- it is re-injected transiently into each request of that run;
- it never enters session history;
- it is dropped at the next prompt unless a fresh check recalls again.

## Shared bank, applicability and provenance

**Storage.** One Pi-owned bank (`pi-memory` by default) holds memories from
every project. Projects are not given separate banks: a project entry can
only opt out, and a per-project `bank` is rejected. Other banks, such as
Hermes's and any existing stores, are never read or written.

**Units.** Each fresh user or assistant message is one *source unit*, bounded
to 1,500 characters and secret-redacted on a best-effort basis. Only the
newest 6 units per check are judged. Jev answers one `choice` question per
unit, and every other message is context only.

| Jev label | Stored as | Tags (stable only) |
| --- | --- | --- |
| `user_preference` | user-wide preference | `pi-memory:user-wide` |
| `transferable_lesson` | transferable lesson | `pi-memory:transferable`, `pi-memory:project:<key>` |
| `project_fact` | project-specific fact | `pi-memory:project-fact`, `pi-memory:project:<key>` |
| `not_durable` | not stored | — |

`<key>` is the first 16 hex digits of the project identity hash.

**Conservative policy** (`classifyUnit`):

- A unit is kept only if `1 − p(not_durable) ≥ retainThreshold` (0.6).
- A broad label (user-wide or transferable) needs its own probability to be at
  least 0.7.
- User-wide also requires that the *user* wrote the unit.
- Anything else that is durable is stored project-local.
- A missing or malformed judgment for any unit voids the whole decision, so
  nothing is stored or recalled.
- Nothing becomes broad by default.

**Items.** Every unit is its own Hindsight item, with its own tags and a fresh
random `document_id`. One preference therefore never makes a mixed exchange
user-wide. Provenance goes into metadata, never tags:

- `applicability`
- `source_project`, `source_project_hash`
- `source_role`
- `source_session`
- `jev_label` (Jev's original top label, before the policy was applied)
- `jev_probabilities`
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
| Mode `read-only` | Recall only; units are not even judged |
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
  the last check, the current run's recall, and retain counts. Accepted retains
  are reported as "queued; not yet confirmed stored".

## Proposed defaults (tunable, not user-approved individually)

- `retainThreshold` is 0.6, `recallThreshold` is 0.5, and the broad-scope
  confidence floor is 0.7.
- Periodic checks run every 4 continuations; at most 6 units are judged per
  check.
- Prompt deadline 4 s; periodic 8 s; retain 5 s.

## Limitations

- **Unjudged messages:** the last exchange before exit is never judged, and
  unjudged units older than the newest 6 are dropped.
- **Unit granularity is one message.** A single message that mixes a preference
  with a project fact is labelled as a whole. Broad labels still need
  confidence, and assistant messages cannot be user-wide.
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

- **Package tests:** 318 tests pass across 18 files. New coverage is in
  `packages/pi-memory/test/automation.test.ts`:
  - real Pi SDK sessions with fake Jev, Hindsight and provider;
  - unit tests of `MemoryAutomation` for applicability, provenance, scope,
    outages and stale work.
- **Mutation checks:**
  - removing the client-side scope check,
  - removing the user-role requirement,
  - removing the tag filter,
  - or removing the confidence floor

  each fails a test.
- **Installed Pi 0.87.1 probe** loaded the package from its local path, with
  fetch fully faked and every other network call blocked:
  - recall reached the first provider request exactly once;
  - `tag_groups` carried the current project key;
  - the retain was async with an `operation_id`, a fresh `document_id`,
    project-fact tags and provenance metadata;
  - injected memory was excluded from the retain.
