# Recovery and handoff

Read before reconciling after reload/resume/fork, handling missing evidence or unknown/leftover worktrees, pausing for a deadline, or switching off with outstanding work.

## Reconcile before acting

1. Read the current conversation and any saved handoff for scope and authorization. Historical work is not fresh authority. Reload/resume restores the role and recorded worker claims, never watches, supervision, or verified identity. New sessions and forks do not inherit owned work.
2. Start from `herdr_workers list`: it matches each recorded worker's terminal **and session identity** against live Herdr state. Only `match` is verified; `session unverified`, `unknown`, `replaced` and `absent` need independent evidence or stay unresolved. The list cannot discover workers that were never claimed (for example, a crash between launch and claim), and it cannot grant a new conversation ownership; adopt only with authorization, by explicit claim. Pane visibility, labels and idle badges alone do not establish identity or delivery. Reusing an available shell is distinct from adopting a running worker.
3. Read bounded report/artifact evidence. If a report has expired or disappeared, state that evidence is missing; preserve unfinished changes and recover from actual artifacts where possible. Do not invent completion or silently repeat the task.
4. For confirmed owned work that is still authorized to continue, deliberately rearm the appropriate watch. Otherwise preserve and hand off, or gracefully quit only when authorized. Never claim supervision until the watch is armed, and never restart work after a user pause/stop.
5. Resume the authorized delivery step: verify artifacts, integrate serially where permitted, and communicate the usable result. Do not stop merely because a worker report exists.

## Reconcile worktrees

Start from `herdr_worktrees list`. Only `created` records with checkout `present`, workspace `mapped`, and changes `clean` are candidates for the normal merge-and-remove path.

- `pending` or `unknown`: creation may or may not have happened. Inspect by branch name with the commands the list prints (`git worktree list`, `git branch --list <branch>`, `herdr worktree list`). Never adopt, retry, or delete it automatically; report what you found.
- `failed`: nothing was created; nothing to clean up.
- Checkout `missing`, workspace `absent`/`mismatch`, or any `unknown` observation: `remove` will refuse. Preserve and report; do not remove by path, force, or close workspace groups.
- `dirty` or `unmerged`: the worker's work is not integrated. Get it committed and merged, or leave it and report the branch.
- Kept branches after removal hold their commits; report them. Delete only with `git branch -d` once merged.
- `removed` with **branch outcome unresolved**: the checkout is gone but the branch decision was never recorded (interrupted or session replaced). Deletion is never resumed automatically; inspect the branch and report it.

## Leave a small recoverable handoff

Before a pause/reload or deadline, stop starting work early enough to verify and preserve it. Keep worker reports temporary; save the handoff in a private stable location and surface its path. A handoff is evidence, not a new task database or automatic restart instruction.

```text
Task and current authorization:
Checkout/branch and edit ownership:
Owned workers: from herdr_workers list (number, pane/terminal/session, observation, task, report)
Worktrees: from herdr_worktrees list (number, state, branch, path, clean/merged, kept branches)
Reports and artifacts: paths; missing/unverified items
State: implemented / checked / applied / blocked / awaiting decision
Unresolved decision:
Next authorized action:
Supervision: actual armed watches, or explicitly not watched
```

Store no credentials. Keep ownership separate from workspace visibility. If report files are temporary, say so; a stale path is not recoverable evidence.

## Switching off and quitting

`/orchestrate off` removes active guidance/tools and stops armed watches, including their command children. It does **not** stop worker agents or erase prior conversation history. Before using it with outstanding work, resolve who will supervise, preserve a handoff, or gracefully stop the owned work within authorization. Do not automatically launch a cleanup agent or stop unrelated processes.

For worker cleanup, use the installed harness's verified graceful exit behavior. Confirm the worker is absent and its shell is again foreground; a successful key-send response is not proof it exited. Preserve its report and unfinished changes, retain the pane for reuse, and leave the user's focus alone.
