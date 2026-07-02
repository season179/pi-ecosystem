# pi-troika: Task-Level Multi-Agent Orchestration for Pi

Date: 2026-07-02 (revised same day after design review + flow-diagram review)
Status: **DESIGN LOCKED** (2026-07-02, user-approved after interactive review).
Not yet implemented — start at §15 milestone 1. Do not reopen the resolved
decisions in §13 or the rejected alternatives in §4.1 without new user input.
This document is the executable spec for implementation. It is written to be
followed mechanically: where it says MUST/NEVER, that is a hard requirement,
not a suggestion.
Working name: `pi-troika` (placeholder — three agents pulling one task, after
三个臭皮匠，赛过诸葛亮 "three cobblers beat one Zhuge Liang").

## 1. The Idea

A deterministic harness (extension code) receives a task, has a planner agent turn it into a
spec with acceptance tests (iterated against critic feedback), and delegates
the actual work to two worker agents running cheap open-source Chinese models
(GLM, DeepSeek, Qwen, Kimi — none of them state-of-the-art). Each worker
solves the full task independently in an isolated git worktree. When both
finish, a synthesis agent (same model as the planner) uses both solutions as
source material to produce the final solution, and a reviewer agent critiques
the result before it is presented to the user.
The default preset (`zhuge` — the Zhuge Liang directing the cobblers) gives
the orchestrator role a stronger model, GPT-5.5 via the Codex subscription,
while the workers stay cheap.

The bet: ensemble of cheap workers + strong planning/synthesis ≥ single
expensive model doing everything, because two independent solutions give a
synthesis agent more surface area to reason from. The synthesis agent forms
one coherent final solution by taking the best ideas, code, and verification
learnings from both worker attempts.

## 2. Terminology (read this first — the words matter)

- **Harness (extension code)**: deterministic TypeScript in
  `packages/pi-troika`. It runs git commands, spawns subprocesses, enforces
  timeouts, writes artifacts. It makes **no LLM calls itself**. NEVER call
  this component "orchestrator" — that word is reserved for the intelligent
  role below.
- **Orchestrator (role/model)**: the `orchestrator` config field names the
  model that does the intelligent orchestration work — it powers the planner
  agent, plan revisions, the synthesis agent, and the reviewer agent.
- **Planner agent**: a headless `pi` subprocess using the `orchestrator`
  model. Runs in the plan worktree. Writes `PLAN.md` and acceptance tests.
  Does NOT implement the task. May be re-spawned to revise the plan after
  critic feedback (§8 step 2).
- **Plan critic agents**: two headless subprocesses, one per **worker model**,
  that critique `PLAN.md` before fan-out (§8 step 2). Read-only, advisory.
  Cheap and perspective-diverse by construction — and the critics are the
  same models that must later implement the plan.
- **Worker A / Worker B**: headless `pi` subprocesses, one per worker model,
  each in its own worktree. They implement the task end-to-end.
- **Synthesis agent**: a headless `pi` subprocess using the `orchestrator`
  model, in its own fresh worktree. Writes the final solution.
- **Reviewer agent**: a headless `pi` subprocess using the `orchestrator`
  model. Reviews the synthesized solution read-only (§8 step 8). Advisory:
  its verdict is shown at DECIDE; it never edits and never triggers retries.

So one run = 6–8 LLM subprocesses (planner, 2 critics, optional revision,
worker A, worker B, synthesis, reviewer), all spawned and supervised by the
non-LLM harness.

Naming: the word "orchestrator" is reserved for the intelligent role. The
deterministic extension code is always called the **harness**, never the
orchestrator.

Why the harness has no LLM (deliberate, do not "fix" this): every branch
point in the pipeline — worker failed? verify green? PLAN.md contract valid?
critics say ready? — is mechanically checkable from exit codes, empty diffs,
file existence, and a mandatory VERDICT first line, so control flow stays
deterministic code and the §14 hard rules are guarantees rather than model
behavior. All judgment work lives in the subprocesses; the planner agent IS
the orchestrator planning, in every sense that matters — it is a full agentic
session running the `orchestrator` model. If planning needs even more
intelligence later, point `orchestrator` at a MoA preset (§3 composition
seam) — do not give the harness an LLM.

## 3. Relationship to pi-moa (already in this repo)

`packages/pi-moa` is the **turn-level** ensemble: on every LLM call, reference
models privately advise an aggregator, which produces that single turn's output.
The references never act; there is one shared context.

pi-troika is the **task-level** ensemble: each worker is a *full agentic
session* (tool calls, file edits, test runs) that completes the entire task
end-to-end in its own worktree; comparison happens once, on finished artifacts
(diffs), not per turn.

They are complementary and composable:

| | pi-moa (built) | pi-troika (this spec) |
|---|---|---|
| Granularity | one LLM turn | one whole task |
| Workers act? | no — advisory text only | yes — edit files, run commands |
| Isolation | none needed | git worktree per agent |
| Synthesis input | reference advice text | two worker solutions, diffs, verification logs, and any repo context the synthesis agent needs |
| Mechanism | synthetic provider (`moa/<preset>`) | command spawning headless `pi` subprocesses |

Composition option: a troika worker could itself run `--model moa/<preset>`,
and pointing `orchestrator` at a MoA preset would give the planner true
multi-model debate on every planning turn — the strongest version of the
"brainstorm, discuss, debate" idea, for free, because both are just model IDs.
Don't build this first, but the seam exists.

