---
name: herdr-orchestration
description: Conversational orchestration in Herdr, only after the user explicitly assigns the orchestrator role. Installation, a worker brief, or HERDR_ENV alone never activates this role.
disable-model-invocation: true
---

# Herdr orchestration

This workflow applies only while explicitly activated by the user through `/orchestrate`, an explicit orchestration request, or an intentionally configured orchestrator launch. Loading this file alone does not activate the extension. For an explicit natural-language request, call `herdr_orchestrate`. Never self-promote from a worker assignment or recursively delegate unless separately authorized.

## Own the outcome, not every pane

Remain the user's conversational partner. Decide what to do directly and what to delegate by likely completion time. Parallelize independent useful work; do not manufacture tasks or mandatory planner/tester/reviewer chains. Activation grants no authority to edit, launch workers, integrate, push, deploy, or spend beyond the user's task.

Before controlling panes, run `herdr --skill`, verify `HERDR_ENV=1`, and inspect the current workspace and available agents. Use current CLI help, explicit pane IDs or unique agent names, and no-focus creation. Do not seize unrelated sessions, answer their approval dialogs, or use their work as test fixtures. Reuse available shell panes in the current Herdr workspace, including panes not created by this session. Before creating a pane, inspect existing candidates and verify that the shell is at its prompt with no foreground command, editor, or agent running. Create a new pane only when no suitable shell pane is available or the user explicitly requests one. Preserve the user's focus and requested working directory.

## Route each new assignment

Use `herdr_route` immediately before each dispatch. It rereads the external `herdr-routing.json` in Pi's agent directory (normally `~/.pi/agent`); edits affect the next assignment, not running workers. Models and allocation policy belong there, never in this skill. Missing/invalid policy needs an actionable setup message, not invented defaults. An explicit one-off user route remains possible after checking its actual model, auth, capabilities, and protection settings; report the override without rewriting defaults.

Selection order: explicit user choices and authorization; required capabilities and enabled/authenticated availability; task difficulty, likely completion time, cost and genuinely known quota; then soft family shares among suitable options. Static quota notes are not live balances. Never delay urgent work, use an unsuitable model, or create work just to meet a percentage. A fallback must meet the same requirements and permission protections; report material substitutions. A refusal is not permission to bypass controls.

Verify the installed harness's model identifiers and launch options, including any required permission-review mode. Pi profiles use Pi's model/auth registry; verify actual image support when needed. Use argument boundaries and shell quoting rather than executable templates from configuration. Ensure worker launches do not inherit `PI_HERDR_ORCHESTRATOR=1`; verify the target shell environment before starting. A worker must start with orchestration inactive.

After successful submission, record the assignment with `herdr_route` so its rolling history counts actual dispatches, not previews or failed starts. Include the selected profile and any fallback in the worker brief/report. Unrecorded selection IDs expire on reload: reconcile an already-started worker before selecting again, and never repeat a dispatch just to repair history. Selection is advisory, not a process launcher or authorization gate.

## Brief, watch, deliver

Give each worker a compact contract:
- Outcome, edit ownership/scope, active checkout, and constraints.
- Temporary report path; ask for findings and artifact paths there, then a reply with the path.
- Proportional observable checks and stopping point; no recursive orchestration.
- Selected profile/fallback and any deadline or genuine decision requiring escalation.

Use `herdr agent prompt` **without `--wait`**, then `herdr_watch`. Continue useful work or end the turn; never block in bash on agent waits or repeatedly poll transcripts. Prefer bounded command watches for long-running checks. A watch firing or an idle/done badge is a signal to inspect, not proof of delivery. An immediate idle can precede work: check evidence and rearm without blindly resubmitting the prompt.

Read the bounded report, verify artifacts and relevant check evidence, then carry out the next authorized action promptly. A report file alone is not a delivered research answer; synthesize it for the user. Distinguish implemented, checked, applied locally, blocked, and awaiting a real decision. Do not repeatedly seek approvals already granted.

Establish integration authority from this conversation and project, never historical sessions. Serialize updates to a shared target, preserve unexpected changes, and use worktrees only where useful. Test the requested visible behavior, not just test counts; use the real interface when practical. Do not expand a focused request into audits, releases, or compatibility matrices.

## Recovery and shutdown

Reload/resume may restore the role, **not watches or worker ownership**. New sessions and forks do not inherit owned work. Inspect available session/report evidence and the actual worker identity before reconciling or rearming supervision. Never claim unwatched work is supervised. Missing reports are missing evidence; preserve unfinished changes and surface recovery limits rather than inventing results.

For work that spans a pause/reload, write a concise private handoff with task, authorization/scope, owned pane + worker session identity, report/artifact pointers, current state, unresolved decision and next action. Keep reports temporary; keep the handoff somewhere stable when recovery is required. Do not adopt unrelated panes merely because they are visible.

Quit owned workers once no longer needed, using verified harness-specific graceful exit behavior. Confirm the agent exited and the pane returned to its shell; retain the pane for reuse. Preserve reports and unfinished changes. Closing a pane is not quitting an agent.

`/orchestrate off` removes active workflow guidance and stops armed watches (including command-watch children); it does **not** stop workers or erase conversation history. Deliberately resolve outstanding supervision before switching off. Never launch a cleanup agent automatically. Honor user pause/stop and deadlines: leave time to check, preserve, and hand off; never restart paused work on your own.
