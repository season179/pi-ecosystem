# Subscription-aware delegation

Collection, cache and routing live in pi-herdr, using the installed CodexBar CLI rather than duplicating provider authentication. No core Pi patch or separate extension.

## Setup

Install/configure [CodexBar](https://github.com/steipete/CodexBar) first. Herdr resolves `/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI` on macOS, otherwise `codexbar` on PATH. `PI_HERDR_CODEXBAR` may name an executable path (not a shell command). No executable is downloaded automatically.

Add an optional `quota` section to `~/.pi/agent/herdr-routing.json`. Verify that the selected CodexBar/native accounts are the accounts used by the listed worker profiles. This example matches the eight-profile policy; it is not a universal account mapping:

```json
"quota": {
  "groups": [
    { "id": "astra", "provider": "codex", "source": "oauth", "profiles": ["pi-astra", "codex-astra"], "reservePercent": 10 },
    { "id": "sol", "provider": "codex", "source": "oauth", "profiles": ["pi-sol", "codex-sol"], "reservePercent": 10 },
    { "id": "fable", "provider": "claude", "source": "cli", "profiles": ["claude-fable"], "windows": ["primary", "secondary", "claude-weekly-scoped-fable"] },
    { "id": "opus", "provider": "claude", "source": "cli", "profiles": ["claude-opus-5"] },
    { "id": "glm", "provider": "zai", "source": "api", "account": "default", "profiles": ["pi-glm", "pi-glm-flash"] }
  ]
}
```

Two groups may share one provider/source/account: the `astra` and `sol` groups above are one Codex subscription (one observation, one poll, one cache entry — never an independent allowance), and the two Claude groups share the native Claude login. Profile sets must stay disjoint (one group per profile). The `sol` group repeats the 10-point coordination reserve so worker delegation sees the same spendable margin as orchestration.

The `fable` group explicitly maps `claude-weekly-scoped-fable`, a user assertion from the 2026-09-18 CodexBar evidence showing that scoped window exhausted while shared Claude windows still had headroom. With that mapping, a 100%-used scoped window marks **only the fable group exhausted** (blocking `claude-fable` and enabling its configured fallback), while the `opus` group — default shared windows only, scoped window deliberately unmapped — stays eligible. Mapping a scoped window is exactly the mechanism QUOTA.md describes for model-specific exhaustion; herdr never infers it from a model name. Do not map the Fable-scoped window onto other Claude models.

The 10-percentage-point coordination reserve is an editable starting preference, not a provider quota or mandatory cutoff. Set a reserve for whichever subscription is hosting orchestration, and mirror it on every group sharing that subscription. Reserving capacity does not automatically switch the orchestrator model. Polling is opt-in through this configuration and explicit orchestration activation. `/orchestrate off` stops it. `/limits` shows cached data even when orchestration is off, but does not initiate a check there.

Each group requires `id`, `provider`, `source`, and configured `profiles`. Optional `account` selects a CodexBar account label; omit for that source's current account. Allowed sources: Codex/Claude `oauth`, `cli`, `web`; Z.ai `api`. There is no automatic cross-source authentication fallback. Source failures appear as unavailable; diagnose/login with the owning app, not by putting credentials in routing config.

Optional `windows` lists exact CodexBar window IDs, default `["primary", "secondary"]`. `tertiary` and `extraRateWindows[].id` are visible but not applied unless listed. In particular, Z.ai `zai-mcp` is not coding allowance, and Claude tertiary/model-specific windows must not be applied to unrelated models. If Fable-specific quota is absent from the source, its balance remains unknown: the reported shared Claude allowance is not proof of Fable headroom. No static half-quota conversion is performed.

Cache: `~/.pi/agent/herdr-quota-cache/` (private directory/files). Cache keys include provider, source, account selector, relevant native-home/config environment and executable override; multiple profiles can share one cache. Reserve/profile/window changes reuse observations. Previous and latest successful samples support bounded burn estimates only with a stable reported account identity and unchanged reset. CLI-only Claude readings can lack identity, in which case burn is deliberately unavailable.

`inspect` and `select` coalesce with the active monitor and never bypass the 30-minute cooldown. Failed attempts preserve the old observation timestamp but disable it as current evidence. Checks are capped at 25 seconds and 512KB output; cancellation kills the CLI process group on POSIX. No raw stdout/stderr is retained. A crashed owner lock is recoverable after two minutes when its PID is dead; a live owner is never evicted.

For a budget departure, first inspect task candidates, then select:

```json
{ "action": "select", "difficulty": "general", "budgetChoice": {
  "profileId": "pi-glm", "snapshotId": "<from inspect.quota.snapshotId>",
  "reason": "GLM fits this implementation task; conserve Astra's six-day balance for orchestration."
} }
```

Supply required capabilities, risk and native evidence on **both** inspect and select. They are not remembered from a previous call. Selection returns normal launch arguments and must still be recorded after successful dispatch. The tool verifies snapshot currency and hard constraints; it does not verify that the model's judgment is wise. A monitored target needs its own fresh applicable reading—another group's freshness cannot stand in for it. An unmonitored profile can be chosen to conserve a known scarce group, but its allowance remains explicitly unknown, not unlimited.

## Advisory signals

Remaining percentage = 100 minus reported used percentage. Spendable percentage subtracts the configured reserve. `low` means at most 10 spendable percentage points in any applicable live window. `conserve` means below an even-time pacing reference by over 10 points, or measured burn that would exhaust spendable allowance before reset while the window is not clearly ahead of even pace. Burn is a two-sample rate that a short burst can inflate, so it drives pressure only when a pacing reference exists and does not contradict it: a window more than 10 points ahead of even pace is `surplus` and its burn stays descriptive evidence. Without `windowMinutes` there is no pacing reference, so burn is descriptive only. `surplus` means over 10 points ahead of the even-time reference in a window, provided no applicable window is low/constrained. These are transparent prompts for judgment, not fixed allocation weights or workload forecasts. Short windows take precedence when constrained. Two observations 6–120 minutes apart, with an identifiable unchanged account/reset, are needed for burn.

Warnings are deduplicated per active session by group/state/pressure/reset. Each warning has exactly one user-visible surface: a UI notification. The same text is steered into model context (`display: false`) without starting an idle model turn or rendering a second transcript copy. Every LLM call also receives a transient current snapshot, so old warning messages do not supersede current data. User-facing `/limits` output is timestamped.

A confirmed quota-exhaustion report blocks the whole configured group until a later successful observation with the same reported account identity (or both sources lacking identity), the next known applicable reset, or 30 minutes (whichever first). After that, stale data is unknown—not assumed replenished. For model-specific exhaustion where other models must remain usable, configure separate profile groups/windows rather than treating a shared provider as one undifferentiated budget. The collector never consumes reset credits or enables paid extra usage.

## Limitations

- Account bindings are operator assertions, not live identity verification. In particular, Pi's session-local `/accounts` selection may differ from native Codex or CodexBar. Verify/reconfigure mappings when switching accounts; do not share a group across distinct subscriptions. The initial local setup verifies saved defaults, not every future worker's effective identity.
- Provider windows are sampled, not a reservation system. Simultaneous workers and non-Pi usage can consume capacity between checks. Missing/reset-past windows stay unknown.
- Only Codex, Claude and Z.ai collectors are currently accepted. Additional configured models can still be routed with unknown quota; adding a new subscription collector is a separate change.
- The source may not report every model-specific allowance. This is particularly relevant to Fable; do not equate a shared Claude window with a separately verified Fable window. In a CodexBar 0.56.6 source review, the Claude `cli` parse path filled only the shared session/weekly (plus opus) windows, while `claude-weekly-scoped-*` windows were populated only in that version's oauth/web code paths. Herdr therefore treats Claude model-scoped allowance as known only when the group explicitly maps a `claude-weekly-scoped-*` window ID (a user assertion — herdr never infers a model-specific mapping from model names) and that window is present and fresh in the current reading. Otherwise summaries and `inspect` set `modelScopedAllowanceUnknown` and word the gap as not reported in this reading or reported but not mapped, stating that shared windows are not model-specific headroom instead of presenting the aggregate as the model's full budget. A generic `tertiary` window is not proof of model-scoped coverage. The flag describes the latest reading (including a stale one); freshness is already stated separately.
- Baseline selection remains available; adaptive delegation depends on the orchestrator following the guide, not an autonomous scheduler. User authorization, task suitability and permission protections remain mandatory.

## Contract

- Opt-in quota groups in `herdr-routing.json` explicitly bind worker profiles to a subscription/account source. Different harnesses sharing a subscription share a group, not independent budgets. Bindings are operator assertions; verify them when changing accounts or native CLI homes. Pi account selection is not automatically synchronized with CodexBar.
- Only active orchestrators poll, at activation and every 30 minutes. Shared private cache and cross-process refresh locks prevent duplicate checks; failed checks also respect the interval. Workers do not poll. Off/reload/shutdown stops the timer and bounded CLI processes.
- Keep all returned rate windows, but apply only configured windows to a profile group. Default applies primary and secondary; model-specific windows require explicit mapping. Missing windows stay unknown. Never infer a Fable quota multiplier from a model name or static note.
- Preserve provider observation timestamps. Missing, failed, stale, malformed and reset-past readings are not zero or unlimited. Never guess that a reset refilled a balance.
- Normalize only bounded quota fields, never persist raw CLI output, emails, credentials, reset credits, or diagnostic errors. Authentication remains CodexBar/native CLI owned.
- `herdr_route inspect` presents configured candidates, readiness, quota, remaining time, reserve and recent observed burn. The model judges task needs and pending work; arithmetic is evidence, not an automatic scheduler.
- A budget-driven selection is distinct from an explicit user override: it requires a reason and fresh quota evidence and may choose only a configured suitable profile. Capabilities, protection checks and known exhaustion remain mandatory. Baseline policy remains unchanged.
- Warn on low balances, below-even pacing, and corroborated burn: consumption that would exhaust a window before reset only when a pacing reference exists and the window is not clearly ahead of even pace. Deduplicate warnings; never wake an idle model just to discuss quota. Favor expiring surplus for useful work, never manufacture work or buy/enable capacity automatically.
- Confirmed exhaustion between polls is reported immediately and temporarily blocks the subscription group. Generic 429s are not evidence of subscription exhaustion.

## Baseline evidence

Before edits: 132/133 tests passed on the first run; a watch kill-grace test reported exit code 137 rather than null. The unchanged test passed in isolation and a full rerun passed 133/133. Treat any recurrence as a pre-existing intermittent failure, not a quota regression without investigation.

2026-09-18 quota-pressure fix: the GLM observation (primary 80% remaining, ~15.8% even pace, burst burn 27.07%/h; weekly 77% remaining, 19.7% even pace, burn 5.41%/h projecting exhaustion in 14.2h against a 33.1h reset) previously forced `conserve` through the ungated burn branch. The replay now yields `surplus` while burn stays visible as descriptive evidence. Legitimate conserves verified unchanged: Fable 58% usable vs ~72% even pace (deficit), Astra 25% usable vs ~84% even pace (deficit), and a synthetic in-band window (usable 40%, even pace 35%, burn 60%/h) still conserves on burn.

Installed CodexBar 0.56.6 is available at `/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI` (not PATH). Read-only checks succeeded for Codex `oauth`, Claude `cli`, and Z.ai `api`. Claude `oauth`/`web` were unavailable. Codex did not report a primary window; do not require one or fabricate it. Z.ai returned separate MCP quota, which is not a coding-model allowance.
