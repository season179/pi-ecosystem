# @season179/pi-moa

Adds a synthetic `moa` provider to Pi for Mixture of Agents orchestration.

The package is named `pi-moa` to match the pi-ecosystem package naming convention. The runtime provider remains `moa`, so models are selected with `moa/<preset>`.

## Usage

```bash
pi install ./packages/pi-moa
pi --model moa/default
```

## Configuration

MoA reads config from the first file found:

1. `<cwd>/.pi/moa.json`
2. `~/.pi/agent/moa.json` or `$PI_CODING_AGENT_DIR/moa.json`
3. built-in defaults

Each enabled preset appears as a synthetic model, for example `moa/default`.

### Tuning reference latency

Reference outputs are truncated to `maxReferenceOutputChars` before they reach the
aggregator or the display, so any generation past that budget is discarded. The
aggregator cannot start until the slowest reference finishes, so two mechanisms keep
verbose references off the critical path:

- Each reference is streamed and its request is **aborted the moment it has produced
  `maxReferenceOutputChars` of text** — the discarded tail is never generated. The
  kept advisory text is byte-identical to reading the full response and truncating;
  only the truncation marker's reported char total reflects the early stop.
- `referenceMaxTokens` caps each reference's generation as an upper bound. It only
  ever lowers a caller-supplied limit; presets that omit it run uncapped. The built-in
  `default` preset sets it to `1024` (well above the ~500 tokens kept), so the kept
  text is unchanged while runaway references stop early even before the char budget.

Both mechanisms above bound reference *length/cost*, not *time*. A separate, opt-in
`referenceTimeoutMs` bounds each reference's *wall-clock* time so a stalled or slow
provider cannot hold the turn hostage:

- `referenceTimeoutMs` sets a per-reference deadline in milliseconds. At the deadline
  the reference's request is aborted and the advice it has produced so far is handed to
  the aggregator (as a truncated reference); if it produced no text yet, it fails
  gracefully like any other reference error (or fails the turn when
  `failOnReferenceError` is set). It is **unset by default** — presets that omit it wait
  for every reference to finish, exactly as before. Set it when you would rather trade a
  slow reference's tail for a faster, bounded turn.

`referenceTimeoutMs` needs a good absolute deadline picked ahead of time. When you run
several references, a relative bound is often better: proceed as soon as *enough* of them
have answered, no matter how fast the batch is overall. That is `referenceQuorum`:

- `referenceQuorum` is the number of references whose advice is enough to start the
  aggregator. The moment that many references **succeed**, the phase resolves immediately
  and the still-running (slower) references are dropped — the ones that can be aborted are,
  capping their cost; a reference that stalls before it streams is simply abandoned rather
  than awaited. This bounds the reference phase to the *N-th fastest* reference instead of
  the slowest, with no deadline to guess. Dropped references are omitted (not shown as
  failures). It is **unset by default** (every reference is awaited, exactly as before),
  must be ≤ the number of `referenceModels`, and composes with `referenceTimeoutMs`. Set it
  when you configure several references but only need the fastest few to move on.

