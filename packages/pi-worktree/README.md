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
# or
pi --wt
```

The extension creates a branch named `pi-wt/<timestamp>-<pid>` from `main` or `master`, places the worktree under:

```txt
<repo>/.pi/worktrees/
```

and shows the active worktree in Pi's status area.

By default, `--worktree` keeps the original safe base-ref behavior: use `main`, falling back to `master`. You can override that base with:

```bash
pi --worktree --worktree-base current
pi --worktree --worktree-base HEAD
pi --worktree --worktree-base main
pi --worktree --worktree-base origin/some-feature-branch
```

`--worktree-base default` and `--worktree-base main-master` are aliases for the default `main`/`master` lookup. `--worktree-base current` uses the checked-out branch, falling back to `HEAD` when detached. Any other value is validated as a commit-ish git ref before the worktree is created; the temporary branch starts from that commit and is created with `--no-track` so it does not track the source ref.

To also carry staged and unstaged tracked-file changes from your current checkout into the new worktree, use:

```bash
pi --worktree --worktree-base current --worktree-include-dirty
```

This applies staged changes as staged in the new worktree and unstaged changes as unstaged. It is safest with `--worktree-base current` or `--worktree-base HEAD`, because the patches are captured from your current checkout. If applying the patches fails against a different base, the worktree is kept and activated; Pi reports which dirty patch failed and keeps the patch files so you can inspect or port changes manually. Untracked files are not copied.

While `--worktree` or `--wt` is active:

- `bash` commands run from the created worktree.
- `read`, `write`, and `edit` calls are redirected into that worktree when they target the original repo.
- `grep`, `find`, and `ls` default to the worktree when no path is provided.
- attempts to write outside the active worktree are blocked.

On `quit`, the extension prompts before removing the worktree whenever there are uncommitted changes **or** commits on the worktree branch that have not been pushed/merged. A clean worktree at the base ref is removed without prompting. The prompt lists the dirty state and a preview of any unpushed commits so you can decide knowingly. Defaults are conservative: dirty-only defaults to delete (`[Y/n]`), but anything involving committed work defaults to keep (`[y/N]`). Confirming removal force-deletes the branch (`git branch -D`) when it has unpushed commits; otherwise it uses the safe `git branch -d`. Keeping the worktree leaves the branch and files in place so you can inspect, commit, diff, or merge manually.

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
tar -tf season179-pi-worktree-26.5.5.tgz
pi install ./season179-pi-worktree-26.5.5.tgz
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
- Git: >=2.24

## Security

Pi extensions execute with your user permissions. This extension runs git commands, redirects Pi tool paths, intercepts Pi/user shell execution, and can remove the temporary worktree on quit. It is a worktree guardrail, not an operating-system sandbox. Review the source before installing.

## Troubleshooting

- If `pi --worktree` reports no base branch, make sure the repository has `main` or `master`.
- If a worktree is kept, inspect it under `.pi/worktrees/`.
- If package resources are not found during local testing, build the package first.
