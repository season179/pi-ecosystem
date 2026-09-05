# @season179/pi-memory

Durable, agent-managed memory for Pi, split into project and legacy-global stores.
Choose `on-demand` for recallable knowledge or explicitly select `always` to include
its full body automatically when memory is enabled, available, and within budget.

## Requirements

- Node.js >=22.19.0
- Pi >=0.80.10

## Installation

This package is not yet published to npm. From a built `pi-ecosystem` checkout:

```bash
npm install
npm run build --workspace @season179/pi-memory
pi install /absolute/path/to/pi-ecosystem/packages/pi-memory
```

Reload or start a new Pi session after installing or upgrading.

SDK embeddings that pass a custom session `agentDir` should import
`createMemoryExtension({ agentDir })` from `@season179/pi-memory/extension`. The standard package entrypoint
uses Pi's documented `PI_CODING_AGENT_DIR`/`getAgentDir()` process setting;
`ExtensionContext` does not expose an SDK session's custom directory.

## Scopes and Storage

Every current tool call requires an explicit scope:

- `project`: memory for the current repository or directory.
- `legacy-global`: the pre-scope, cross-project store used by 26.8.
- `all`: `recall` only; searches both stores with one ranking and one limit.

For compatibility, historical tool calls that omit `scope` are rewritten to
`legacy-global` before validation. New calls should always name the scope.

Files live under Pi's agent directory:

```txt
<agent-dir>/pi-memory/config.json
<agent-dir>/pi-memory/details.md                         # legacy-global
<agent-dir>/pi-memory/index.md                           # legacy-global
<agent-dir>/pi-memory/projects/<slug>-<hash16>/project.json
<agent-dir>/pi-memory/projects/<slug>-<hash16>/details.md
<agent-dir>/pi-memory/projects/<slug>-<hash16>/index.md
```

In Git repositories, project identity is the canonical Git common directory.
The main checkout, its subdirectories, and linked worktrees therefore share one
project store. Separate clones have different common-directory paths and do not
share memory. Outside Git, the canonical working directory is the identity.
Ambiguous Git failures do not fall back to the directory: project memory becomes
unavailable for that session, while explicit legacy-global tools still work.

`details.md` is authoritative; `index.md` is derived. Missing, stale, or malformed
index data is derived from details for reads and can be replaced by a later
locked write. Invalid UTF-8, unparseable details, duplicate IDs, or an index
without authoritative details fail closed and leave files untouched.

## Modes

Modes control automatic memory from **both scopes**, not tool registration.
The built-in default is `read-write`, so project metadata works without setup;
full-body inclusion requires an explicit `always` selection.

| Mode | Automatic memory and mode policy | Project reads | Project writes | Legacy-global reads/writes |
| --- | --- | --- | --- | --- |
| `off` | None, including global always entries | Allowed | Allowed | Allowed |
| `read-only` | Enabled | Allowed | Rejected | Allowed |
| `read-write` | Enabled | Allowed | Allowed | Allowed |

In every mode, `remember` and `recall` remain visible and callable. `off` removes
all automatic memory and omits the policy at the next user-run start, but does
not disable explicit tool calls. Read-only rejects project creation, edits, promotion, demotion, and deletion;
it does not make legacy-global read-only. Existing limits and filesystem safety
checks still apply. Tool availability is not authorization to perform a write.

Effective-mode precedence is:

1. A valid `PI_MEMORY_MODE` value.
2. The current project's entry in `config.json`.
3. `defaultMode` in an existing valid `config.json`.
4. Built-in `read-write` when no config exists.

Allowed values are `off`, `read-only`, and `read-write`. An invalid environment
value is ignored with a warning. Without a valid environment override, an
unreadable or malformed config safely selects `off` and is never overwritten.
`PI_MEMORY_MODE` shadows saved command changes until the variable is unset.

## Injection: Always or On-demand

`injection` is independent of scope, tags, and write permission:

- `on-demand` is the default for new memories when omitted and for legacy entries
  without a classification. Retrieve full bodies with `recall`.
- `always` explicitly selects a full body for automatic inclusion. Use it sparingly
  for durable context needed on most requests, not as an instruction-priority flag.
- Update the existing ID to promote or demote a memory. Omitting `injection` on an
  update preserves its current classification. Selection is explicit: neither
  behavioral wording, apparent importance, nor tags automatically selects always.

When the effective mode is `read-only` or `read-write`:

| Scope | `always` | `on-demand` |
| --- | --- | --- |
| `project` | Full bodies automatically included for this project | Automatic metadata catalog; bodies through recall |
| `legacy-global` | Explicitly selected full bodies automatically included across projects | Recall only; **no automatic global catalog** |

