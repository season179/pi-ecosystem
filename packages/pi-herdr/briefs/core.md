# Brief: core worker

Read `briefs/COMMON.md` first. You own EXACTLY these files under
`packages/pi-herdr/`:

- `src/herdr-cli.ts`
- `src/watches.ts`
- `test/herdr-cli.test.ts`
- `test/watches.test.ts`
- `test/fixtures/fake-herdr.mjs`

`src/types.ts` is being written concurrently by another worker with the
exact contract in COMMON.md — import from `../src/types.js` and code
against the contract even if the file doesn't exist yet. If it's absent
when you need to typecheck, wait/retry once, then note it.

## src/herdr-cli.ts

Per contract. Details:

- `spawn(herdrCommand(), args, { shell: false, stdio: ["ignore","pipe","pipe"] })`.
- Collect stdout/stderr; cap each at 1 MiB keeping the TAIL.
- `json`/`errorJson`: `JSON.parse` of the full captured text; if that
  fails, try the LAST non-empty line (herdr CLI prints one JSON object,
  but a shell wrapper may prepend noise); else leave undefined.
- timeoutMs default 30000. On timeout: SIGKILL the child, resolve with
  captured output and `exitCode` from the close event (or null).
- `signal` (AbortSignal): on abort, kill the child; resolve, don't reject.
- Spawn errors (ENOENT etc.): resolve with exitCode null and the error
  message in stderr — never reject.

## src/watches.ts

Per contract. Details:

- `buildWatchArgs` (pure):
  - agent mode: `["agent","wait",target]` + for each `until` value
    `["--until",u]` + `["--timeout",String(timeoutMs)]` when set.
  - output mode: `["pane","wait-output",target]` + `["--regex",regex]`
    if regex set else `["--match",match]` + timeout as above.
  - Validation errors (output mode without match/regex, both set,
    agent-mode with match/regex) → throw plain Error with clear message.
- `start(spec)`: capacity check counts only status "armed" records
  (records with status "fired"/"stopped" stay in the list for `list()`
  history but don't count). Spawn the waiter child with
  `{ detached: true, shell: false, stdio: ["ignore","pipe","pipe"] }`.
  Watch ids increment from 1.
- Child close (natural): set status "fired" unless a stop marked it
  "stopped"; classify outcome:
  - killed by stop()/shutdown() → kind "killed"
  - exit 0 → "fired"
  - nonzero + (errorJson or stderr) mentioning timeout (case-insensitive
    substring "timeout" or "timed out") → "timeout"
  - anything else → "error"
  Then call `onOutcome(record, outcome)` exactly once per watch.
  onOutcome callbacks must be wrapped in try/catch (a throwing callback
  must not break the manager).
- `stop(id|"all")`: for each armed target: `process.kill(-child.pid, "SIGTERM")`
  (fall back to `child.kill("SIGTERM")` if the group kill throws), then a
  5s timer; if the child's close event has NOT fired when it expires,
  `process.kill(-pid, "SIGKILL")` (same fallback). The "has closed" check
  MUST key on a boolean set by the close event — never on `child.killed`
  (that only records that a signal was sent). Clear the timer on close.
  Resolve after all targeted children have closed. Stopping an already
  fired/stopped id is a no-op.
- `shutdown()`: `stop("all")`, idempotent, safe to call twice.
- Keep per-watch state internal; expose only WatchRecordPublic copies
  (callers must not be able to mutate internal state).

## test/fixtures/fake-herdr.mjs

A node script standing in for the herdr CLI, controlled by env:

- `FAKE_HERDR_BEHAVIOR=ok` (default): print
  `{"id":"x","result":{"type":"agent_info","echo":<argv as JSON>}}` to
  stdout, exit 0. Optional `FAKE_HERDR_DELAY_MS` sleep first.
- `timeout-error`: print `{"error":{"code":"wait_timeout"}}` to stderr,
  exit 1.
- `stall`: install a SIGTERM handler that ignores the signal, print
  nothing, and sleep forever (so only SIGKILL ends it).
- `bad-exit`: print garbage (non-JSON) to stderr, exit 3.

## Tests

test/herdr-cli.test.ts (point PI_HERDR_COMMAND at
`node test/fixtures/fake-herdr.mjs` — you may need
`process.execPath` + args; if runHerdr only takes a command string,
make a tiny executable shim script in the fixtures dir, chmod +x):
- ok behavior → exitCode 0, json parsed, args echoed
- bad-exit → exitCode 3, json undefined, stderr captured
- timeoutMs expiry on a stalling child → resolves, child killed
- ENOENT command → resolves with exitCode null, stderr has message

test/watches.test.ts:
- buildWatchArgs matrix: agent+until+timeout; output+match; output+regex;
  validation errors
- natural completion (ok behavior) → onOutcome once, kind "fired",
  record status "fired", json present
- timeout-error behavior → kind "timeout"
- bad-exit → kind "error"
- stall behavior + stop() → SIGKILL escalation actually ends the child;
  onOutcome kind "killed"; status "stopped"; test completes well within
  vitest timeout (use a shorter escalation delay if you make it
  configurable via an options field `killGraceMs` — allowed, default 5000)
- CapacityError at maxWatches; fired watches free capacity
- list() ordering; returned records are copies (mutating them doesn't
  affect the manager)
- shutdown() twice is safe

## Done

Per COMMON.md. Note explicitly in your final message: the exact
mechanism you used to launch the fixture as PI_HERDR_COMMAND.
