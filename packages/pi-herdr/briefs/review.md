# Brief: review worker (fresh eyes, report only — do NOT edit files)

You are reviewing `packages/pi-herdr`, just built by three other agents.
You have no prior context — that is deliberate.

Read, in order:
1. `HERDR.md` (repo root) — §4 decisions, §5 tool contract, §6 steering,
   §10 hazards. This is the spec.
2. `packages/pi-herdr/briefs/COMMON.md` — the module contracts.
3. Every file under `packages/pi-herdr/src` and `test` (skip `briefs/`).

Then verify mechanically:
- `npm run build -w @season179/pi-herdr` (must exit 0)
- `npx vitest run packages/pi-herdr` (all green)

Review dimensions, in priority order:

1. **Kill path correctness** (src/watches.ts): SIGTERM→SIGKILL
   escalation MUST key on a close-event flag, never `child.killed`;
   group kill (`-pid`) with single-pid fallback; timers cleared on every
   path; no orphaned children possible after shutdown().
2. **Callback discipline**: `onOutcome` exactly once per watch under
   every interleaving (natural exit, stop during exit, double stop,
   shutdown during exit); a throwing onOutcome must not corrupt the
   manager.
3. **Extension lifecycle rules** (src/extensions/herdr.ts): nothing
   spawned at factory time; manager rebuilt per `session_start`, torn
   down in `session_shutdown`; no capture of any turn's `ctx.signal`;
   `ctx.hasUI` guarded UI calls; wake budget semantics per HERDR.md
   (wakeBudget 0 = never trigger; steer always).
4. **Wake-path failure containment**: the onOutcome handler in the
   extension must be unable to throw/reject unhandled (tail fetch
   failure, toast failure, telemetry failure, sendMessage failure).
5. **Contract conformance** against COMMON.md exports — exact names,
   signatures, semantics (including: fired/stopped records don't count
   toward capacity; records returned are defensive copies).
6. **Steering text**: herdr_watch description must clearly forbid
   bash-level blocking waits and polling loops.
7. **Test honesty**: do the watches tests actually prove SIGKILL
   escalation (a SIGTERM-ignoring child that dies anyway, within a
   bounded time)? Do CLI tests cover ENOENT and timeout kill?
8. Hygiene: ESM `.js` relative imports everywhere; no dependency on or
   reference to `packages/pi-delegate`; no new npm deps; tool results
   are compact strings, not JSON dumps.

Output format — your final message, nothing else:

```
BUILD: pass|fail (detail if fail)
TESTS: pass|fail (counts)
FINDINGS (ranked, most severe first):
1. [critical|major|minor] file:line — one-sentence defect.
   Failure scenario: concrete input/state → wrong behavior.
...
VERDICT: ship | fix-first (list finding numbers that block)
```

Do not edit any file. Do not run any herdr command. Report only.
