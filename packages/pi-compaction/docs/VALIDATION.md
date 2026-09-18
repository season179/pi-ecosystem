# Local validation — 2026-09-18

Package: `@season179/pi-compaction` 26.9.0, unpublished.
Runtime exercised: Pi 0.85.1, Node 24.19.0.

## Completed

- Root `npm run validate`: all configured workspace builds and pack dry-runs pass.
- `npm test --workspace @season179/pi-compaction`: **128 tests, 8 files pass**.
- `git diff --check`: clean.
- Real Pi CLI loads the built extension from its package manifest in an isolated
  agent directory. A fake coding provider executes `compaction_recall`; local
  metadata files are produced without loading personal sessions/extensions.
- Real Pi CLI `/compaction report 7d` prints in noninteractive mode and appends
  only a custom entry, not a model-facing message. Lifecycle tests confirm report
  and preview content stays out of subsequent provider requests.
- Real `AgentSession` tests exercise threshold pruning, original-history
  fallback, restore/recall, persistence, tree isolation, manual compaction,
  stale-observation handling and telemetry linkage. Provider conversion tests
  exercise paired pruning through Anthropic, OpenAI Chat/Responses/Codex and
  Google serializers; these are not live requests to those providers.
- Scoring tests exercise pinned destination, rejected redirects, actual byte
  limits, cancellation/deadlines, per-attempt metrics and late-result isolation.
- A synthetic live TypeSafe request through the corrected transport succeeded:
  four candidates, one request, zero failures, approximately **802 ms**. No real
  session text or repository contents were included. This confirms service
  acceptance, not decision quality or a general latency guarantee.
- `pi install` added the local checkout path to the user's package list. No
  other settings were changed. Pruning remains **off by default**.

## Start using it

Reload Pi (`/reload`) or start a new session, then:

```text
/compaction status
/compaction preview
/compaction on
```

Enable only for session data you permit sending to TypeSafe. `TYPESAFE_API_KEY`
must be available to the Pi process. Preview uses no network; score-only mode
and enabled threshold scoring make real API requests.

After ordinary coding use:

```text
/compaction report 7d
/compaction feedback bad-prune
```

`/compaction off` stops replay; `/compaction restore all` pins currently pruned
outputs. Recall can read original branch outputs even before a Pi summary.

## Not established yet

No multi-day or live coding-provider quality/cost comparison has been completed.
The initial keep threshold is not calibrated. Local reports distinguish measured
usage, estimates, missing prices and explicit feedback; low recall is not proof
of correct pruning. TypeSafe token usage is recorded when returned, but scoring
cost remains unavailable without known prices. No publish or push was performed.
