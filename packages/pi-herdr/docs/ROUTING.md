# External worker routing

`herdr-routing.json` is the user's routing policy, separate from watch settings in `herdr.json`. It lives in Pi's **agent directory**: normally `~/.pi/agent/herdr-routing.json`, or the directory returned by Pi's `getAgentDir()` when `PI_CODING_AGENT_DIR` is set. The loader receives this directory; it does not guess the home directory.

Read it at activation and before **every new selection**. There is no cache: edits affect the next assignment without rebuilding, restarting, or changing existing workers. Activation/selection does not launch workers or grant permission.

## Setup

1. Review [the example](herdr-routing.example.json) and [JSON Schema](herdr-routing.schema.json). Copy the example to your agent directory **only when authorized**. There are no built-in routing defaults and installation does not create this file.
2. Verify the exact harness/model/provider, auth readiness, input support, and protection flags on your installation. Edit enabled state, ranks, fallback order, and share window to reflect your preferences.
3. Select a route before dispatch, including explicit one-off choices. Missing or invalid configuration reports the path and setup instructions. A caller may report that error and still pass an explicit validated override, without rewriting defaults.

The example represents all eight requested profiles (Sol primary/protected, Fable hardest, Opus and both Astra profiles reserved, GLM full/Flash easy). It is a candidate policy, not live quota data or a universal model recommendation. Its difficulty ranks, within-family preferences, and 50-assignment window are editable proposals. Relative shares 40 Sol / 40 GLM / 20 Fable with zero-weight Astra and Opus families, and the dated intelligence/cost/quota notes are **user-supplied planning inputs from 2026-09-18**, not independently verified benchmarks or prices. Static notes do not affect the algorithm.

## Verified local identifiers (2026-09-18)

Checked installed Pi 0.85.1, Claude Code 2.1.276, and Codex CLI 0.155.0. No paid worker or model request was launched for these checks.

| Profile | Native model selection | Auth owner / observed readiness | Input metadata |
|---|---|---|---|
| Claude Fable | `claude --model claude-fable-5-1` | Native Claude auth; `loggedIn: true`, `claude.ai`, first-party, team subscription | Pi Anthropic catalog has text/image for the exact model; verify native route before image tasks |
| Codex Astra | `codex --model gpt-6-astra` | Native Codex auth; logged in with ChatGPT | Native cached model catalog: text/image |
| Pi Astra | `pi --provider openai-codex --model gpt-6-astra` | Pi `openai-codex`, OAuth configured | Pi registry: text/image |
| Pi GLM | `pi --provider zai --model glm-5.3` | Pi `zai`, API key configured | Pi registry: text only |
| Pi GLM Flash | `pi --provider zai --model glm-5.3-flash` | Pi `zai`, API key configured | Pi registry: text/image |
| Pi Sol | `pi --provider openai-codex --model gpt-5.6-sol` | Pi `openai-codex`, OAuth configured | Pi registry: text/image |
| Codex Sol | `codex --model gpt-5.6-sol` | Native Codex auth; logged in with ChatGPT | Native cached model catalog: text/image |
| Claude Opus 5 | `claude --model claude-opus-5` | Native Claude auth; same first-party team login as Fable | Pi Anthropic catalog: text/image |

Evidence: installed harness `--help`; Claude binary contains exact `claude-fable-5-1` and `claude-opus-5` identifiers and Pi's Anthropic catalog agrees; native Codex `models_cache.json` has `gpt-6-astra` and `gpt-5.6-sol`; installed Pi `ModelRuntime` registry with local cached catalogs and read-only injected credential/store access returned these exact available provider/model pairs. Verified effort flags on the installed CLIs and Pi docs (`docs/usage.md`): Pi `--thinking <level>` (off…max; this policy only ever passes `low`/`medium`/`high`), Claude `--effort <level>`, and Codex config override `-c model_reasoning_effort=<level>`. Credential values were neither printed nor copied to routing files. Native auth checks were filtered to readiness fields. Metadata presence is not a successful inference request, quota balance, or guarantee of access when dispatch happens. Never translate logical “Astra” into provider `openai` when the intended Pi subscription provider is `openai-codex`.

For integration, use Pi's model/auth registry, not another credential database. `find(provider, id)` establishes an exact registered identity; `getAvailable()` establishes configured availability and `model.input` provides `text`/`image` metadata. Resolve current readiness through Pi when necessary, without returning credentials. External harness readiness comes from current native evidence supplied by the caller; this module has no external adapter or probes.

## Configuration contract

All fields are required unless marked optional. Unknown fields are rejected at every structured level. The loader also checks profile uniqueness, known families, direct fallback references, positive finite total shares, and real calendar dates beyond structural JSON Schema validation.