## 4. Design Guidance

The 三个臭皮匠 intuition is backed by real results (mixture-of-agents /
best-of-N literature). The chosen product shape is full-agent synthesis:

1. **PLAN is an acting phase, not a text phase.** Ensemble gain is largest on
   well-specified tasks with verifiable outcomes. Therefore the planner agent
   runs *in a worktree with full tools* and commits acceptance tests before
   fan-out. That commit (`BASE_PLAN`) is the fork base for both workers and the
   synthesis agent, so every downstream agent and every VERIFY step sees the
   same tests. A plan that only *describes* tests in prose is not acceptable —
   it silently degrades the strongest quality lever.
2. **Plans are critiqued before fan-out.** Two weak workers executing a bad
   plan produce two bad solutions. The plan-review loop (§8 step 2) is a
   bounded critic→revise cycle, not an open-ended debate: worker models
   critique (cheap, diverse, and they are the future implementers), the
   orchestrator model revises, the harness caps rounds via `planReviewRounds`.
3. **Full synthesis agent, not binary judging.** The synthesis agent can
   inspect anything it needs: the original task, plan, acceptance criteria,
   worker diffs, verification logs, worker worktrees (by absolute path), and
   repository files through normal tools.
4. **Avoid mechanical patch splicing.** "Best from both" does not mean blindly
   merging diffs. The synthesis agent uses both attempts as reference material
   and writes the final implementation in one coherent pass.
5. **Advisory agents never block.** Critics and the reviewer inform; they do
   not gate. If one dies or times out, the run continues with a note. Only
   the core path (planner, workers per the failure policy, synthesis) can
   abort a run.
6. **Honest caveats.** Roughly 5× cost and latency per task (6–8 subprocesses,
   though critics/workers are cheap models), plus dependency install ×4
   worktrees. Planner/revision/synthesis/reviewer draw on the Codex
   subscription quota, not pay-per-token API. On vague tasks, two weak workers
   may make the same mistakes — the PLAN + PLAN REVIEW phases exist precisely
   to de-vague the task before fan-out.

### 4.1 The flow-diagram review (2026-07-02): what was adopted and what was not

The user's sketch proposed: orchestrator receives task → "need planning?"
triage → plan with subagent (brainstorm/discuss/debate) → "plan good enough?"
loop → workers A+B → synthesis → code reviewer → respond to user.

- **Adopted: the plan-quality loop** — as the bounded critic→revise cycle in
  §8 step 2 (deterministic, capped, weak-model-friendly), not as free-form
  multi-agent debate (unbounded cost, no mechanical termination condition).
- **Adopted: the code reviewer** — §8 step 8, advisory, feeding DECIDE.
- **Not adopted for v1: the "need planning?" triage node.** In v1 troika only
  runs when the human types `/troika <task>` — that keystroke IS the "yes,
  this needs the ensemble" decision, and an LLM second-guessing it after an
  explicit, expensive invocation would surprise the user. The left third of
  the diagram (user ↔ orchestrator conversation, trivial tasks answered
  directly) is the normal interactive Pi session, which already exists. When
  agent-invoked troika lands (v2), the main Pi agent becomes that triage
  node by deciding whether to call the troika tool.
- **Kept even though the sketch omits them:** worktree isolation, the two
  VERIFY steps, the tamper check, and the DECIDE user checkpoint — these are
  the safety rails that make the rest trustworthy.

## 5. What Exists Upstream (pi repo: `/Users/season/Personal/pi`)

Verified by source inspection on 2026-07-02:

- **Subagent example extension** — `packages/coding-agent/examples/extensions/subagent/`
  (`index.ts`, `agents.ts`, workflow prompts in `prompts/`). Implements ~80% of
  troika's subprocess layer:
  - Spawns workers as `pi --mode json -p --no-session --model <model> ...`
    subprocesses, streaming JSON events (`message_end`, `tool_result_end`),
    tracking per-agent usage/cost. Copy the spawn/stream/usage-parsing code.
  - Each task accepts an optional **`cwd`** (`TaskItem`/`ChainItem` schemas,
    `index.ts` ~lines 431–458) — confirms subprocesses run happily with cwd
    pointed at a worktree.
  - parallel mode (`mapWithConcurrencyLimit`, `index.ts` ~line 219) shows the
    concurrency pattern; troika only ever needs 2-wide.
- **Read tool resolves absolute paths outside cwd** — verified in
  `packages/coding-agent/src/core/tools/read.ts` +
  `path-utils.ts` (`resolveToCwd` resolves relative paths against cwd but
  passes absolute paths through; there is no cwd-escape blocking in core
  tools). This means the synthesis and reviewer agents CAN read worker
  worktrees and the artifacts directory directly via absolute paths. No
  sandbox workaround needed.
- **Extension API** — docs at `packages/coding-agent/docs/extensions.md`, types
  at `packages/coding-agent/src/core/extensions/types.ts`. Relevant surface:
  `pi.registerCommand`, `pi.exec(command, args, options)` (for all git and
  verify commands), lifecycle hooks, `ctx.ui` for the DECIDE checkpoint.
- **Headless entry points** — `--print/-p`, `--mode text|json|rpc`,
  `--no-session`, `--model`, `--tools`, `--append-system-prompt` (all in
  `packages/coding-agent/src/cli/args.ts`; docs in `docs/usage.md`,
  `docs/json.md`).
