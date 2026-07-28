# Fix batch 2 — orchestrator-only guard. Owner: builder

Problem: pi also runs as workers/planner/reviewer inside herdr panes,
and every herdr pane carries HERDR_ENV=1 + HERDR_PANE_ID — so once this
package is installed globally, worker pis would register the watch
tools too. Only the orchestrator should get them.

## The fix (src/extensions/herdr.ts)

Extend the factory guard: register nothing unless ALL of
- `process.env.HERDR_ENV === "1"`
- `process.env.HERDR_PANE_ID` is set
- `process.env.PI_HERDR_ORCHESTRATOR === "1"`  ← new

Add a short comment above the guard: herdr marks every pane the same
way, so orchestrator-vs-worker must be an explicit launch-time opt-in
(`PI_HERDR_ORCHESTRATOR=1 pi …` or
`herdr pane split --env PI_HERDR_ORCHESTRATOR=1`).

## Done

`npm run build -w @season179/pi-herdr` + `npx vitest run
packages/pi-herdr` green. Report under 10 lines. Touch ONLY
src/extensions/herdr.ts.
