# Routing decisions

Read when policy includes an eligible external harness, or for missing/invalid policy, image/risky tasks, fallbacks, explicit overrides, or policy edits.

## Policy and selection

Policy lives in `herdr-routing.json` in Pi's agent directory, normally `~/.pi/agent`. Models, prices, suitability ranks, fallback order and soft family shares belong there, not in skill prose. `herdr_route` rereads it before each selection; edits change subsequent assignments, never running workers. Do not change preferences without authorization.

Choose in this order:
1. Current user choices and operational limits.
2. Required capabilities, enabled/authenticated availability, and permission protections.
3. Task difficulty, likely successful completion time, cost and quota **when actually known**.
4. Soft family shares among otherwise suitable choices.

Shares only balance equal suitability ranks. Keep capable generalists equally ranked so a family is not starved; reserve stricter ranks for genuine task-fit differences. Use automatic selection unless the user specifies a route: `profileId` and `override` bypass share balancing.

Static quota notes are not live balances; intelligence indices are not task-performance guarantees. Never create work, delay urgent work, or choose an unsuitable model to fill a percentage. If task fit contradicts configured ranks, report the mismatch rather than silently pinning a route or editing policy.

## Exceptional routes

- **Missing/invalid policy:** report the actionable path/setup error returned by `herdr_route`. Do not invent defaults. An explicit one-off user choice can use a validated `override` after readiness checks; report the policy error without rewriting defaults.
- **External harness:** check eligible candidates before first dispatch; do not confuse unchecked with unavailable. Check current native model identifiers, auth readiness and supported permission flags. Supply non-secret evidence in `externalChecks`; these assertions are advisory, not proof of a live worker's settings. Verify effective protection after launch and before substantive work. Pi profiles use Pi's exact model/auth registry instead of a duplicate credential database.
- **Images:** verify actual image-input support on the selected route. A model label or configured capability hint alone is insufficient.
- **Risky work:** request the required protections through `herdr_route`; never relabel risk to obtain a preferred model. Protection settings do not grant permission for the operation. A refusal must not be routed around.
- **Fallback:** require the same task capability and protection constraints. Report the original route, substitute and reason. If none is eligible, surface the blocker; do not silently downgrade. An explicit user choice needs `allowFallback` before substitution.

## Launch and record

Use the returned native argument array, verifying installed CLI syntax and quoting each argument if passed through a shell. Policy contains no executable templates. Ensure the target shell's `PI_HERDR_ORCHESTRATOR` is unset or `0`; `1` is an explicit orchestrator default, not a worker setting.

Only after successful submission, call `herdr_route` with `action: "record"`, the returned `selectionId`, and worker `target`. This counts an actual assignment, not a preview or failed start, and is not proof of completion or ownership. Include the selected profile and any fallback in the worker report. Then arm the nonblocking watch as in the core loop.

Selection IDs expire on reload. Reconcile any already-started worker before selecting again; never repeat a dispatch just to repair assignment history.
