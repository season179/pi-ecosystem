# Persistent memory injection: implementation and verification

## Diagnosis

The previous `packages/pi-memory` implementation stored full bodies in authoritative
`details.md` files, with a derived `index.md`. `remember` and `recall` already
supported project and legacy-global stores; updates preserved IDs.

Automatic availability was narrower than storage:

- The ordinary `context` hook rendered only project metadata: IDs, titles, tags,
  retrieval cues, and update times. Bodies required `recall`.
- The catalog had its own 4,096-byte / 1,000-estimated-token / 200-entry limits.
  It retained newest entries and reported omissions.
- A fixed extension policy was appended at `before_agent_start`. It was not a
  full-body injection path.
- Catalog context was transient and merged into a user turn, not persisted to
  the session JSONL. The runtime refreshed across lifecycle replacements and
  invalidated its catalog after local project mutations.
- Compaction and branch summarization used separate calls over durable history;
  they did not run ordinary catalog injection. The next ordinary request needed
  to reconstruct memory context. The old assembler returned no injection when
  no literal user message remained.
- `remember` checked a cached mode, so a read-write → read-only change between
  request assembly and tool execution could still permit a write. Marker-based
  deduplication could also delete a user's literal quotation of a catalog block.
  Both were reproduced using an isolated installed-Pi SDK probe.

This explains an availability gap, not the entirety of the reported incidents.
An agent can fail to retrieve a catalog entry, or disregard guidance it has
already read. Automatic full-body injection addresses the former, not guaranteed
compliance. The application repository and its conversation history were not
needed for this investigation.

## Design rationale

Use an explicit per-memory treatment, not tags or inferred importance. Existing
records and ordinary creates remain on-demand. Promotion and demotion update the
same ID. Keep reference metadata and selected full bodies in separate bounded
reservations, with independent project/global budgets so concurrent writes can
be checked under the existing per-store lock.

Keep memory-derived text transient and clearly labeled as persistent untrusted
advisory context. Do not place it in the system prompt or treat it as permission
to act. Reassemble current memory on ordinary requests rather than relying on a
compaction summary to preserve a previous copy.

The tool field is `injection: "always" | "on-demand"`. Omission defaults to
on-demand on create and preserves treatment on update. Legacy files are read
without migration writes; only always entries need an `Injection: always`
metadata line. The derived index format stays unchanged.

The full rendered always reservations are 8,192 bytes / 2,000 estimated tokens for
project memory and 4,096 bytes / 1,000 estimated tokens for legacy-global memory.
Each includes 512 bytes / 128 estimated tokens of diagnostic headroom. The
project reference catalog retains its separate 4,096-byte / 1,000-token limit.
Admission is checked under the existing store lock. An external overflow replaces
the affected entire always set with an actionable error, never a partial subset.

Explicit global always selections apply across projects; ordinary global
references remain recall-only. Effective `off` suppresses all automatic blocks.
Project read-only enforcement refreshes at mutation admission. Structural
ownership tags replace marker-text guessing for transient-block cleanup.

For user-facing parameters, limits, lifecycle semantics, migration, and recovery,
see [the package README](../packages/pi-memory/README.md).

## Verification baseline

Before changes: `npm test --workspace @season179/pi-memory` passed all 152 tests
across nine test files on repository Pi SDK 0.80.10. An independent, no-network
probe on installed Pi 0.85.1 confirmed the old ordinary catalog included metadata
but no body, omitted injection on summary-only continuation, and did not persist
transient blocks.

## Final regression evidence

`npm run build --workspace @season179/pi-memory`,
`npm test --workspace @season179/pi-memory`, and `git diff --check` pass.
`npm pack --workspace @season179/pi-memory --dry-run --ignore-scripts` also passes
against that build and includes the compiled injection module and declarations.
The final suite has **272 passing tests across 16 files** (152 before this change).
Coverage includes:

| Acceptance area | Observable checks |
| --- | --- |
| Availability and selection | Fresh SDK session receives the complete correction; reference metadata appears without its body; recall returns that reference body. |
| Mutations | Same-ID promotion/demotion, omitted-policy edits, deletion, both scopes, and next-request refresh. |
| Isolation and permissions | Unrelated projects, same IDs across scopes, explicit global opt-in, unavailable project identity, live read-only changes, and cached symlink swaps. |
| Compatibility | Legacy fixture bytes/hashes unchanged on read, absent-policy defaults, invalid-policy rejection, historical scope-less calls. |
| Lifecycle | Real new/resume/reload/fork, branch summarization, split-turn compaction and automatic no-new-user retry. |
| Capacity | Exact byte/estimated-token boundaries, locked concurrent admission, rejected-write immutability, recovery, whole-set external overflow, bounded actionable errors in print/JSON/RPC. |
| Context integrity | Re-fed/cloned contexts do not duplicate blocks; quoted markers survive; transient bodies stay out of session JSONL and summarizer input. |

