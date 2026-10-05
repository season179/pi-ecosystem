# @season179/pi-hindsight

Give Pi continuity across sessions: remember useful decisions and preferences instead of repeatedly rediscovering them.

## What it does

- Retrieves memories from Hindsight, checks their relevance, and adds useful ones to a later model request without blocking the first answer. Memory is background evidence, not instructions.
- Saves completed conversations and provides tools for searching, reflecting on, retaining and correcting memories.
- Records local troubleshooting logs, capped at **1 GB total**. These contain conversation and memory text; treat them as sensitive.

## Setup

Requires Pi 1.0+, a Hindsight server, and a TypeSafe API key for automatic retrieval. Disable legacy `pi-memory` automation before using this package.

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

4. Enable assessment in `~/.pi/agent/typesafe.json` and set `TYPESAFE_API_KEY`:

   ```json
   {
     "model": "jev-1.13.0",
     "timeoutMs": 2000,
     "hindsight": { "enabled": true }
   }
   ```

   Alternatively set `apiKeyFile` in that file. Without valid assessment configuration and credentials, automatic retrieval is disabled.

5. Reload Pi. `/hindsight` shows status; `/hindsight memories` shows delivered memory.

The default mode is **read-write**, including automatic conversation capture. Use `--hindsight-mode read-only` to disable writes, or `off` to disable memory access. Read-only still sends text to retrieval/assessment services. A local Hindsight server may also use remote models. Automatic retrieval/assessment inputs and injected memories are not redacted, including their copies in model context and persisted sessions.

[Telemetry reference](docs/telemetry.md) · [Provenance and local patches](NOTICE.md)
