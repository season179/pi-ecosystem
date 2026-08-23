# pi-troika: Task-Level Multi-Agent Orchestration (SHELVED)

Date: 2026-07-02 (shelved; condensed to this tombstone 2026-07-28)
Status: **SHELVED — never built.** Season's verdict: too expensive (~5×
cost per task). Reference-only; do not treat as a plan or propose
reviving it without new user input.

## What it was

A quality play: a deterministic harness (extension code, no LLM calls of
its own) would run a whole task through a pipeline of headless `pi`
subprocesses — planner (strong model, acting in a worktree, committing
acceptance tests before fan-out), two plan critics (the cheap worker
models themselves), two workers each solving the full task independently
in isolated worktrees, then a synthesis agent forming one final solution
from both attempts and a read-only reviewer critiquing it before a DECIDE
checkpoint. Name from 三个臭皮匠，赛过诸葛亮.

Complementary to pi-moa (turn-level ensemble, advisory text, shared
context) — troika was the task-level ensemble (agents act, worktree per
agent, comparison on finished artifacts).

## Lessons that carried forward

These outlived the project (into pi-delegate — itself since retired — and
pi-herdr):

- **Acceptance checks must be mechanical**: exit codes, empty diffs, file
  existence, a mandatory VERDICT first line — never a model's self-report.
- **Keep the harness LLM-free**: every branch point should be mechanically
  checkable; judgment lives in the agent subprocesses. The historical design
  proposed a MoA preset for a stronger planner, but pi-moa is now retired and
  that option is no longer current guidance.
- **A plan that only *describes* tests in prose silently degrades the
  strongest quality lever** — planners must commit runnable acceptance
  tests before fan-out.
- **Vocabulary discipline**: "harness" = deterministic code,
  "orchestrator" = the intelligent role. Conflating them muddles designs.
- **Worktree-per-agent** is the isolation answer when multiple agents
  edit concurrently (and why single-worker pi-delegate skipped it).

The full 773-line executable spec (run pipeline, prompt contracts,
resolved decisions, milestones) is in git history — last full version at
commit `f5b0d80`.
