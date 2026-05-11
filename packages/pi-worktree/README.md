# @season179/pi-worktree

A Pi extension that adds a `--worktree` flag. When enabled, Pi creates an isolated git worktree for the session, redirects path-aware tool calls into that worktree, and prompts on quit before deleting or keeping the worktree.

## Installation

```bash
pi install npm:@season179/pi-worktree
```

## Usage

```bash
pi --worktree
```

The extension creates a branch named `pi-wt/<timestamp>-<pid>` from `main` or `master` and places the worktree under:

```txt
<repo>/.pi/worktrees/
```

## Included Resources

- Pi extension: `dist/extensions/worktree.js`

## Local Development

```bash
npm install
npm run build --workspace @season179/pi-worktree
```

Test without publishing:

```bash
pi -e ./packages/pi-worktree --worktree
```

Because this package publishes compiled JavaScript, build before using `pi -e` from the package directory.

## Tarball Validation

```bash
npm pack --workspace @season179/pi-worktree
tar -tf season179-pi-worktree-26.5.0.tgz
pi install ./season179-pi-worktree-26.5.0.tgz
```

The tarball should include:

```txt
package/package.json
package/README.md
package/LICENSE
package/dist/extensions/worktree.js
```

## Publishing

```bash
npm login
npm publish --workspace @season179/pi-worktree --access public
```

Scoped public packages require `--access public`.

## Compatibility

Tested with:

- Pi: 0.74.0
- Node.js: >=22

## Security

Pi extensions execute with your user permissions. This extension runs git commands, redirects tool paths, and can remove the temporary worktree on quit. Review the source before installing.

## Troubleshooting

- If `pi --worktree` reports no base branch, make sure the repository has `main` or `master`.
- If a worktree is kept, inspect it under `.pi/worktrees/`.
- If package resources are not found during local testing, run `npm run build --workspace @season179/pi-worktree` first.