- **Chinese models are first-class** in `packages/ai/src/providers/`: DeepSeek
  (`deepseek.ts`), GLM/Z.ai (`zai.ts`, `zai-coding-cn.ts`), Kimi/Moonshot
  (`moonshotai.ts`, `moonshotai-cn.ts`, `kimi-coding.ts`), MiniMax
  (`minimax.ts`/`minimax-cn.ts`), plus OpenRouter/Fireworks/Together gateways.
  Qwen via DashScope/OpenRouter as `openai-completions` with
  `compat.thinkingFormat: "qwen"`.
- **Codex subscription is first-class too** — provider `openai-codex`
  (`openai-codex.ts`, OAuth as "OpenAI (ChatGPT Plus/Pro)"), with `gpt-5.5`
  in `openai-codex.models.ts` (verified 2026-07-02). Powers the default
  preset's orchestrator role.
- **Not useful here**: `packages/orchestrator/` upstream is a fleet supervisor
  (instance heartbeats/IPC), not a task planner. No built-in worktree
  management in pi core.

## 6. What Exists in This Repo to Mix and Match

### `packages/pi-worktree` — the isolation layer, with one trap
- Reuse: worktree creation/removal plumbing, and the `.git/info/exclude`
  registration pattern (`src/extensions/worktree.ts` ~line 174) so `.pi/` never
  shows up in `git status`.
- **TRAP — do not copy the fork-point logic.** `worktree.ts` ~line 490 picks
  `main`/`master` as the branch base. That is correct for pi-worktree's
  session-sandbox use case and WRONG for troika: a `/troika` run started from a
  feature branch must fork from that branch's HEAD, not from main. Troika MUST
  fork from explicitly recorded commits (`BASE_HEAD`, then `BASE_PLAN` — see
  §8) and MUST NOT contain any main/master lookup.
- Workers spawned as subprocesses with `cwd` set to their worktree don't need
  pi-worktree's path redirection at all — the subprocess is simply born inside
  the worktree.

### `packages/pi-moa` — reusable patterns
- **Config/preset pattern** (`src/extensions/config.ts`): `.pi/<name>.json` →
  `~/.pi/agent/<name>.json` → built-in defaults; validation with named
  preset/field errors; recursion guards.
- **Model resolution + auth** (`src/extensions/orchestrator.ts`):
  `registry.find()` at call time, `registry.getApiKeyAndHeaders(model)`, and
  **credential redaction** — copy the scrubbing helper and apply it to every
  provider/subprocess error before it is written to any artifact or shown in
  any prompt.
- **Guidance-block discipline** (`src/extensions/messages.ts`): stable markers
  and per-source truncation caps — the same discipline applies to how worker
  diffs are inlined into the synthesis prompt (see `maxInlineDiffChars`).
- Architectural difference to respect: pi-moa is a synthetic *provider* because
  it intercepts every turn. Troika is a *command* (`/troika <task>`) because it
  runs once per task and spawns full sessions. pi-moa's PLAN.md §2 ("why not a
  tool") does **not** apply to troika.

### `packages/pi-skills-status` — minor reuse
- Footer/status-item pattern for live progress
  (`worker A (glm-5.2): 12 tool calls · worker B (deepseek-v4-pro): 9 tool calls`).

### `packages/pi-readbeam` — not relevant.

## 7. Run Directory Layout

Everything a run produces lives under one directory so cleanup is `rm -rf` +
`git worktree prune` + branch deletion, and post-mortems have one place to look.

```
<repo>/.pi/troika/runs/<run-id>/
  manifest.json            # run state; updated by the harness at every phase transition
  plan/                    # git worktree, branch troika/<run-id>/plan
  worker-a/                # git worktree, branch troika/<run-id>/worker-a
  worker-b/                # git worktree, branch troika/<run-id>/worker-b
  synthesis/               # git worktree, branch troika/<run-id>/synthesis
  artifacts/
    PLAN.md                # final committed plan
    plan-round-<n>.md      # PLAN.md snapshot per plan-review round (round 0 = first draft)
    critique-r<n>-a.md     # critic A's critique in round n (worker-A model)
    critique-r<n>-b.md     # critic B's critique in round n (worker-B model)
    review.md              # reviewer agent's verdict + findings
    planner.jsonl          # raw --mode json stdout of the planner agent (and revisions)
    critic-a.jsonl  critic-b.jsonl
    worker-a.jsonl  worker-b.jsonl
    synthesis.jsonl  reviewer.jsonl
    worker-a.diff  worker-b.diff  synthesis.diff    # vs BASE_PLAN
    test-tamper.diff         # acceptance-test files only — empty = untouched
    verify-baseline.log  verify-worker-a.log  verify-worker-b.log  verify-synthesis.log
    usage.json               # per-agent tokens/cost + totals
```

- `<run-id>` format: `YYYYMMDD-HHMMSS-<pid>` (UTC). Example: `20260702-134501-8812`.
- Branch names: `troika/<run-id>/plan`, `.../worker-a`, `.../worker-b`,
  `.../synthesis`.
- `manifest.json` fields: `runId`, `preset`, `task`, `baseHead`, `basePlan`,
  `phase` (one of `precheck|plan|plan-review|fork|work|verify-workers|synthesize|verify-synthesis|review|decide|clean|done|failed`),
  `workers: [{name, model, status, exitCode, reason}]`, `startedAt`,
  `updatedAt`. Write it before starting each phase, not after finishing.