- `version`: `1`.
- `historyWindow`: positive safe integer. Number of most recent actual assignments, not days, tokens, spend, or runtime.
- `familyShares`: family name → non-negative relative weight, with a positive total. `40/40/20` and `.4/.4/.2` are equivalent. Zero is a soft target, **not disablement**.
- `quota` (optional): explicit subscription groups and profile/window bindings; see [QUOTA.md](QUOTA.md). Omit to disable polling.
- `profiles`: nonempty array:
  - `id`, `family`: stable labels. History records the assigned family, so later profile renaming does not reinterpret old assignments.
  - `harness`: `pi`, `claude`, or `codex`.
  - `model`: exact native model identifier. `provider` is required only for Pi; native Claude/Codex own their auth/provider configuration.
  - `enabled`: boolean; neither explicit choice nor fallback overrides `false`.
  - `capabilities`: hints, not proof. Use `text`/`image` for current Pi integration. Additional tags require real observations from a caller; never infer code quality from an intelligence index.
  - `suitability`: nonempty object with any of `easy`, `general`, `hardest`; values are non-negative ranks. Lower is better. Omission means unsuitable, not a low score. This is task-fit judgment, including likely successful completion time; it is not an intelligence-score threshold.
  - `preference`: non-negative rank (lower better), used after fit/share ties, e.g. economical Flash for an easy task or preferred Pi harness within Astra. Configure ranks deliberately; unknown prices/quota are not fabricated.
  - `protection`: `standard`, `claude-auto` (Claude only), or `codex-approve-for-me` (Codex only).
  - `fallbacks`: ordered list of other configured IDs. Only direct edges are followed; mutual fallback lists are safe, not recursive traversal.
  - `fallbackOnly` (optional boolean): reserved route. Excluded from baseline ranking and `budgetChoice`; reachable only as a configured fallback target of another profile or through an explicit user `profileId`/`override` (reported with a warning). Zero-weight family shares are a soft signal; `fallbackOnly` is the hard exclusion. The loader does not require an incoming fallback edge: an explicit-user-only reserved profile is valid configuration.
  - `reasoningEffort` (optional `low`/`medium`/`high`): exact effort level emitted in `launchArgs` (`--thinking` for Pi, `--effort` for Claude, `-c model_reasoning_effort=<level>` for Codex). Values above `high` are rejected by design: this policy never launches worker reasoning above high. This is a launch-time argument, not a runtime cap — verify the worker's effective effort after launch.
  - `planning` (optional): required `source` and `date` (`YYYY-MM-DD`); optional `intelligenceIndex`, `costNote`, `quotaNote`, `capabilityNote`. Descriptive text only, never executable instructions or live balances.

IDs reject whitespace, globs, CLI flags, and shell expressions. Provider identifiers allow ASCII letters/digits plus `.`, `_`, `/`, `-`, starting with a letter/digit. Model identifiers additionally allow `@` (including first position) and `:` to preserve real IDs such as `@cf/zai-org/glm-5.3` and `z-ai/glm-5.3:batch`; they still cannot start with a dash. Exact registry matching, not this character filter, establishes a valid model. Colon segments are preserved verbatim, never interpreted as thinking suffixes by this helper. Profile/family/capability labels exclude `/`.  No credentials, endpoints, auth commands, argv, environment overrides, executable templates, or dispatch engine are accepted. Optional quota monitoring uses a fixed bounded CodexBar adapter, not a configurable shell command. The schema cannot recognize secrets hidden in prose: do not put secrets in notes either.

## Pure API

Exports from `src/routing.ts`:

```ts
loadRoutingConfig(agentDir: string): RoutingConfig
validateRoutingConfig(value: unknown): RoutingConfig
selectRoute(
  config: RoutingConfig | undefined,
  request: RouteRequest,
  availability: readonly RouteAvailability[],
  history: readonly RouteAssignment[] = [],
  quota?: QuotaReport,
): RouteSelection
```

Failures throw `RoutingError extends ConfigError`; validation and selection return detached data. No shared mutable state, subprocess, network, file writes, or registry import is hidden in selection. `loadRoutingConfig` is synchronous and reads exactly one JSON file each call.

```ts
const config = loadRoutingConfig(agentDir); // refresh every time
const selected = selectRoute(config, {
  difficulty: "general",
  requiredCapabilities: ["text"],
  risky: false,
}, observations, actualAssignmentHistory);
// selected: { profile, source: "policy" | "explicit" | "fallback" | "budget",
//             fallbackOf?: string, budgetReason?: string, warnings: string[] }
// No worker has started. Report any fallback; preserve authorization boundaries.
```

### Request and one-off selection

