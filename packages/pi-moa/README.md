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
