# pi-delegate: Orchestrator → Cheap-Worker Delegation for Pi

Date: 2026-07-03 (retired 2026-07-28)
Status: **FAILED EXPERIMENT — RETIRED** (Season's verdict, 2026-07-28).
Reference-only, same standing as TROIKA.md.

> **Note to agents:** do not build on this design, load this package,
> refer to or copy its code, or propose orchestrator→cheap-worker
> delegation revivals (Season, 2026-07-28). It was built (M1–M3),
> dogfooded, and judged a failure. The package was never published to npm
> and is not installed in `~/.pi`; it remains in-tree only as a historical
> record and can be deleted at any time (git history keeps everything).
>
> **Why it failed** (Season, 2026-07-28): superseded by better tooling.
> Agent-multiplexer/ADE environments — herdr, Orca ADE — let pi delegate to
> *visible, managed* agents (real panes, lifecycle detection, human can
> watch and intervene) better than this extension's invisible headless
> worker subprocesses ever could. The goal lives on; this mechanism lost.
> Successor direction: HERDR.md.

Working name: `pi-delegate` (placeholder).

## 1. The Idea

The main interactive Pi agent runs an expensive, strong model. This extension
gives it a `delegate` tool: hand a well-scoped coding task to a cheap worker
model (GLM by default), which does the read-edit-test churn in a headless
subprocess and returns a compact result. The expensive model stays on
planning, conversation, and judgment.

**The bet (cost play, not quality play):** most tokens in agentic coding are
input tokens from the tool loop — file reads, grep results, test output —
re-sent to the model every turn as context grows. Delegation moves that churn
onto a flat-rate cheap model, so the orchestrator's context stays small:
conversation + plan + brief + compact result summaries. Target ≈ 0.3–0.5×
cost per task at roughly equal quality on well-scoped work.

The economics are decided by **what flows back to the orchestrator**. If the
orchestrator re-reads the full diff plus surrounding files to trust the work,
the savings evaporate. Therefore: mechanical verification (harness-run
command), compact result contract, spot-checks not re-reads.

Relationship to shelved pi-troika (see `TROIKA.md`, reference only): troika
was the quality play (~5× cost, ensemble + synthesis, never built). This is
the opposite corner — one worker, supervised live, cheaper than solo. The
worker roles differ, but troika's §5 upstream inventory and its verification
lesson (acceptance checks must be mechanical) carry over directly.

## 2. Decisions (locked 2026-07-03)

1. **Default worker: `zai/glm-5.2`** (Season's call). Coding-plan endpoint
   (`api.z.ai/api/coding/paas/v4`), cost table is all zeros = flat
   subscription quota, so worker marginal cost ≈ 0. The scarce resource is
   orchestrator tokens; telemetry measures those, not worker spend.
2. **Agent-invoked only for v1** (Season's call). No `/delegate` command. The
   orchestrator decides when to delegate, steered by the tool description +
   `promptGuidelines`.
3. **In-place edits, no worktrees.** One worker doesn't collide with
   anything; the orchestrator inspects results directly with its own tools.
   Safety rail: harness makes a git checkpoint before each delegation
   (auto-commit dirty state or record clean HEAD), so recovery is one
   `git reset --hard <checkpoint>` away. Worktree isolation was a troika need
   (2 concurrent workers), not a need here.
4. **Sync tool call.** The orchestrator blocks on `delegate` like any tool.
   It usually can't proceed without the result anyway; async queueing
   (pi-buddy-style) is complexity v1 doesn't need.
5. **One worker attempt per tool call; orchestrator-mediated retries.** The
   harness has NO retry loop. On failure the tool returns a structured
   failure report and the orchestrator decides: re-delegate with a sharper
   brief, or take over. Hard guideline in `promptGuidelines`: **max 2
   delegations per task, then do it yourself.** This is the anti-retry-spiral
   rail — without it, bad days cost more than no delegation.
6. **Harness-run verification.** The brief includes a `verify` command
   (tests/typecheck/build). The harness runs it via `pi.exec` after the
   worker exits — the verdict is mechanical, never the worker's claim.
7. **No synthesis, no critics, no DECIDE checkpoint.** The orchestrator IS
   the live supervisor; a supervised single worker doesn't need the ceremony
   that troika's unsupervised pipeline did.

## 3. Terminology (same vocabulary as troika — it was good)

- **Harness**: deterministic extension code in `packages/pi-delegate`. Spawns
  the worker, runs git/verify commands, writes telemetry. Makes no LLM calls.
- **Orchestrator**: the main interactive Pi agent (the expensive model). The
  intelligence deciding when/what to delegate and judging results.
- **Worker**: headless `pi` subprocess on the cheap model. Implements the
  brief end-to-end in the main working tree.

## 4. Tool Contract

`pi.registerTool` (types.ts ~line 1198), name `delegate`, sequential
execution mode.

Parameters (the **brief** — the orchestrator writes this):

- `task` (string, required): what to build/change and why. Written for an
  implementer with zero conversation context.
- `context` (string, required): conversation-derived constraints the worker
  cannot discover from the repo ("we decided X", "don't touch Y", naming
  conventions agreed earlier). The worker sees none of the session history —
  forgetting this field is the classic delegation failure.
- `files` (string[], optional): files/dirs in scope. Advisory focus hint,
  not a sandbox.
- `verify` (string, required): shell command that must exit 0 for the work
  to count (e.g. `npm test -w @season179/pi-moa`). Harness-run.

Tool description + `promptSnippet` + `promptGuidelines` carry the
when-to-delegate steering (§6). This prompt text is the most important
artifact in the extension.

Result (compact by design):

```
status: success | verify_failed | worker_error | timeout
summary: <worker's final message, capped ~2000 chars>
diffstat: <git diff --stat checkpoint..HEAD, plus untracked files list>
verify: <exit code + last ~50 lines of output>
checkpoint: <sha to reset to if rejecting>
cost: <worker tokens/time, from JSON event stream>
```

No full diff in the result. The orchestrator spot-checks with its own read
tool where it has doubts.

## 5. Execution Flow (one `delegate` call)

1. **Checkpoint**: `git add -A && git commit` (message
   `pi-delegate checkpoint`) if tree dirty; record HEAD sha either way.
2. **Spawn worker**: copy the spawn/stream/usage-parsing pattern from the
   upstream subagent example
   (`packages/coding-agent/examples/extensions/subagent/index.ts` ~294–335):
   `pi --mode json -p --no-session --model zai/glm-5.2
   --append-system-prompt <tmpfile> "<brief>"`, cwd = project root, default
   coding toolset. Stream `message_end`/`tool_result_end` events; surface
   progress via `onUpdate`.
   Worker system prompt additions: implement the brief fully; run the verify
   command yourself before finishing; never commit, never push; final message
   = summary of what changed and any deviations from the brief.
3. **Verify**: harness runs the brief's `verify` command via `pi.exec`,
   bounded timeout.
4. **Report**: build the result contract; on `worker_error`/`timeout`,
   include stderr tail and whether the tree changed.
5. **Telemetry**: append one JSONL record (same pattern as pi-moa's
   `telemetryPath`): timestamp, brief size, worker model, worker
   tokens/cost/duration, verify exit, status, diffstat summary, attempt
   number (orchestrator passes none — harness counts calls per session).

Timeouts: worker wall-clock cap (default ~10 min) and verify cap (default
~5 min), both config-overridable. On timeout: kill subprocess, report; the
tree stays as the worker left it (checkpoint makes that safe).

## 6. When-to-Delegate Steering (promptGuidelines)

Delegate: implement-from-spec, boilerplate, applying a known pattern across
files, writing tests for defined behavior, mechanical refactors — anything
where the brief can state acceptance criteria without knowing the solution.

Don't delegate: debugging with unknown cause, subtle cross-cutting changes,
anything where writing the brief requires already having the answer, tasks
touching code the orchestrator hasn't understood yet.

Rules: always fill `context` with conversation-derived constraints; max 2
delegations per task then take over; on `verify_failed`, prefer sharpening
the brief over blind retry; spot-check the diff where you have doubts instead
of re-reading everything.

## 7. Config

Optional `~/.pi/agent/delegate.json` (defaults in code — unlike moa.json,
which is compulsory by its own history; revisit if drift bites):

```json
{
  "workerModel": "zai/glm-5.2",
  "workerTimeoutMs": 600000,
  "verifyTimeoutMs": 300000,
  "telemetryPath": "~/.pi/agent/delegate-telemetry.jsonl"
}
```

`workerModel` is any pi model string — the composition seam. No multi-tier
escalation ladder in v1; the orchestrator taking over IS the escalation.

## 8. Milestones

1. **Spawn layer**: package scaffold; port the subagent example's
   spawn/stream/usage parsing; hardcoded brief smoke test against glm-5.2.
   ✅ Done 2026-07-03: `packages/pi-delegate` (`src/worker.ts`, no-op
   extension entry, 11 unit tests, `npm run smoke`). Smoke verified
   end-to-end: glm-5.2, 2 turns, 12.3s, cost $0.0000 (flat quota confirmed).
   Finding for M2: normal completion reports `stopReason: "stop"`, not
   `"end"` — failure detection must treat `"stop"` as success and key on
   exit code / `"error"` / `"aborted"`.
2. **Tool + safety rails**: `registerTool` with brief schema, checkpoint,
   harness verify, result contract, timeouts.
   ✅ Done 2026-07-03: `delegate` tool wired (src/git.ts checkpoint/changes,
   src/brief.ts, src/result.ts, extension entry). End-to-end smoke
   (`scripts/smoke-tool.mjs`) passed: dirty-tree auto-commit checkpoint →
   glm-5.2 worker → harness verify → compact report. Two rails added beyond
   the spec: (a) workers are spawned with `PI_DELEGATE_WORKER=1` and the tool
   refuses to run when that marker is set — no recursive delegation (a smoke
   harness bug fork-bombed ~1300 processes before this guard existed);
   (b) `PI_DELEGATE_PI_COMMAND` env seam for driving the tool outside a real
   pi process, where `getPiInvocation`'s argv[1] heuristic is invalid.
3. **Steering + telemetry**: promptSnippet/promptGuidelines, JSONL
   telemetry, config loading.
   ✅ Done 2026-07-03: src/config.ts (optional `<agentDir>/delegate.json`,
   loud ConfigError on invalid/unknown/bad-typed fields, tilde expansion) +
   src/telemetry.ts (one JSONL record per call incl. aborted runs; append
   never throws) + steering completed with the "code you have not understood
   yet" clause and a §6 regression test. Smoke asserts the telemetry record
   end-to-end. 40 tests green.
4. **Dogfood**: use it for a week on real tasks; judge with telemetry
   (delegation success rate, orchestrator takeover rate, verify-failure
   rate). Decide then: keep, tune steering, or add a second worker tier.

## 9. Non-Goals (v1)

- `/delegate` user command (v2 candidate)
- Parallel/multiple workers, synthesis, critics (that was troika; shelved)
- Worktree isolation, async delegation, in-harness retry loops
- Worker web access or MCP tools

## 10. Addendum: 2026-07-11 hardening (delivered behavior)

Motivated by the first real dogfood incident: a delegation ran the full
10-minute cap with a frozen progress display, and the SIGKILL escalation
turned out to be dead code (`proc.killed` records that a signal was *sent*,
so it was already true after SIGTERM). Changes, agreed in a Claude↔Codex
design debate:

- **Kill path** (src/worker.ts): escalation keys on actual process close;
  workers spawn `detached` and kills go to the process group so tool
  children (builds, tests) die too; timers and the abort listener are
  cleaned up on every completion path; signal-killed workers report a
  nonzero exit instead of masquerading as exit 0.
- **Worker isolation**: workers run with `--no-extensions` (no MoA/buddy/MCP
  inside workers). Skills and context files stay enabled — domain-knowledge
  skills are deliberately available to the worker.
- **Progress** (src/progress.ts): state-shaped running view re-emitted on a
  10s heartbeat — turn count, elapsed vs budget, current activity with
  sanitized args (one line, 80 chars, secrets redacted), last 3 completed
  activities with durations, and the interrupt hint
  `esc stops worker · partial work preserved · reset point <sha>`.
  Tool-less assistant messages surface as one-line narration.
- **Timeout/abort reporting** (src/result.ts, extension): no automatic
  post-timeout verify (it could silently add the full verify budget to the
  wait); instead the report distinguishes "partial work exists — run the
  verify command yourself to assess salvage" from "no changes were made",
  and promptGuidelines steer the orchestrator accordingly. User aborts now
  collect and report the diffstat instead of returning blind.
