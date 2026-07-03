# @season179/pi-delegate

Gives [pi](https://github.com/badlogic/pi-mono) an orchestrator/worker split:
the main agent (expensive, strong model) delegates well-scoped coding tasks to
a cheap worker model (default `zai/glm-5.2`) running as a headless `pi`
subprocess. The worker absorbs the read-edit-test tool-loop churn; the
orchestrator's context stays small.

Design spec: `DELEGATE.md` at the repo root.

## Status

Milestone 1 (spawn layer) — the extension entry point registers nothing yet.
`src/worker.ts` implements spawning a worker, streaming its JSON events, and
collecting usage/cost. The `delegate` tool lands in milestone 2.

## Development

```bash
npm run build -w @season179/pi-delegate
npm run test -w @season179/pi-delegate
npm run smoke -w @season179/pi-delegate   # real worker run against zai/glm-5.2
```