- On startup, if `.pi/troika/runs/` contains directories whose manifest `phase`
  is not `done`, print a one-line notice listing them (leftovers from crashed
  runs). Do not auto-delete them in v1.

## 8. Run Pipeline (exact, step by step)

`/troika <task>` runs these steps in order. Any step that says "abort" means:
set manifest `phase: "failed"`, print the error with the run dir path, keep the
run dir and all worktrees for inspection, and stop.

### Step 0 — PRECHECK
1. `git rev-parse --show-toplevel`. Non-zero exit → print
   "troika requires a git repository" and stop (no run dir created).
2. `git status --porcelain`. Any output → print
   "troika requires a clean working tree; commit or stash first" and stop.
   Rationale: worktrees fork from commits, so uncommitted changes would be
   invisible to every agent — refusing is the only non-confusing behavior.
3. Load config (§9), resolve the preset, resolve all three models via
   `registry.find()` — unknown model → abort with the model id in the message.
4. `BASE_HEAD = git rev-parse HEAD`. Record in manifest.
5. Create the run dir + `artifacts/` + initial `manifest.json`. Ensure `.pi/`
   is in `.git/info/exclude` (pi-worktree pattern, §6).

### Step 1 — PLAN (acting phase)
1. `git worktree add <run-dir>/plan -b troika/<run-id>/plan <BASE_HEAD>`
2. If `setupCommand` is set: run it in the plan worktree (§10 execution rules).
   Non-zero exit → abort.
3. Spawn the **planner agent** (§11 subprocess rules, §12.1 prompt) with
   cwd = plan worktree, model = preset `orchestrator`. Stream stdout to
   `artifacts/planner.jsonl`. Timeout: `plannerTimeoutMs`. Killed/non-zero
   exit → abort.
4. Validate the PLAN.md contract (§12.1). Any violation → abort with the
   specific violation named. Snapshot to `artifacts/plan-round-0.md`.

### Step 2 — PLAN REVIEW (bounded critique loop)
Repeat for round n = 1 .. `planReviewRounds` (skip entirely if 0):
1. Spawn **critic A** (worker-A model) and **critic B** (worker-B model) in
   parallel (§12.2 prompt), each with cwd = plan worktree. Timeout:
   `plannerTimeoutMs` each. Save each critique to
   `artifacts/critique-r<n>-{a,b}.md` (final assistant message text).
2. Parse the mandatory first line of each critique: `VERDICT: READY` or
   `VERDICT: REVISE` (case-insensitive). A critic that died, timed out, or
   produced a malformed first line counts as READY with a note in its
   critique file — advisory agents never block (§4.5).
3. Both READY → exit the loop.
4. Otherwise spawn a **plan revision** (§12.1 revision variant, `orchestrator`
   model, cwd = plan worktree) with both critiques included. Timeout:
   `plannerTimeoutMs`. If the revision subprocess fails → exit the loop with
   the existing plan and a note (do not abort). Re-validate the PLAN.md
   contract — violation → abort. Snapshot to `artifacts/plan-round-<n>.md`.

After the loop:
5. Commit the plan worktree: if `git status --porcelain` is non-empty,
   `git add -A && git commit -m "troika(<run-id>): plan + acceptance tests"`.
6. `BASE_PLAN = git -C <plan worktree> rev-parse HEAD`. Record in manifest.
   Copy final `PLAN.md` to `artifacts/PLAN.md`.
7. If `verifyCommand` is set: run it in the plan worktree, capture to
   `artifacts/verify-baseline.log`. **A non-zero exit here is EXPECTED and is
   not a failure** — newly written acceptance tests should fail before
   implementation. Record the exit code; do not abort on it.

### Step 3 — FORK
For each of `worker-a`, `worker-b`, `synthesis`, in that order:
1. `git worktree add <run-dir>/<name> -b troika/<run-id>/<name> <BASE_PLAN>`
2. If `setupCommand` is set: run it in that worktree. Non-zero exit → abort.

Run these sequentially, not in parallel (package-manager caches and lockfile
tooling do not reliably tolerate concurrent installs).

### Step 4 — WORK
1. Spawn worker A and worker B **in parallel** (§11, §12.3), each with cwd =
   its own worktree, model = its preset entry. Stream to
   `artifacts/worker-<x>.jsonl`. Timeout: `workerTimeoutMs` each.
2. After each worker exits: if `git -C <wt> status --porcelain` is non-empty,
   `git -C <wt> add -A && git -C <wt> commit -m "troika(<run-id>): <name> final state"`.
   (The harness commits; never rely on the worker having committed.)
3. Classify each worker, exactly this rule:
   - **FAILED** if (a) the process was killed by timeout, or (b) exited
     non-zero, or (c) `git -C <wt> diff --quiet <BASE_PLAN> HEAD` exits 0
     (i.e., it changed nothing).
   - **SUCCEEDED** otherwise. A failing test suite does NOT make a worker
     FAILED — verification results are information for synthesis, not a
     success criterion here.
4. Failure policy:
   - Both FAILED → abort (the remaining steps are skipped; nothing to
     synthesize).
   - One FAILED → continue with the survivor. The synthesis prompt MUST state
     that only one attempt exists and why the other failed (§12.4).
   - Both SUCCEEDED → continue normally.