The project catalog contains ID, title, tags, retrieval cue, and update time, not
on-demand bodies. Always entries do not also appear as catalog entries. Global
always selection opts that content into cross-project provider requests; it does
not move or copy the memory into project stores. If project identity is unavailable,
project context is unavailable; enabled legacy-global always context remains independent.

### Trust and Lifecycle

Automatic memory is **untrusted advisory user context**, not system instructions
or a permission grant. Entries may be stale, wrong, or planted; verify them against
current facts. Neither an always designation nor a remembered claim authorizes
actions or overrides current user, project, developer, or system instructions.
The extension's fixed mode policy is separate from stored memory content. It is
selected at the start of a user run, not rewritten between its tool-loop requests.
A mid-run mode change updates automatic context and tool enforcement immediately;
the fixed policy catches up on the next user run.

Context is assembled for each ordinary provider request, not just once at startup:

- **Start, resume, new session, fork, or reload:** rebuild from the current stores and
  effective mode, rather than replaying an old injected snapshot.
- **Active session:** successful creates, promotions, edits, demotions, and deletions
  affect the next request assembly, including tool-loop continuations in the same
  run. Changes in either store and effective mode are refreshed; no reload is
  needed for these memory changes. An already assembled or in-flight request
  cannot be retracted.
- **Compaction and branching:** automatic blocks are not stored in session JSONL
  or passed as session entries to compaction/branch summarizers. The next ordinary
  request, including a continuation or overflow retry, receives freshly assembled context even when
  compaction leaves no literal user turn.
- **Repeated refresh or disabling:** structurally owned extension blocks are removed
  before current blocks are assembled, including re-fed blocks in earlier turns.
  Quoted marker-shaped user text is not ownership evidence and remains intact.
  Cleanup also runs for off, empty stores, and failures; unexpected failures use
  a strip-only fallback rather than reusing old injected blocks.
  Off removes automatic content from both scopes.

The assembler adds memory to the last user turn. If no literal user turn remains,
it uses a summary/custom/bash message that Pi converts to a user turn; if none is
available, it prepends a transient user message without interrupting tool-call/result
adjacency. These are request-only transformations, not new saved conversation turns.

Transient injection does not erase recalled tool results, assistant quotations,
or other derived text already in history; those can persist and enter summaries.
Memory failures must not fail the user's task.

### Budgets and Recovery

Automatic inclusion has independent, reserved per-scope budgets. A project cannot
consume the global reservation or vice versa. Budgets measure rendered context,
not just body text: include wrappers, advisory text, metadata, escaping, separators,
and reserved diagnostic overhead. Always bodies are reversibly escaped (including
backslashes, closing delimiters, and control characters), not stripped or truncated.
Project on-demand metadata is separately bounded; omitted entries remain recallable.

| Independent reservation | UTF-8 bytes | Estimated tokens | Entry limit |
| --- | --- | --- | --- |
| Project always | 8,192 | 2,000 | Must fit in full |
| Legacy-global always | 4,096 | 1,000 | Must fit in full |
| Project on-demand catalog | 4,096 | 1,000 | 200 |

Each always reservation includes **512 bytes and 128 estimated tokens reserved
for diagnostics**; that allowance is not extra body capacity. The complete normal
always block must therefore fit **7,680 bytes / 1,872 estimated tokens** for project
or **3,584 bytes / 872 estimated tokens** for legacy-global. Measurement uses a
fixed-length generation and worst-case bytes and estimated tokens across the
project-mode lines so changing modes cannot make an admitted entry overflow.
Normal renders may use less than this conservative admission measurement.
Error replacement blocks fit inside the 512-byte / 128-token diagnostic reservation. The independent ceilings sum to **16,384 bytes / 4,000 estimated
tokens** of automatic memory per ordinary request (excluding fixed policy/tools).
On-demand metadata can be omitted to meet its catalog cap, with an omission count
and recall guidance. That catalog truncation rule never selects a subset of always
memories.

UTF-8 bytes and estimated tokens are different measurements. The current estimator
is `ceil(text.length / 4)`, using JavaScript UTF-16 code units, not Unicode code
points or the provider's tokenizer. These per-request memory caps **do not reserve
room in the provider's actual context window**, guarantee that the full request
fits, or change Pi compaction's `reserveTokens` setting. Other instructions,
history, and tool results also consume context. Automatic-context budgets are
separate from the on-disk storage caps described below.