A reasoning reference model can also spend most of its wall-clock *thinking* before it
emits any advice text. That thinking never reaches the aggregator or the display (only
the reference's text is kept), and the stream-and-abort above counts text — not thinking
— so it cannot shorten it. A separate, opt-in `referenceReasoning` bounds that thinking:

- `referenceReasoning` sets the thinking effort (`minimal`, `low`, `medium`, `high`, or
  `xhigh`) used for reference requests only, decoupling it from the reasoning level the
  aggregator/caller uses. Point it low (e.g. `minimal`) so a heavy-thinking reference —
  such as a "flash" model that reasons by default — stops holding up the aggregator with
  reasoning that gets discarded anyway. It is **unset by default** (references inherit the
  caller's reasoning, exactly as before); a non-reasoning reference model clamps it away
  to a no-op. Because thinking still improves the reference's kept advice, this trades a
  little advice quality for latency, so it stays opt-in.

The knobs above all bound reference *output* (length, cost, time, thinking). The
remaining critical-path cost is reference *input*: on a large, uncached transcript the
reference must ingest the whole history before it emits its first token, and that prefill
sits on the aggregator-blocking path. `referenceMaxContextChars` bounds it:

- `referenceMaxContextChars` caps the size of the transcript **the references see** (in
  characters of rendered text). When the history exceeds it, the middle turns are elided:
  the references keep the most recent turns plus the first user turn (usually the task),
  with a note that earlier turns were dropped. The **aggregator always receives the full,
  untrimmed context** and does the actual work, so this only trims the references' advisory
  view — never the final answer's context. It is **unset by default** (references see the
  whole transcript, exactly as before). Set it when reference latency on long transcripts
  matters more than giving the advisors full history.

### Aggregator prompt-cache reuse across tool loops

Every knob above tunes the reference phase. The aggregator itself has one large,
separate cost: on each turn of an agentic tool loop it re-prefills its context. Providers
that support prompt caching (e.g. Anthropic, and `openrouter/anthropic/*` — the default
aggregator) avoid this by reusing the longest **byte-stable prefix** of the previous turn's
request, so normally only the newly-appended tool result is re-prefilled.

By default the private reference guidance is appended to the **latest user message**. In a
tool loop the only user message is usually the original task at index 0 (later turns are
`assistant`/`toolResult` roles), so injecting the fresh-every-turn guidance there changes an
early message and **busts the aggregator's prompt cache for the entire transcript** — a full
re-prefill on every tool-loop iteration. `aggregatorGuidancePlacement` controls this:

- `aggregatorGuidancePlacement: "trailing-message"` appends the guidance as a **new trailing
  user turn** (when the transcript ends on an assistant/tool turn) instead of mutating the
  early task message. The whole prior transcript then stays a byte-stable prefix the
  aggregator's provider can reuse from its cache across turns, so only the small trailing
  guidance is re-prefilled. It is **unset by default** (`"latest-user"`, the original
  behavior). Recommended for OpenAI-compatible aggregators (including the default
  `openrouter/anthropic/*`), where a trailing user turn after tool results is a valid role
  sequence. On strict Anthropic-style alternation a trailing user turn after tool results can
  be rejected; the existing consecutive-user fallback then folds the guidance into the system
  prompt, so correctness is preserved regardless of provider.

  Because whether a provider accepts a trailing user turn is a **stable property of its API**
  (not a transient failure), the first such rejection for a given aggregator provider is
  remembered for the rest of the process: subsequent turns skip the doomed trailing attempt and
  go straight to the system-prompt placement. This bounds the worst case of `trailing-message`
  on a strict provider to **one wasted request per process** instead of one on every tool-loop
  turn. Providers that accept the trailing turn are never recorded, so their behavior is
  unchanged, and the default `latest-user` placement never attempts a trailing turn at all.

### Streaming the aggregator answer (time-to-first-token)

By default the aggregator's answer is delivered to the UI in a **single burst** once it has
finished generating: MoA consumes the aggregator's stream internally and only forwards the
final message. The reference outputs stream in first (as the leading thinking block), then
there is a pause for the whole aggregator generation, then the complete answer appears at
once. On a long answer this pause is the dominant *perceived* latency of the turn.

- `streamAggregator: true` forwards the aggregator's incremental content events as they are
  generated, so its answer streams into the UI token-by-token — time-to-first-token drops from
  the full generation time to the first token. Each forwarded event's content index is offset
  by one to sit after the reference-thinking block (index 0), and every streamed partial
  carries that block, so the live message shape matches the final one. Any complete private
  guidance the aggregator echoes is stripped from the streamed partials just as it is from the
  final message. It is **unset by default** (buffered), so the default behavior is byte-identical
  — the *final* persisted message is the same either way; only the live display differs. Enable
  it for a snappier feel with a streaming-capable UI.

### Streaming the reference thinking block (reference-phase feedback)

By default the reference outputs are shown as a **single burst** too: MoA runs the whole
reference phase, then emits the complete reference thinking block at once, then the aggregator
runs. While the references are being generated the turn shows nothing — and the reference phase
is the second-largest cost after the aggregator. `streamAggregator` only streams the *answer*; it
does not touch this earlier gap.

- `streamReferences: true` reveals the reference thinking block **as it fills in**: the header
  (which models, which aggregator) is emitted immediately — before any reference finishes — and
  each reference's advice is appended the moment that reference settles, so the phase gives
  continuous feedback instead of a silent wait. Sections are revealed in **slot order** (a
  reference that finishes ahead of an earlier slot is buffered until that slot reveals), so the
  streamed order matches the final block and the accumulated text is byte-identical to the
  buffered prelude. Like `streamAggregator`, it is **display-only**: the persisted `done` message
  is still built atomically, so what re-enters model context is unchanged. It is **unset by
  default** (single burst), so default behavior is byte-identical. It composes with
  `streamAggregator` (reference thinking streams at content index 0, the answer at index 1+).
  It is scoped to the common case — it falls back to the single burst (no live reveal) when
  `referenceQuorum` is set (dropped references would leave gaps in the slot-ordered reveal) or a
  reference model can't be found (a missing slot shifts the output order); those paths stay
  byte-identical.
