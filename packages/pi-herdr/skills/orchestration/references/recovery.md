# Recovery and handoff

Read before reconciling after reload/resume/fork, handling missing evidence, pausing for a deadline, or switching off with outstanding work.

## Reconcile before acting

1. Read the current conversation and any saved handoff for scope and authorization. Historical work is not fresh authority. Reload/resume may restore the role, but never assume watches or worker ownership were restored. New sessions and forks do not inherit owned work.
2. Match each previously owned worker's recorded pane **and session identity** against live Herdr state. Pane visibility, labels and idle badges alone do not establish identity or delivery. Reusing an available shell is distinct from adopting a running worker.
3. Read bounded report/artifact evidence. If a report has expired or disappeared, state that evidence is missing; preserve unfinished changes and recover from actual artifacts where possible. Do not invent completion or silently repeat the task.
4. For confirmed owned work that is still authorized to continue, deliberately rearm the appropriate watch. Otherwise preserve and hand off, or gracefully quit only when authorized. Never claim supervision until the watch is armed, and never restart work after a user pause/stop.
5. Resume the authorized delivery step: verify artifacts, integrate serially where permitted, and communicate the usable result. Do not stop merely because a worker report exists.

## Leave a small recoverable handoff

Before a pause/reload or deadline, stop starting work early enough to verify and preserve it. Keep worker reports temporary; save the handoff in a private stable location and surface its path. A handoff is evidence, not a new task database or automatic restart instruction.

```text
Task and current authorization:
Checkout/branch and edit ownership:
Owned workers: pane ID + harness/session identity
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
