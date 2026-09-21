# Routing decisions

Read for quota-aware delegation, eligible external harnesses, missing/invalid policy, image/risky tasks, fallbacks, explicit overrides, or policy edits.

## Policy and selection

Policy lives in `herdr-routing.json` in Pi's agent directory, normally `~/.pi/agent`. Models, prices, suitability ranks, fallback order and soft family shares belong there, not in skill prose. `herdr_route` rereads it before each selection; edits change subsequent assignments, never running workers. Do not change preferences without authorization.

Choose in this order:
1. Current user choices and operational limits.
2. Required capabilities, enabled/authenticated availability, and permission protections.
3. Task difficulty, likely successful completion time, cost and quota **when actually known**.
4. Soft family shares among otherwise suitable choices.

Shares only balance equal suitability ranks in baseline automatic selection. Keep capable generalists equally ranked so a family is not starved; reserve stricter ranks for genuine task-fit differences. `profileId` and `override` are explicit-user choices, not an agent budget shortcut. A `fallbackOnly` profile is reserved: never baseline- or budget-select it; it appears only as a configured fallback target or when the user explicitly names it. A `reasoningEffort` level is the exact launch effort (never above high); it does not cap the worker at runtime — verify the effective effort after launch.

### Budget-informed judgment

When `quota.groups` is configured, use `herdr_route` action `inspect` with the actual task difficulty/capabilities/protection needs and native evidence. It returns a compact summary: the snapshot ID, each quota group's live windows (usable allowance after reserve, reset timing, pacing, burn, caveats, shared subscriptions) and one eligibility row per candidate. Request `verbosity: "full"` only when a decision needs the complete profile/quota JSON; it is bounded and marks truncation. Then use `select` with `budgetChoice: { profileId, snapshotId, reason }` to depart from baseline ranks/shares. Budget choice still requires suitability for the difficulty, enabled/authenticated availability, capabilities, protections and non-exhausted quota. It cannot add a model or rewrite the policy. If the snapshot changes, inspect and reconsider. Use automatic selection when live evidence is unavailable; do not treat missing readings as abundant capacity.

Reason across **all** groups, not hardcoded families: remaining allowance, reset time, recent observed burn, pending work and coordination reserve. Keep the current orchestrator on its model unless the user authorizes changing it. Reduce workers sharing its scarce subscription first. Favor a capable group's surplus near reset for real pending work. A smaller model-specific allowance can drain faster; apply only actual reported/mapped windows, never manufacture a half-sized quota or double a usage percentage. Percentages across subscriptions are not equivalent amounts of work.

Pacing labels are advisory arithmetic, not predictions or instructions to exhaust a budget. `conserve` compares spendable allowance to remaining time and recent burn; `surplus` means a window is ahead of even pacing. Short-window limits can constrain an otherwise generous weekly balance. Missing model-specific limits must be disclosed. Native CLI and Pi may use different accounts: configured group bindings must be reverified after account changes.

If premium groups are constrained together, warn the user and shift only suitable work to available economical routes. If the economical group is constrained, warn early and explain whether to wait, reduce parallelism or ask for another configured/authorized model. Do not purchase, install or activate a new provider without permission. Quota warnings do not authorize downgrading an unsuitable or permission-protected task.

Provider checks are shared and limited to once per 30 minutes while orchestration is active. `inspect`, `select`, and `/limits` reuse the cache; do not poll CodexBar yourself or force more frequent checks. After a worker reports **confirmed subscription exhaustion**, use `herdr_route` action `exhausted` with its profile ID so all routes in that group are temporarily blocked immediately. A generic 429/throughput error is not enough. Unknown/stale/reset-past readings are neither exhausted nor unlimited.

Static quota notes are not live balances; intelligence indices are not task-performance guarantees. Never create work, delay urgent work, or choose an unsuitable model to fill a percentage or use expiring allowance. Explain meaningful budget departures in the worker report. Report genuine task-fit mismatches rather than silently changing policy.

## Exceptional routes

- **Missing/invalid policy:** report the actionable path/setup error returned by `herdr_route`. Do not invent defaults. An explicit one-off user choice can use a validated `override` after readiness checks; report the policy error without rewriting defaults.
- **External harness:** check eligible candidates before first dispatch; do not confuse unchecked with unavailable. Complete missing checks and retry selection before falling back. Check current native model identifiers, auth readiness and supported permission flags. Supply non-secret evidence in `externalChecks`; these assertions are advisory, not proof of a live worker's settings. Verify effective protection after launch and before substantive work. Pi profiles use Pi's exact model/auth registry instead of a duplicate credential database.
- **Claude folder trust:** accept the trust prompt for the assigned project in owned workers, then continue with permission review enabled. Verify the displayed path; this does not authorize unrelated folders or other approval prompts.
- **Images:** verify actual image-input support on the selected route. A model label or configured capability hint alone is insufficient.
- **Risky work:** request the required protections through `herdr_route`; never relabel risk to obtain a preferred model. Protection settings do not grant permission for the operation. A refusal must not be routed around.
- **Fallback:** require the same task capability and protection constraints. Report the original route, substitute and reason. If none is eligible, surface the blocker; do not silently downgrade. An explicit user choice needs `allowFallback` before substitution.

## Launch and record

Use the returned native argument array, verifying installed CLI syntax and quoting each argument if passed through a shell. Policy contains no executable templates. Effort flags (`--thinking`, `--effort`, `-c model_reasoning_effort=<level>`) come from the profile's `reasoningEffort`; never raise them above high. Ensure the target shell's `PI_HERDR_ORCHESTRATOR` is unset or `0`; `1` is an explicit orchestrator default, not a worker setting.

Only after successful submission, call `herdr_route` with `action: "record"`, the returned `selectionId`, and worker `target`. This counts an actual assignment, not a preview or failed start, and is not proof of completion or ownership. Include the selected profile and any fallback in the worker report. Then arm the nonblocking watch as in the core loop.

Selection IDs expire on reload. Reconcile any already-started worker before selecting again; never repeat a dispatch just to repair assignment history.
