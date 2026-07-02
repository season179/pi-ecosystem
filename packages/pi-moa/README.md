# @season179/pi-moa

Adds a synthetic `moa` provider to Pi for Mixture of Agents orchestration.

The package is named `pi-moa` to match the pi-ecosystem package naming convention. The runtime provider remains `moa`, so models are selected with `moa/<preset>`.

## Usage

```bash
pi install ./packages/pi-moa
pi --model moa/default
```

## Configuration

**A `moa.json` is required — there is no built-in default config.** Which models
advise and aggregate is always an explicit decision, never something the package
picks for you. MoA reads the first file found:

1. `<cwd>/.pi/moa.json`
2. `~/.pi/agent/moa.json` or `$PI_CODING_AGENT_DIR/moa.json`

If neither exists — or the file is invalid — the extension fails to load with an
error naming the searched paths (or the offending file and field), and pi treats
that as a fatal startup diagnostic: it prints the error and exits instead of
running without the models you chose.

Minimal config:

```json
{
  "defaultPreset": "default",
  "presets": {
    "default": {
      "enabled": true,
      "referenceModels": [
        { "provider": "openrouter", "model": "anthropic/claude-haiku-4.5" }
      ],
      "aggregator": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" }
    }
  }
}
```

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
  ever lowers a caller-supplied limit; presets that omit it run uncapped. A value
  like `1024` (well above the ~500 tokens kept by the default char budget) leaves the
  kept text unchanged while runaway references stop early even before the char budget.
  The cap **stands down when a reasoning effort is in play** for the reference
  (inherited from the caller or set via `referenceReasoning`): on completions-style
  APIs thinking tokens share the `max_tokens` budget (OpenRouter derives the Anthropic
  thinking budget as a fraction of `max_tokens`, with a provider-side minimum), so a
  small cap on a thinking reference could get the request rejected or let thinking
  starve the kept advice. A thinking reference is still bounded by the stream-level
  abort above and, optionally, `referenceTimeoutMs`.

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

- `referenceToolResultMaxChars` is the finer-grained companion to `referenceMaxContextChars`.
  In an agentic transcript the bulkiest, least-advice-relevant content is usually the **tool
  results** (file dumps, command output), and those drive the reference's prefill. This knob
  bounds the leading portion of **each tool result the references see** (a short tail is always
  also kept so the advisor still sees the outcome). Unlike `referenceMaxContextChars`, which
  elides whole middle *turns* (losing the sequence of actions), it keeps **every turn** and
  just compresses each verbose result — which is exactly what an advisor needs (see *what* was
  done, not every byte of output). As with the other reference-input levers the **aggregator
  always receives the full, untrimmed tool results**, so this only shrinks the advisory view.
  It is **unset by default** (references see the default per-result budget, exactly as before),
  and composes with `referenceMaxContextChars` (shrinking each result first leaves fewer whole
  turns to elide). Set it on tool-heavy transcripts where reference prefill dominates.

- `referenceToolResultTailChars` is the **tail** companion to `referenceToolResultMaxChars`.
  Each tool result the references see always keeps a trailing slice (its **outcome** — the exit
  status, the final lines of output) even when its head is capped, so `referenceToolResultMaxChars`
  bounds the *head* while a fixed tail (500 chars) is retained regardless. On a long agentic
  transcript with many tool results, that always-kept tail (500 chars × every result) can itself
  dominate reference prefill — a cost the head cap alone can't reach. This knob bounds the tail
  kept per result, so the two together give full control over per-tool-result reference input.
  It is **unset by default** (the default 500-char tail, exactly as before); its minimum is 1
  (a tail of 0 would defeat the truncation). As with every reference-input lever, the **aggregator
  always receives the full, untrimmed tool results**, so this only shrinks the advisory view.

Every knob above bounds the reference's *generation* (length, cost, time, thinking, input).
One critical-path cost sits *below* generation, in the network layer: when a reference's
request hits a transient error (a 429 rate limit or a 5xx), the underlying SDK retries it
with exponential backoff — two attempts by default — and each retry, plus any server-requested
`Retry-After` wait, blocks the aggregator (which cannot start until the slowest, or quorum-th,
reference settles). `referenceMaxRetries` bounds that backoff:

