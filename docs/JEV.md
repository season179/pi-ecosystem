# Jev live integration

[Jev](https://docs.typesafe.ai/model-jaggedness/jev-1.13) (via
[TypeSafe AI](https://typesafe.ai)) gates two extension behaviors with cheap,
structured model calls: **pi-buddy** periodic automatic-review triage and
**pi-memory** semantic recall ranking. Both are **live/ACTIVE**: when enabled
and a key is available, they change behavior immediately (Buddy may skip
clearly low-value periodic reviews; memory recall ranks candidates by
meaning). There is no observe-only/shadow mode. API errors, operation deadlines,
malformed answers, and missing credentials fall back to pre-Jev deterministic
behavior. Caller/session cancellation is different: stop the cancelled work;
do not launch a fallback review or publish stale recall results.

This describes the active integration contract, not proof that a running Pi
session has loaded it. Build/install and reload requirements are below.

## Transport

Both consumers call the official SDK directly (no shared internal package).
Required client settings (not a complete deadline/cancellation wrapper):

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
const client = new TypeSafeClient({
  apiKey,
  defaultModel: model,          // pinned: "jev-1.13.0"
  baseURL: "https://api.typesafe.ai", // do not inherit TYPESAFE_BASE_URL
  logLevel: "off",             // do not inherit TYPESAFE_LOG_LEVEL
  timeout: timeoutMs,           // 3000; attempt/body delivery only
  retry: { maxRetries: 0 },     // no SDK retry/backoff
});
// ... client.systemOne({ state, questions }, { signal }) ...
```

Verified against installed SDK **0.6.0**: its per-attempt timer covers fetch and
full response-body buffering, but is cleared **before** `response.text()` and
JSON parsing. Disabling retries does **not** make that a whole-operation bound.
For native responses the remaining read is buffered, not further network delivery;
a synthetic delayed `text()` still demonstrates that the parsed promise can
outlive the timer. Synchronous JSON parsing cannot be interrupted by a JS timer.

Consumers need an outer deadline covering the awaited parsed result (and all
memory batches), composed with caller/session cancellation. Race asynchronous
work against that deadline/cancellation, abort transport, clean up listeners and
timers, and reject late results before taking action. Bound payloads and response
size as well; a deadline cannot preempt synchronous CPU work.

The SDK reports `APITimeoutError` for its own attempt timer and
`APIUserAbortError` for signal cancellation during delivery. Its caller-signal
listener is removed after buffering, so late cancellation needs a consumer check.
An outer deadline also aborts a supplied signal: inspect caller cancellation and
the deadline's origin, not just the SDK error class, when deciding whether to
fall back or stop.

Explicit `logLevel: "off"` prevents environment-enabled debug payload logging;
explicit `baseURL` prevents an environment override from redirecting authenticated
requests. Do not log raw errors or provider bodies. API
[limits](https://docs.typesafe.ai/api): single state + largest question 32k
tokens, all state + questions 64k tokens — callers keep payloads well below.

## Configuration

Global per-user file `<agentDir>/typesafe.json` (each extension resolves
`agentDir` through its existing mechanism; for this user `~/.pi/agent`).
An absent file leaves both features disabled — no behavior change for other
users. A malformed file yields a bounded visible warning and deterministic
existing (non-Jev) behavior, never silent apparent success.

```json
{
  "model": "jev-1.13.0",
  "timeoutMs": 3000,
  "apiKeyFile": "typesafe.key",
  "buddy": { "enabled": true, "skipThreshold": 0.85, "auditEvery": 5 },
  "memory": { "enabled": true, "minRelevance": 0.5 }
}
```

- `buddy.skipThreshold` — minimum answer probability for the "clearly low-value"
  decision (`probabilities[label]` for choice answers, or `noul` for a yes/no
  answer), **not** the SDK's separate `confidence` field and not a guarantee of
  correctness. Unknown/high-risk/context-incomplete always escalate
  to the full reviewer. Every `auditEvery`-th periodic opportunity (default 5)
  bypasses Jev as a fixed audit.
- `memory.minRelevance` — minimum semantic relevance for a candidate to appear
  in semantic recall results.

## API key

Precedence: `TYPESAFE_API_KEY` environment variable, then `apiKeyFile`
(relative to `agentDir`, or absolute). No key is ever hardcoded or written by
the extensions. Once the integration code is loaded, config **and key are
re-read at decision time**, so installing the key later activates live behavior
without restarting or mutating the process environment.

Secure key-file setup (default path `~/.pi/agent/typesafe.key`): copy an existing
secure file containing only the key (an optional trailing newline is accepted).
Replace the source **path**, never paste a real key into a command or chat. Source
and destination must be different files; this replaces any destination key.

```sh
install -m 600 /secure/path/to/existing-typesafe-key "$HOME/.pi/agent/typesafe.key"
```

Keep the source file private too. Credential values, request/response payloads,
and provider error bodies must never be printed by either extension; the explicit
SDK logging setting above is part of that requirement.

## Live vs fallback state

| Condition | Buddy periodic gate | Memory recall |
| --- | --- | --- |
| Enabled + key valid | Jev triage; skips clearly low-value | Semantic ranking of all allowed-scope candidates |
| No key / auth error / timeout / malformed answer | Normal review runs | Existing deterministic recall |
| Config absent | Feature off (plain behavior) | Feature off (plain behavior) |
| Config malformed | Bounded warning + fallback | Bounded warning + fallback |
| Caller/session cancelled | Stop; no fallback review | Stop; discard late result |

Explicit Buddy consultations and eligible run-end reviews are never gated.
Exact-ID/title and empty-query memory recalls bypass Jev entirely. Fallback is
observable via each extension's status/telemetry (method/fallback/skip
diagnostics) without spam.

## Installation and packaging

Both workspaces declare `@typesafe-ai/sdk: ^0.6.0` as a runtime dependency;
the current checkout resolves **0.6.0**. This range does not pin future installs
to the audited version. SDK 0.6.0 ships ESM, CommonJS, and TypeScript declarations
and requires Node >=20; Buddy requires >=22 and memory >=22.19.0.

For a local checkout, install workspace dependencies and build both packages
before registering their package directories with `pi install`. Local-path
installation references those directories without copying them; do not assume
it builds changed TypeScript. Reload or start a new Pi session after installing
or rebuilding extension code. Installing a key alone cannot load new code.

Both packages ship `dist`; their `prepack` scripts clean and rebuild it. The SDK
is installed as a dependency, not bundled into those tarballs. Root `docs/JEV.md`
is **not** included in either package's file list, so packaged README setup
instructions must link to a durable published copy or include the essentials.
A script-skipping pack dry run only checks existing artifacts, not a fresh build,
installed activation, or successful authenticated calls.