`RouteRequest` requires `difficulty`; optional `requiredCapabilities` defaults to none, `risky` defaults to false. Caller must classify risk from current instructions/task context, not label risky work safe to force a route. Current user authorization remains authoritative outside this advisory selector.

- `profileId`: explicit user selection of a configured profile. Bypasses suitability/share preferences, never enablement, runtime capability/auth checks, or protections.
- `override`: an explicit one-off full `RoutingProfile`, validated identically (including optional `fallbackOnly`/`reasoningEffort`). Use a new ID rather than shadowing a configured profile; use `profileId` for an existing ID. Can work with `config: undefined` after a reported missing/invalid-file error. Without config its fallback list must be empty. The override is not written to the policy.
- `budgetChoice`: `{ profileId, snapshotId, reason }` from the latest `inspect`. Allows agent budget judgment to depart from ranks/shares, never from difficulty suitability or hard constraints. Requires fresh applicable quota evidence and a 10–1000 character reason. Does not silently fall back if blocked; inspect and reconsider. Mutually exclusive with user overrides.
- `profileId` and `override` are mutually exclusive. `allowFallback: true` is required to substitute for either explicit selection; otherwise failure is a blocker. Fallbacks must meet the actual requested difficulty even when the explicitly selected original bypassed suitability.

### Availability and permission boundary

Supply one `RouteAvailability` per exact `(harness, provider, model, protection)` tuple:

```ts
{
  harness: "pi", provider: "zai", model: "glm-5.3",
  available: true, authenticated: true, capabilities: ["text"],
  protection: "standard", bypassPermissions: false,
  // remainingQuota?: number; reason?: string
}
```

Observations must be independently checked, not copied from config or a model label. Absent or duplicate/ambiguous observations block; deduplicate shared model observations in the caller. Exact matching prevents a readiness check for `openai` being reused for `openai-codex`. Required capabilities must occur in **both** policy hints and observations. Auth/availability require literal `true`; permission bypass requires literal `false`. Unknown protection/bypass is not approval. Optional `remainingQuota: 0` blocks; omitted is unknown; positive amounts are not compared across plans. Native evidence text is not echoed by the selector, avoiding accidental sensitive probe output.

`risky: true` requires either Claude `claude-auto` or Codex `codex-approve-for-me`; Pi/`standard` is excluded even under explicit override. Installed help verifies Claude `--permission-mode auto` and Codex `--approve-for-me` (workspace-write sandbox). These are protection requirements, **not proof they are enabled or authorization to act**. Caller must verify effective worker state; refusals remain refusals. Fallback cannot drop a protected original route to `standard`, even on a request not marked risky. Never use `--dangerously-skip-permissions`, `bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`, or similar bypass flags as fallback.

### Ranking and fallbacks

1. Honor explicit safe choices first.
2. Policy candidates must be enabled and meet configured capabilities, difficulty, and risk protections. `fallbackOnly` profiles are not baseline candidates.
3. Rank by suitability (ascending), family deficit (descending), preference (ascending), then ID (ASCII ascending) for deterministic ties.
4. Check the preferred route's current readiness. If blocked, try its **configured direct fallbacks**, in order, applying all safety/capability/difficulty filters. A `fallbackOnly` profile is a legitimate fallback target; this is its configured purpose. Fallback triggers on any blocker (readiness, auth, capability, or confirmed quota exhaustion) — there is no quota-only fallback condition; if you need one, model it through per-group window mapping so exhaustion blocks the exact group. Report `source: "fallback"`, `fallbackOf`, and a warning. No eligible fallback means a blocker, not silent substitution from an unrelated profile.

Family deficit = normalized target weight − observed proportion in the last `historyWindow` assignment entries. With empty history the observed proportion is zero. `RouteAssignment` only needs `{ family: string }`; callers may retain profile/target/session identity as well. History is oldest first and counts real starts, not selection queries, failed launches, completions, tokens, or runtime. Historical unknown/removed families remain in the denominator: they were still actual assignments. Astra includes Codex and Pi; GLM includes full and Flash. Fallback order overrides balance.

Shares only distinguish equally ranked suitable choices; they cannot override explicit selection, capability, quota exhaustion, or protection. The example ranks Claude Fable and the Sol/GLM generalists equally for general work so Fable's share can participate, while preferring Fable for hardest work and GLM for easy work. The example can still diverge substantially from 40/40/20 when work is mostly easy or hardest. Never generate unnecessary work, wait for a percentage, or use a weaker unsuitable model to balance. Use baseline automatic selection without live quota evidence, explicit selection for user choices, or a reasoned `budgetChoice` for adaptive delegation (never for `fallbackOnly` routes). Report task-fit mismatches rather than silently editing the policy.

