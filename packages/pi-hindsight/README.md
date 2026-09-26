# @season179/pi-hindsight

Thin official-derived Hindsight integration for **Pi 0.87.1**. Product default: **read-write with automatic capture**, initial automatic Reflect and opted-in Jev-gated periodic Reflect. Automatic memory is best effort, **not guaranteed in the first answer**. See [provenance and patch list](NOTICE.md).

**Local rollout, 2026-09-26:** installed from this workspace; updated Claude source-curation guard installed. Fresh-host/live-service acceptance is still in progress. The old pi-memory writer is disabled but its package and original data remain. Migration has two unresolved provider-rate-limit failures; live model acceptance tests are paused. Replacement installation is not migration completion or permission to uninstall the old package.

## Activation boundary

**Do not install or load this into a live session while the old writer remains active.** After separate cutover approval, disable the old writer before loading this package normally. Normal users need no activation flags. Any isolated staging host must explicitly use `--hindsight-mode off`; only credential-free mocked tests deliberately exercise the read-write default.

- `--hindsight-mode read-write` (default): automatic completed-conversation capture, explicit Retain, curation and deliberate reads. Official `retainSessions: false` still disables automatic capture.
- `--hindsight-mode off`: all memory operations denied, including config/HTTP access.
- `--hindsight-mode read-only`: deliberate Reflect, existing page/fact reads and automatic retrieval only; no capture, Retain or curation. Queries still go to the configured service and Reflect can invoke its model.
- `/hindsight`: show status only; cannot activate memory or modify configuration.

There is one mode control, no separate capture opt-in flag. The extension factory itself starts no HTTP, config reads, seeding, installs or background work, but a completed reply in default mode **will** capture. No settings/install command is needed for building/testing. Worker hosts that load this extension must explicitly use off/read-only when capture is not intended; no worker detector is invented.

## Configuration and routing

Uses the official `~/.hindsight/coding-agent.json` (or `HINDSIGHT_CONFIG`): defaults → environment fallback → file → `harnesses.pi`, then `banks.<resolved-id>`. Official `mapPathToBank`, static bank IDs, worktree-aware default resolution, opt-in rules, bank overrides, tags/metadata, endpoint/auth, observation scopes, Reflect budget/timeout and page-search limit are retained. The legacy `pi-memory` bank is explicitly blocked.

An explicit effective endpoint is required before any HTTP: supply `apiUrl` through the official environment/file/harness/bank layers, or deliberately choose `serverMode: "cloud"` or `"daemon"` for its official endpoint. Missing config, implicit Cloud defaults, and `serverMode: "self-hosted"` without a URL fail closed with status, not an upload. Bank overrides must authorize the actual effective URL; a mode-only override that leaves a different implicit URL is refused. Review the endpoint before installation/loading: even a loopback Hindsight service may send text to remote models. Read-only describes memory mutations, not network/cost-free operation. Redaction is best effort, not a secret-detection guarantee.

The package deliberately **does not execute** upstream autoInject pages/Recall injection or its Reflect→pages→Recall fallback, autoSeed, Git ingest, surveys, page setup, manageBankConfig or autoUpdate. Daemon configuration selects its endpoint but does not start/install a daemon. An absent `conversation` retain strategy is left to server defaults. No extra router/registry exists.

**Recommended shared-file settings** (they also govern Claude): `autoSeed: false`, `gitIngest: "none"`, `codebaseSurvey: false`, `autoUpdate: false`. Official `autoSeed` does more than page setup: its detached `deepen.js` imports every past host conversation for the repository and ingests git history.

**Bank and Knowledge Page setup** is an explicit operator step, run once per destination bank (and again after adding a `mapPathToBank` entry for a new Pi-first repository):

```sh
node packages/pi-hindsight/scripts/setup-bank.mjs --repo <path>   # repository must be explicitly mapped
node packages/pi-hindsight/scripts/setup-bank.mjs --global        # global bank below
```

It runs the installed official 0.7.0 `deepen.js` with a private copy of the config that forces `retainSessions: false`, `gitIngest: none`, `autoSeed`/`codebaseSurvey`/`autoUpdate` off. So only the official additive bank config and predefined page seeding run. Then it lists the bank's pages.

