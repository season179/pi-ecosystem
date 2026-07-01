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
