# @season179/pi-hindsight

Give Pi continuity across sessions: remember useful decisions and preferences instead of repeatedly rediscovering them.

## What it does

- Recalls relevant memories in the background and adds them as context, not instructions.
- Saves conversations and provides tools to search, reflect on, retain, and correct memories.

## Setup

Requires Pi 1.0+, a Hindsight server, and Cloudflare Workers AI or TypeSafe credentials.

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

   Keep the server's default tokenizer (`o200k_base`) and Recall limit (500 tokens).

4. Enable Clef assessment in the `hindsight` section of `~/.pi/agent/typesafe.json`, preserving any other settings:

   ```json
   {
     "hindsight": {
       "enabled": true,
       "provider": "cloudflare",
       "accountId": "your-32-character-cloudflare-account-id",
       "model": "clef",
       "timeoutMs": 10000
     }
   }
   ```

   Set `CLOUDFLARE_API_TOKEN` to an account-scoped Workers AI token. Alternatively, set `hindsight.apiKeyFile` to a token file with permissions `0600`; relative paths resolve under `~/.pi/agent`.

   For TypeSafe instead, set `hindsight.provider` to `typesafe`, the top-level `model` to your TypeSafe model, and `TYPESAFE_API_KEY` to your key.

5. Restart Pi after rebuilding or changing environment variables. `/hindsight` shows status; `/hindsight memories` shows delivered memory.

Defaults to **read-write**. Use `--hindsight-mode read-only` to disable writes, or `--hindsight-mode off` to disable memory access.

**Privacy:** conversation and memory text are sent to configured services, including in read-only mode, and stored unredacted in local retrieval logs and injected session context. A local Hindsight server may use remote models.

[Telemetry reference](docs/telemetry.md) · [Provenance and local patches](NOTICE.md)