**Pre-cutover guard.** `harnesses.pi.captureSince` (ISO time; a local key that official hosts ignore) skips automatic capture for sessions whose header predates it, with status. This stops a resumed pre-cutover session replaying history the legacy writer already captured. A malformed value blocks automatic capture. Explicit Retain is unaffected.

Claude gets the same guarantee from `scripts/claude-stop-guard.mjs`, which replaces the official Stop command in `~/.claude/settings.json`. It is installed as one bundled file carrying the vendored 0.7.0 config and bank resolution:

```sh
npm run build -w @season179/pi-hindsight
node packages/pi-hindsight/scripts/bundle-claude-guard.mjs ~/.hindsight/pi-hindsight/claude-stop-guard.mjs   # 0600
node ~/.hindsight/pi-hindsight/claude-stop-guard.mjs --official ~/.hindsight/coding-agents/dist/claude-stop-hook.js --sha256 <pinned hash>
```

It reads `harnesses["claude-code"].captureSince` from the same official file. Only when the transcript's earliest timestamp is at or after that cutoff does it forward the unchanged hook stdin to the pinned official hook. A resumed Claude session appends to its original transcript, so the earliest entry is the original start.

**Curated sources are not replayed.** Re-retaining an unchanged source re-extracts claims that were edited or invalidated; the Stage 6 baseline measured this. Before any append, both harnesses therefore read the facts of the session's own source document (`conversation:<session>`) in the bank the host resolves:
- live facts come from `GET …/memories/list?document_id=…`, checked for `edited_at`;
- archived facts come from the same listing with `state=invalidated`.

The read is bounded: 200 facts per page, at most 5,000, and every item must match the filter. If any fact was curated, capture is refused, whichever session or harness did the curation.
- **Pi** records the refusal as a durable block in the session's checkpoint; the existing cursor is preserved.
- **The Claude guard** resolves the bank exactly as the official Stop hook does. It reads the recorded session root without writing it.

A failed, oversized or unfiltered read also refuses capture. A permanently deleted fact leaves no trace, so this cannot prevent resurrection after external deletion.

Anything uncertain is skipped with exit 0 and a metadata line in `~/.hindsight/coding-agents-logs/stop-guard.jsonl`, which rotates at 2 MiB to one `.1`. That covers:
- a missing or invalid cutoff;
- an undated or unreadable transcript;
- entries from another session (fork);
- an unresolved destination, curated source facts or a failed curation read;
- an official hook whose hash changed, which needs re-review and a new pin;
- hook input over 1 MiB or a transcript over 256 MiB. Every one of the 217 current real transcripts passes.

Fresh sessions are captured exactly as before. SessionStart and UserPromptSubmit stay official and unwrapped.

**Remote-less repositories** use explicit bank names with a path-hash suffix, for example `coding-agent::local:<name>-<first 8 hex of sha256(realpath)>`. Two same-named directories therefore never share a bank. `$HOME` and `~/.pi` are never mapped.

**Global cross-project memory (read-only).** If `~/.hindsight/coding-agent-global.json` (or `HINDSIGHT_GLOBAL_CONFIG`) exists, it must name one static `bankId`, no `mapPathToBank`, an explicit endpoint, and not `pi-memory`. Automatic retrieval then runs the project and global Reflect in parallel under the same bounded foreground wait, 90-second maximum total background lifetime and attempt budget, but only while the global file's own `autoInject` is `reflect`; its endpoint, bank, mode, `autoInject` and `observationScopes` are part of the frozen retrieval snapshot, so a mid-flight change rejects the result. `hindsight_reflect` accepts `scope: "global"`. Capture, Retain, curation and pages never target the global bank, and a repository that resolves to it is refused. A broken or failing global config never blocks project retrieval. Global is relevance-based: the legacy guaranteed `always` injection no longer exists. The same file serves Claude through a second official UserPromptSubmit hook (with `HINDSIGHT_CONFIG` pointing at it and a separate `TMPDIR`) and a second MCP server with its write tools denied.

## Automatic retrieval

Starts in Pi's `before_agent_start` hook, i.e. when an idle `prompt()` starts a new run. Steering/follow-up messages do not trigger it, but they are persisted user entries and count toward cadence. `n` = user-message entries on the active branch plus the new prompt, recomputed from the persisted branch (resume/branch/fork follow it; no special resumed-session Reflect).

