# @season179/pi-worktree

Add a `--worktree` flag to Pi.

If you like Claude Code's `--worktree` behavior, this brings the same idea to Pi: start a session in a fresh git worktree, keep the agent's edits away from your current checkout, then choose whether to keep or delete the worktree when you exit.

It is intentionally narrow. No task runner, no dashboard, no multi-agent framework. Just a safer place for Pi to work when you do not want it touching the branch or worktree you are using.

## What It Does

- Creates a temporary branch and git worktree for the Pi session.
- Runs shell commands from that worktree.
- Redirects Pi's path-aware file tools into the worktree when they target the original repo.
- Blocks common escapes, including parent-directory traversal and writes outside the active worktree.
- Prompts on exit before deleting the worktree, with a warning if it has uncommitted changes.

## Installation

```bash
pi install npm:@season179/pi-worktree
```

## Usage

```bash
pi --worktree
```

The extension creates a branch named `pi-wt/<timestamp>-<pid>` from `main` or `master`, places the worktree under:

```txt
<repo>/.pi/worktrees/
```

and shows the active worktree in Pi's status area.

While `--worktree` is active:

- `bash` commands run from the created worktree.
- `read`, `write`, and `edit` calls are redirected into that worktree when they target the original repo.
- `grep`, `find`, and `ls` default to the worktree when no path is provided.
- attempts to write outside the active worktree are blocked.

On `quit`, the extension checks whether the worktree is dirty and asks whether to remove it. Keeping it leaves the branch and files in place so you can inspect, commit, diff, or merge manually.

## When To Reach For It

Use this when you want Pi to:

- try a risky refactor without touching your current branch;
- fix tests while your main checkout stays clean;
- explore a change you may discard;
- work in the same repo while you keep another branch open elsewhere.

For multi-agent orchestration, task dashboards, or automated merge workflows, use a larger Pi workflow package. This is just the worktree safety layer.

## Included Resources

- Pi extension: `dist/extensions/worktree.js`

## Local Development

```bash
npm install
cd packages/pi-worktree
npm run build
```

Test without publishing:

```bash
pi -e ./packages/pi-worktree --worktree
```

Because this package publishes compiled JavaScript, build before using `pi -e` from the package directory.

## Tarball Validation

```bash
npm pack
tar -tf season179-pi-worktree-26.5.2.tgz
pi install ./season179-pi-worktree-26.5.2.tgz
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
npm publish --access public
```

Scoped public packages require `--access public`.

## Compatibility

Tested with:

- Pi: 0.74.0
- Node.js: >=22

## Security

Pi extensions execute with your user permissions. This extension runs git commands, redirects Pi tool paths, intercepts Pi/user shell execution, and can remove the temporary worktree on quit. It is a worktree guardrail, not an operating-system sandbox. Review the source before installing.

## Troubleshooting

- If `pi --worktree` reports no base branch, make sure the repository has `main` or `master`.
- If a worktree is kept, inspect it under `.pi/worktrees/`.
- If package resources are not found during local testing, build the package first.
