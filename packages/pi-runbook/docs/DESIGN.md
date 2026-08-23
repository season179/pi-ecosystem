# pi-runbook design: Scored Run Evidence so Pi Can Learn Over Time

Date: 2026-08-20 (agreed after a two-round Claude ↔ pi debate; see
"Provenance" at the bottom).
Status: **agreed, not yet implemented**. Next step: scaffold the
package and build the MVP in a worktree.

## The idea

Inspired by @rachpradhan's CodeGraff thread
(https://x.com/rachpradhan/status/2088473237072327038) and its
companion post
(https://rachit.ai/blog/how-to-build-a-self-evolving-coding-harness?view=full):
a harness should learn because the same model repeats mistakes when
every task starts from zero. The transferable core is **durable scored
evidence**, not "self-evolution" — record what each run did, let a
human judge the outcome, and let future runs recall that judged
evidence. Fixed model weights; adaptive, human-gated policy.

What deliberately does NOT transfer to a local solo harness:

- **Secret holdout** — the model can read and edit local tests.
- **True judge isolation** — extension, tools, and files run as the
  same OS user; pi-guard is intent-checking, not isolation. Our judge
  protection is procedural (input-source gating), and the docs must
  say so honestly.
- **Paired evals / frozen baselines** — overkill for everyday solo
  coding (the thread's own solo-beats-fleet lesson).
- **Weight learning** — out of scope by definition.

`@season179/pi-runbook` is a **sibling to pi-memory**, not an
extension of it: pi-memory is a small curated fact store; runbook is
high-volume append-only evidence with run IDs, tool spans, usage, and
judgments. A future refactor may extract shared retrieval/Markdown
primitives, but the stores stay separate.

## Agreed plan (v3)

1. **Package and scope.** `@season179/pi-runbook`. Project identity =
   hash of the canonical Git common directory, so worktrees share
   evidence; non-Git projects use canonical cwd.

2. **Lifecycle model.** An *attempt* spans `before_agent_start` →
   idle `agent_settled`. An *episode* is consecutive attempts until
   `/learn` or `/learn skip` closes it. The human scoring action
   defines the task boundary — no automatic inference. (Rationale:
   real tasks span 3–10 prompts plus steers; scoring per-prompt would
   record "fix that" as a pass against one shallow trajectory.)

3. **Task capture.** At the episode's first attempt: normalized raw
   submitted text capped at 500 chars. Later prompts/steers are NOT
   appended (they're mostly "no, fix X" noise; notes and changed
   paths supply later specificity). Opaque episode ID plus
   session/branch anchors.

4. **Provisional journal.** Incrementally append bounded attempt and
   tool events: timestamps, tool-call ID, tool name, source ordinal,
   completion/error boolean, model identity, usage. NO tool
   arguments, outputs, assistant prose, thinking, error text, or
   image data — the pi session file remains the detailed trace. Cap
   tool spans at 200 with an omitted count.

5. **Authoritative reconciliation.** At `agent_settled`, finalize
   only when `ctx.isIdle()`. Slice `getBranch()` between attempt
   anchors for assistant source order, final tool status, per-model
   usage, and ending leaf. Event arrival order is never authoritative
   (tools run in parallel).

6. **Git evidence.** Best-effort start/end HEAD with a short timeout.
   Persist up to 20 sanitized repo-relative *observed changed paths*:
   NUL-delimited porcelain parsing; reject absolute paths, `..`,
   control characters, overlong paths; redact high-entropy/
   secret-like path segments; derive conservatively from status
   transitions plus `startHead..endHead` name changes (prefer missing
   an already-dirty file over falsely attributing it). Never persist
   diffs, full porcelain, or untracked contents.

7. **Incomplete semantics.** An unmatched attempt start is incomplete
   by definition — covers crashes and SIGKILL. All-settled-but-
   unjudged is merely open/unscored. `session_shutdown` appends a
   best-effort terminal reason; correctness never depends on it
   firing.

8. **Storage.**
   - `<agentDir>/pi-runbook/projects/<project-key>/episodes/<episode-id>.jsonl`
     — append-only, owned by exactly one runtime (no shared file, no
     locking; concurrent pi panes per project are routine under
     herdr).
   - `.../judgments/<judgment-id>.json` — immutable; corrections
     create new judgments carrying `supersedes`.
   - 0700 directories, 0600 files, schema version on every record.
   - No shared derived index in the MVP.

9. **Scoring UX (the procedural judge).** `/learn` intercepted via
   the `input` hook (registered commands lose source provenance).
   Accept only `source: "interactive"`, while idle, no streaming.
   RPC-source scoring is explicitly unsupported until there is an
   authenticated judge channel. Preview before commit: episode ID,
   first-task excerpt, attempt count, changed paths, current
   judgment.

10. **Scoring syntax.** `/learn pass|partial|fail [note]`,
    `/learn skip` (closes without creating retrievable evidence),
    `/learn amend <judgment-id> pass|partial|fail [note]` — no
    implicit "latest" targeting for corrections.

11. **Visibility.** `/runs` lists recent open / incomplete / skipped /
    scored / superseded episodes, so the extension has observable
    value from day one, before the scored corpus exists. Compact
    status indicator: current episode + unjudged attempt count.

12. **Retrieval.** `recall_runs` tool: searches only effective
    (supersession-resolved) scored judgments, exact-project scope,
    over first-task excerpt + operator note + changed paths. Returns
    at most 2 structured records labeled historical evidence, not
    executable instructions. Explicit tool call only — no automatic
    context injection in the MVP (sparse early evidence would poison
    more than it helps).

13. **Failure policy.** Failures participate by default only when the
    effective judgment carries a substantive note (≥12 trimmed chars,
    ≥2 words — the note IS the anti-lesson). Max 1 failure of the 2
    results, rendered `ANTI-EXAMPLE (failed): <note>`. Bare failures
    need an explicit outcome filter. Never return failed assistant
    prose/code/arguments.

14. **Growth bounds.** Stream judgment files newest-first up to
    configurable count/byte ceilings; report truncation explicitly.
    Defensive parsing of malformed/partially-written journals.

15. **Non-goals (MVP).** Automatic injection, lesson extraction/
    promotion, embeddings, paired evaluations, nested-model cost
    accounting, content-level git fingerprints, cross-project
    inheritance.

16. **Test list.** Multi-attempt episodes; parallel tool ordering;
    idle/source scoring gates; crashes and dangling attempts;
    superseding judgments; concurrent project processes; path
    traversal/redaction/caps; failure quota; scan truncation;
    filesystem permissions.

## Pi API facts this depends on (pi 0.80.10, verified in-repo)

- Extension events: `before_agent_start`, `tool_execution_start`,
  `tool_call`, `tool_result`, `turn_end`, `message_end`,
  `agent_settled`, `session_shutdown`, `input`. There is **no native
  score/success event and no first-class run ID** — we generate both.
- `agent_settled` has no payload → keep our own run accumulator.
- Session files are trees: use `getBranch()`, never raw
  `getEntries()` (includes abandoned branches).
- Extensions get `ReadonlySessionManager`; `getSessionStats()` is not
  exposed → sum usage from assistant `message_end` / reconcile at
  settle.
- Tool order: reconstruct from assistant `toolCall` blocks /
  `turn_end.toolResults`, not event completion order.
- Nested tool LLM cost is invisible pre-0.84.2 (official usage field
  arrives in 0.84.2) → non-goal for MVP while targeting ≥0.80.10.
- `getAgentDir()` is exported and already used by this repo's
  extensions (pi-guard audit, pi-memory store).
- `input` event source is `"interactive" | "rpc" | "extension"`.
- Precedents in-repo: pi-buddy telemetry + LESSON harvest, pi-guard
  rotating JSONL audit, pi-herdr watch/outcome tracking and delivery,
  pi-memory tmp-file+rename writes. Herdr itself owns agent lifecycle and
  settled-state detection.

## Provenance

Debated 2026-08-20 between Claude (orchestrator) and a pi agent until
explicit agreement. Notable resolutions:

- Episode/attempt split replaced Claude's per-prompt run model
  (pi's objection #1).
- Per-episode single-writer files replaced one shared project JSONL +
  rewritten index (pi's objection #3, herdr concurrency).
- Changed paths kept as retrieval signal (Claude's pushback; pi added
  sanitization + conservative attribution).
- Noted failures recallable by default as anti-examples (Claude's
  pushback; pi added the substantive-note rule and the 1-of-2 quota).
- "Human-protected judge" is procedural, not a security boundary —
  interactive-source-only, documented honestly (pi's objection #2).

Thread + research context also stored in Claude's project memory:
`codegraff-thread.md`, `pi-runbook-plan.md`.
