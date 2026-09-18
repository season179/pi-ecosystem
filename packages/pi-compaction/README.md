# @season179/pi-compaction

Reversible, provider-valid context pruning for [Pi](https://github.com/earendil-works/pi-coding-agent), driven by TypeSafe's System One (Jev) scoring.

When Pi is about to summarize a long session because the context window is nearly full, this extension first asks Jev which completed tool results the rest of the task still needs. Results Jev judges unneeded are replaced by a one-line note, and completed read-only calls it judges unneeded are removed together with their results. If the pruned context fits comfortably under Pi's threshold, the summary is deferred. The originals stay in the session file and can be listed, searched, read and restored at any time.

Nothing is summarized by this extension, and nothing is sent to Jev except a skeleton of the conversation with tool outputs replaced by size notes.

## Requirements

- Pi 0.85.1 or newer (`@earendil-works/pi-coding-agent`).
- Node 22.19 or newer.
- A TypeSafe API key in `TYPESAFE_API_KEY` for scoring. Without it the extension loads, answers commands and records local telemetry, but cannot make new scoring decisions. Previously committed decisions can still replay when pruning is enabled; use `/compaction off` to stop replay.

## Installation

**Unpublished.** The package is not on npm yet; install it from a local checkout:

```sh
git clone https://github.com/season179/pi-ecosystem.git
cd pi-ecosystem
npm install
npm run build --workspace @season179/pi-compaction
pi install /absolute/path/to/pi-ecosystem/packages/pi-compaction
```

Pi loads packages at session start: reload (`/reload`) or start a new session after installing. Rebuild (`npm run build --workspace @season179/pi-compaction`) after pulling changes; the installed entry points at the checkout's `dist/`. Remove with `pi remove /absolute/path/to/pi-ecosystem/packages/pi-compaction`.

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

A committed pass is reused while Pi's view of context size is based on the same provider response: repeated checks recompute what is pruned *right now* (after any restore, pin or mode change) and cancel the summary only if that still fits under the same config and coding model. No new pass runs unless the candidate set, config or model changed. Decisions are monotone: a later pass never resurrects an earlier removal; only pins do. When Pi does summarize, keep verdicts expire: results retained after the summary can be asked about again, while applied removals and pins persist.

At replay time every committed decision is re-checked against the live message list. If a tool-call id has become ambiguous (duplicate call or result) or its result is missing, the decision is skipped and every message carrying that id is sent untouched.

## Commands

| Command | Effect |
| --- | --- |
| `/compaction status` | Enablement, key presence, config source, overlay counts, last pass, context usage. |
| `/compaction on` / `off` | Per-session override, persisted on the branch. Off sends originals again. |
| `/compaction preview` | No network. Shows candidates, exclusions and how many requests a pass would send, and writes the exact redacted state plus question batches to a private file under `~/.pi/agent/pi-compaction/preview/` (mode 0600). |
| `/compaction score` | Runs a real scoring pass (paid) and shows would-be decisions without committing them; request latency/usage is recorded. |
| `/compaction restore <archive id \| all>` | Pins results so they are sent in full again. |
| `/compaction report [days]` | Local telemetry report, e.g. `/compaction report 7d` (default 7, max 90). Shown in the transcript as a custom entry that is never sent to the model; printed to stderr without a UI. |
| `/compaction feedback bad-prune [passId]` | Labels a pass as harmful. Only explicit labels count; recall and off are not treated as failures. |
| `/compaction export <new file> [days]` | Writes hashed telemetry metadata to a new file (mode 0600). |

## Tool: `compaction_recall`

Available to the model whenever the extension is loaded.

| Action | Parameters | Result |
| --- | --- | --- |
| `list` | `omittedOnly` (default true), `offset`, `limit` | Archive ids, tool, arguments, size, turn and status. |
| `search` | `query`, `limit` | Results whose original output or arguments contain the text, with a snippet. |
| `read` | `id`, `offset`, `limit` (chars, max 16000), `restore` | Original output, paged. Reading a pruned result pins it back into context by default; `restore: false` reads without restoring. |

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
| `pairDroppableTools` | `read, grep, find, ls` | Pi built-in read-only tools whose calls may disappear entirely; other tools keep the call as evidence. Add your own read-only custom tools by name; nothing else is assumed. |

Invalid fields fall back to defaults and are reported by `/compaction status`.

## Telemetry

Telemetry is local only, under `~/.pi/agent/pi-compaction/telemetry` (directory 0700, one JSON line per event file, 30-day retention, 4 MiB cap). It records session, pass, request, summary, recall, restore, mode, feedback and error events with measured token usage per request. Session, pass, model, provider, config and candidate identifiers are stored as hashes; no transcript text, arguments or paths are retained. Baseline telemetry is collected while pruning is off so on/off periods can be compared. Comparisons in `/compaction report` are observational, and the report never claims exact cost savings or "summaries avoided".

Details worth knowing:

- The observation scope is one tree branch: continuing from an interior node (`/tree`) starts a new scope, so sibling traffic never closes another branch's pass interval; returning to an existing tip adopts its scope. A pass committed on the shared prefix is linked only to the scope it was committed in.
- `turn` is the number of user prompts on the branch (monotone across prompts and resume); the context fraction is not clamped, so overflow above 1.0 is visible.
- Coding requests link to a pass only when that pass's decisions were actually applied to the request; requests while pruning is off carry no link.
- Coding prices are pi-ai's catalog API list rates (USD per million tokens, tiered by request input) when the catalog has them; they are estimates, never invoices. Scoring requests record measured per-attempt latency and, when TypeSafe reports it, `reportedInputTokens` (API-reported input without a cache split) and output tokens; no TypeSafe price is known, so no scoring cost is computed.

## Limitations

- Estimated savings use a characters-per-four heuristic; the decision to defer a summary is confirmed by the provider's next usage report, and Pi summarizes if the estimate was wrong.
- A kept result is not asked about again on the same branch until Pi summarizes; after a summary the retained results are scoreable again.
- `keepThreshold` 0.35 is a starting point, not a calibrated value; use `/compaction feedback bad-prune` and the report to judge it on real sessions.
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
