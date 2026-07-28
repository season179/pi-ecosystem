# Brief: ui worker (wake card, list rendering, /watches command)

Read `briefs/COMMON.md` first (and HERDR.md §5 for the card shape). You
own EXACTLY these files under `packages/pi-herdr/`:

- `src/render.ts`
- `src/commands.ts`
- `test/render.test.ts`

`src/types.ts` already exists with the exact COMMON.md contract; import
from `../src/types.js` (in src files: `./types.js`).

## src/render.ts

Pure functions, no pi imports, no side effects. Design for a terminal:
short lines (~72 chars), no ANSI colors (pi themes the message box).

- `formatWatchCard(record, outcome, tail?)`:
  ```
  watch #2 "reviewer" fired: agent settled after 3m41s
  note: reviewing auth diff, expect questions about session.ts
  last lines:
    <tail, indented two spaces, at most ~20 lines>
  ```
  Adapt line 1 by outcome.kind:
  - fired + agent mode: `watch #N "<target>" fired: agent settled (<state>) after <dur>` —
    pull `<state>` from outcome.json when present
    (`result.agent.agent_status` shape; fall back to omitting it).
  - fired + output mode: `watch #N "<target>" fired: output matched after <dur>`
    and include the matched text from outcome.json (`result.text` or
    similar — inspect defensively, fall back to raw stdout tail).
  - timeout: `watch #N "<target>" timed out after <dur>`
  - error: `watch #N "<target>" failed (exit <code>) after <dur>` + first
    2 lines of stderr, indented.
  - killed: `watch #N "<target>" stopped after <dur>`
  Omit the note line when absent; omit "last lines" when no tail.
  Durations: `41s`, `3m41s`, `1h02m`.
- `formatWatchLine(record, nowMs)`:
  `#2 armed  agent reviewer (until idle|done|blocked)  3m41s  — note`
  status-first columns, condition summary, elapsed from startedAt to
  nowMs for armed / "-" otherwise, note truncated to 40 chars.
- `formatStatusChip(armedCount)`: `undefined` when 0, `"herdr: 1 watch"`,
  `"herdr: 3 watches"`.

Export a small internal helper `formatDuration(ms): string` too (used by
both, tested directly).

## src/commands.ts

Per contract: `registerWatchesCommand(pi, deps)`.

`pi.registerCommand("watches", { description: "List and manage herdr
watches", handler })`. Handler behavior:
- No UI (`!ctx.hasUI`): nothing to select — just notify via return/print
  path available to command handlers (consult
  `docs/extensions.md` registerCommand section and mirror what
  `packages/pi-buddy/src/extensions/buddy.ts` does around line 500).
- Empty list → `ctx.ui.notify("no herdr watches", "info")`.
- Otherwise `ctx.ui.select` over `formatWatchLine` rows plus a final
  "stop ALL armed watches" row and a "close" row. Selecting an armed
  watch → confirm → `deps.stop(id)` → notify stopped. Selecting
  fired/stopped rows → just notify the line (history peek).

Keep it defensive: deps.stop may reject — catch and notify the error.

## test/render.test.ts

- formatDuration: 41s / 3m41s / 1h02m boundaries
- card: fired agent-mode with state+note+tail (snapshot the exact string)
- card: output-mode fired without note/tail
- card: timeout, error (stderr excerpt), killed variants
- formatWatchLine armed vs fired elapsed column; note truncation
- formatStatusChip 0/1/3

No test for commands.ts (UI plumbing — exercised in live smoke), but it
MUST compile.

## Done

Per COMMON.md: your files compile (`npx tsc --noEmit` scope note allowed
if teammate files are mid-flight) and render tests green. Report files +
deviations, under 30 lines.
