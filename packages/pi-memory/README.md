# @season179/pi-memory

Give Pi persistent, agent-managed memory through two LLM tools.

The extension stores durable memories as readable Markdown under Pi's agent directory. Memories are never injected automatically; the agent explicitly uses `recall` when prior context may help and `remember` when something should persist.

## What It Does

- Adds `remember` actions for creating, updating, and deleting memories.
- Adds `recall` search over titles, tags, and retrieval cues.
- Keeps authoritative full details in `pi-memory/details.md`.
- Fully regenerates the derived `pi-memory/index.md` cache after every mutation.
- Caps each rendered file at an estimated 4,000 tokens.

This is a lean first version. It intentionally has no locking, duplicate detection, hashes, slash commands, or automatic context injection.

## Installation

```bash
pi install npm:@season179/pi-memory
```

## Usage

Ask Pi to remember durable information naturally, for example:

```txt
Remember that I prefer concise commit messages without attribution trailers.
```

Later, ask Pi to recall it. The agent can call:

- `remember` with `create`, `update`, or `delete`.
- `recall` with a query, optional result limit, and optional body inclusion.

Memory IDs use the immutable form `m_aaaaaaaaaa`. Updates and deletes require an existing ID, so the agent should recall the memory first.

Recall ranks an exact ID or title first, then case-insensitive word overlap, then recency. An empty query returns the most recently updated memories.

## Storage

Files live at:

```txt
<pi-agent-dir>/pi-memory/details.md
<pi-agent-dir>/pi-memory/index.md
```

`details.md` is authoritative. If `index.md` is missing, malformed, or inconsistent, the extension rebuilds it from `details.md`. Writes use a temporary file and rename, with details written before the index.

If a mutation would push either rendered file above 4,000 estimated tokens (`ceil(characters / 4)`), nothing is written. The error reports current and projected usage plus old and large memories to consider consolidating.

## Included Resources

- Pi extension: `dist/extensions/memory.js`

## Local Development

```bash
npm install
npm run build --workspace @season179/pi-memory
npm test --workspace @season179/pi-memory
```

Test without publishing:

```bash
pi -e ./packages/pi-memory
```

Smoke-test package loading without your global extensions:

```bash
pi --no-extensions -e ./packages/pi-memory --help
```

Because this package publishes compiled JavaScript, build before using `pi -e` from the package directory.

## Tarball Validation

```bash
npm pack --workspace @season179/pi-memory
npm pack --workspace @season179/pi-memory --dry-run
```

The tarball should include:

```txt
package/package.json
package/README.md
package/LICENSE
package/dist/extensions/memory.js
package/dist/store.js
```

## Publishing

```bash
npm login
npm publish --access public
```

Scoped public packages require `--access public`.

## Compatibility

- Pi: 0.80.10 or newer
- Node.js: >=22

## Security

Pi extensions execute with your user permissions. This extension reads and writes Markdown only inside the `pi-memory` directory under Pi's agent directory. Review the source before installing.

## Troubleshooting

- If the tools are unavailable, make sure the package is installed and enabled.
- If package resources are not found during local testing, build the package first.
- If `details.md` cannot be parsed, repair its section metadata before trying another mutation.
