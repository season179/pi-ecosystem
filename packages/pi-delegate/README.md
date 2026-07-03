# @season179/pi-delegate

Gives [pi](https://github.com/badlogic/pi-mono) an orchestrator/worker split:
the main agent (expensive, strong model) delegates well-scoped coding tasks to
a cheap worker model (default `zai/glm-5.2`) running as a headless `pi`
subprocess. The worker absorbs the read-edit-test tool-loop churn; the
orchestrator's context stays small.

Design spec: `DELEGATE.md` at the repo root.

## How it works

The extension registers a `delegate` tool. Per call:

1. **Checkpoint** — dirty tree is auto-committed (`pi-delegate checkpoint`,
   `--no-verify`); the HEAD sha is the reset point either way.
2. **Worker** — headless `pi --mode json -p --no-session` on the configured
   cheap model edits the repo in place. Workers may not run git mutations and
   may not delegate recursively (`PI_DELEGATE_WORKER` guard).
3. **Verify** — the harness runs the brief's `verify` command itself; the
   verdict is mechanical, never the worker's claim.
4. **Report** — compact contract back to the orchestrator: status
   (`success` / `verify_failed` / `worker_error` / `timeout`), checkpoint,
   diffstat + untracked files, verify tail, capped worker summary. Never the
   full diff.
5. **Telemetry** — one JSONL record per delegation for judging the economics.

The harness never retries. The orchestrator's steering (via tool guidelines)
caps re-delegation at 2 attempts, then it takes over itself.

## Config

Optional `~/.pi/agent/delegate.json` (missing file → defaults; invalid file
fails extension load loudly):

```json
{
  "workerModel": "zai/glm-5.2",
  "workerTimeoutMs": 600000,
  "verifyTimeoutMs": 300000,
  "telemetryPath": "~/.pi/agent/delegate-telemetry.jsonl"
}
```

## Development

```bash
npm run build -w @season179/pi-delegate
npm run test -w @season179/pi-delegate
npm run smoke -w @season179/pi-delegate   # real worker run against zai/glm-5.2
node packages/pi-delegate/scripts/smoke-tool.mjs  # full tool flow end-to-end
```