- **Tool mutation:** validate under the affected store's mutation lock, without
  cross-store checks or locks. Reject projected overflow before committing with
  `PI_MEMORY_INJECTION_BUDGET_EXCEEDED`, including an oversized create, promotion,
  or edit. A rejected pre-commit change does not change the memory or spend a
  committed-mutation allowance.
- **External change:** replace the affected scope's **entire always set** with a
  bounded actionable error. No newest-first subset or partial body is injected.
  The error says all always bodies for that scope were excluded, reports usage
  versus limits, and includes recovery guidance or a compact status pointer with
  recovery actions. Preserve the other scope and independent project on-demand
  catalog where safe. The task
  continues. Status lists the complete selected and excluded IDs.
- **Recovery:** recall or locally show the affected entries; demote unnecessary always
  entries, shorten content, or delete obsolete entries in the same scope. Recovery
  mutations remain possible under the cap rules; ordinary permissions and the
  per-run mutation limit still apply. Deletes and demotions are permitted injection
  recovery; other updates that remain over budget must strictly shrink usage without
  growing either byte or estimated-token usage. Existing storage-cap recovery
  remains a separate requirement: demotion does not bypass it.

Capacity errors appear in context on every affected request. A user-facing error
is emitted once per affected scope/store generation per session through TUI/RPC
notification or stderr in **both print and JSON modes**. A changed generation can
produce another notification. The bounded context error does not embed an
unbounded ID list; use status for every excluded always ID and recovery guidance. Memory errors do not stop the user's task.
Recovery that still exceeds the injection cap returns
`INJECTION_OVER_BUDGET_REMAINS`; continue demoting, shrinking, or deleting.

## Tools

- `remember`: create, update, or delete in `project` or `legacy-global`.
- `recall`: search `project`, `legacy-global`, or `all`; results are scope-labeled.

IDs are immutable (`m_aaaaaaaaaa`). Recall before updating or deleting so the
ID and scope are known. Exact ID/title matches rank first, then word overlap
across title, tags, and cue, then recency. An empty query returns recent entries.
`includeDetails=false` omits bodies from recall results; it does not change the
memory's injection classification. The default includes bodies. Search matches
metadata, not body text. Recall and local show expose the normalized injection
classification; remember results report selection and post-change scope budget usage.

### Argument Schema

These are tool arguments, not the format of the Markdown storage files.

| Tool/action | Required fields | Optional fields |
| --- | --- | --- |
| `remember` create | `action:"create"`, `scope`, `title`, `cue`, `body` | `tags`, `injection` (default `"on-demand"`) |
| `remember` update | `action:"update"`, `scope`, `id`, at least one editable field | `title`, `cue`, `body`, `tags`, `injection` (omitted fields preserved) |
| `remember` delete | `action:"delete"`, `scope`, `id` | None needed |
| `recall` | `scope`, `query` | `limit` (1–10, default 5), `includeDetails` (default true) |

`remember` scope is `project` or `legacy-global`; `recall` also accepts `all`.
`injection` accepts only `"always"` or `"on-demand"`, on create/update; `null` and
unknown values are rejected, not treated as omission. An update
containing only the ID, scope, action, and injection classification is valid.
Use `tags:[]` to clear tags; omit tags to preserve them on update.

### JSON Examples

Each block is an independent tool call, not one run: at most **three committed
mutations per user run**, across both scopes. Recall first to avoid duplicates and
obtain the right scope/ID. The scenarios below are fictional examples, not facts
to save unchanged. Replace illustrative IDs with actual returned IDs.

**Recall — search both stores, metadata only:**

```json
{"scope":"all","query":"historical import investigation","limit":5,"includeDetails":false}
```

**Remember — create an on-demand historical reference:** omitting `injection` has
the same default. Use this for knowledge needed during occasional investigation,
not facts already recoverable from the repository.

```json
{
  "action":"create",
  "scope":"project",
  "title":"Historical import investigation",
  "cue":"When revisiting the archived partner import incident",
  "body":"The 2026-08-14 investigation traced the mismatch to partner exports that omitted timezone offsets. The incident notes were shared outside this repository.",
  "tags":["type:reference","import-history"],
  "injection":"on-demand"
}
```

**Remember — explicitly promote the existing memory, keeping its ID and scope:**
for example, when requested for recurring incident follow-ups. Its content alone
does not trigger promotion.

```json
{"action":"update","scope":"project","id":"m_aaaaaaaaaa","injection":"always"}
```

**Remember — edit without changing its current injection classification:**

