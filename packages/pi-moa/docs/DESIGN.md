# pi-moa design notes

Status: **RETIRED 2026-07-28 — superseded by `@season179/pi-buddy`**
(Season's verdict). Reference-only, same standing as the repo-root
`docs/TROIKA.md` and `docs/DELEGATE.md` tombstones.

Durable decisions and rationale that are not recoverable from the code or the
README. Consolidated from the original implementation plan (2026-06-30) and the
agentic-references design note (`feat/moa-smart`, merged as `461fe2f`). Where
the plan and the shipped code disagree, the code wins and the reversal is
recorded here.

## Architecture: a synthetic provider extension

MoA is a pi provider extension. It registers a synthetic `moa` provider; each
enabled preset becomes a synthetic model (`moa/<preset>`), and the provider's
`streamSimple` performs all orchestration: fan out privately to the reference
models, collect advisory responses, inject them as private guidance into the
aggregator's context, and stream the aggregator as the acting model with normal
tool behavior preserved.

Why a provider extension: `pi.registerProvider()` already supports custom
providers; a custom provider's `streamSimple` receives the full `Context`
(messages and tools); extensions can reach `ctx.modelRegistry`, whose
`getApiKeyAndHeaders` is the correct auth resolver; and pi's gitlab-duo example
extension is precedent for a synthetic provider delegating to lower-level
model/provider APIs.

Rejected alternatives:

- **A tool.** Inverts the design: references become something the acting model
  asks for instead of private advisors to it. Reference outputs would enter the
  visible tool loop, and it increases recursion and tool-access risk.
- **A `before_provider_request` hook.** Hooks can augment a payload, but they
  are the wrong abstraction for fanning out to multiple models, cleanly
  replacing/proxying the stream, or stripping tools from references while
  preserving tools for the aggregator.
- **A core pi feature first.** Extension-first is lower risk and matches the
  existing architecture; add a core helper only after the extension proves
  where the current extension API is insufficient.

## References are advisors, not acting agents

The reference request replaces the original system prompt entirely with a
reference-advisor prompt. References are advisors, not acting agents: the
original agent/tool instructions can confuse them, and they must not inherit
instructions to use tools or behave as the main assistant. The original system
prompt is never passed through or quoted as authoritative; if domain
orientation is needed, the reference prompt describes the transcript neutrally.

The plan's corollary — "do not let reference models call tools" — was later
reversed: `referenceTools`/`referenceToolRounds` give references an opt-in,
bounded, read-only private investigation loop (see below). The default
no-tools path is unchanged.

## Stale guidance stripping

Prior synthetic MoA guidance is stripped from the transcript at the start of
every MoA turn, before either the reference context or the aggregator context
is built. Rationale: old reference advice must not accumulate across turns,
stale private context must not influence later turns, and phantom guidance
messages must not build up in the stored transcript.

## Guidance placement and the consecutive-user fallback

The plan pinned "insert the guidance as a new synthetic user message after the
latest user message, never append to the user's message". That was reversed in
code: the default `aggregatorGuidancePlacement` is `latest-user`, which appends
the guidance into the latest user message; the separate-turn shape survives as
the opt-in `trailing-message` placement (the README covers the prompt-cache
trade-off between them).

The separate-turn shape can produce consecutive `user` messages, and some
provider APIs enforce strict role alternation and reject that sequence. This
risk was identified up front, and provider compatibility was to be proven
rather than assumed — with a fallback required so the core behavior survives a
rejection. The fallback shipped: a rejection is detected on the aggregator's
first error event (`isConsecutiveUserRejection`), the guidance is folded into
the system prompt instead (`injectGuidanceAsSystem`), and the rejection is
remembered per aggregator model for the rest of the process so later turns skip
the doomed trailing attempt. (The plan's originally proposed fallback — append
to the latest user message — became the default placement instead.)

## Other plan decisions reversed in code

- Config loading: "project config only, with a built-in default when no file
  exists" became: `moa.json` is compulsory — project `.pi/moa.json`, then
  global `~/.pi/agent/moa.json` (or `$PI_CODING_AGENT_DIR/moa.json`), and a
  hard error when neither exists, so model choice is always explicit.
- Reference dispatch: `completeSimple` per reference became `streamSimple`
  with stream-and-abort at the output char budget, so a verbose reference's
  discarded tail is never generated.

## Known uncertainty: cross-extension provider composition

MoA calling built-in/API-backed providers is supported. MoA calling a model
served by another extension-defined synthetic provider is not guaranteed — it
may depend on compat API registry load order. When a referenced model's API is
not registered, fail clearly.

## Still-relevant risks

| Risk | Position |
| --- | --- |
| Reference usage invisible to session accounting | Aggregator usage is visible (its stream is the main stream); reference usage/cost is recorded only in opt-in telemetry |
| References hallucinate bad advice | Advisor-only prompt; the aggregator remains the acting model and owns the answer |
| Auth leakage through error text | Redact credential-like content before embedding reference errors in guidance; never log keys |
| Config drift from available models | Model slots are resolved against the registry at call time, not at load time |

## Agentic references (feat/moa-smart)

`referenceTools` gives each reference a bounded private read-only investigation
loop before its final advice: while the model stops with `toolUse` and rounds
remain, tools execute privately and the loop continues on the reference's own
append-only context; at the round cap the last tool results are appended and
exactly one final request is made with tools withheld.

### Why not pi-agent-core's agentLoop

The loop is a small in-package loop around pi-ai `streamSimple()` and
`Context.tools`, reusing pi-coding-agent's read-only tool factories (root
exports only — the package's `exports` map forbids deep imports) through a thin
adapter. `agentLoop` from `@earendil-works/pi-agent-core` already handles tool
continuation, argument validation, and abort plumbing, but four costs ruled it
out here:

1. pi-moa does not peer `pi-agent-core` (it peers only `pi-ai`,
   `pi-coding-agent`, and `pi-tui`); adopting it adds a new peer dependency.
2. `agentLoop` works in `AgentMessage` space and emits `AgentEvent`s, not the
   pi-ai assistant event streams the orchestrator already consumes.
3. It streams responses internally and appends assistant/tool-result messages
   to its own context, so an adapter would still be needed to recover per-round
   assistant messages, final advice text, usage, tool-call counts, and stop
   causes.
4. The orchestrator has reference-specific lifecycle behavior `agentLoop`
   knows nothing about: quorum resolution, output char budgets,
   `referenceMaxTokens`, reference-only cache retention, provider routing, and
   metadata-only telemetry.

### v1 security boundary

There is deliberately no cwd jail. References get the same read scope as the
main agent's read-only tools; read-only access is the security boundary, not
path confinement.

### Loop contracts

- `referenceMaxTokens` is a per-round cap, never a loop-total budget; the
  loop-total bound is the round cap plus `referenceTimeoutMs`.
- `maxReferenceOutputChars` budgets only the final advice-producing stream;
  tool-round preambles and commentary must never consume the advice budget.
- `ReferenceOutput.text` must remain exactly the final advice text, so the
  progressive (`streamReferences`) accumulated text stays byte-identical to the
  atomic block.
