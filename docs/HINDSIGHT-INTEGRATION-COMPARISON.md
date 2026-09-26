# Should Pi and Claude Code use the official Hindsight integration?

2026-09-25. Research only; no installation, runtime changes, bank writes or public issue filing authorized or performed.

> **Superseded direction (2026-09-26):** The current [pi-hindsight plan](PI-HINDSIGHT-PLAN.md) selects a new official-derived Pi package replacing pi-memory, not an adapted custom pi-memory adapter, alongside official Claude integration and Jev-gated Reflect. Its current-state section records the completed Claude configuration repair and verification limits. Recommendations below are historical; source findings remain evidence. The 0.7.0/Pi 0.87.1 history defect is source-traced, not yet reproduced in an executable test. Implementation is not authorized here.

## Recommendation

**Do not switch production now. Evaluate upstream before committing to another custom adapter.** Cross-harness project memory is a strong reason to prefer a maintained shared integration if it meets our needs. Keeping Pi-only automation forever does not solve Claude Code continuity. Conversely, installing upstream on Claude alone while Pi retains its current bank gives us two disconnected memory systems.

The official Pi adapter has a source-verified session-history replacement defect against installed Pi 0.87.1. Resolve and regression-test that before a two-harness trial. A small Claude-only sandbox trial could evaluate its capture and tools sooner, but cannot demonstrate Pi/Claude continuity.

The research worker recommended extending our custom core to Claude immediately. The coordinating assessment, challenged in independent review, **defers that build**: its maintenance cost is unjustified until we test whether upstream plus narrow fixes/configuration is sufficient.

## Evidence and version

Audited published `@vectorize-io/hindsight-coding-agents` **0.7.0**, including its distributed Pi bundle, and matching [source commit 0c0869b](https://github.com/vectorize-io/hindsight/tree/0c0869b7321c836d4f902d1f6ef8b5c8b432a2c4/hindsight-integrations/coding-agents). Package/source fetched into `/tmp` without executing package code or install scripts. Compared local pi-memory working-tree source and installed Pi 0.87.1 loop. No end-to-end upstream integration tests or quality/cost trials were run.

Primary product reference: [Coding agents integration](https://hindsight.vectorize.io/sdks/integrations/coding-agents). See [Hindsight study](HINDSIGHT-STUDY.md) for our existing integration and server behavior.

## What we gain and what changes

| Area | Official integration | Our current integration |
| --- | --- | --- |
| Harnesses | Pi native extension/tools; Claude hooks plus MCP; one repository bank shared across harnesses | Pi automation only |
| Maintenance | Shared upstream implementation across many harnesses | We own lifecycle, capture, retrieval and tests |
| Evidence capture | Broad conversation capture, optional/background git ingestion and codebase survey | Selected, bounded, redacted spans judged by Jev |
| Retrieval | First-prompt synthesis by default; knowledge-page search/read and on-demand Reflect tools | Gated raw/observation recall; deliberate `recall` only searches manual files |
| Scope | Repository banks; default bank name uses repository basename | One Pi-owned bank with strict project/user-wide/transferable tag policy |
| Curated memory | No equivalent to our manual file-store system | Explicit `remember`/`recall` and controlled always-injection |

Official page search is **not** a raw-memory recall tool. Its existing tools do not directly implement the deliberate scoped fact search proposed in our improvement plan.

Default upstream behavior includes automatic session retain, bank configuration management, git seeding, codebase survey, Reflect injection, knowledge-page refresh and automatic runtime updates. These are documented/configurable choices, not inherently defects—but they change processing, latency, retained content and recurring cost. A local Hindsight endpoint does not make remote model processing local.

No client-side secret redaction was found in the capture paths reviewed. Treat that as a gap to test or address, not proof that every server configuration exposes secrets. Our own redaction is also best effort.

## Pi blocker: run-local messages used as a cumulative document

Source paths below are relative to `hindsight-integrations/coding-agents/src/` at the pinned commit:

1. `harness/pi-extension.ts:144–147` passes `agent_end.messages` into `readPiMessages` and then `core.onTranscript`.
2. Installed Pi's `pi-agent-core/dist/agent-loop.js:43–57,152,182,207` emits only the current run's new messages, not the full session history.
3. `core/runtime.ts:233–246,310–352` passes those turns onward without accumulating prior runs.
4. `core/retain-cursor.ts:110–127` chooses replacement when the transcript no longer extends the previous prefix.
5. `core/chat.ts:242–316` writes that replacement under the same `conversation:<sessionId>` document ID.

**Result:** successive distinct runs can replace earlier Hindsight conversation content and its extracted memories with only the latest run. This concerns the Hindsight copy, not deletion of Pi's local session file. Confirm with a deterministic two-run mocked-client regression, then an approved disposable-bank test before migration or public bug reporting. Claude's hook path reads a cumulative transcript file and does not have this specific adapter mismatch.

The Pi tool wrapper also omits the host cancellation signal (`harness/pi-extension.ts:103–107`). Long Reflect calls therefore have no forwarded user-abort signal through this wrapper. It has no integration with our custom `/pi-memory` read-only/off controls; that is a policy compatibility issue, not a claim that upstream violates a standard Pi memory-mode API.

## Shared-bank and worker constraints

- **Never point upstream at our existing `pi-memory` bank unchanged.** Its whole-bank synthesis, `shared` observation scopes, different tags and bank-configuration writes are incompatible with our controlled-write invariants. A pilot needs separate banks.
- Default `coding-agent::{gitProject}` uses a basename (`core/bank.ts:176–196`). Repositories with the same basename need explicit distinct mappings; do not assume globally unique project identity.
- Standalone Claude worker processes are ordinary sessions to the hooks. Their orchestrator briefs and intermediate conclusions can become memory. The hook disable environment switch can suppress automatic worker capture/injection; explicit tools are a separate surface. Decide worker policy deliberately rather than confusing worker instructions with the human user's preferences.
- Our custom Pi automation also lacks an explicit worker-specific suppression policy. This is not solely an upstream weakness.
- Keep curated manual file memories under either option. If upstream eventually takes over automatic Hindsight capture, disable our automatic capture path to avoid two writers; retaining manual tools is a separate decision. Test behavior across both harnesses rather than assuming Claude can already access those files through the same tools.

## Proposed evaluation, not an approved rollout

1. Reproduce and fix/track the Pi adapter defect; confirm cancellation behavior. No public issue has been filed.
2. Use the existing self-hosted endpoint, an explicit non-sensitive repository allowlist and a new uniquely mapped bank; pin the audited package version.
3. Start with automatic updates and codebase survey disabled, retrieval rather than automatic Reflect, and explicitly reviewed git/page-refresh/capture settings. Validate the effective configuration before enabling anything; do not blindly copy a partial sample.
4. Exclude standalone workers from automatic capture initially. Define redaction and provenance requirements, including assistant proposal versus completed work.
5. Test Pi → Claude and Claude → Pi recall, two-run session retention, unrelated-query abstention, project isolation, worker exclusion, shutdown/abort, actual latency and provider usage.
6. Prefer upstream adoption if these pass with small maintainable changes. Build a custom Claude adapter only if a material requirement still cannot be met. Cross-project preferences and transfer lessons need a deliberate policy because repository banks do not reproduce our current broad-scope behavior automatically.

No migration, history import, provider change or existing-memory curation is implied. Existing manual memories and the current production bank remain untouched.
