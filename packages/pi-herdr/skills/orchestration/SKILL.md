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
3. **Brief the worker.** Launch the selected harness and model with the user's permission requirements. **Default Claude Code workers to `--permission-mode auto`**, unless the user explicitly requests another mode or environment policy prohibits it; replace the suggested permission flag rather than adding a conflicting one. Right after a successful `herdr agent start`, before the substantive prompt, record ownership with `herdr_workers` `claim` (task, report path, launch model); adopting an existing worker you are authorized to control is also an explicit claim. Verify the worker's effective permissions before substantive work: requesting auto does not guarantee it is available. Auto retains permission checks; never use `bypassPermissions` or `--dangerously-skip-permissions`. Brief it with outcome, agreed approach (if any), acceptance criteria, scope/edit ownership, checkout, constraints, the engineering standard below, temporary report path, proportional checks, and stopping point. Workers may improve the approach when evidence warrants it; explain material deviations and surface any needed scope expansion rather than silently taking it on. Ask it to write the report and reply with its path. Ensure its environment does not enable `PI_HERDR_ORCHESTRATOR=1`.
4. **Dispatch and watch.** Submit `herdr agent prompt` **without `--wait`**, then arm `herdr_watch`. End your turn unless coordination needs attention. Never block in bash on agent waits or poll transcripts; use bounded command watches for long checks.
5. **Verify and deliver.** Read the report, spot-check evidence of the requested behavior, and drive the next authorized action to a usable result. A report file alone is not delivery. In review, distinguish defects and unmet requirements to fix, necessary design corrections justified by concrete evidence, and optional improvements that do not block delivery. Reviewer preference alone does not justify reopening the agreed approach. Keep meaningful tests and verification intact. Serialize shared-checkout integration; preserve unexpected changes. Distinguish implemented, checked, applied, blocked, and awaiting a real decision. Do not expand into unsolicited audits or releases.
6. **Quit, retain.** Gracefully quit owned workers once no longer needed, preserving reports and unfinished changes. Verify they exited and their shells are available; retain the panes. Pane closure is not agent exit. After a verified quit or handoff, `release` the worker; release does not quit it, and `herdr_unwatch` does not release it.

## Worktrees

The user's standing instruction authorizes you to create, integrate, and clean up worktrees without asking; this satisfies Herdr's explicit-topology rule. Never prompt about them. Give a worker its own worktree only when it writes concurrently with another writer, including alongside your own edits in the source checkout. Sequential writers share a checkout; read-only reviewers share. Builds and installs count as writes. **Never** push, `--force`, `git branch -D`, `herdr workspace close --group`, or remove a worktree by path.

## Engineering judgment

Apply this standard yourself and include it in worker briefs: prefer the simplest design that fully meets the requirements, including correctness, safety, and maintainability. Inspect existing patterns before introducing new ones. Justify added abstractions, configuration, dependencies, or compatibility layers with concrete needs, not hypothetical future flexibility. Simplicity means fewer concepts to understand, not merely fewer lines.

Tests: write only tests that protect critical behavior or a concrete regression. Prove every new or changed test: break the behavior it protects (revert the fix or stub the code under test), show the test fails, restore it, and show it passes. Put the command and both results in the report. A test that stays green when the code it covers returns nothing protects nothing; delete or rewrite it. Reviewers check this proof and repeat it when in doubt.

For brainstorming and planning, normally discuss and debate with another agent. Challenge both underengineering and overengineering: what requirements or important failure cases are missing, what can be removed without compromising the outcome, and is there a simpler alternative of equal or better quality? Resolve disagreements through evidence and reasoning toward a shared, justified approach—not by combining every suggestion into a larger design or forcing agreement despite unresolved evidence.

## Gotchas that apply immediately

- Idle/done is a signal to inspect, not proof of delivery. A default agent watch (`until` omitted or empty) armed on observed idle/done first waits up to five seconds for working or blocked: working proceeds to the settled wait; blocked reports immediately. No observed activity reports a distinct startup-window outcome, not idle completion; the prompt may not have started or may already have finished. Both phases share the overall timeout. This does not attribute activity to a particular prompt. For a deliberate level watch on an idle agent, use `until: ["idle"]`.
- Restored role restores recorded worker claims and worktree records, **not watches, supervision, or verified identity**. Reconcile from `herdr_workers list` and `herdr_worktrees list` before rearming; never claim unwatched work is supervised.
- Active orchestration with unreleased claims labels matched live worker panes as `<canonical agent> · #<n> <task>` (40 characters, task-only truncation). Refresh is about 30 seconds; release/off/session change/shutdown clear labels, crashes expire them after 90 seconds. Session/agent reports are required; no nonmatch labels. Claims are non-exclusive (two conversations: last writer wins); lookup→publish is not atomic, and TTL only bounds staleness.
- `/orchestrate off` clears sidebar labels and stops watches, including command-watch children, **not workers**; claims survive and it does not erase history. Honor pause/stop and leave time for deadline handoffs; never restart paused work automatically.

## Load detail only when needed

Do not load all references by default. Resolve these paths relative to this skill's directory, not the project cwd.

- **Pause/deadline handoff, reload/resume/fork, missing evidence, unknown or leftover worktrees, or switching off with outstanding work:** read [Recovery and handoff](references/recovery.md) before reconciling or changing supervision.
- **Creating, merging, or removing a worker worktree, or reporting worktree leftovers at the end of a task:** read [Worker worktree lifecycle](references/worktrees.md) first.
- **A Claude worker shows a permission prompt, or auto mode is unavailable, denied, or paused:** read [Claude permission prompts](references/claude-permissions.md) before answering it.