### Step 5 — VERIFY (workers)
For each SUCCEEDED worker, **sequentially** (never in parallel — test suites
collide on ports, databases, and shared caches):
1. If `verifyCommand` is set: run it in the worker's worktree, capture
   stdout+stderr+exit code to `artifacts/verify-worker-<x>.log`.
2. `git -C <wt> diff <BASE_PLAN> HEAD > artifacts/worker-<x>.diff`.

If `verifyCommand` is unset, skip 1 and note "no verification configured" in
the manifest; this caveat must also appear in the DECIDE summary.

### Step 6 — SYNTHESIZE
1. Spawn the **synthesis agent** (§11, §12.4) with cwd = synthesis worktree,
   model = preset `orchestrator`. Stream to `artifacts/synthesis.jsonl`.
   Timeout: `synthesisTimeoutMs`. Killed/non-zero/empty-diff → abort (same
   classification rule as workers).
2. After exit, commit: if `git -C <wt> status --porcelain` is non-empty,
   `git add -A && git commit -m "troika(<run-id>): synthesis final state"`.

### Step 7 — VERIFY (synthesis)
1. If `verifyCommand` is set: run it in the synthesis worktree →
   `artifacts/verify-synthesis.log`.
2. `git -C <wt> diff <BASE_PLAN> HEAD > artifacts/synthesis.diff`.
3. **Tamper check**: for the acceptance-test file list parsed from PLAN.md
   (§12.1), run `git -C <wt> diff <BASE_PLAN> HEAD -- <file1> <file2> ...`
   → `artifacts/test-tamper.diff`. Empty file = tests untouched. If the list
   was `NONE`, write an empty file and note "no acceptance tests declared".

### Step 8 — REVIEW (advisory)
1. Spawn the **reviewer agent** (§12.5) with cwd = synthesis worktree,
   model = preset `orchestrator`. Timeout: `reviewerTimeoutMs`. Stream to
   `artifacts/reviewer.jsonl`; save its final assistant message to
   `artifacts/review.md`.
2. The reviewer is read-only by contract. After it exits, the harness runs
   `git -C <synthesis wt> status --porcelain`; if anything changed,
   `git reset --hard HEAD && git clean -fd` and prepend a warning line to
   `review.md` ("reviewer attempted modifications; discarded"). The
   deliverable is the committed state — the reviewer cannot alter it.
3. If the reviewer died, timed out, or its first line is not
   `VERDICT: APPROVE` or `VERDICT: CONCERNS`, write
   "review unavailable: <reason>" to `review.md` and continue — advisory
   agents never block (§4.5).

### Step 9 — DECIDE
Present to the user (via `ctx.ui`):
- Synthesis branch name and worktree path.
- Verification result: exit code + last ~30 lines of `verify-synthesis.log`
  (or "no verification configured").
- Tamper check: "acceptance tests untouched" or the content of
  `test-tamper.diff` shown prominently — a green verify means nothing if the
  tests were weakened.
- Reviewer verdict (APPROVE / CONCERNS / unavailable) + its findings from
  `review.md`.
- Worker outcomes: per worker, status + verify exit code.
- Usage: per-agent and total tokens/cost from `usage.json`.

Then ask, exactly these options:
1. **Keep synthesis, clean the rest** (default) — remove plan/worker-a/worker-b
   worktrees and branches; keep synthesis worktree+branch and `artifacts/`.
2. **Keep everything** — leave all four worktrees for manual comparison.
3. **Abandon** — remove all four worktrees and branches; keep `artifacts/`.

This step runs even when synthesis verification failed or the reviewer raised
concerns — both stop at this checkpoint for user direction; there is no
automatic retry and no automatic fallback in v1. Troika never merges into the
user's branch in v1; landing the synthesis branch is always a manual action by
the user.

### Step 10 — CLEAN
Per the user's choice: `git worktree remove --force <path>` for each worktree
to remove, then `git branch -D troika/<run-id>/<name>`, then
`git worktree prune`. Always keep `artifacts/` and `manifest.json`. Set
manifest `phase: "done"`.

## 9. Config

File resolution (pi-moa pattern): `<repo>/.pi/troika.json` →
`~/.pi/agent/troika.json` → built-in defaults.

```json
{
  "defaultPreset": "zhuge",
  "presets": {
    "zhuge": {
      "orchestrator": { "provider": "openai-codex", "model": "gpt-5.5" },
      "workers": [
        { "provider": "zai", "model": "glm-5.2" },
        { "provider": "deepseek", "model": "deepseek-v4-pro" }
      ],
      "setupCommand": "npm ci",
      "verifyCommand": "npm test",
      "planReviewRounds": 1,
      "plannerTimeoutMs": 600000,
      "workerTimeoutMs": 900000,
      "synthesisTimeoutMs": 900000,
      "reviewerTimeoutMs": 600000,
      "verifyTimeoutMs": 600000,
      "maxInlineDiffChars": 40000
    }
  }
}
```

Field rules:
- `orchestrator` (required): model for the planner, plan revisions, synthesis,
  and reviewer agents — the intelligent orchestration role (§2 naming). There
  is no separate synthesizer or reviewer model field in v1.
- `workers` (required): exactly 2 entries in v1. 1 or 3+ → validation error
  naming the preset. Worker models also serve as the plan critics.