| `n` | Action |
|---|---|
| 1 | **Initial**: one `low`-budget Reflect of the current prompt, ungated (official default) |
| 5, 9, 13 … (`(n-1) % 4 === 0`) | **Periodic**: Jev Noul ≥ 0.7 → one `low` Reflect; negative/unavailable → nothing |
| other | nothing |

Because steering/follow-ups also increase `n`, a periodic value can be skipped; cadence is not "every four hook calls". Mid-run tool loops can receive the already-started result at a natural next turn; they never start another retrieval or induce a model turn. Short one-answer requests may finish without memory. Use `hindsight_reflect` when consultation must precede the answer. **Jev decides timing only**: it never sees, filters or scores the Reflect answer, and never affects capture/retention. It cannot certify Reflect's correctness.

**Injection.** With a global bank configured, the message has labelled `Repository memory` / `Global cross-project memory` sections, each within an equal share of the limit. If one Reflect fails, the other still injects and retrieval pauses as below. A positive result becomes a persisted, displayed `custom_message` (`pi-hindsight-context`), using the same untrusted-evidence framing as tools. Its redacted evidence payload is limited to **4,000** characters; JSON escaping and the framing add overhead. A fast result appears after the user prompt; a late result is staged after a completed tool-bearing turn. Before a late result first enters model context, the originating user entry must still be the current, unchanged request on the same lineage, with unchanged original/gate inputs and authorized mode/config/scopes. Natural assistant/tool progress does not invalidate that snapshot. Steering/new input, edits, missing effective request context, expiry or lost ownership refuse delivery. A small persisted receipt means **released to model context**, not that the provider received or used it. Unreleased drafts never become model context after restart and never strip assistant evidence. Echo exclusion starts chronologically at release (fast/legacy messages retain their existing behavior), so earlier capture prefixes remain unchanged. Released content remains ordinary branch context; local curation persistently filters prior automatic injections without erasing their historical echo provenance. Aborting a staged release also filters it from subsequent requests. An empty answer, or content identical to an injection already on the branch, is not injected. At most **8** injections per active branch.

**Foreground deadline.** Initial retrieval waits at most **6 seconds** for Reflect. Periodic retrieval allows at most **2 seconds total** for gate/key reads and Jev, then at most 6 seconds for Reflect. The hook returns even when transport ignores abort. Jev cannot dispatch later from an expired gate window. Foreground Reflect expiry means **pending**, not failure: the same request continues, without resubmission. Synchronous local config/git work cannot be timer-interrupted. Esc cannot cancel the pre-run wait because Pi supplies no active-run signal yet; session changes/shutdown do.

**Background deadline.** At most one owned opportunity, with parallel project/global legs, exists until delivery or final settlement. Each Reflect obeys `min(reflectTimeoutMs, 90000)` milliseconds, measured from its original dispatch, never an extra 90 seconds after the foreground wait. The combined result can wait for the slower leg; failed legs leave successful content available. Late delivery only happens at an existing tool-turn boundary and a fresh same-request context check: no steering, follow-up, induced turn or carry to a new prompt. Final settlement, run abort, session/tree/fork change, curation or shutdown cancels pending work. Shutdown joins owned work for at most one second. Timers/listeners are disposed. Remote model cancellation is **not guaranteed** by client abort.

The official default timeout is 20 seconds. The local rollout sets `harnesses.pi.reflectTimeoutMs: 90000` in both project and global configs; it does not extend foreground waiting, change Claude's timeout, change the service model, or restart the service. Lower configured deadlines remain respected. Deliberate tool deadlines remain separately configured.

**Budgets.** At most **8 automatic Reflect requests** and **32 Jev requests** per activation, counted before dispatch, including failed/empty/duplicate results; project/global each count. Session switches do not reset these counts; reload/restart does. At most 8 staged/injected messages per branch. Low Reflect budget, no retry. These bound request count and local lifetime, not lifetime dollars or already-started remote work.

**Failure.** Jev failure or an actual Reflect failure/deadline uses the opportunity with **no retry**, pausing automatic retrieval for **10 minutes**. Foreground detachment and final-settlement cancellation do not count as service failures. Each opportunity freezes mode, endpoint, bank, `autoInject`, observation scopes and deadlines, rechecked before dispatch and delivery; stale work is refused. There is no pages/Recall fallback or deterministic substitute for an unavailable gate.