The agent-facing tool/context owns registry checks, fresh loading, result presentation, and session-stamped assignment recording **after successful dispatch**. Resume can reuse that conversation's history; forks must not inherit assignment ownership. This helper neither persists history nor starts/restarts workers.

## Agent-facing `herdr_route` contract

Available only after explicit orchestration activation. This tool never launches a worker.

- `action: "inspect"`: requires `difficulty`; accepts task constraints and `externalChecks`. Returns candidates with blockers plus the shared quota snapshot (including snapshot ID), without recording a selection. The model-facing text is a compact evidence summary by default: the snapshot ID first, then one block per quota group (state, pressure, reserve, applicable windows with remaining/usable allowance, reset timing, pacing reference and burn; historical readings labelled as such; missing, unmapped and model-scoped caveats; warnings; which groups share one subscription), then one row per candidate (eligibility or exact block reason, harness/provider/model, effort, protection, family, preference, reserved flag, capabilities, suitability ranks, fallbacks, quota group). Static planning notes are omitted. `verbosity: "full"` returns the complete profile/quota JSON instead. Both forms are bounded to 24KB/500 lines and append an explicit `[TRUNCATED …]` marker naming what is missing; the compact form reports how many candidate rows survived. Structured `details` (`quota`, `candidates[{ profile, blocked }]`, `configWarning`) are identical in both forms and are not sent to the model.
- `action: "exhausted"`: requires `profileId`; report only confirmed subscription exhaustion, not a generic 429. Temporarily blocks the shared subscription group without an extra provider poll.
- `action: "select"`: requires `difficulty`; accepts the request fields above plus `externalChecks`. Reloads policy, obtains Pi model/auth/input readiness, and returns `selectionId`, `profile`, `source`, optional `fallbackOf`, `warnings`, and `launchArgs`. If an explicit override proceeds without valid config, also reports `configWarning`. The model-facing text is compact by default: `selectionId`, route/family/source/fallback provenance, exact harness/provider/model/protection/effort, the `launchArgs` JSON array, any `budgetReason`, warnings, and the dispatch → record → watch duties. `verbosity: "full"` returns the complete selection JSON (bounded to 16KB/300 lines, truncation marked). `details` are unchanged either way.
- `externalChecks`: Claude/Codex observations only: `harness`, exact `model`, `available`, `authenticated`, `capabilities`, `protection`, `bypassPermissions`, and nonempty `evidence` text from current native auth/model/help checks. These are **agent-supplied advisory evidence**, not an automatic external adapter or independent verification of a live worker. No credentials in evidence. Verify effective protection after launch. Pi checks cannot be replaced with these assertions.
- `action: "record"`: only **after successful dispatch**, supply the returned `selectionId` and worker `target`. Records session-stamped profile/family/target/fallback metadata. Repeating the same selection/target does not count twice. Unknown/expired selections or a different target for an already-recorded selection fail. Recording asserts a dispatch report, not completion, ownership, or restored supervision.

`launchArgs` are argument arrays, never shell command templates. `reasoningEffort`, when configured, appends the harness effort flag. The fixed safety implementation uses:

| Harness/protection | Fixed native options | Effort suffix (when set) |
|---|---|---|
| Pi / standard | `--provider <provider> --model <model>` | `--thinking <level>` |
| Claude / claude-auto | `--model <model> --permission-mode auto` | `--effort <level>` |
| Claude / standard | `--model <model> --permission-mode manual` | `--effort <level>` |
| Codex / codex-approve-for-me | `--model <model> --approve-for-me` | `-c model_reasoning_effort=<level>` |
| Codex / standard | `--model <model> --sandbox workspace-write --ask-for-approval on-request` | `-c model_reasoning_effort=<level>` |

Quote each argument if a caller subsequently uses a shell. Preserve the current user's operational limits; clear inherited orchestrator activation from workers. Verify native flags and the effective worker permission mode before starting substantive work. Protection implementation is deliberately not editable executable policy. Do not route around a refusal using a different profile. The tool reads the shared quota cache but never schedules work to fill a share. Explicit IDs do not override known exhaustion.

## Focused verification

From repository root:

```sh
node_modules/.bin/vitest run packages/pi-herdr/test/routing.test.ts packages/pi-herdr/test/routing-tool.test.ts
node_modules/.bin/tsc -p packages/pi-herdr/tsconfig.json --noEmit
```

Tests cover reload behavior, all eight profiles, missing/invalid JSON, exact identity/readiness, capability and protection filtering, explicit overrides, direct eligible fallback, fallback-only reservation (baseline, budget, fallback target, explicit), reasoning-effort validation and launch flags, scoped Claude window exhaustion granularity, quota unknown/zero, family grouping, rolling windows, deterministic selection, and no input mutation. They intentionally do not enforce exact small-batch ratios or launch paid workers.