- `setupCommand` (optional): run once per worktree after creation (§8 steps
  1.2, 3.2). Needed because a fresh git worktree has no `node_modules`, build
  artifacts, or env files — without it, `verifyCommand` fails everywhere.
  If unset, no setup is run.
- `verifyCommand` (optional): run per §8 steps 2.7, 5, 7. If unset, all verify
  steps are skipped and the DECIDE summary says so.
- `planReviewRounds` (default 1): max critique→revise rounds in §8 step 2.
  0 disables plan review entirely.
- `maxInlineDiffChars`: per-worker cap on how much diff text is inlined into
  the synthesis and reviewer prompts. Diffs beyond the cap are truncated
  inline with a note pointing at the full `.diff` artifact path.
- Timeouts: milliseconds; all five have the defaults shown above. Critics use
  `plannerTimeoutMs`.
- Validation errors must name the preset and field (pi-moa convention).
- Recursion guard: reject any preset whose model resolves to a troika-provided
  model id (there are none in v1 since troika registers no provider, but keep
  the check pattern if that ever changes).

## 10. Command Execution Rules (setup, verify, git)

- Run `setupCommand`/`verifyCommand` via `pi.exec("bash", ["-c", command], { cwd })`
  with cwd set to the target worktree. Never a login shell (`-l`), never the
  user's main checkout as cwd.
- Capture stdout+stderr merged, plus exit code, into the corresponding
  `artifacts/*.log` file.
- Apply `verifyTimeoutMs` to both setup and verify commands. On timeout:
  SIGTERM, wait 10 s, SIGKILL; record `exitCode: null, reason: "timeout"`.
- All git commands run via `pi.exec` with explicit `-C <path>` or `cwd` —
  NEVER rely on the extension process's working directory.
- Before writing any subprocess/provider error into an artifact, a prompt, or
  the UI, pass it through the credential-redaction helper copied from pi-moa.

## 11. Agent Subprocess Rules (planner, critics, workers, synthesis, reviewer)

- Spawn command shape (copy the subagent example's spawn/stream code):
  `pi --mode json -p --no-session --model <provider/model> "<prompt>"`
  with `cwd` set to the agent's worktree.
- `--no-session` is deliberate, not an oversight: the raw JSONL capture below
  already preserves each agent's full transcript in `artifacts/`,
  self-contained with the run. Session files would duplicate that into the
  user's global session store, cluttering `pi --resume` with ephemeral
  subagent runs whose worktrees later get deleted. The only capability lost
  is native resume into a worker conversation — v1 workers are one-shot, so
  nothing needs it. If a v2 debug mode wants "step back into worker A's
  session", drop `--no-session` for that spawn and record the session ID in
  the manifest.
- Do NOT pass `--tools`: agents get pi's default coding toolset (read, bash,
  edit, write, grep, find, ls). Confirm the default set during milestone 4 and
  pin it explicitly with `--tools` only if the default turns out to include
  anything interactive.
- Write the raw stdout JSONL stream to `artifacts/<agent>.jsonl` unmodified.
- Parse per-agent usage/cost from `message_end` events exactly as the subagent
  example's `index.ts` does; accumulate into `artifacts/usage.json`.
- Timeout enforcement: on expiry send SIGTERM, wait 10 s, then SIGKILL.
- The prompt is passed as the single positional argument. If prompts exceed
  argv comfort (~100 KB), switch to `--append-system-prompt <file>` for the
  static parts; do not build this until it is actually needed.

## 12. Agent Prompt Contracts

Prompts are assembled by the harness from templates. Each template below
lists what MUST be included. Keep prompts plain and imperative — the worker
models are weak; do not rely on subtlety.

### 12.1 Planner agent

Prompt MUST contain:
1. The user's task, verbatim.
2. Instruction: "You are planning, not implementing. Do NOT implement the
   task. Do NOT modify existing source files except to add tests."
3. Instruction to write `PLAN.md` at the worktree root with EXACTLY these
   sections:
   - `## Task` — restated task.
   - `## Approach` — how a competent implementer should proceed.
   - `## Acceptance criteria` — observable, checkable statements.
   - `## Acceptance test files` — a bullet list of repo-relative paths, one
     per line, of the test files that verify this task. If the repo already
     has adequate tests, list those existing files. If the task is genuinely
     untestable, write exactly one bullet: `- NONE`.
   - `## How to verify` — the command(s) to run and what output means success.
4. Instruction: if adequate tests do not exist, write new acceptance tests
   now; they MUST fail before the task is implemented and pass after.
5. Instruction: do not run `git commit`, `git checkout`, `git switch`, or
   `git rebase`; the harness handles git.

**Revision variant** (§8 step 2.4) additionally contains: the current
`PLAN.md`, both critiques verbatim, and the instruction "Revise PLAN.md and
the acceptance tests. For every critique issue, either fix the plan or state
in the plan why the critique is wrong. Keep all five required sections."

Harness-side validation after the planner (or a revision) exits:
- `PLAN.md` exists at the worktree root.
- It contains all five `##` headings above.
- Every path under `## Acceptance test files` exists in the plan worktree,
  OR the list is exactly `- NONE`.
Any violation → abort, naming the violated rule.

### 12.2 Plan critic agents

Prompt MUST contain:
1. The user's task, verbatim, and the full text of the current `PLAN.md`.
2. Framing: "You are one of the models that will implement this plan.
   Critique it as the implementer: Are the acceptance criteria complete and
   mechanically checkable? Do the tests actually cover the task? Is the
   approach feasible? What is ambiguous or missing?"