**Configuration.** Mode `off` makes zero config/HTTP/Jev access. Official `autoInject: "reflect"` (default) enables retrieval; `"none"` (or deprecated `autoReflect: false`) disables it; `"pages"`/`"recall"` **disable it with a status message** rather than substituting Reflect or Recall. `recallOptions` is unused. The periodic gate additionally needs the shared `<agentDir>/typesafe.json` (as used by Buddy/Herdr/pi-memory) with a dedicated section and a key (`TYPESAFE_API_KEY`, then `apiKeyFile`):

```json
{ "model": "jev-1.13.0", "timeoutMs": 2000, "apiKeyFile": "typesafe.key", "hindsight": { "enabled": true } }
```

Absent file/section or key → periodic gate off (initial still runs); malformed → gate off with status. The endpoint is pinned to `https://api.typesafe.ai`, SDK logging off, retries 0. Jev receives the redacted current request, the last six visible branch messages (context edits honored, 1,500 chars each) and the last two injected memory texts. **This sends conversation excerpts to TypeSafe**; enable it only if that is acceptable. Cadence, threshold, caps and cooldown are constants pending Stage 6 evaluation. `/hindsight` shows the last retrieval outcome.

**Telemetry.** `<agentDir>/hindsight-telemetry.jsonl` (0600, rotates at 2 MiB to one `.1`, nothing when mode is `off`). A pre-existing current or rotated file with broader permissions is repaired to 0600 before each write; the Claude guard's log follows the same policy. It holds metadata only: tool/outcome/timing, retrieval trigger, gate decision, Reflect count and injected character count. For capture it records retain `accepted`/`unchanged`/`blocked`/`not_sent`/`skipped_pre_cutover` separately from prior extraction `completed`/`pending`/`failed_or_unknown`. Consolidation is always `not_observed`, because the API exposes no per-document signal. It never records prompts, answers, memory text or credentials.

**Legacy internal Recall preference.** Explicitly reconciled as *not delivered*: automatic paths use Reflect only, no Recall tool exists, and configured Recall/pages injection is refused instead of approximated. Revisit only if evaluation shows Reflect misses cases that Recall recovers, under separate approval.

## Tools

| Tool | Operation |
|---|---|
| `hindsight_reflect` | Deliberate synthesized answer, bounded and abortable; `scope: project` (default) or `global` (read-only) |
| `hindsight_search_knowledge_pages` | Search existing official pages; returns page IDs/snippets |
| `hindsight_read_knowledge_page` | Read an existing page; no generation/refresh |
| `hindsight_retain` | Explicit evidence extraction; identical redacted content within a session deduplicates |
| `hindsight_manage_fact` | Inspect/edit/invalidate/revert one identified world/experience fact |

There is **no raw Recall**, broad delete, page-generation or migration tool. One-off legacy migration uses the local operator script `scripts/migrate-legacy.mjs` (not shipped):
- It is a dry run by default and writes a content-free manifest.
- `--apply --expect <dry-run manifest>` recomputes the plan before any write and refuses unless every source, hash, destination, quarantine, operation ID and expected payload matches the reviewed dry run.
- Each manifest row carries the expected SHA-256 of the exact redacted payload plus tag and metadata hashes.
- Apply requires the complete retired-note inventory and destination banks that store text verbatim (`memory_defense` unset).
- An existing document is either verified identical or reported as a conflict, never skipped or overwritten.
- `--verify` exits nonzero unless every imported item is present, byte-identical and extracted. Curation requires the inspected fact's exact original text and document ID, rechecks them before PATCH, and reads back the requested change. Invalidation is reversible. **Permanent deletion is unavailable** because the verified API has no single-fact DELETE; it never falls back to document/bank/supporting-fact deletion. If a safe endpoint is later added, it still needs a separate explicit human confirmation design.

