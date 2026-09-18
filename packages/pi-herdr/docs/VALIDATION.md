# Orchestration validation

## Subscription quotas — 2026-09-18

- Built and tested the existing local package: **165 tests in 13 files** pass. Package dry run includes new compiled collectors/cache, schema and quota documentation; `git diff --check` passes. No release version bump or publish.
- New coverage: actual fake-executable boundary, output caps/abort/redaction, missing/malformed/stale windows, source validation, cross-monitor coalescing, 30-minute timer and failure cooldown, private cache, dead/empty/live lock behavior, account selectors, exhaustion between polls, budget-choice suitability/auth/image/protection checks, inspect → select → record reason, and explicit-alias exhaustion blocking.
- Runtime integration tests cover inactive workers not polling, transient context snapshots, deduplicated warnings, no idle model wake, generic 429 vs confirmed exhaustion, and off/deactivation.
- Verified installed CodexBar 0.56.6 supports all three sources. Codex OAuth and Z.ai API worked; Claude OAuth/web were unavailable, but native CLI `/usage` worked. No credentials were copied into Herdr configuration or cache.
- Initial local binding check: saved Pi default Codex account ID matched native Codex; Pi's Z.ai key matched CodexBar's selected `default` token account. This checks saved defaults, not future account switches. Fable workers use the same native Claude source queried by CodexBar.
- Real Pi 0.85.1 RPC smoke loaded the built extension, found `/limits`, activated a disposable orchestrator session, displayed fresh quotas for all three configured groups, reused the cache on a second `/limits`, and switched orchestration off. **Zero assistant/model turns and zero extension errors.** No workers, purchases or reset-credit consumption. Smoke process exited.
- Observed at approximately 06:18 UTC: Astra weekly 43% remaining, reset September 24 (`conserve`, 10-point editable orchestration reserve); Claude shared session 34%/weekly 63% remaining (`surplus`); GLM session 98%/weekly 81% remaining (`surplus`). These are historical acceptance observations, not current balances. No separate Fable-specific allowance was returned and none was fabricated.
- The user's installed Pi package points directly to this checkout; building updates its installed files. The running session needs `/reload` (or a new session) to load the new tool schema and handlers. Local `herdr-routing.json` now opts into the three verified source bindings, retaining baseline shares and suitability.

Limitations: no paid end-to-end model delegation was launched for quota testing; intelligent task judgment is guide-driven and not guaranteed by deterministic tests. Real provider reset transitions, multi-day behavior and automatic account identity synchronization were not tested or claimed. Initial unchanged baseline had one intermittent watch kill-grace assertion failure; isolated and subsequent full runs passed.

## Earlier orchestration validation — 2026-09-17

Validated locally on macOS, Node 24.19.0, Pi 0.85.1, Herdr 0.9.1. Native profile preflight also checked Claude Code 2.1.274 and Codex CLI 0.154.0. This is bounded acceptance evidence, not a cross-platform or model-performance benchmark.

## Automated/package checks

- Baseline: 94 tests in 7 files.
- Final: **130 tests in 10 files**, including activation/context/lifecycle, fresh routing, exact identity/auth/capability/protection filtering, fallback, family history, explicit override, dispatch recording and existing watch behavior.
- 2026-09-18 reload-entry fix: **172 tests in 14 files** (adds `test/entry.test.ts` — shim structure, and a child-process fixture proving initial load → dependency-only rebuild → factory re-invocation picks up the rebuilt bundle, unchanged re-invocations stay pinned, and externals keep host module identity).
- TypeScript `--noEmit`, isolated build, installed local-package build, and `git diff --check` passed.
- Isolated `npm pack --dry-run --json` included compiled entrypoint/helpers, canonical skill, routing schema/example and documentation. No publish/release was performed.
- 2026-09-18: `npm pack` smoke loaded the extracted tarball entry through the shim and confirmed tool/command registration; end-to-end same-process rebuild→reload was verified through the installed Pi loader against an isolated fixture (old-code bundle → new-code bundle, changed behavior, pinned on repeated unchanged reload). The live installed dist was never regressed for verification.
- Source and installed builds were validated separately; the installed checkout was built only after isolated live acceptance passed.

## Real Herdr/Pi acceptance

| Behavior | Observed outcome |
|---|---|
| Fresh `/orchestrate` with skill discovery disabled | Active workflow + route/watch tools; no model request or worker launched by command |
| Repeated activation / unknown arguments | Already-active confirmation; unknown argument rejected without changing state |
| Natural-language activation after off/reload | Model called `herdr_orchestrate`, received canonical guidance, called `herdr_watches`; zero watches and no workers started |
| Disposable delegation 1 | Policy chose Pi GLM-5.3-flash; worker independently checked sum 1..40 = **820**; watch woke coordinator; report read, answer independently verified, worker quit, original shell retained |
| Hot policy edit and delegation 2 | Disabling Flash changed next selection to Pi GLM-5.3 **without another reload/restart**; sum of squares 1..10 = **385** independently checked and delivered; worker quit, shell retained |
| Running worker after restoring policy | Worker session retained `zai/glm-5.3`; changing policy did not restart/reconfigure it. Original policy restored byte-for-byte |
| Reload | Role restored with explicit warning that armed watches were not restored |
| Off | Guidance/tools deactivated; UI explicitly disclosed that workers were not stopped and history was unchanged |
| New conversation | New session ID; `/orchestrate off` confirmed it was already inactive |
| CLI fork from a non-orchestrator parent with env activation set | Inactive despite `PI_HERDR_ORCHESTRATOR=1`; no inherited activation/ownership |
| Normal installed-package startup resuming saved conversation | Existing local package discovered normally (no `-e`); saved activation restored; repeated `/orchestrate` confirmed already active |
| Cleanup | Owned agents quit; shells/panes retained. No unrelated workers or Firstmate panes used |

Both delegated tasks used temporary reports and existing watches, not blocking agent waits. No user reminder was needed to read, verify, deliver, or quit workers.

## Small trial sample

Measured from saved session timestamps, not estimates:

| Task | Request → final answer | Watch settlement → final answer |
|---|---:|---:|
| GLM Flash arithmetic | 102.8 s | 38.1 s |
| GLM arithmetic | 88.7 s | 38.5 s |

The post-watch interval includes report reading, independent verification, graceful exit, shell verification, and delivery. These trivial tasks test workflow mechanics; delegation is not recommended over direct arithmetic. They do not establish model quality, optimal allocation, or a performance advantage over another workflow.

## Recovery decision and limits

The trial demonstrated follow-through without a recovery/follow-through failure. Therefore the plan's conditional task-database slice was **evaluated, not added speculatively**. Session-owned activation and small assignment history are implemented; worker ownership, report evidence and handoff reconciliation remain explicit workflow responsibilities. There is no automatic watch/task restoration or worker restart.

All five policy profiles are representable and have locally checked identifiers/auth configuration; only the two GLM text routes were dispatched by the new routing tool during this smoke. No live image inference, live quota balance, forced allocation ratio, unattended multi-day recovery, broad compatibility matrix, or release pipeline was tested. Existing watch-mode limitations in README remain unchanged.