- `referenceMaxRetries` caps the client-side retry attempts for **reference requests only**
  (`0` disables retries entirely). Because references are advisory and failure-tolerant — a
  failed one simply drops out of the guidance rather than failing the turn, unless
  `failOnReferenceError` is set — a low cap lets a transient-error reference give up fast and
  let the phase move on with whatever succeeded, instead of silently spending seconds on
  backoff on the critical path. It is deliberately **reference-only**: the aggregator produces
  the final answer, so failing it faster on a transient error would be a robustness regression,
  not a speed win. It is **unset by default** (references keep the SDK/caller retry behavior,
  exactly as before), and is forwarded to providers that support client-side retries (the
  default `openrouter` fleet) and ignored by those that don't. Set it (e.g. `0` or `1`) to
  trade a little reference resilience for a bounded worst-case turn.

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

  Because whether a trailing user turn is accepted is a **stable property of the serving API**
  (not a transient failure), the first such rejection for a given aggregator model
  (keyed `provider/model`, since a gateway fronts many upstream APIs with different
  alternation rules) is remembered for the rest of the process: subsequent turns skip the
  doomed trailing attempt and go straight to the system-prompt placement. This bounds the
  worst case of `trailing-message` on a strict model to **one wasted request per process**
  instead of one on every tool-loop turn. Models that accept the trailing turn are never
  recorded, so their behavior is unchanged, and the default `latest-user` placement never
  attempts a trailing turn at all.

`aggregatorGuidancePlacement` keeps the prefix **byte-stable** so the cache *can* be reused;
`aggregatorCacheRetention` controls how **long** that cache lives:

- `aggregatorCacheRetention: "long"` asks the aggregator's provider to keep its prompt cache
  alive for its long-retention window (Anthropic-style `cache_control.ttl: "1h"`, OpenAI
  `prompt_cache_retention`) instead of the provider default `"short"` (~5 min on Anthropic).
  Prompt caching only avoids the aggregator's per-turn re-prefill *while the cache lives*: when
  a long-running tool or a review pause between turns exceeds the short TTL, the cache expires
  and the next turn re-prefills the **whole transcript**. `"long"` survives those gaps so the
  next turn stays a cache hit — dropping its time-to-first-token. Accepts `"none" | "short" |
  "long"`. It is applied **only to the aggregator**. It is set **after** the caller's
  options, so a preset governs the aggregator's retention regardless of the caller. It is a
  pure cache-TTL hint — the generated answer is **byte-identical** either way — and **unset by
  default** (the aggregator inherits the caller/provider retention exactly as before). The
  trade-off that keeps it opt-in: long-retention cache writes cost more per token (on Anthropic
  a 1h write is ~2× base input vs ~1.25× for 5 min), so it only pays off when turn gaps
  routinely exceed the short TTL. Providers that don't support long retention ignore it (safe
  no-op).

- `referenceCacheRetention` is the reference-side mirror of `aggregatorCacheRetention`. A
  reference is one provider call *per MoA turn*, but MoA is re-invoked on every turn of an
  agentic tool loop, and each turn re-runs the references over the **same transcript grown
  append-only** (prior MoA guidance is stripped back out, so a reference's rendered view stays
  a byte-stable growing prefix). So — like the aggregator — a reference re-prefills that shared
  prefix every turn, and prompt caching avoids it only while the cache lives; the provider
  default `"short"` expires across a long tool run or review pause, forcing a cold reference
  re-prefill on the aggregator-blocking critical path. `"long"` keeps the next turn's reference
  a cache hit (lower reference TTFT → shorter reference phase). It is applied **only to the
  references** and set **after** the caller's options, so a preset governs reference retention
  independent of the caller *and* of `aggregatorCacheRetention` — completing the role-scoped
  retention matrix. Also a pure cache-TTL hint (**byte-identical** advice, hence answer) and
  **unset by default**. Kept opt-in because references are smaller/cheaper prefillers than the
  aggregator, so the pricier long-cache *write* only pays off when reference turn gaps
  routinely exceed the short TTL; a non-caching reference provider ignores it (safe no-op).

### Capping the aggregator's reasoning effort

Placement and retention tune the aggregator's *prefill*. Its *generation* — the answer
tokens, and for a reasoning model the thinking that precedes them — is the dominant
per-turn latency cost. The aggregator inherits the caller's `reasoning` level by default,
and there is otherwise no way to lower it without also lowering the references' inherited
default. `aggregatorReasoning` decouples them (the aggregator-side mirror of
`referenceReasoning`):