Retain reports **accepted**, not completed extraction/consolidation. Curation verifies the fact change, then requests a refresh of up to 10 of the bank's Knowledge Pages, reported as "refresh requested; freshness not verified". It does not rewrite the source, scrub Pi transcripts, or prove observations/pages fresh. Other sessions/harnesses can replay old evidence. This session's auto-capture is durably blocked before curation, including on an uncertain PATCH outcome; other sessions and Claude refuse to replay a source with curated facts (see above). There is no automatic unblock. No page cache or cross-request retrieval cache is maintained. Curation cancels pending automatic retrieval without aborting the curation operation itself, and records text-free invalidation of this session's earlier automatic injections. Those injections remain visible historical records and retain echo provenance, but are no longer fed to the model. This does not rewrite sources, remove earlier assistant restatements, or invalidate other sessions' context.

## History and failure behavior

Capture runs at Pi's final `agent_settled` boundary. It reads the current persisted session JSONL, validates its session/header/active parent chain against `SessionManager`, and retains original user/assistant text, roles, statement timestamps and entry IDs. Compaction summaries do not replace original evidence; context edits are respected. It never uses run-local `agent_end.messages`, a tail-truncated transcript, or an in-memory-only history accumulator.

The official document is `conversation:<sessionId>`, strategy `conversation`, tags `source:chat`/`harness:pi`, context `coding agent session`, configured observation scopes (default shared). The official UUIDv5 identity covers bank, document, append mode and content. A small non-context Pi custom entry holds the official cursor plus the outstanding operation ID. On resume, extraction must be verifiably completed before appending another interval; the stored document must match the expected prefix. The adapter never replaces existing documents or retries uncertain writes.

Supported: straight-line multi-run sessions, reopen/resume, compaction, returning to the already-retained lineage. Deliberately fail-closed:

- Divergent branch, rewind/source-edit that changes the retained prefix; old branch evidence stays untouched. No suffix-document scheme is invented.
- Fork/clone ancestry (avoids treating copied history as fresh corroboration), ephemeral `--no-session`, incomplete reply, torn/invalid JSONL, missing cursor for an existing document, destination drift, changed remote source, failed/pruned/unknown operation.
- Session JSONL over **8 MiB**, or full sanitized evidence/payload over **256 KiB**. No destructive truncation fallback.
- Concurrent/interrupted capture lock. A transient adjacent `.pi-hindsight.lock` excludes concurrent writers; a crash leaves it fail-closed. Review the pending operation and ensure no writer runs before an operator removes a stale lock. Do not erase cursor entries or reset documents to bypass a safety refusal.

Pending extraction is checked on the next completed reply; there is no polling daemon or new telemetry system. Automatic capture has a 10-second request budget, tool work a bounded configured deadline, and shutdown cancels owned work with at most a one-second wait. A server mutation may already have been accepted when cancellation occurs; status never claims it was undone.

## Privacy and attribution

Exclude raw tool inputs/results, thinking, system/custom messages and generated summaries. Strip known official and pi-memory injection wrappers before processing; redact common credential patterns before outbound queries/content/tags/metadata. Retrieved content is framed as untrusted historical evidence, not authority. Exact retained/retrieved strings from this package's tool results are excluded only from **subsequent assistant text** on the active branch. Later results never rewrite earlier evidence, and primary user statements are preserved before and after retrieval. Semantic paraphrases are **not** detected. Explicit-Retain deduplication does not promise cross-path deduplication of primary user evidence also captured automatically. Jev never selects spans or classifies retention; Hindsight performs extraction.

## Offline validation

From the workspace root:

```sh
npm run build --workspace @season179/pi-hindsight
npm run check --workspace @season179/pi-hindsight
npm test --workspace @season179/pi-hindsight
npm --offline pack --workspace @season179/pi-hindsight --dry-run --ignore-scripts
```

The repo currently has Pi 0.80.10. Local check scripts instead resolve an **already installed 0.87.1** from the Node prefix, or `PI_HINDSIGHT_PI_ROOT`. No installation, root dependency upgrade or machine-specific path is bundled. Pi/TypeBox are peers; the only runtime dependency is the official `@typesafe-ai/sdk` (already used by the other Jev consumers here). Jev calls in tests use a mocked SDK `fetch`. Tests strip inherited credential variables, deny live HTTP, use temporary files/config and a synthetic provider with the real Pi SDK lifecycle; no live extensions/models/banks are loaded. Mocked document/extraction behavior is not a live-server extraction or cross-harness guarantee.
