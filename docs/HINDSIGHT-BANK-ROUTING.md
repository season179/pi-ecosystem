# Hindsight bank routing

Status: 2026-09-26. **Stage 2 is complete for this repository only.** Other repositories, cross-project/global knowledge and default policies remain open. See the [plan](PI-HINDSIGHT-PLAN.md) and [audit record](HINDSIGHT-DATA-AUDIT.md).

## Current mapping

- `~/.hindsight/coding-agent.json` (mode 0600) keeps the self-hosted `http://127.0.0.1:8888` endpoint. One official `mapPathToBank` entry was added:
  `"/Users/season/Others/pi-ecosystem": "coding-agent::season179:pi-ecosystem"`.
- The prior file was backed up privately before an atomic write. No other keys or configuration changed.
- The bank was created empty with one `PUT /v1/default/banks/coding-agent%3A%3Aseason179%3Api-ecosystem` body `{}`. The verified state is: no overrides, no documents, no memory units, no pages or mental models, and no operations.
- Nothing was retained, imported, seeded, surveyed, reflected or consolidated. No model calls were made.
- This step did not modify the old mixed-project `pi-memory` bank or its writer. The existing pi-memory package continues writing there. **Current Pi is not shared.** Sharing starts only when the replacement package is cut over.

## Resolver and config contract

Both harnesses must read the same file through the official 0.7.0 code (`src/core/config.ts`, `src/core/bank.ts`); there is no separate router or registry.

- Config layering: built-in defaults, then `HINDSIGHT_*` environment fallbacks, then the file's top level, then `harnesses.<name>`. `banks.<id>` applies after resolution. There is no project-local config, and `mapPathToBank` is file-only.
- Resolution order:
  1. `mapPathToBank`. The longest matching path prefix wins, checked against both the literal directory and its main-worktree root.
  2. A static `bankId`.
  3. The template `coding-agent::{gitProject}`.
- The Pi replacement uses `loadConfig({harness: "pi"})`, `deriveBankIdOrSkip(cfg, cwd, "pi", sessionRoot)` and `applyBankConfig`. If the repository probe fails, it skips instead of guessing.

## Worktree and subdirectory behaviour (verified with the installed resolver, claude-code and pi)

| Directory | Bank |
|---|---|
| Repository root, any subdirectory | `coding-agent::season179:pi-ecosystem` |
| Linked worktree of this repository | same, through its main-worktree root (verified on a scratch fixture; no real worktree exists) |
| Unrelated repository also named `pi-ecosystem` | `coding-agent::pi-ecosystem` (isolated) |
| Other repositories | the basename default, e.g. `coding-agent::pi-jev` |

## Limitations

- The mapping is keyed to the absolute path. Moving or recloning the repository elsewhere falls back to the basename default until the map is updated.
- Another Git repository nested under this path would inherit the mapping. None exists today.
- Unmapped repositories still share banks by basename. Map each one explicitly before relying on it.
- For a mapped bank, official page scoping names the bank id rather than the repository. This is cosmetic.

## Retain compatibility for the Pi replacement

The Pi replacement must match the official conversation documents so both harnesses build one bank:

- **Document:** id `conversation:<sessionId>`, strategy `conversation`, context `coding agent session`.
- **Tags:** configured `retainTags` first, then `source:chat` and `harness:pi`.
- **Metadata:** `{source: "chat", session_id, ref_id, harness: "pi"}`. The built-in keys win.
- **Request:**
  - `async: true`
  - `observation_scopes: "shared"`, the official default. Scopes are sent per retain; they are not a bank setting.
  - `update_mode: "append"` for incremental turns.
  - `operation_id` = uuidv5 of bank, ref id, mode and content.
- **History fix:** the package must carry the fix for run-local messages replacing the cumulative conversation document. See the audit record.
- **Deferred to later stages:** Git commits (`git:<sha>`, `source:git`), the commit log (`gitlog:<repo>`, `source:git` + `source:git-log`), uploads (`source:upload`), survey markers (`source:survey-baseline`), Knowledge Pages and bank manifest seeding. Seeding stays with official `manageBankConfig`, which adds only what the bank lacks.

## Defaults caution and activation

- Official Claude hooks are registered globally with defaults `autoSeed`, `codebaseSurvey` (headless `claude -p`), page seeding with hourly refresh, `retainSessions` and `autoUpdate`. These defaults are unchanged and no gates were added.
- The first ordinary Claude session here will configure the new bank and start Git backfill, a survey, pages and LLM extraction. Decide defaults before that session. Test in safe mode until then.
- Hooks read the config on each run. A running MCP server may still hold the old config, so tools need a fresh session or MCP reconnect. That fresh session triggers the hook side effects above.
