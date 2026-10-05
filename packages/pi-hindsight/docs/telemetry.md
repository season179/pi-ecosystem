# Telemetry reference

Logs live at `<agentDir>/hindsight-telemetry.jsonl` and `.1`. Both are owner-only (`0600`), capped at 500 MB each: **1 GB total**, with the oldest archive replaced on rotation. Restart all running Pi sessions after rebuilding so they use the same logger.

## Investigating a lookup

Find `retrieval_start` by session and request, then follow its `job` across both files. `job` matches an injected message's `deliveryId`; `origin` identifies the persisted user entry once available. Earlier rows carry `userTimestamp` and the start row's `userHash`.

| Event                              | Evidence                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `retrieval_start`                  | Current request, recent conversation, already-provided memory, input entry IDs                              |
| `recall_request` / `recall_result` | Bank, query, allowlisted options, latency, returned memory text or safe failure category                    |
| `candidate_skipped` / `candidates` | Same-session/unknown-source, duplicate, empty or candidate-limit exclusions; candidate IDs and fingerprints |
| `assessment_request`               | Exact bounded state, questions, criteria, provider, requested model, endpoint host and selection limits     |
| `assessment_response`              | Provider-reported model and whether it matches the request, or numeric Cloudflare error codes               |
| `assessment_result`                | Scores and selection/rejection reasons, or assessment failure                                               |
| `selection`                        | Exact text prepared for injection                                                                           |
| `delivery_boundary`                | Why a turn could or could not stage memory                                                                  |
| `delivery`                         | Staged, released, or not delivered, with reason and timing                                                  |
| `context_dropped`                  | Why a pending draft was excluded from the model context                                                     |
| `retrieval_skip`                   | Empty input or failure cooldown                                                                             |

`released` means the context hook included memory, **not proof the model used it**. Distinguish empty/failed Recall from assessment rejection; `none_useful` alone does not explain which occurred. Trace rows include elapsed time, phase, turn count and failure/cooldown state. Assessment rows identify the provider and requested model. `assessment_response.responseModel` is the provider's reported label, not independent proof of the serving implementation; unexpected labels are sanitized. `success` on that row describes the response envelope, not score validation or memory selection. Recall requests include `queryBytes`, `queryTokens`, `queryTokenLimit` (480) and `queryEncoding` (`o200k_base`); the complete query, including labels and any truncation marker, counts toward the token limit. Unlogged Recall option names are disclosed as `unloggedOptionKeys`.

`candidate_skipped.reason: same_session_source` means a source belongs to the active session; `unknown_source` means provenance could not be fully verified (including budget-truncated source expansion). Both are deterministic exclusions before assessment, not relevance-model decisions. `recall_result.memories[].sources` contains resolved source document/session IDs when complete; source-fact text is not copied into these rows.

## Privacy and reliability

Conversation-derived text and memory are intentionally duplicated and **may contain quoted secrets**. Transport credentials, headers, full endpoint URLs, Cloudflare account IDs and arbitrary service error bodies are excluded. Assessment endpoint hostnames (for example, `api.cloudflare.com`) are logged. Capture and explicit-tool events contain metadata only. Off mode writes nothing.

Writes are best effort: a busy writer or disk error never fails retrieval. The next successful row reports that process's `droppedRows`; a process exiting before then cannot report its losses. Crashes can leave an incomplete job. Rows use `schema: 2`; older rows may lack detailed diagnostics.

Append and rotation share a nonblocking directory lock. Dead owners and abandoned empty locks are recovered; live or unknown owners are never displaced. PID reuse or a malformed owner can require manual lock removal **after confirming no writer is active**. A crash can leave a tiny staging directory containing no diagnostic text. Existing oversized log files are discarded on the next successful write.
