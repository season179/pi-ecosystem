# pi-buddy: Sparring Partner Extension for Pi

Date: 2026-07-02
Status: Design complete, ready for implementation
Confidence: High — design decisions settled through discussion; key pi seams (custom tools, nested LLM calls via `streamSimple`, steering injection, turn events) are proven by pi docs and the pi-moa package in this repo.

## 1. Goal

Give pi a partner/buddy to bounce ideas off: discussion, debate, pushback, and
fact checking — the way a good human reviewer behaves. The buddy helps catch
issues and improve quality. It can **read, search, and list** files to verify
claims, but can **never write**.

## 2. Core Design Decisions (settled)

### 2.1 Buddy model
- `zai/glm-5.2` (Z.ai Coding endpoint, already configured in `~/.pi/agent/models.json`).
- Usable context window deliberately capped at 300K in models.json (model
  degrades beyond that despite the advertised 1M). `maxTokens` 131072.
- Model/provider must be configurable (flag + settings), defaulting to `zai/glm-5.2`.

### 2.2 Shape: one tool + one command
- `consult_buddy` tool registered via `pi.registerTool()`, callable by the main
  agent. Parameters:
  - `question` (string, required): what the agent wants the buddy's take on.
  - `stance` (enum, required): `discuss` | `debate` | `fact_check` | `review`.
    Use `StringEnum` from `@earendil-works/pi-ai` (Google compat).
- `/buddy <text>` command for the human to summon the buddy directly.
  Runs the same consultation path; result is injected into the session so both
  the human and the main agent see it.
- `promptSnippet` + `promptGuidelines` teach the main agent when to consult:
  before committing to a design, when uncertain about a factual claim, when the
  user asks for review, when about to make a risky/irreversible decision.

### 2.3 Stances shape the buddy's system prompt
- `discuss`: open exploration, tradeoffs, alternatives.
- `debate`: steelman the opposing view; must argue against the proposal even if
  it ultimately agrees (state agreement only after presenting the strongest
  counter-case).
- `fact_check`: must verify claims against actual files using its read tools;
  cite file paths/lines; distinguish verified vs. unverifiable.
- `review`: quality review of recent work — correctness, missed requirements,
  design smells.
- All stances share a base persona: candid, direct, no sycophancy; disagree
  when warranted; concede when wrong; keep it concise and concrete.

### 2.4 Buddy capabilities: read-only nested loop
- The buddy is a nested agentic loop (not a single completion): it may call
  tools, results feed back, loop continues until it produces a final text
  answer or hits an iteration cap (default 10 iterations).
- Tools available to the buddy: `read`, `grep`, `find`, `ls` — created via
  pi's factories (`createReadTool`, `createGrepTool`, `createFindTool`,
  `createLsTool`). **No `write`, no `edit`, no `bash`.**
- Implementation seam: `streamSimple` from `@earendil-works/pi-ai` with
  `ctx.modelRegistry.getApiKeyAndHeaders(model)` for auth — the same pattern
  pi-moa uses. Tool schemas passed in context; tool calls executed by the
  extension; results appended as toolResult messages; loop.
- Respect `signal` (from tool execute / ctx.signal) so Esc cancels a
  consultation mid-flight.

### 2.5 Context sharing: full transcript
- Each consultation serializes the **full current session branch**
  (`ctx.sessionManager.getBranch()`) into the buddy's context: user messages,
  assistant messages, tool calls and results, compaction summaries.
- Rendered as a readable transcript block in a user-role message, followed by
  the consultation request (question + stance instructions).
- Cost is not a constraint (subscription).

### 2.6 Memory: stateless buddy, continuity via transcript
- No buddy-side persistent state. Each consultation is a fresh LLM call.
- Continuity emerges for free: prior `consult_buddy` calls and responses are
  part of the transcript, so the buddy sees its own past opinions and can say
  "I flagged this before" or "you tried that already".
- Survives forks/branches/compaction with zero machinery.

### 2.7 Context-budget guard (safety net, not core path)
- Estimate transcript tokens (chars/4 heuristic is fine).
- If estimate exceeds ~90% of the buddy model's context window minus headroom
  for system prompt + buddy tool-loop results + maxTokens output:
  trim from the middle, oldest tool outputs first (they are bulkiest and least
  valuable; the buddy can re-read any file itself).
- Keep: system context, conversation head (incl. compaction summary), and the
  most recent N turns in full.
