# @season179/pi-hindsight

Hindsight memory for **Pi**: retrieve relevant memories, capture completed conversations, and expose explicit memory tools.

**Default: read-write, including automatic capture.** Disable legacy pi-memory automation before loading; do not run simultaneous writers. Use `--hindsight-mode read-only` for retrieval without writes, or `off` for no memory access. `/hindsight` shows status.

## Configuration

Uses `~/.hindsight/coding-agent.json` (or `HINDSIGHT_CONFIG`). Configure an explicit `apiUrl` and review the destination bank before loading. Prefer `mapPathToBank` for explicit repository routing; default dynamic routing can share a bank between same-named repositories. The legacy `pi-memory` bank is blocked.

- Pi 1.0+ is required. `autoInject: "reflect"` (default) and `"recall"` both enable Recall → assessment → injection; `"none"` disables it and `"pages"` is unsupported. Prefer `harnesses.pi.autoInject` for Pi-only settings; other harnesses keep their own semantics.
- `retainSessions: false` disables automatic capture without disabling explicit writes.
- Optional read-only global memory uses `~/.hindsight/coding-agent-global.json` (or `HINDSIGHT_GLOBAL_CONFIG`) with an explicit endpoint and static `bankId`.

Conversation text goes to the configured service; even a local Hindsight server may use remote models. Redaction is best effort. Read-only still makes network/model requests.

## Automatic retrieval

Every current user message—including steering and queued follow-ups—starts `prepareMemoryInjection()` in the background. The agent never waits for it. First request: no history; later requests: up to **three completed user-message + agent-response pairs** still in effective context. Compaction and context edits are respected; tools, thinking and incomplete responses are not pairs.

```text
user message ─┬─ agent proceeds normally
              └─ Recall candidates → assess candidates → selected memories
                                                       ↓
                         next natural same-request model call → injection
                         run ends or request changes          → not delivered
```

Hindsight **Recall** retrieves discrete candidates from the repository and optional read-only global bank. One batched assessment request asks whether each adds relevant information that could improve the next response/action, excluding redundant, tangential or contradicted information. Memory already visible to the agent is supplied for comparison. No automatic Reflect or pages fallback; explicit `hindsight_reflect` is unchanged.

All automatic retrieval, **including the first message**, requires `<agentDir>/typesafe.json`:

```json
{
  "model": "jev-1.13.0",
  "timeoutMs": 2000,
  "apiKeyFile": "typesafe.key",
  "hindsight": { "enabled": true }
}
```

`TYPESAFE_API_KEY` overrides the key file. Missing/invalid configuration or credentials means **no automatic retrieval or unjudged injection**. Jev is the current assessment model; code and function names are model-neutral. Other APIs, including Clef, are not implemented.

**Content is not redacted in this automatic path.** The assessment service receives bounded conversation excerpts, previously available memory and actual candidate memory content. Selected excerpts also enter model context and the persisted session without content redaction. Size limits are not privacy protection. Transport credentials are never added to assessment state or telemetry. Capture and explicit tools retain their existing redaction protections. Memories remain untrusted historical evidence, not instructions.

### Timing and limits

- **No foreground wait; memory is not guaranteed for the first answer.** A single-model-call answer may receive none. Selected memory can only reach a subsequent natural model request for the same unchanged user request. It cannot alter an in-flight request, force an extra turn, or carry into a newer request.
- Recall: **5 seconds per bank**, concurrent project/global requests. Assessment: **at most 2 seconds**. Local configuration/key reads are also bounded. Defensive total job lifetime: **90 seconds**; no retries.
- **6 candidates total**, **800 characters per candidate snippet**, at most **4 selected** at probability **≥ 0.7**. The finalized serialized injection—including framing—is **≤ 4,000 characters**. Explicit truncation markers; whole assessed snippets are retained rather than silently rewritten after judgment.
- Current request: **4,000 characters**; each side of a completed pair: **1,500 characters**. Already-available memory excerpts: **12,000 characters**, with omitted-character disclosure. Recall uses the current request plus a bounded recent-conversation excerpt. Configured `recallOptions` filters/types are honored; entity/chunk expansion and trace are disabled.
- One owned latest-request job. No lifetime attempt/injection cutoff. Duplicate candidates already available in effective context are omitted; changed content can be reassessed.
- **3 consecutive retrieval/assessment failures → 2-minute pause**. A healthy project result is not suppressed by an unavailable optional global leg. Paused, unavailable, no useful memory and not delivered are distinct outcomes.

### Visibility and inspection

A compact right-aligned indicator **above the editor**, not in the footer, shows checking → selected/awaiting model request → injected, none useful, not delivered, unavailable or paused. Its outcome stays until the next user message. The existing `[fast mode]` widget is untouched; Hindsight uses its own neighboring row, not another plugin's private shared registry.

Delivered memory appears as a compact conversation receipt:

```text
▸ Hindsight · 2 memories injected · project + global
```

- **Fullscreen:** click the receipt header to expand; click again to collapse just that receipt.
- **Keyboard:** Pi's `Ctrl+O` toggles expandable output globally, including tool output.
- **Inspection:** `/hindsight memories` displays this branch's delivery status and exact delivered text without requiring mouse support. `/hindsight` shows mode/capture/retrieval status.
- Expanded receipts show **the actual serialized model-context message**, including scope/context, safety framing and truncation—not a candidate summary or a second persisted text copy. Staged/undelivered/invalidated receipts are labelled honestly. Delivery means made available to a model request, **not proof the agent used it**.

### Read the code

- `src/extension.ts`: user `message_end` → `prepareMemoryInjection()` → guarded `turn_end` staging → `context` release.
- `src/retrieval.ts`: effective completed pairs, candidate preparation/deduplication, assessment configuration and `assessMemoryCandidates()`.
- `src/retrieval-ui.ts`: above-editor indicator and clickable actual-message receipt.

## Tools and capture

| Tool                               | Purpose                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `hindsight_reflect`                | Synthesize an answer from project or read-only global memory |
| `hindsight_search_knowledge_pages` | Search existing pages                                        |
| `hindsight_read_knowledge_page`    | Read an existing page                                        |
| `hindsight_retain`                 | Submit evidence for extraction                               |
| `hindsight_manage_fact`            | Inspect, edit, invalidate or revert one identified fact      |

Automatic capture appends sanitized, persisted user/assistant history after a completed reply. It excludes raw tools, thinking and summaries; uncertain writes, changed retained history and curated sources block capture rather than overwrite evidence. Retain acceptance does not mean extraction is complete. Fact edits do not rewrite sources or guarantee fresh pages. No permanent-delete tool exists.

## Development and reference

From the workspace root:

```sh
npm run build --workspace @season179/pi-hindsight
npm run check --workspace @season179/pi-hindsight
npm test --workspace @season179/pi-hindsight
```

Checks use the installed Pi: `PI_HINDSIGHT_PI_ROOT` overrides discovery, otherwise the Node-prefix installation is preferred over the workspace dependency. New releases are not blocked by an exact-version check; build/tests detect API incompatibilities. Tests use mocked services, not live models or banks.

- [Provenance and local patches](NOTICE.md).
