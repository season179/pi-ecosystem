# @season179/pi-hindsight

Give Pi continuity across sessions: remember useful decisions and preferences instead of repeatedly rediscovering them.

## What it does

- Retrieves memories from Hindsight, checks their relevance, and adds useful ones to a later model request without blocking the first answer. Memory is background evidence, not instructions.
- Saves completed conversations and provides tools for searching, reflecting on, retaining and correcting memories.
- Records local troubleshooting logs, capped at **1 GB total**. These contain conversation and memory text; treat them as sensitive.

## Setup

Requires Pi 1.0+, a Hindsight server, and Cloudflare Workers AI or TypeSafe credentials for automatic retrieval. Disable legacy `pi-memory` automation before using this package.

1. Build from the repository root:

   ```sh
   npm run build --workspace @season179/pi-hindsight
   ```

2. Add this package's directory to `packages` in `~/.pi/agent/settings.json`.

3. Set your endpoint and intended bank in `~/.hindsight/coding-agent.json` (or `HINDSIGHT_CONFIG`):

   ```json
   {
     "apiUrl": "http://localhost:8888",
     "bankId": "your-project-bank",
     "harnesses": { "pi": { "autoInject": "recall" } }
   }
   ```

   Use `mapPathToBank` instead of a single `bankId` when routing different repositories to separate banks. An optional global bank uses `~/.hindsight/coding-agent-global.json` (or `HINDSIGHT_GLOBAL_CONFIG`).

   Recall queries use a **480-token** budget with `o200k_base`, prioritizing the current request and then newest conversation exchanges. The server must use the same tokenizer encoding (`HINDSIGHT_API_TOKENIZER_ENCODING=o200k_base`, Hindsight's default). Its default 500-token Recall limit needs no change.

4. Enable Clef assessment in the `hindsight` section of `~/.pi/agent/typesafe.json`, preserving any other settings:

   ```json
   {
     "hindsight": {
       "enabled": true,
       "provider": "cloudflare",
       "accountId": "your-32-character-cloudflare-account-id",
       "model": "clef",
       "timeoutMs": 2000
     }
   }
   ```

   Set `CLOUDFLARE_API_TOKEN` (or `PERSONAL_CF_API_TOKEN`) to an account-scoped Workers AI token. Alternatively, set `hindsight.apiKeyFile` to an owner-only (`0600`) token file; relative paths resolve under `~/.pi/agent`. Credential precedence is `CLOUDFLARE_API_TOKEN`, then `PERSONAL_CF_API_TOKEN`, then the file. `clef-flash` is also supported. Assessment sends conversation and candidate memory text to Cloudflare; Hindsight's backend model is unchanged.

   To keep using TypeSafe, omit `provider` or set it to `typesafe`, keep `hindsight.enabled: true`, and use the existing top-level `model` (default `jev-1.13.0`) and `apiKeyFile` or `TYPESAFE_API_KEY`. Cloudflare never inherits TypeSafe's model or credentials. Without valid assessment configuration and credentials, automatic retrieval is disabled. Assessment timeouts are capped at two seconds.

5. Restart Pi after rebuilding or changing environment variables. `/hindsight` shows status; `/hindsight memories` shows delivered memory.

The default mode is **read-write**, including automatic conversation capture. Use `--hindsight-mode read-only` to disable writes, or `off` to disable memory access. Read-only still sends text to retrieval/assessment services. A local Hindsight server may also use remote models. Automatic retrieval/assessment inputs and injected memories are not redacted, including their copies in model context and persisted sessions.

[Telemetry reference](docs/telemetry.md) · [Provenance and local patches](NOTICE.md)