- Insert a visible marker in the transcript where trimming occurred.

### 2.8 Pull by default, quiet push after 3 idle turns
- **Pull**: main agent calls `consult_buddy` whenever it wants.
- **Push**: if 3 consecutive turns elapse in an agent run without any
  `consult_buddy` call, the extension automatically runs the buddy in a
  watchdog review over the recent transcript with instructions:
  "Review the recent turns. If you see a real problem — wrong direction,
  factual error, missed requirement, quality issue — raise it. If not, reply
  exactly `PASS`."
- **PASS-suppression**: if the buddy replies `PASS`, nothing is injected;
  the agent is not interrupted; no noise.
- **Steering**: substantive concerns are injected via
  `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: false })` as a
  custom message the agent must address; displayed so the human sees it too.
- **Counter rules**:
  - Counter increments on `turn_end` during an active agent run.
  - Resets on: any `consult_buddy` call (pull), any push (fired or PASS),
    and agent run boundaries (`agent_start`).
  - Turns are only counted within an agent run (no stale accumulation across
    short conversational prompts).
- Push must not re-enter: guard against a push firing while a previous push's
  buddy call is still running.

### 2.9 UX
- Custom `renderCall` / `renderResult` for `consult_buddy`: show stance +
  question compactly; buddy's answer styled distinctly; `expanded` shows the
  buddy's tool activity (files it read, searches it ran).
- `onUpdate` streams progress ("buddy is reading src/foo.ts…").
- Custom message renderer for pushed reviews (customType `buddy-review`).
- `ctx.ui.setStatus` while a consultation is in flight.

## 3. Package Layout

Follow repo conventions (mirror pi-moa / pi-readbeam):

```
packages/pi-buddy/
├── package.json          # @season179/pi-buddy, pi.extensions -> dist
├── tsconfig.json         # extends ../../tsconfig.base.json
├── PLAN.md               # this file
├── README.md
├── LICENSE
├── src/extensions/
│   ├── buddy.ts          # entry: registers tool, command, events, config
│   ├── consult.ts        # consultation orchestration (nested loop)
│   ├── transcript.ts     # branch -> transcript serialization + budget guard
│   ├── stances.ts        # stance system prompts + watchdog prompt
│   ├── buddy-tools.ts    # read-only tool set construction + execution
│   └── render.ts         # TUI rendering (tool call/result, pushed reviews)
└── test/
    └── buddy.test.ts     # transcript serialization, budget guard, counter logic
```

## 4. Implementation Order

1. **Scaffold** package (package.json, tsconfig, LICENSE, README stub).
2. **transcript.ts**: serialize `getBranch()` entries to text; token estimate;
   trimming guard. Pure functions — unit-testable first.
3. **stances.ts**: base persona + per-stance prompts + watchdog prompt.
4. **buddy-tools.ts**: build read-only toolset from pi factories; map
   tool-call requests from the buddy's stream to executions.
5. **consult.ts**: nested loop — build context, call `streamSimple`, execute
   tool calls, iterate, return final text + activity log. Abort + iteration cap.
6. **buddy.ts**: wire it together — `registerTool` (with renderers),
   `registerCommand("buddy")`, turn counter (`agent_start`/`turn_end`/pull
   resets), push with PASS-suppression + steering injection, `registerFlag`
   for model override, status line.
7. **Tests** for the pure parts (transcript, trimming, counter state machine,
   PASS detection).
8. **Manual smoke test**: `pi -e packages/pi-buddy/src/extensions/buddy.ts`
   in a scratch project; verify pull, push, PASS-suppression, Esc cancel.
9. **Workspace integration**: add pack/validate scripts to root package.json.

## 5. Open Items / Risks

- Exact `streamSimple` tool-calling shape for zai's `openai-completions` API:
  verify tool schema pass-through against pi-moa's orchestrator, which already
  drives the same seam.
- Reasoning content on assistant messages: zai glm-5.2 has thinking enabled;
  ensure the nested loop's message replay satisfies any
  `requiresReasoningContentOnAssistantMessages`-style compat requirements.
- Watchdog false-positive rate: if pushes get noisy in practice, raise the
  threshold (3 → 5 turns) or narrow the watchdog prompt. Threshold should be
  a constant, easy to make configurable later.
- `/buddy` command with empty args: prompt via `ctx.ui.input` for the question.