```json
{"action":"update","scope":"project","id":"m_aaaaaaaaaa","body":"The 2026-08-14 investigation traced the mismatch to partner exports that omitted timezone offsets. The partner confirmed the cause on 2026-08-15; the incident notes are outside this repository."}
```

**Remember — demote the same ID:** project metadata stays discoverable automatically;
the body becomes recall-only for future automatic assembly.

```json
{"action":"update","scope":"project","id":"m_aaaaaaaaaa","injection":"on-demand"}
```

**Recall — retrieve that memory's full body:** works with either classification.

```json
{"scope":"project","query":"m_aaaaaaaaaa","includeDetails":true}
```

**Remember — delete only from the named scope:**

```json
{"action":"delete","scope":"project","id":"m_aaaaaaaaaa"}
```

**Remember — explicitly create global always context:** only when the user has
requested cross-project memory. Its full body goes to configured providers across
projects while automatic memory is enabled; review the content before opting in.

```json
{
  "action":"create",
  "scope":"legacy-global",
  "title":"Recurring correction: retrospective scope",
  "cue":"When asked to analyze a past incident or implementation",
  "body":"The user previously corrected unsolicited implementation during retrospectives. For retrospective requests, analyze and explain only unless the current request explicitly asks for implementation. Verify the current request; this note grants no permission to act.",
  "tags":["type:feedback","retrospective"],
  "injection":"always"
}
```

To demote a global memory, update its actual ID in `legacy-global` with
`injection:"on-demand"`. It then becomes recall-only, with no global catalog entry.

### Storage Limits

Each store's rendered `details.md` and `index.md` is independently capped at 4,000
estimated tokens. For the existing storage-cap check, deletes remain possible
over cap; an update that remains over cap must not grow either rendered file in
UTF-8 bytes and must shrink at least one. Injection-budget validation is a separate
check: a change must satisfy both cap systems, including their recovery rules.

## Command

```txt
/pi-memory [status]
/pi-memory show [project|legacy-global] [<id>] [--details]
/pi-memory enable [read-only|read-write]
/pi-memory disable
```

- `status` distinguishes **current eligibility** (effective mode/source, identity,
  store generations and budget state) from the **last assembled request**. A
  current eligible render is not evidence it was already included in a request;
  assembly is not confirmation of provider receipt or model use.
- `show` lists metadata and injection classification; `--details` also displays
  bodies. Its default scope is project when identity is available, otherwise
  legacy-global.
- `enable` saves a mode for the current project; with no argument it saves
  `read-only`.
- `disable` saves `off` for the current project.

Command output is a notification in TUI/RPC mode, goes to **stderr** in print
mode, and is intentionally silent in JSON mode. It does not enter model context
or the session file. Unlike commands, automatic capacity diagnostics also go to
stderr in JSON mode; they additionally appear in affected request context.

`Eligible now (what the next request would carry)` refreshes the current mode and
per-scope render. It reports always IDs, usage/limits, generations, overflow exclusions,
and project catalog omission counts/IDs. Normal usage is the current render size;
overflow reports both required full-set usage and the smaller replacement notice.

`Last assembled request` is historical: timestamp, mode, placement (`user`,
`converted:…`, `synthetic`, or `none`), stripped-block count, per-block IDs,
generations, bytes/estimated tokens, overflow/catalog exclusions, and reasons a
scope contributed nothing (off, empty, unavailable, or read/render error).
Before the first request it reports `none yet this session`. A mode change or
store edit can make this differ from eligibility now. Status does not overwrite
that historical record or imply provider delivery.

## Upgrading from 26.8

1. Upgrade to Node >=22.19.0 and Pi >=0.80.10.
2. Update the checkout, rebuild, reinstall, and reload/start a new Pi session.
3. Run `/pi-memory status` and `/pi-memory show legacy-global`.
4. Project memory is automatically active in `read-write`; use `/pi-memory
   disable` only if you want to turn proactive memory off for this project.

Existing entries without an injection classification default to `on-demand`;
upgrading does not automatically promote old memories or expose global metadata.
The 26.8 root store remains in `legacy-global`. Nothing is moved or copied
automatically, and there is no migration command yet (`/pi-memory migrate`
reports that it is unavailable). To copy selected knowledge, recall it from
legacy-global and explicitly create a project memory after reviewing it; delete
the original separately only if intended. Promotion/demotion is not scope migration.

Back up both stores and configuration **before upgrading or changing stored
classifications**. Do not move files between generated project directories.
Use tools to change injection rather than guessing at the Markdown representation.

### Downgrading

