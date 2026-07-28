# Fix batch 1 (from review) — owner: builder

Four accepted review findings. All in YOUR files (`src/watches.ts`,
`src/extensions/herdr.ts`, `test/watches.test.ts`). Do not touch other
files.

## F1 (major) — shutdown latch in WatchManager

`start()` currently succeeds during/after `shutdown()`, so a racing
start leaves a detached waiter alive after teardown (violates HERDR.md
§4.5 "all killed in session_shutdown").

Fix in `src/watches.ts`:
- private `isShutdown = false`; `shutdown()` sets it (synchronously,
  before awaiting `stop("all")`).
- `start()` throws `Error("watch manager is shut down")` when set.
- `stop()` via herdr_unwatch must NOT latch — only `shutdown()`.

Regression test in `test/watches.test.ts`: after `await
manager.shutdown()`, `start(...)` throws; and shutdown remains
idempotent.

## F2 (major) — wake budget consumed before send succeeds

`src/extensions/herdr.ts` increments `wakesUsed` before
`pi.sendMessage`. If the send throws, budget is burned with no wake.
Move the increment to AFTER sendMessage returns (same decision object —
do not recompute).

## F3 (minor) — tail fetch can block delivery 30s

The tail `runHerdr(["agent","read",...])` call uses the default
30s timeout. Pass an explicit short timeout: `{ timeoutMs: 5000 }`.
(The generation check already handles shutdown races — no other change.)

## F5 (minor) — parse-failure fallback (HERDR.md §10.6)

On parse failure the card must deliver raw CLI output instead of
guessing. In the outcome handler: when `outcome.json === undefined` and
the watch was not stopped, use the last ~10 lines of
`outcome.stdout || outcome.stderr` as the card tail (reuse the existing
tail variable; fetched tail, when present, still wins).

## Done

Full `npm run build -w @season179/pi-herdr` + `npx vitest run
packages/pi-herdr` green. Report: per-fix one-liner (what changed,
file:line), new test names, verification output counts. Under 25 lines.