3. Output contract: the FIRST line of the reply must be exactly
   `VERDICT: READY` or `VERDICT: REVISE`, followed by a numbered list of
   issues, each with a concrete suggested fix.
4. Read-only: do not modify any file; do not run git; inspecting the repo
   with read tools is allowed and encouraged.

Harness parses only the first line. Died/timeout/malformed → counts as READY
with a note (§4.5); the critique text is still saved and passed to the
revision if the other critic triggered one.

### 12.3 Worker agents

Prompt MUST contain:
1. The user's task, verbatim.
2. The full text of `PLAN.md`.
3. Instruction: "Implement the task completely in this repository checkout.
   The acceptance tests described in the plan already exist in your checkout;
   make them pass without weakening them."
4. Instruction to run the verify command (from `## How to verify`) before
   finishing and to fix failures.
5. Instruction: do not run `git commit`, `git checkout`, `git switch`,
   `git rebase`, or `git worktree`; stay in the current directory; the
   harness handles git.
6. No mention of the other worker. Workers must be independent.

### 12.4 Synthesis agent

Prompt MUST contain:
1. The user's task, verbatim, and the full text of `PLAN.md`.
2. Status of both workers. If one failed:
   "Worker B (deepseek-v4-pro) failed: timeout after 900s. You have ONE
   reference attempt instead of two. Review it critically rather than
   trusting it."
3. Per surviving worker: model name, verify exit code, and the first
   `maxInlineDiffChars` characters of its diff inline. If truncated, say so
   and give the absolute path to the full `.diff` file.
4. Absolute paths to: each worker worktree, each `.diff`, each verify log,
   each worker `.jsonl`, and `artifacts/verify-baseline.log` — with the note:
   "You can read any of these with the read tool using the absolute path."
5. Instruction: "Do NOT run git commands in the worker worktrees. Read the
   provided diff files instead."
6. Instruction: "Your checkout already contains the plan and acceptance tests
   at the same base commit the workers started from. Write ONE coherent final
   implementation in your own checkout, taking the best ideas from the
   reference attempts. Do not splice their patches together mechanically."
7. Instruction: run the verify command before finishing; do not modify the
   acceptance test files listed in PLAN.md — any change to them will be
   flagged to the user; if you believe a test itself is wrong, say so
   explicitly in your final summary instead of editing it.
8. Same git prohibitions as workers (12.3 item 5).

### 12.5 Reviewer agent

Prompt MUST contain:
1. The user's task, verbatim, and the full text of `PLAN.md`.
2. The synthesis diff inline (capped at `maxInlineDiffChars`, with the
   absolute path to the full file), the synthesis verify exit code + log
   path, and the tamper-check result.
3. Framing: "You are reviewing the final solution before it is shown to the
   user. Check: does the diff actually satisfy each acceptance criterion?
   Are there bugs, regressions, or unhandled edge cases? Is anything in the
   diff unrelated to the task?"
4. Output contract: the FIRST line of the reply must be exactly
   `VERDICT: APPROVE` or `VERDICT: CONCERNS`, followed by numbered findings,
   each labeled `[blocking]` or `[minor]`, with file/line references.
5. Read-only: you may read files and run read-only commands (including the
   test suite), but MUST NOT modify any file and MUST NOT run git write
   commands. Any modification will be discarded by the harness.
6. Advisory: your verdict is shown to the user at DECIDE; it does not trigger
   retries.

## 13. Resolved Decisions (v1)

- Naming: "orchestrator" always refers to the intelligent role (the
  `orchestrator` model powering planner, revisions, synthesis, and reviewer).
  The deterministic extension code is the "harness" — in docs, code
  identifiers, and UI text.
- New extension/package only: create `packages/pi-troika`; do not modify
  existing extensions except as reference material to copy/adapt from.
- Invocation: only the human typing `/troika <task>` starts a run. No
  agent-callable Troika tool and no "need planning?" triage in v1 — the
  explicit invocation IS the triage decision (§4.1). The harness (extension
  code) makes no LLM calls itself.
- PLAN is an acting phase; its commit `BASE_PLAN` is the fork base for
  workers and synthesis (§4.1, §8).
- Plan review is in v1: a bounded critic→revise loop (§8 step 2), critics =
  the two worker models, reviser = the orchestrator model, capped by
  `planReviewRounds` (default 1). Free-form multi-agent debate rejected as
  unbounded; MoA-as-orchestrator noted as the v2 upgrade path (§3).
- Code review is in v1: a read-only reviewer agent (§8 step 8), orchestrator
  model, advisory only — verdict + findings shown at DECIDE, never a retry
  trigger.
- Advisory agents (critics, reviewer) never abort a run; they degrade to
  notes (§4.5).
- Fork point is the invoking checkout's `HEAD` (via `BASE_PLAN` on top of
  `BASE_HEAD`), never main/master. Dirty working tree → refuse to run.
- Full-agent synthesis is the primary v1 behavior; synthesis uses the same
  model as the planner (`orchestrator` config field).
- Worker count is fixed at exactly two.
- Worker failure policy: one survivor → continue with explicit notice to the
  synthesis agent and user; zero survivors → abort. A failing test suite does
  not count as worker failure.