The tests also serialize actual fresh and post-compaction SDK contexts through
six real Pi AI serializers: Anthropic Messages, OpenAI Completions, OpenAI
Responses, OpenAI Codex Responses, Google Generative AI, and Bedrock Converse.
Each is intercepted before network I/O. Bodies remain in user context, internal
ownership tags are removed, and tool-call/result adjacency is preserved.

### Inspected assembled context

Raw captures and the verification manifest are in
`/tmp/pi-memory-injection/evidence/`. These are observations from real SDK session
assembly with a scripted, no-network provider—not standalone renderer fixtures.
The orchestrator inspected both extracted contexts:

| Capture | Before memory/conversion | Provider-context roles | Result |
| --- | --- | --- | --- |
| `fresh-assembled-context.json` | `user` | `user` | Full correction exactly once; reference metadata only. |
| `postcompact-assembled-context.json` | `compactionSummary, assistant, toolResult` (zero literal users) | `user, assistant, toolResult` | Full correction exactly once, immediately on automatic retry. |

Both contain this **entire synthetic memory body**, without a `recall` call in
the fresh session or compaction retry:

```text
ALWAYS_FULL_BODY_BEGIN_f17ab4
When asked for a retrospective, limit the work to analysis. Do not write tests or project instructions unless the current user request explicitly asks for them.

ALWAYS_FULL_BODY_MIDDLE_61a193
Synthetic multilingual note: café 漢字 😀.
ALWAYS_FULL_BODY_END_8cd905
```

The body appears inside `<pi_memory_always advisory="untrusted" scope="project">`
(with its actual generation attribute), after framing that explicitly denies
permissions and precedence over system/developer/current user/project instructions.
It is absent from the system prompt. The separate on-demand research body is absent.

Snapshot SHA-256 hashes recorded by the manifest:

- Fresh: `1e619de4af98489a06dd8ea0acf67311563b0ed16eb3d43d49e282b3ffe8bba9`
- Post-compaction: `31e0560491d23e49b8993e5d9dd9c06d5182346a6706cfa0a8e0242baf20680e`

Regenerate captures and inspect them from the repository root:

```sh
npm run build --workspace @season179/pi-memory
PI_MEMORY_EVIDENCE_DIR=/tmp/pi-memory-evidence \
  ./node_modules/.bin/vitest run packages/pi-memory/test
node packages/pi-memory/test/helpers/write-injection-manifest.mjs /tmp/pi-memory-evidence
```

The manifest records source capture/index, pre-conversion and provider roles,
body-canary counts, reference-body exclusion, and extracted-file hashes. Fresh
runs generate new IDs/timestamps, so hashes change. No real stored memories,
application-repository data, or provider credentials are used.

### Independent installed-Pi verification

An independent probe against installed **Pi / Pi AI 0.85.1** passed **14 checks**
with 13 captured requests across five persistent fixture sessions. The orchestrator
reran it after the final build: zero failures. Captures verify fresh full project
and global bodies, body-only external refresh, actual on-demand recall, read-only
rejection after request assembly, real manual split-turn compaction followed by
direct no-new-user continuation, and separate summary-only continuation.
Concurrent sessions with distinct projects and explicit agent directories remained
isolated; unavailable project identity did not suppress selected global bodies.

Results and exact assembled contexts:

- `/tmp/pi-memory-injection/final-probe-result.json` (checks and compiled-file hashes)
- `/tmp/pi-memory-injection/final-captures.json` (the orchestrator inspected the fresh context)
- `/tmp/pi-memory-injection/final-probe.mjs` (rerunnable isolated probe)

This complements—not replaces—the repository SDK 0.80.10 automatic-overflow retry
and six-serializer tests. The installed-Pi probe uses a fake provider and seeded
valid tool history for manual compaction, not a live provider or an automatic
threshold run. Its summary-only variant deliberately retains just the genuine
summary checkpoint.

## Remaining limitations

- Automatic availability **does not guarantee model compliance**. These checks
  prove assembly and serialization, not a live model's choices or provider receipt.
- `always` applies to ordinary enabled requests, not separate compaction/branch
  summarizers or unrelated extension-owned model calls. Later extensions can
  still modify context.
- `off`, unavailable/corrupt stores, and explicit capacity errors can prevent
  inclusion; status distinguishes current eligibility from the last assembly.
- Token counts are estimates. These caps do not reserve provider context-window
  space or change Pi's compaction settings. Fixed mode policy updates per user
  run; transient mode text and tool permissions refresh within the run.
- External refresh uses file-stat signatures. It is not continuous content hashing
  against a writer deliberately preserving all tracked attributes.
- Demotion/deletion cannot retract in-flight requests, recalled history, model
  quotations, provider retention, or backups. Older package readers require
  legacy-layout files before downgrade; follow the README.

No application-repository changes, real-memory promotions, installs, publishing,
or release/version changes were made by this work.
