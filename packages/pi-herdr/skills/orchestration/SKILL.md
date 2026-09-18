---
name: herdr-orchestration
description: Coordinate visible Herdr workers with editable routing, nonblocking watches, temporary reports, and verified delivery. Use only after the user explicitly assigns the orchestrator role; never self-promote from a worker brief.
compatibility: Pi with pi-herdr inside Herdr; herdr CLI on PATH.
disable-model-invocation: true
---

# Herdr orchestration

Active only through `/orchestrate`, an explicit user orchestration request, or an intentionally configured orchestrator launch. For a natural-language request, call `herdr_orchestrate`. Installation or reading this file grants no role or operational authority. Workers must not recursively orchestrate unless separately authorized.

## Own the outcome, not every pane

Stay available to the user. Delegate substantive work; handle only tiny tasks and brief coordination checks yourself. Hand off work that grows. Workers own implementation, testing, and fixes; review evidence rather than repeat their work. Parallelize useful work, not process. Follow through within granted authority.

1. **Find a shell.** Before controlling panes, run `herdr --skill` and verify `HERDR_ENV=1`. Reuse available shell panes in the current Herdr workspace, including panes not created by this session. Inspect candidates: the shell must be at its prompt with no foreground command, editor, or agent. Create a pane only if none is suitable or the user explicitly requests one. Preserve focus and requested cwd; never take over unrelated running work.
2. **Route and brief.** Read policy and verify eligible external harnesses before first dispatch. With quota monitoring configured, call `herdr_route` action `inspect` for the task, then `select` with `budgetChoice` (profile ID, snapshot ID, and task/budget reason) when adjusting delegation. Weigh remaining allowances, reset times, observed burn, upcoming work and orchestration reserve across all subscriptions. Favor expiring surplus for useful work; conserve scarce groups; warn when capable or economical alternatives are low. Otherwise use baseline automatic selection. Reserve `profileId`/`override` for explicit user choices. Never invent defaults or bypass protections. Brief the worker with outcome, scope/edit ownership, checkout, constraints, selected profile/fallback, temporary report path, proportional checks, and stopping point. Ask it to write the report and reply with its path. Ensure its environment does not enable `PI_HERDR_ORCHESTRATOR=1`.
3. **Dispatch and watch.** Submit `herdr agent prompt` **without `--wait`**, record the successful assignment with `herdr_route`, then arm `herdr_watch`. End your turn unless coordination needs attention. Never block in bash on agent waits or poll transcripts; use bounded command watches for long checks.
4. **Verify and deliver.** Read the report, spot-check evidence of the requested behavior, and drive the next authorized action to a usable result. A report file alone is not delivery. Serialize shared-checkout integration; preserve unexpected changes. Distinguish implemented, checked, applied, blocked, and awaiting a real decision. Do not expand into unsolicited audits or releases.
5. **Quit, retain.** Gracefully quit owned workers once no longer needed, preserving reports and unfinished changes. Verify they exited and their shells are available; retain the panes. Pane closure is not agent exit.

## Gotchas that apply immediately

- Idle/done is a signal to inspect, not proof of delivery. Immediate idle can precede work: check evidence and rearm, without blindly resubmitting.
- Restored role is **not restored watches or worker ownership**. Reconcile before rearming; never claim unwatched work is supervised.
- `/orchestrate off` stops watches, including command-watch children, **not workers**; it does not erase history. Honor pause/stop and leave time for deadline handoffs; never restart paused work automatically.

## Load detail only when needed

Do not load all references by default. Resolve these paths relative to this skill's directory, not the project cwd.

- **Quota-aware delegation, missing/invalid policy, eligible external harness, image/risky task, fallback, explicit override, or policy edits:** read [Routing decisions](references/routing.md) before selecting or launching that route.
- **Pause/deadline handoff, reload/resume/fork, missing evidence, or switching off with outstanding work:** read [Recovery and handoff](references/recovery.md) before reconciling or changing supervision.
