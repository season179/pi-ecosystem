# @season179/pi-compaction

Reversible, provider-valid context pruning for [Pi](https://github.com/earendil-works/pi-coding-agent), driven by TypeSafe's System One (Jev) scoring.

When Pi is about to summarize a long session because the context window is nearly full, this extension first asks Jev which completed tool results the rest of the task still needs. Results Jev judges unneeded are replaced by a one-line note, and completed read-only calls it judges unneeded are removed together with their results. If the pruned context fits comfortably under Pi's threshold, the summary is deferred. The originals stay in the session file and can be listed, searched, read and restored at any time.

Nothing is summarized by this extension, and nothing is sent to Jev except a skeleton of the conversation with tool outputs replaced by size notes.

## Requirements

- Pi 0.85.1 or newer (`@earendil-works/pi-coding-agent`).
- Node 22.19 or newer.
- A TypeSafe API key in `TYPESAFE_API_KEY` for scoring. Without it the extension loads, answers commands and records local baseline telemetry, but never prunes.

## Installation

```sh
pi install npm:@season179/pi-compaction
```

or from a checkout:

```sh
pi install /absolute/path/to/packages/pi-compaction
```

Pruning is **off by default**. Turn it on per session with `/compaction on`, or for every session with `~/.pi/agent/pi-compaction.json`:

```json
{ "enabled": true }
```

A key alone never enables pruning. `/compaction on` in a session without a key warns and stays passive.

## What happens, step by step

1. Every request goes through a replay-only `context` handler that applies decisions already committed on the current branch. This step never scores and never uses the network.
2. When Pi decides to auto-compact for the **threshold** reason, the `session_before_compact` handler collects candidates: completed tool call/result pairs on the current branch, excluding the newest `protectRecentGroups` tool groups, pinned results, reads of instruction or plan files, image results, and pairs with duplicate or missing ids.
3. A skeleton of the conversation (user text, assistant text, call names and arguments, result sizes; secrets redacted, sensitive paths withheld) is sent to Jev with two questions per candidate: does the task still need this call to be visible, and does it still need the result body.
4. Answers become decisions: keep, replace the result with a note, or remove call and result together. Removal is limited to tools in `pairDroppableTools` and is applied atomically for assistant messages that carry thinking blocks, so OpenAI Codex reasoning items are never left without their function calls.
5. Decisions are persisted as a custom session entry, then the extension predicts whether the pruned context fits below Pi's threshold. If it does, the summary is cancelled and the next request already carries the pruned payload. If not, Pi summarizes as usual, over the untouched originals.
6. Manual `/compact` and overflow recovery are never intercepted.

A committed pass is reused while Pi's view of context size is based on the same provider response, and no new pass runs unless the candidate set changed. Decisions are monotone: a later pass never resurrects an earlier removal; only pins do.

## Commands

| Command | Effect |
| --- | --- |
| `/compaction status` | Enablement, key presence, config source, overlay counts, last pass, context usage. |
| `/compaction on` / `off` | Per-session override, persisted on the branch. Off sends originals again. |
| `/compaction preview` | Local candidate collection and skeleton fit; no network. |
| `/compaction score` | Runs a scoring pass and shows would-be decisions without committing them. |
| `/compaction restore <archive id \| all>` | Pins results so they are sent in full again. |
| `/compaction report [days]` | Local telemetry report (default 7 days), added to the transcript. |
| `/compaction feedback bad-prune [passId]` | Labels a pass as harmful. Only explicit labels count; recall and off are not treated as failures. |
| `/compaction export <new file> [days]` | Writes hashed telemetry metadata to a new file (mode 0600). |

## Tool: `compaction_recall`

Available to the model whenever the extension is loaded.

| Action | Parameters | Result |
| --- | --- | --- |
| `list` | `omittedOnly` (default true), `offset`, `limit` | Archive ids, tool, arguments, size, turn and status. |
| `search` | `query`, `limit` | Results whose original output or arguments contain the text, with a snippet. |
| `read` | `id`, `offset`, `limit` (chars, max 16000), `restore` | Original output, paged. `restore: true` pins it back into context. |

Archive ids are session entry ids of the original tool result; the placeholder note names the id to read.

## Configuration

`~/.pi/agent/pi-compaction.json` (all fields optional):

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Default enablement for new sessions. |
| `keepThreshold` | `0.35` | Minimum keep probability for a call or result to stay. |
| `protectRecentGroups` | `4` | Newest assistant tool-call groups never pruned, across user turns. |
| `maxStateTokens` | `20000` | Skeleton budget; the skeleton is abridged or collapsed to fit, otherwise the pass is skipped. |
| `maxRequestTokens` | `28000` | Skeleton plus one batch of questions. |
| `maxCandidatesPerBatch` | `24` | Candidates per Jev request. |
| `concurrency` | `2` | Parallel Jev requests. |
| `timeoutMs` / `deadlineMs` | `8000` / `20000` | Per-request timeout and total pass budget. |
| `savingsFactor` | `0.8` | Fraction of estimated savings credited when predicting headroom. |
| `marginTokens` / `marginFraction` | `1024` / `0.05` | Extra room kept below Pi's threshold before a summary is deferred. |
| `scoringCooldownMs` | `15000` | Minimum time between passes on one branch. |
| `model` | SDK default | Jev model name. |
| `pairDroppableTools` | `read, grep, find, ls, glob, bash_readonly` | Tools whose calls may disappear entirely; other tools keep the call as evidence. |

Invalid fields fall back to defaults and are reported by `/compaction status`.

## Telemetry

Telemetry is local only, under `~/.pi/agent/pi-compaction/telemetry` (directory 0700, one JSON line per event file, 30-day retention, 4 MiB cap). It records session, pass, request, summary, recall, restore, mode, feedback and error events with measured token usage per request. Session, pass, model, provider, config and candidate identifiers are stored as hashes; no transcript text, arguments or paths are retained. Baseline telemetry is collected while pruning is off so on/off periods can be compared. Comparisons in `/compaction report` are observational, and the report never claims exact cost savings or "summaries avoided".

## Limitations

- Estimated savings use a characters-per-four heuristic; the decision to defer a summary is confirmed by the provider's next usage report, and Pi summarizes if the estimate was wrong.
- A kept result is not asked about again on the same branch until Pi summarizes.
- Turning pruning off and on again re-applies earlier decisions; use `/compaction restore` to undo specific ones.
- Idle pre-emptive scoring is out of scope; scoring runs only when Pi's threshold compaction would start.

## Local Development

```sh
npm install
npm run build --workspace @season179/pi-compaction
npm test --workspace @season179/pi-compaction
```

Tests run the extension inside a real `AgentSession` with a fake provider and a fake scorer, and serialize pruned contexts through pi-ai's Anthropic, OpenAI Completions, OpenAI Responses, OpenAI Codex and Google converters. No test uses the network.

## License

MIT
