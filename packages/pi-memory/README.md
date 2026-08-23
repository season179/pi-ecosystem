# @season179/pi-memory

Durable, agent-managed memory for Pi, split into project and legacy-global stores.
Pi can proactively receive a small project-memory catalog; full memory bodies stay
out of that catalog and are retrieved with `recall`.

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

Modes control proactive **project** memory behavior, not tool registration.
The built-in default is `read-write`, so project memory works automatically without setup.

| Mode | Project catalog and prompt policy | Project reads | Project writes |
| --- | --- | --- | --- |
| `off` | None | Allowed | Allowed |
| `read-only` | Enabled | Allowed | Rejected |
| `read-write` | Enabled | Allowed | Allowed |

In every mode, `remember` and `recall` remain visible and callable. In
particular, `off` removes the proactive catalog and memory policy but does not
disable explicit project tool calls. Explicit legacy-global reads and writes
also remain available in every mode.

Effective-mode precedence is:

1. A valid `PI_MEMORY_MODE` value.
2. The current project's entry in `config.json`.
3. `defaultMode` in an existing valid `config.json`.
4. Built-in `read-write` when no config exists.

Allowed values are `off`, `read-only`, and `read-write`. An invalid environment
value is ignored with a warning. Without a valid environment override, an
unreadable or malformed config safely selects `off` and is never overwritten.
`PI_MEMORY_MODE` shadows saved command changes until the variable is unset.

## Automatic Catalog

In `read-only` and `read-write`, each ordinary provider request can receive one
trailing, transient catalog for the current project. It contains metadata only:
ID, title, tags, retrieval cue, and update time. It contains no bodies, is not
written to the Pi session JSONL, and is treated as untrusted advisory context.
Use `recall` with `scope=project` for full bodies.

The whole catalog is capped at all three limits:

- 4,096 UTF-8 bytes
- about 1,000 estimated tokens (`ceil(characters / 4)`)
- 200 entries

Newest entries are retained first and an omission count directs the agent to
`recall`. An empty or unreadable project store injects no catalog; memory errors
fail open so they do not fail the user's task. Catalog injection is currently
verified for Anthropic Messages and OpenAI Completions/Responses (including
Azure and Codex Responses). It is omitted with a warning for other APIs because Bedrock
and Gemini reject the resulting trailing user turn; switching to a verified API
re-enables it for the next request.

## Tools

- `remember`: create, update, or delete in `project` or `legacy-global`.
- `recall`: search `project`, `legacy-global`, or `all`; results are scope-labeled.

IDs are immutable (`m_aaaaaaaaaa`). Recall before updating or deleting so the
ID and scope are known. Exact ID/title matches rank first, then word overlap
across title, tags, and cue, then recency. An empty query returns recent entries.
`includeDetails=false` omits bodies; the default includes them.

Each store's rendered `details.md` and `index.md` is capped at about 4,000
estimated tokens. Deletes remain possible over cap; updates are allowed only
when they shrink without growing either rendered file. At most three committed
memory mutations are allowed per user run across both scopes.

## Command

```txt
/pi-memory [status]
/pi-memory show [project|legacy-global] [<id>] [--details]
/pi-memory enable [read-only|read-write]
/pi-memory disable
```

- `status` reports effective mode/source, identity, both stores, and catalog state.
- `show` lists metadata; `--details` also displays bodies. Its default scope is
  project when identity is available, otherwise legacy-global.
- `enable` saves a mode for the current project; with no argument it saves
  `read-only`.
- `disable` saves `off` for the current project.

Command output is a notification in TUI/RPC mode, goes to **stderr** in print
mode, and is intentionally silent in JSON mode. It does not enter model context
or the session file.

## Upgrading from 26.8

1. Upgrade to Node >=22.19.0 and Pi >=0.80.10.
2. Update the checkout, rebuild, reinstall, and reload/start a new Pi session.
3. Run `/pi-memory status` and `/pi-memory show legacy-global`.
4. Project memory is automatically active in `read-write`; use `/pi-memory
   disable` only if you want to turn proactive memory off for this project.

The 26.8 root store remains byte-for-byte in `legacy-global`. Nothing is moved
or copied automatically, and there is no migration command yet (`/pi-memory
migrate` reports that it is unavailable). To move selected knowledge, recall it
from legacy-global and explicitly create a project memory after reviewing it.
Back up the store first; do not move files between generated project directories.

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
credentials, or sensitive personal data. While a mode is enabled and the
catalog is nonempty, project metadata is sent to the configured model provider
on each request. Bodies are sent to the provider when returned by `recall`;
recalled tool results may also persist in Pi session history. Check the
provider's retention policy.

`remember delete` removes an entry from the current local store. It is not secure
erasure and cannot remove prior provider requests, Pi session history, backups,
filesystem snapshots, or synced/copied stores. The extension provides no
retention policy, redaction service, remote deletion, or cross-store deletion.

## Troubleshooting

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
files under `dist/`.

## Security

Pi extensions execute with your user permissions. Review the source before
installing.
