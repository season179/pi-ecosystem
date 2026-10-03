# @season179/pi-hindsight

Hindsight memory for **Pi 0.87.1**: retrieve relevant memories, capture completed conversations, and expose explicit memory tools.

**Default: read-write, including automatic capture.** Disable legacy pi-memory automation before loading; do not run simultaneous writers. Use `--hindsight-mode read-only` for retrieval without writes, or `off` for no memory access. `/hindsight` shows status.

## Configuration

Uses `~/.hindsight/coding-agent.json` (or `HINDSIGHT_CONFIG`). Configure an explicit `apiUrl` and review the destination bank before loading. Prefer `mapPathToBank` for explicit repository routing; default dynamic routing can share a bank between same-named repositories. The legacy `pi-memory` bank is blocked.

- `autoInject: "reflect"` enables automatic retrieval (default); `"none"` disables it. Pages/Recall injection is unsupported.
- `retainSessions: false` disables automatic capture without disabling explicit writes.
- Optional read-only global memory uses `~/.hindsight/coding-agent-global.json` (or `HINDSIGHT_GLOBAL_CONFIG`) with an explicit endpoint and static `bankId`.

Conversation text goes to the configured service; even a local Hindsight server may use remote models. Redaction is best effort. Read-only still makes network/model requests.

## Automatic retrieval

```text
user request → initial Reflect, or periodic Jev gate → Reflect → agent context
```

| User-message count¹ | Action |
|---|---|
| 1 | Reflect without Jev |
| 5, 9, 13, … | Reflect only if Jev's yes-probability is ≥ 0.7 |
| Other | No new automatic retrieval |

¹ Active-branch user entries plus the new prompt. Retrieval starts only when an idle prompt starts a run; steering/follow-ups count but do not trigger it.

Periodic retrieval requires `<agentDir>/typesafe.json`:

```json
{
  "model": "jev-1.13.0",
  "timeoutMs": 2000,
  "apiKeyFile": "typesafe.key",
  "hindsight": { "enabled": true }
}
```

`TYPESAFE_API_KEY` overrides the key file. Missing configuration/key disables periodic retrieval, not initial Reflect. **Enabling Jev sends redacted conversation excerpts and previously injected memory to TypeSafe.** Jev decides whether to retrieve; it never judges the Reflect answer or controls capture.

- Waits up to **2 seconds for the gate**, then **6 seconds for Reflect**. Memory is not guaranteed in the first answer; use `hindsight_reflect` when consultation must precede it.
- Pending Reflect can deliver at a natural tool-turn boundary for the same unchanged request, within its configured timeout (maximum **90 seconds total**). No forced extra turn or carry to a new prompt.
- Limits: **8 Reflect requests and 32 Jev requests per activation**, **8 injections per branch**, **4,000 evidence characters per injection**. Project/global requests each count.
- Service failures pause automatic retrieval for **10 minutes**, without retries or Recall/pages fallback.

### Read the code

For **user request → optional Jev gate**, read these two files:

1. `src/extension.ts`: the `before_agent_start` handler, from `triggerFor()` through the `trigger === 'periodic'` block. This connects the request to the gate and acts on its answer.
2. `src/retrieval.ts`: `triggerFor()` → `automaticQuery()` → `gateState()` → `loadGate()` / `loadKey()` → `askGate()`. `INSTRUCTIONS` and `CRITERIA` contain the actual question Jev answers.

## Tools and capture

| Tool | Purpose |
|---|---|
| `hindsight_reflect` | Synthesize an answer from project or read-only global memory |
| `hindsight_search_knowledge_pages` | Search existing pages |
| `hindsight_read_knowledge_page` | Read an existing page |
| `hindsight_retain` | Submit evidence for extraction |
| `hindsight_manage_fact` | Inspect, edit, invalidate or revert one identified fact |

Automatic capture appends sanitized, persisted user/assistant history after a completed reply. It excludes raw tools, thinking and summaries; uncertain writes, changed retained history and curated sources block capture rather than overwrite evidence. Retain acceptance does not mean extraction is complete. Fact edits do not rewrite sources or guarantee fresh pages. No permanent-delete tool exists.

## Development and reference

From the workspace root:

```sh
npm run build --workspace @season179/pi-hindsight
npm run check --workspace @season179/pi-hindsight
npm test --workspace @season179/pi-hindsight
```

Checks require an installed Pi 0.87.1, resolved from the Node prefix or `PI_HINDSIGHT_PI_ROOT`. Tests use mocked services; they do not prove live-service behavior.

- [Provenance and local patches](NOTICE.md).