- `aggregatorReasoning` pins the thinking effort (`minimal`, `low`, `medium`, `high`, or
  `xhigh`) used for the aggregator request only, independent of what the caller passed.
  Point it lower (e.g. `medium`) so a preset can run a fast aggregator on top of the
  references' guidance without forcing the caller to lower reasoning globally (which would
  also hit the references). It is applied **after** the caller's options, so the preset
  governs the aggregator's reasoning regardless of the caller, and touches **only the
  aggregator** — references keep their own (caller- or `referenceReasoning`-set) effort.
  It is **unset by default** (the aggregator inherits the caller's reasoning exactly as
  before), and a non-reasoning aggregator clamps it away to a provider-side no-op. Because
  reasoning shapes the *final answer*, this trades answer quality for latency directly — a
  sharper trade-off than the reference knobs — so it stays opt-in.

### Steering OpenRouter provider routing (which upstream backend serves the request)

The reasoning/retention/placement knobs tune *how* a request runs; these tune *which
upstream backend* serves it. OpenRouter fronts several providers per model and, by default,
balances routing (weighted by price/uptime) — which can land a request on a slow backend.
Symmetric knobs steer that selection, one per role:

- `aggregatorProviderRouting` pins the **aggregator's** request — its generation is the
  dominant, **un-bounded** per-turn cost (references are already bounded by
  quorum/timeout/output caps), so routing it to a faster backend is a direct latency lever.
- `referenceProviderRouting` pins **every reference's** request — references sit on the
  aggregator-blocking critical path (the aggregator waits for the slowest, or the quorum-th
  fastest, reference), so routing them for lowest time-to-first-token / highest throughput
  directly shortens that phase.

Both pass an OpenRouter [provider-routing](https://openrouter.ai/docs/guides/routing/provider-selection)
object through to the request. The speed-relevant fields are `sort: "throughput"` (route to
the highest tokens/sec provider), `sort: "latency"` (lowest time-to-first-token), and
`preferred_min_throughput` / `preferred_max_latency` (explicit floors/ceilings). Applied by
pi-ai **only for models whose baseUrl is `openrouter.ai`**, so each knob is a safe **no-op
for non-OpenRouter models**. Example: `"referenceProviderRouting": { "sort": "latency" }`.

Each knob is **role-scoped** (the aggregator knob never touches references and vice versa).
Both are **unset by default** and, unlike the pure cache/TTL hints, are **not** shipped in
the `default` preset: a different backend can differ in quantization or behavior and so
could subtly shift the aggregator's answer (directly, or — for the reference knob — via the
reference advice it feeds into the aggregator), so they stay opt-in (constrain with
OpenRouter's `quantizations` / `only` / `ignore` if that matters).

### Pre-warming the aggregator's prompt cache (overlapping prefill with the reference phase)

Placement and retention decide whether the aggregator's prompt cache *can* be reused; this
knob attacks *when* the aggregator prefills at all. The aggregator needs the reference
guidance to build its request, so its prefill currently runs **entirely after** the reference
phase — un-overlapped, sitting on the head of its generation. On a cold cache (the first turn
of a session, or after the cache TTL expires) that prefill is pure added latency.

- `aggregatorPrewarm: true` fires a throwaway request to the aggregator over the
  **guidance-free transcript prefix** — byte-identical to the prefix the real request will
  share (system prompt + tools + prior turns; only the appended reference guidance differs) —
  the moment the turn starts, so it runs **concurrently with the reference phase**. The
  provider prefills and writes its prompt cache while the references are still streaming; when
  the real aggregator request fires after the references settle, it reads that warm cache
  instead of prefilling from cold, cutting its time-to-first-token. This is the one lever that
  **hides** aggregator prefill under the reference phase rather than shrinking either phase.

  The warm-up is deliberately cheap and side-effect-free: its `onPayload`/`onResponse` hooks
  are dropped, its reasoning is pinned to `minimal` (so a reasoning aggregator doesn't burn a
  thinking budget on the ping — the cached prefix is keyed by message content, not generation
  params), it carries the preset's `aggregatorCacheRetention` (so the warm cache write asks
  for the same TTL the real request will), and its request is **aborted at the provider's
  first content event** — not at the stream's `start`, which fires when the HTTP headers
  arrive and may precede the prefill — since the first token proves the prompt has been fully
  processed and the cache written, so it pays for the prefill but generates essentially
  nothing. Any failure is swallowed — the warm-up can never affect the real turn. The real
  request gives the warm-up a **short bounded grace** (250ms) to settle before reading: when
  the reference phase dominated the wall-clock the warm-up finished long ago and the grace
  costs ~0ms, but a warm-up still mid-prefill (fast references, huge transcript, stalled
  provider) is a full aggregator prefill that would otherwise hold the turn hostage — after
  the grace the real request proceeds cold and the straggling warm-up is cancelled.

  It is **unset by default** — no warming request fires, so the turn is byte-identical to
  before the knob existed. Kept opt-in because the warm-up costs an extra prefill (a
  prompt-cache write) and only pays off on **caching** providers (the default
  `openrouter/anthropic/*` aggregator is one). It composes best with
  `aggregatorGuidancePlacement: "trailing-message"` and `aggregatorCacheRetention: "long"`,
  which keep the shared prefix byte-stable and the warm cache alive; with the default
  `latest-user` placement in a tool loop the guidance mutates an early message, so the warmed
  prefix still covers the (large, fixed) system prompt but not the whole transcript.