The format adds optional `Injection: always` after `Cue:` in `details.md`.
On-demand serialization uses the legacy layout without that line; the new parser
also accepts an explicit `Injection: on-demand` line. Absent selection means
on-demand, unknown values fail closed, and the derived index format is unchanged.
Reads do not rewrite legacy files. A successful mutation serializes the whole
named store, omitting any explicit on-demand metadata lines. Ordinary mutation
timestamps still change; demotion restores the legacy layout, not old timestamps.

**Older readers cannot read the always metadata line.** Do not run old and new
writers simultaneously against a store containing it. Before downgrading, back up
the newer stores, then use the newer version to demote or remove always entries
from both scopes and verify the rewritten files use the legacy layout. An explicit
on-demand metadata line must also be normalized to the legacy layout for older
readers. Alternatively, restore a compatible pre-upgrade backup; this loses later
changes unless preserved separately. Do not assume changing the package alone
converts the store.

## Concurrency and Filesystem Boundary

Mutations use an in-process queue, an owner-checked cross-process directory
lock, synchronized temporary files, and atomic rename, with `details.md`
committed before the derived index. This prevents lost updates between
cooperating Pi processes on the same local filesystem.

These are local-filesystem guarantees, not distributed coordination. Do not
rely on them across NFS/network filesystems, cloud-synced copies, containers
with separate roots, or different hosts. Symlinked memory paths are rejected.

## Privacy and Deletion Limits

Memories are plaintext Markdown, not encrypted. Do not store secrets,
credentials, or sensitive personal data. While automatic memory is enabled,
ordinary requests send project on-demand metadata and selected always bodies
from the project and legacy-global stores to the configured model provider.
Legacy-global always bodies travel across projects; there is no automatic catalog
of other global entries. Explicit recall sends returned metadata/bodies regardless
of automatic mode, and its results may persist in Pi session history.

Transient automatic blocks are not themselves written to session JSONL, but a model
can quote or act on them; derived text and summaries can persist. Local
`/pi-memory show --details` displays bodies without sending them to the model.
Check the provider's retention policy. Demotion, off, and deletion affect future
automatic inclusion, not previously sent data or copies already in history.

`remember delete` removes an entry from the current local store. It is not secure
erasure and cannot remove prior provider requests, Pi session history, backups,
filesystem snapshots, or synced/copied stores. The extension provides no
retention policy, redaction service, remote deletion, or cross-store deletion.

## Troubleshooting

- **Expected always content missing:** check effective mode, the correct scope/ID
  and injection classification with `/pi-memory status` and `/pi-memory show`.
  Compare current eligibility with last assembly; check identity, store errors,
  and budget diagnostics. An environment mode can override a saved enable command.
- **Injection budget overflow:** review affected entries with recall or local show;
  demote, shorten, or delete in the named scope. Read-only project recovery first
  requires write permission. Do not blindly retry the same oversized change or
  treat a memory failure as a reason to abandon the user's task. The affected
  always set is excluded in full until it fits; the other scope is independent.
- **Lock (`PI_MEMORY_BUSY` / `PI_MEMORY_LOCK_UNSAFE`):** retry a busy store
  shortly. For an unsafe lock, inspect `.pi-memory-mutation.lock/owner.json` and
  stop every Pi process that could own it before removing anything. Locks are
  never stolen merely because they are old.
- **Identity unavailable or mismatched:** run `/pi-memory status`; verify Git and
  `git rev-parse --path-format=absolute --git-common-dir`. A `project.json`
  sidecar must match the generated directory and canonical identity. Do not edit
  it to force two clones to share; repair or restore the matching store, then
  start a new session.
- **Corruption:** back up the affected store. Repair authoritative `details.md`
  manually when it has invalid UTF-8, malformed sections, or duplicate IDs.
  `index.md` cannot recover bodies; it is derived from details. The extension
  leaves corrupt files untouched and currently has no repair/migration command.
- **No tools:** confirm the package is installed and enabled, then build it and
  reload Pi. For local loading, use `pi -e ./packages/pi-memory` after building.

## Local Development

```bash
npm install
npm run build --workspace @season179/pi-memory
npm test --workspace @season179/pi-memory
npm pack --workspace @season179/pi-memory --dry-run
```

Smoke-test without global extensions:

```bash
pi --no-extensions -e ./packages/pi-memory --help
```

The tarball should include `README.md`, `LICENSE`, `package.json`, and compiled
files under `dist/`. In the workspace, see the
[injection diagnosis and verification report](../../docs/MEMORY-INJECTION.md)
for implementation evidence and known limitations.

## Security

Pi extensions execute with your user permissions. Review the source before
installing.
