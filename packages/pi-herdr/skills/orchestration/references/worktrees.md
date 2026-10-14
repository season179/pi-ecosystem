# Worker worktree lifecycle

Read before creating, merging, or removing a worker worktree, and before the end-of-task report when any worktree record exists.

## Lifecycle

`herdr_worktrees` `create` (task; target defaults to the current branch) → `herdr agent start --pane <root pane>` → `herdr_workers` `claim` → watch. The worker commits on its branch and reports hashes. Quit it and verify. Then merge serially into the target in the **source** checkout with an ordinary `git merge <branch>`, only when that checkout is on the target and clean; otherwise postpone and report. Run the checks, then `herdr_worktrees` `remove` with the record number.

## Gotchas

- **Keep reports and artifacts outside the checkout.** Brief workers in a worktree to write their report and any artifact worth keeping to a path outside it. `remove` destroys everything in the checkout that is not committed, including ignored files (`node_modules`, `dist`, logs, reports).
- **Base is the last commit.** Uncommitted source edits are not in the worktree; work that depends on them waits until they are committed. Never stash or commit the user's edits.
- On doubt, preserve, record, and report at the end.

## End-of-task report

List leftovers from `herdr_workers list` and `herdr_worktrees list`: unknown, dirty, unmerged, kept branches, and branch outcome unresolved.