### Reference cadence (skipping the reference phase on tool-loop turns)

Every knob above shrinks or overlaps the reference phase; this one asks whether it needs to
run at all. In an agentic tool loop MoA re-runs the whole reference phase on **every model
turn**, but new strategic input mostly arrives at user-turn boundaries — the tool-loop turns
in between re-derive near-identical advice at full reference latency.

- `referenceCadence: "user-turn"` runs the references only when the transcript ends on a
  **fresh user message**. Tool-loop turns (transcript ends on an assistant/tool message) reuse
  the guidance computed for the *same* user turn, taking the entire reference phase off those
  turns' critical path — the aggregator starts immediately with the cached advice. The cache
  is per-preset and anchored to the identity of the latest user message, so a new user message
  (or a different conversation on the same preset) always recomputes. The default
  (`"every-turn"` / unset) re-runs references on every turn exactly as before.

  This is a **semantic trade**, which is why it is opt-in: mid-loop tool results never update
  the advice, so guidance can go stale during a long tool run. It fits workflows where
  references provide strategic direction (set when the user asks for something) rather than
  step-by-step tactical review.

### Per-turn timing telemetry

Whether any of these knobs is worth its trade-off is an empirical question — the answer needs
timings, not intuition. Setting the **top-level** config field `telemetryPath` (e.g.
`"~/.pi/agent/moa-timings.jsonl"`) appends one JSON line per MoA turn recording where the
wall-clock went:

- auth resolution, reference-context render, and total turn time;
- per reference: request start, response headers, first token, settle time, stop cause
  (`stop` / `length` / `error` / `aborted` — `aborted` marks our own cancellation, e.g.
  a reference superseded by a reached `referenceQuorum`, so `error` always means a
  genuine upstream failure), kept chars, and token usage + cost;
- the pre-warm's start/settle times and how long the real request actually blocked on it;
- the aggregator: request start, headers, first token, done, guidance placement used,
  whether the trailing-placement fallback fired, and usage + cost;
- whether the turn reused cached guidance (`referenceCadence`).

The records are **metadata only** — no prompt or completion text is ever written — and
emission is fire-and-forget (a write failure never affects the turn). Unset by default: no
timers run and nothing is written.

The file is **self-trimming**, so leaving telemetry on permanently never grows it without
bound: once it reaches `telemetryMaxBytes` (top-level field, default 16 MB — roughly
10–15k turn records), the oldest lines are dropped in place, keeping the newest records
that fit in half the cap. It is always a single file — no `.1` rotation siblings — and the
trim rewrites through a `.tmp` + atomic rename, so a crash mid-trim never corrupts it.
Steady-state size stays between half the cap and the cap. Set `telemetryMaxBytes: 0` to
disable trimming and grow the file indefinitely. Analyze with `jq`, DuckDB, or anything that reads JSONL;
the interesting first questions are *slowest reference vs aggregator generation* (which phase
dominates), *reference `firstTokenMs` vs `settleMs`* (prefill-bound or generation-bound), and
*aggregator `headersMs`→`firstTokenMs` across turns* (whether placement/retention/pre-warm
actually produce cache hits).

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
  final message. Streaming is **display-only** — the *final* persisted message (and thus next-turn
  model context) is the same either way, so it is a zero-regression speedup. The *type-level*
  default is unset (buffered), so a preset that omits the knob is unaffected — set it in your
  presets for a streamed turn. (One display nuance: if the
  aggregator errors mid-generation you'll see the partial answer before the error — standard
  streaming behavior — instead of only the error.)

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
  is still built atomically, so what re-enters model context is unchanged. The *type-level*
  default is unset (single burst), so a preset that omits the knob is unaffected — enable it
  alongside `streamAggregator` for a fully-streamed turn. It composes with `streamAggregator` (reference thinking streams at content index 0,
  the answer at index 1+). It is scoped to the common case — it falls back to the single burst (no
  live reveal) when `referenceQuorum` is set (dropped references would leave gaps in the
  slot-ordered reveal) or a reference model can't be found (a missing slot shifts the output
  order); those paths stay byte-identical.
