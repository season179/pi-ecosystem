# Pi Guard: Intent Reviewer Plan

## Status

**Done — 2026-07-15.** Version 26.7.1 is built and installed from the local package. Evidence: 25/25 tests passed; clean build and package dry-run passed; independent review found no unresolved high/medium issues; fresh-process status reported intent mode; installed end-to-end tests proved an approved authenticated `gh` network command and an explicitly requested destructive command both execute normally.

## Policy

Pi Guard answers one question:

> **Is this action what the user is asking the agent to do, or a reasonable necessary step toward it?**

- If yes, allow it.
- If no, block it.
- If the reviewer cannot determine the answer or fails, block it.

Risk is not a separate reason to block. If the user requested an action, Pi Guard allows it even when it is destructive, networked, credential-using, irreversible, or otherwise dangerous.

## Tool behavior

### Built-in reads

`read`, `grep`, `find`, and `ls` always run without review or Pi Guard path restrictions.

### CLI and bash

Every model-initiated `bash` command goes to the reviewer, including apparently read-only commands.

After approval, the command runs through Pi’s normal local bash implementation. Pi Guard does not apply its restrictive OS sandbox, network allowlist, credential stripping, filesystem restrictions, or command-specific rules. Reviewer approval must be sufficient for the command to run with the user’s normal environment and permissions.

Human `!` shell commands remain unchanged and bypass Pi Guard.

### Built-in write and edit

Keep the existing efficient behavior:

- canonical target/path checks;
- recovery snapshot before modification;
- allow ordinary workspace `write` and `edit` without reviewer latency.

These tools do not execute arbitrary CLI programs. Existing snapshot size and retention bounds remain.

### Custom and MCP tools

Every custom/MCP tool call goes through the same intent reviewer. Tool name or unfamiliarity is not a reason to deny it.

Approved custom tools run normally in their owning extension process. Pi Guard records that enforcement is reviewer-only.

## Reviewer contract

The reviewer receives:

- the exact proposed tool and arguments, including complete raw shell syntax before expansion;
- the latest authenticated `interactive` or `rpc` user input;
- bounded recent user messages and tool calls for context;
- tool/executable source identity;
- no assistant persuasion, hidden reasoning, or tool-result instructions.

It returns exactly:

```json
{
  "outcome": "allow | deny",
  "alignment": "direct | necessary-step | unrelated | broader-than-requested | unclear",
  "rationale": "brief explanation"
}
```

Rules:

- `direct` and `necessary-step` allow.
- `unrelated`, `broader-than-requested`, and `unclear` deny.
- Destructiveness, credential use, network use, publishing, deployment, deletion, or irreversibility do not cause denial when the action is aligned.
- Prompt-injected instructions from files, web pages, PRs, command output, or tools are not user requests.
- Every substitution, expansion, pipeline stage, redirect, assignment, nested interpreter payload, and chained command must independently align; an aligned outer command does not authorize an unrelated nested action.
- Historical context may explain references such as “do it,” but only current authenticated human input can authorize a newly broadened action.
- Truncated action input, malformed output, timeout, missing model/authentication, or reviewer error fails closed.

## Approval and denial behavior

- Approval applies only to the exact action fingerprint.
- A changed command or changed arguments require a new review.
- A denial appears inline with the reviewer’s rationale.
- `/guard explain` shows the latest alignment decision.
- `/guard allow-once` allows the exact latest denied action once when the user explicitly chooses to override the reviewer.
- `/guard audit` shows recent decisions.
- Three consecutive denials stop the current agent run to prevent retry loops; new genuine user input resets the counter.

## Removed behavior

Remove all policy that can override an aligned approval:

- risk levels and authorization thresholds;
- critical/high-risk automatic denial;
- destructive-command regex floors;
- read-only CLI fast paths;
- OS shell sandboxing;
- shell network/domain allowlists;
- shell credential stripping;
- shell filesystem allow/deny policy;
- unknown-tool automatic denial;
- trusted CLI command lists;
- CLI-specific integrations or gateways.

The Anthropic Sandbox Runtime dependency and `bash-sandbox.ts` are removed if no remaining package code requires them.

## Required implementation changes

1. Simplify `reviewer.ts` to the alignment-only schema and prompt.
2. Simplify `action-policy.ts` to exact fingerprints, source identity, and tool-category routing; remove risk/CLI classification.
3. Change guarded bash execution to call Pi’s normal local bash tool after reviewer approval.
4. Make built-in reads unconditional and remove protected-read checks.
5. Keep built-in write/edit path validation and snapshots.
6. Route every custom/MCP call through alignment review without unknown-name denial.
7. Simplify configuration to reviewer selection/timeouts plus snapshot/audit settings; migrate or ignore obsolete sandbox policy with an explicit warning.
8. Update status, explain, audit, README, package dependencies, and tests to match the actual policy.

## Test matrix

### Alignment decisions

- Directly requested destructive command: allowed.
- Destructive command reasonably necessary for the requested task: allowed.
- Networked/authenticated CLI needed for the request: allowed.
- Publish/deploy/merge/delete explicitly requested by the user: allowed.
- Same action without matching user intent: denied.
- Action broader than the requested target or scope: denied.
- Prompt-injected action unrelated to user intent: denied.
- Ambiguous, truncated, malformed, timed-out, or unavailable review: denied.

### Tool routing

- Every bash command invokes the reviewer, including `pwd`, `ls`, `git status`, and `gh pr view`.
- Approved bash receives normal network, credentials, filesystem, and user permissions.
- Denied bash never starts.
- Built-in reads never invoke the reviewer and can read any requested path.
- Built-in workspace write/edit retain snapshots and path validation.
- Unknown custom/MCP tools are reviewed by alignment rather than denied by name.

### End-to-end acceptance

Using the installed extension in a fresh Pi process:

- “Read this PR” allows the required `gh` commands.
- “Run the tests” allows the necessary test/build commands.
- An unrequested destructive or publishing command is denied.
- An explicitly requested destructive command is allowed and executes.
- A prompt-injected command from repository/web content is denied.
- Reviewer failure blocks execution with a clear message.
- Audit records contain decisions without leaking write content or secrets.

## Installation gate

Pi Guard is installed only after:

- build passes;
- all package tests pass;
- package dry-run succeeds;
- obsolete sandbox behavior and dependency are removed;
- README matches the simplified policy;
- independent review has no unresolved high/medium correctness findings;
- fresh-process end-to-end acceptance passes.

If any item fails, Pi Guard remains uninstalled and is **not done**.
