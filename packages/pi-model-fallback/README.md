# @season179/pi-model-fallback

Automatic model failover for Pi. When the selected model fails with a persistent provider error (rate limit, overload, 5xx, network), Pi switches to the next model in a user-defined fallback chain and resumes work automatically.

Main model settings (`settings.json`) are configured nowhere in this extension — the fallback chain lives in its own config file.

## What It Does

- Triggers only after Pi's built-in same-model retries are exhausted.
- Classifies errors by HTTP status first, error-message patterns as backstop.
- Falls back on rate limit (429), overload (529), 5xx, and network errors.
- Never falls back on user aborts, context-overflow, or 4xx request errors (those fail identically on every model).
- Auth errors (401/403) do not trigger fallback unless explicitly enabled.
- Resumes the interrupted run automatically via a "continue" message.
- Restores your original model on the next interactive message after a cooldown (default 10 minutes), so an ongoing outage doesn't cause churn.
- A manual model switch (`/model`, Ctrl+P) cancels the pending restore — your choice wins.
- Persists fallback state in the session: resuming a session left on a fallback model restores the original immediately.

## Installation

```bash
pi install npm:@season179/pi-model-fallback
```

## Configuration

Create `~/.pi/agent/fallback-models.json` (global) or `.pi/fallback-models.json` (project-local, wins if present). It contains **only** the fallback chain:

```json
{
  "fallbacks": [
    { "provider": "openai-codex", "model": "gpt-5.6-sol" },
    { "provider": "google", "model": "gemini-3-pro" }
  ],
  "restoreCooldownMinutes": 10,
  "fallbackOnAuthErrors": false
}
```

- `fallbacks` — ordered chain; entries without a configured API key are skipped.
- `restoreCooldownMinutes` — how long after the last failure before the original model is restored on your next message (default `10`).
- `fallbackOnAuthErrors` — set `true` to also fall back on 401/403. Off by default because it can silently shift spend to a metered key and mask an expired credential.

The config is re-read on every trigger, so edits apply without reloading Pi.

## Usage

- `/fallback` — show the chain, current model, and whether a fallback is active.
- `/fallback restore` — force-switch back to the original model before the cooldown expires.

## Known Pi-Core Limitation

Pi persists *every* model switch (including this extension's) as the new global default in `~/.pi/agent/settings.json`; there is no session-only `setModel` in the extension API. The restore path writes the original defaults back, and resumed sessions repair them at startup. But while a fallback is active — or after a crash mid-fallback, until that session is resumed — new Pi sessions elsewhere will start on the fallback model.