- Verify runs are sequential, never parallel.
- If synthesis verification fails or the reviewer raises concerns, stop at
  the DECIDE checkpoint and ask the user; no silent retry, no fallback.
- Landing is manual-review-first: keep the synthesis branch/worktree
  (DECIDE option 1 default); troika never merges into the user's branch.
- Usage/cost is summed across planner, critics, revisions, worker A, worker
  B, synthesis, and reviewer, then shown as a per-task total.
- Non-git projects are refused with a clear message; dirty trees likewise.
- All run state and artifacts live under `.pi/troika/runs/<run-id>/`;
  artifacts are always kept, even on Abandon.

## 14. Hard Rules for the Implementing Agent

1. Create `packages/pi-troika` only. NEVER modify `pi-moa`, `pi-worktree`,
   `pi-skills-status`, or the upstream pi repo.
2. NEVER copy pi-worktree's main/master fork-base lookup (§6 trap). All
   worktrees fork from `BASE_HEAD` or `BASE_PLAN` recorded in the manifest.
3. NEVER run any agent subprocess, setup command, or verify command with cwd
   in the user's main checkout. Every subprocess cwd is a run worktree.
4. NEVER run two verify commands at the same time.
5. NEVER auto-merge, auto-rebase, or otherwise touch the user's branch. The
   only branches troika creates or deletes are `troika/<run-id>/*`.
6. NEVER let an advisory agent (critic, reviewer) abort a run or mutate the
   deliverable — reviewer changes are reset, dead critics count as READY.
7. Always update `manifest.json` before entering a phase, so a crash leaves
   an accurate record.
8. Always redact credentials (pi-moa helper) before persisting or displaying
   any error text.
9. Timeout kills are SIGTERM → 10 s → SIGKILL, everywhere.
10. On abort, keep the run dir and worktrees; never clean up on failure paths.
    Cleanup only happens via DECIDE.
11. Validation failures must name the preset/field/contract rule violated —
    never a bare "invalid config".

## 15. Implementation Milestones (each with a "done when" gate)

1. **Scaffold + config.** Package skeleton registering `/troika`; port
   pi-moa's config loader/validator to the §9 schema.
   *Done when:* `/troika` with a bad preset prints a named validation error;
   with defaults it prints the resolved preset and exits (no run yet).
2. **Precheck + run dir + manifest.** §8 step 0.
   *Done when:* dirty tree and non-git dir are refused with the exact
   messages; a clean repo gets a run dir with a valid `manifest.json` and
   `.pi/` in `.git/info/exclude`.
3. **Worktree lib.** Create/remove worktrees + branches from an explicit
   commit (adapted from pi-worktree, minus the main/master lookup).
   *Done when:* a test script creates 4 worktrees from a fixed SHA, verifies
   their HEADs equal that SHA, removes them, and `git worktree list` +
   `git branch` are clean afterward.
4. **Subprocess runner.** Copy the subagent example's spawn/stream/usage
   parsing; add timeout-kill and raw JSONL capture (§11).
   *Done when:* it runs a trivial prompt in a worktree and produces a
   `.jsonl` artifact plus a usage entry; a 1 ms timeout produces a clean
   kill with `reason: "timeout"`.
5. **PLAN phase.** §8 step 1 + §12.1 contract validation.
   *Done when:* on a toy repo, the planner produces a contract-valid PLAN.md
   with new failing tests, snapshotted as `plan-round-0.md`.
6. **PLAN REVIEW loop.** §8 step 2: parallel critics, VERDICT parsing,
   revision, re-validation, commit, baseline verify.
   *Done when:* a READY+READY round commits immediately; a forced REVISE
   critique triggers exactly one revision; `verify-baseline.log` shows the
   expected failure; a critic killed mid-run counts as READY with a note.
7. **FORK + WORK.** §8 steps 3–4 including setupCommand, parallel workers,
   commit-after-exit, and the FAILED/SUCCEEDED classification + failure
   policy.
   *Done when:* both worker worktrees end with a commit and correct
   classification; killing one worker manually yields the one-survivor path.
8. **VERIFY workers.** §8 step 5 with sequential execution and diff capture.
   *Done when:* both `.diff` and `verify-*.log` artifacts exist and verify
   runs are provably sequential (timestamps in logs don't overlap).
9. **SYNTHESIZE + VERIFY + tamper check.** §8 steps 6–7, §12.4 prompt.
   *Done when:* synthesis produces a commit, `synthesis.diff`,
   `verify-synthesis.log`, and `test-tamper.diff` (empty when tests are
   untouched; non-empty when a test file is deliberately edited in a test
   run).
10. **REVIEW agent.** §8 step 8, §12.5 prompt, read-only enforcement.
    *Done when:* `review.md` starts with a valid VERDICT line; a reviewer
    that deliberately edits a file has its change reset and the warning
    prepended; a killed reviewer yields "review unavailable" and the run
    continues.
11. **DECIDE + CLEAN.** §8 steps 9–10 with the three options, reviewer
    verdict display, and correct worktree/branch cleanup per option.
    *Done when:* each option leaves exactly the documented set of worktrees,
    branches, and artifacts.
12. **End-to-end smoke test.** Toy repo with one existing failing test; two
    cheap workers; full pipeline including plan review and code review.
    *Done when:* the synthesis worktree passes verify, the DECIDE summary
    shows worker statuses + reviewer verdict + total cost, and option 1
    cleanup leaves only the synthesis worktree + artifacts.
