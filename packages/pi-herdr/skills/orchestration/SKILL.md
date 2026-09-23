---
name: herdr-orchestration
description: Coordinate visible Herdr workers with nonblocking watches, temporary reports, and verified delivery. Use only after the user explicitly assigns the orchestrator role; never self-promote from a worker brief.
compatibility: Pi with pi-herdr inside Herdr; herdr CLI on PATH.
disable-model-invocation: true
---

# Herdr orchestration

Active only through `/orchestrate`, an explicit user orchestration request, or an intentionally configured orchestrator launch. For a natural-language request, call `herdr_orchestrate`. Installation or reading this file grants no role or operational authority. Workers must not recursively orchestrate unless separately authorized.

## Own the outcome, not every pane

Stay available to the user. `herdr_select` decides whether each task is done inline or delegated; brief coordination checks (reading reports, spot-checking evidence) are not tasks. If inline work grows, select again before handing it off. Workers own implementation, testing, and fixes; review evidence rather than repeat their work. Parallelize useful work, not process. Follow through within granted authority.

1. **Select first.** Before deciding to do a task inline or delegate it, and before every new worker launch, call `herdr_select` with a factual brief, relevant context and purpose. For review, discussion or debate, pass the models that authored the work or position as `provenance` (or `provenanceUnknown: true`); never guess. Pass explicit user restrictions as `allowedOptions` and preferences as `userPreferences`. Follow the result: `inline` means do it yourself; a worker result names the harness and exact model. `cannot_select` and `needs_context` are answers: report or clarify, then select again; do not override them. Only a `failed` outcome (Jev unavailable, tool error or bug) permits a manual choice, and you must tell the user. The tool launches and polls nothing.
2. **Find a shell.** Before controlling panes, run `herdr --skill` and verify `HERDR_ENV=1`. Reuse available shell panes in the current Herdr workspace, including panes not created by this session. Inspect candidates: the shell must be at its prompt with no foreground command, editor, or agent. Create a pane only if none is suitable or the user explicitly requests one. Preserve focus and requested cwd; never take over unrelated running work.
3. **Brief the worker.** Launch the selected harness and model with the user's permission requirements. Verify the worker's effective permissions before substantive work; never bypass protections. Brief it with outcome, scope/edit ownership, checkout, constraints, temporary report path, proportional checks, and stopping point. Ask it to write the report and reply with its path. Ensure its environment does not enable `PI_HERDR_ORCHESTRATOR=1`.
4. **Dispatch and watch.** Submit `herdr agent prompt` **without `--wait`**, then arm `herdr_watch`. End your turn unless coordination needs attention. Never block in bash on agent waits or poll transcripts; use bounded command watches for long checks.
5. **Verify and deliver.** Read the report, spot-check evidence of the requested behavior, and drive the next authorized action to a usable result. A report file alone is not delivery. Serialize shared-checkout integration; preserve unexpected changes. Distinguish implemented, checked, applied, blocked, and awaiting a real decision. Do not expand into unsolicited audits or releases.
6. **Quit, retain.** Gracefully quit owned workers once no longer needed, preserving reports and unfinished changes. Verify they exited and their shells are available; retain the panes. Pane closure is not agent exit.

## Gotchas that apply immediately

- Idle/done is a signal to inspect, not proof of delivery. Immediate idle can precede work: check evidence and rearm, without blindly resubmitting.
- Restored role is **not restored watches or worker ownership**. Reconcile before rearming; never claim unwatched work is supervised.
- `/orchestrate off` stops watches, including command-watch children, **not workers**; it does not erase history. Honor pause/stop and leave time for deadline handoffs; never restart paused work automatically.

## Load detail only when needed

Do not load all references by default. Resolve these paths relative to this skill's directory, not the project cwd.

- **Pause/deadline handoff, reload/resume/fork, missing evidence, or switching off with outstanding work:** read [Recovery and handoff](references/recovery.md) before reconciling or changing supervision.
