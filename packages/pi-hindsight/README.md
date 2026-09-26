# @season179/pi-hindsight

Thin official-derived Hindsight integration for **Pi 0.87.1**. Product default: **read-write with automatic capture**. This is Stage 3 staging, **not installed or activated**, and does not replace or touch pi-memory. See [provenance and patch list](NOTICE.md).

## Activation boundary

**Do not install or load this into a live session while the old writer remains active.** After separate cutover approval, disable the old writer before loading this package normally. Normal users need no activation flags. Any isolated staging host must explicitly use `--hindsight-mode off`; only credential-free mocked tests deliberately exercise the read-write default.

- `--hindsight-mode read-write` (default): automatic completed-conversation capture, explicit Retain, curation and deliberate reads. Official `retainSessions: false` still disables automatic capture.
- `--hindsight-mode off`: all memory operations denied, including config/HTTP access.
- `--hindsight-mode read-only`: deliberate Reflect and existing page/fact reads only. Queries still go to the configured service and Reflect can invoke its model.
- `/hindsight`: show status only; cannot activate memory or modify configuration.

There is one mode control, no separate capture opt-in flag. The extension factory itself starts no HTTP, config reads, seeding, installs or background work, but a completed reply in default mode **will** capture. No settings/install command is needed for building/testing. Worker hosts that load this extension must explicitly use off/read-only when capture is not intended; no worker detector is invented.

## Configuration and routing

Uses the official `~/.hindsight/coding-agent.json` (or `HINDSIGHT_CONFIG`): defaults → environment fallback → file → `harnesses.pi`, then `banks.<resolved-id>`. Official `mapPathToBank`, static bank IDs, worktree-aware default resolution, opt-in rules, bank overrides, tags/metadata, endpoint/auth, observation scopes, Reflect budget/timeout and page-search limit are retained. The legacy `pi-memory` bank is explicitly blocked.

An explicit effective endpoint is required before any HTTP: supply `apiUrl` through the official environment/file/harness/bank layers, or deliberately choose `serverMode: "cloud"` or `"daemon"` for its official endpoint. Missing config, implicit Cloud defaults, and `serverMode: "self-hosted"` without a URL fail closed with status, not an upload. Bank overrides must authorize the actual effective URL; a mode-only override that leaves a different implicit URL is refused. Review the endpoint before installation/loading: even a loopback Hindsight service may send text to remote models. Read-only describes memory mutations, not network/cost-free operation. Redaction is best effort, not a secret-detection guarantee.

Stage 3 deliberately **does not execute** upstream autoInject/autoReflect, autoSeed, Git ingest, surveys, page refresh/setup, manageBankConfig or autoUpdate. Daemon configuration selects its endpoint but does not start/install a daemon. An absent `conversation` retain strategy is left to server defaults; bank/page setup needs its own later review. No extra router/registry exists.

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

Exclude raw tool inputs/results, thinking, system/custom messages and generated summaries. Strip known official and pi-memory injection wrappers before processing; redact common credential patterns before outbound queries/content/tags/metadata. Retrieved content is framed as untrusted historical evidence, not authority. Exact retained/retrieved strings from this package's tool results are excluded only from **subsequent assistant text** on the active branch. Later results never rewrite earlier evidence, and primary user statements are preserved before and after retrieval. Semantic paraphrases are **not** detected. Explicit-Retain deduplication does not promise cross-path deduplication of primary user evidence also captured automatically. No Jev/span selection/classifier runs here; Hindsight performs extraction.

## Offline validation

From the workspace root:

```sh
npm run build --workspace @season179/pi-hindsight
npm run check --workspace @season179/pi-hindsight
npm test --workspace @season179/pi-hindsight
npm --offline pack --workspace @season179/pi-hindsight --dry-run --ignore-scripts
```

The repo currently has Pi 0.80.10. Local check scripts instead resolve an **already installed 0.87.1** from the Node prefix, or `PI_HINDSIGHT_PI_ROOT`. No installation, root dependency upgrade or machine-specific path is bundled. Pi/TypeBox are peers; there are no added runtime dependencies. Tests strip inherited credential variables, deny live HTTP, use temporary files/config and a synthetic provider with the real Pi SDK lifecycle; no live extensions/models/banks are loaded. Mocked document/extraction behavior is not a live-server extraction or cross-harness guarantee.
