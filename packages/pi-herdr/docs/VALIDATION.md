# Orchestration validation — 2026-09-17

Validated locally on macOS, Node 24.19.0, Pi 0.85.1, Herdr 0.9.1. Native profile preflight also checked Claude Code 2.1.274 and Codex CLI 0.154.0. This is bounded acceptance evidence, not a cross-platform or model-performance benchmark.

## Automated/package checks

- Baseline: 94 tests in 7 files.
- Final: **130 tests in 10 files**, including activation/context/lifecycle, fresh routing, exact identity/auth/capability/protection filtering, fallback, family history, explicit override, dispatch recording and existing watch behavior.
- TypeScript `--noEmit`, isolated build, installed local-package build, and `git diff --check` passed.
- Isolated `npm pack --dry-run --json` included compiled entrypoint/helpers, canonical skill, routing schema/example and documentation. No publish/release was performed.
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
