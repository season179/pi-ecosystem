# @season179/pi-hindsight

Thin official-derived Hindsight integration for **Pi 0.87.1**. Product default: **read-write with automatic capture** and automatic first-prompt Reflect (Step 4: Jev-gated periodic Reflect when opted in). This is staging, **not installed or activated**, and does not replace or touch pi-memory. See [provenance and patch list](NOTICE.md).

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

The package deliberately **does not execute** upstream autoInject pages/Recall injection or its Reflect→pages→Recall fallback, autoSeed, Git ingest, surveys, page refresh/setup, manageBankConfig or autoUpdate. Daemon configuration selects its endpoint but does not start/install a daemon. An absent `conversation` retain strategy is left to server defaults; bank/page setup needs its own later review. No extra router/registry exists.

## Automatic retrieval

Runs only in Pi's `before_agent_start` hook, i.e. when an idle `prompt()` starts a new run. Steering/follow-up messages do not trigger it, but they are persisted user entries and count toward cadence. `n` = user-message entries on the active branch plus the new prompt, recomputed from the persisted branch (resume/branch/fork follow it; no special resumed-session Reflect).

| `n` | Action |
|---|---|
| 1 | **Initial**: one `low`-budget Reflect of the current prompt, ungated (official default) |
| 5, 9, 13 … (`(n-1) % 4 === 0`) | **Periodic**: Jev Noul ≥ 0.7 → one `low` Reflect; negative/unavailable → nothing |
| other | nothing |

Because steering/follow-ups also increase `n`, a periodic value can be skipped; cadence is not "every four hook calls". Mid-run tool loops get no automatic retrieval; use `hindsight_reflect`. **Jev decides timing only**: it never sees, filters or scores the Reflect answer, and never affects capture/retention. It cannot certify Reflect's correctness.

**Injection.** A positive result is returned as a persisted, displayed `custom_message` (`pi-hindsight-context`) placed after the user prompt, using the same untrusted-evidence framing as tools, at most **4,000** redacted characters. It is sent once and then remains ordinary branch context; it is never evidence for capture, and exact copies of the delivered text in later assistant replies are omitted from capture (same chronological echo rule as tool results). An empty answer, or content identical to an injection already on the branch, is not injected. At most **8** injections per active branch.

**Latency and budgets.** Before each run the network wait is ≤ **8 s** in total (one shared deadline; only small local config/key reads are outside it): Jev ≤ `min(typesafe.timeoutMs, 2000)` ms, automatic Reflect ≤ `min(official reflectTimeoutMs, 6000, time left)` ms; both use a wall-clock race that also bounds fetches ignoring abort. Deliberate tool deadlines are unchanged. **Esc cannot cancel this pre-run wait** (Pi supplies no run signal before the run starts); session switch/tree/shutdown does. Per extension activation at most **8 automatic Reflect attempts** and **32 Jev attempts**, counted before each request, including empty/duplicate/failed results; session switches do not reset them, but reload/restart re-activates the extension and does. This bounds calls per process activation, not lifetime cost.

**Failure.** Any Jev/Hindsight failure (timeout, HTTP, invalid/incomplete response) uses up that opportunity with **no retry** and pauses all automatic retrieval for **10 minutes**. A session change during the wait discards the result without a pause; a mode/bank/endpoint change is rejected as stale and, conservatively, also pauses. There is no pages/Recall fallback and no deterministic substitute for an unavailable gate.

**Configuration.** Mode `off` makes zero config/HTTP/Jev access. Official `autoInject: "reflect"` (default) enables retrieval; `"none"` (or deprecated `autoReflect: false`) disables it; `"pages"`/`"recall"` **disable it with a status message** rather than substituting Reflect or Recall. `recallOptions` is unused. The periodic gate additionally needs the shared `<agentDir>/typesafe.json` (as used by Buddy/Herdr/pi-memory) with a dedicated section and a key (`TYPESAFE_API_KEY`, then `apiKeyFile`):

```json
{ "model": "jev-1.13.0", "timeoutMs": 2000, "apiKeyFile": "typesafe.key", "hindsight": { "enabled": true } }
```

Absent file/section or key → periodic gate off (initial still runs); malformed → gate off with status. The endpoint is pinned to `https://api.typesafe.ai`, SDK logging off, retries 0. Jev receives the redacted current request, the last six visible branch messages (context edits honored, 1,500 chars each) and the last two injected memory texts. **This sends conversation excerpts to TypeSafe**; enable it only if that is acceptable. Cadence, threshold, caps and cooldown are constants pending Stage 6 evaluation. No telemetry is recorded; `/hindsight` shows the last retrieval outcome.

**Legacy internal Recall preference.** Explicitly reconciled as *not delivered*: automatic paths use Reflect only, no Recall tool exists, and configured Recall/pages injection is refused instead of approximated. Revisit only if evaluation shows Reflect misses cases that Recall recovers, under separate approval.

## Tools

| Tool | Operation |
|---|---|
| `hindsight_reflect` | Deliberate synthesized answer, bounded and abortable |
| `hindsight_search_knowledge_pages` | Search existing official pages; returns page IDs/snippets |
| `hindsight_read_knowledge_page` | Read an existing page; no generation/refresh |
| `hindsight_retain` | Explicit evidence extraction; identical redacted content within a session deduplicates |
| `hindsight_manage_fact` | Inspect/edit/invalidate/revert one identified world/experience fact |

There is **no raw Recall**, broad delete, page-generation or migration tool. Curation requires the inspected fact's exact original text and document ID, rechecks them before PATCH, and reads back the requested change. Invalidation is reversible. **Permanent deletion is unavailable** because the verified API has no single-fact DELETE; it never falls back to document/bank/supporting-fact deletion. If a safe endpoint is later added, it still needs a separate explicit human confirmation design.

Retain reports **accepted**, not completed extraction/consolidation. Curation verifies the fact change only: it does not rewrite the source, scrub Pi transcripts, or prove observations/pages fresh. Other sessions/harnesses can replay old evidence. This session's auto-capture is durably blocked before curation, including on an uncertain PATCH outcome; there is no automatic unblock. No page or injected-memory cache is maintained.

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
