# @season179/pi-accounts

## 26.9.0 (local, unpublished)

- Fork upstream 0.52.2 with its MIT license, authentication/storage implementation, and regression suites.
- Add `/accounts-auto` for quota-confirmed ChatGPT primary/fallback selection and return after reset.
- Default to `oc-codex` → Pi built-in login without setup when a saved `oc-codex` account exists; `/accounts-auto off` persists as `autoSwitch: false`.
- Check the switched account can serve the selected model before sending a request; a refused switch restores the previous account.
- Share quota cooldowns across sessions and processes in `pi-accounts-quota.json` (locked atomic updates, no tokens): new sessions send to the fallback while the primary is known to be exhausted, `/accounts-auto retry` clears globally, configuring a pair keeps real exhaustion, and a corrupt file fails open with a warning. Legacy per-session cooldown entries are ignored.
- Resume failed requests without synthetic prompts or replaying completed tools.
- Require Pi 0.87.1 and reject manual account changes during active responses.

## Upstream history: @narumitw/pi-accounts

## 0.52.2

### Patch Changes

- 751a296: Start Pi sessions without waiting for account-file locks or provider activation, while preserving fail-closed authentication by gating each provider's first use, allowing compatible usage queries to await pending activation, and cancelling stale startup work.
- Updated dependencies [e6db042]
  - @narumitw/pi-tui-kit@0.65.1

## 0.52.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.52.0

### Minor Changes

- da8b65e: Add a Set default account picker to `/accounts` for each provider. New sessions use the saved default, while current, resumed, and reloaded sessions retain their own account selections. Preserve unknown settings fields during saves and order asynchronous reads after queued writes.

## 0.51.0

### Minor Changes

- f6b3000: Keep OAuth account selections local to each Pi session and restore them after resume or reload.

## 0.50.0

### Minor Changes

- ae12c77: Add named OAuth account management for xAI, Kimi For Coding, OpenRouter, and Radius.

## 0.49.11

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.49.10

### Patch Changes

- 42e8940: Allow current-account consumers to verify named OAuth credentials through a process-local protocol, including GitHub Copilot usage and OpenAI Codex reset flows.

## 0.49.9

### Patch Changes

- 71125e0: Pass a lifecycle-cancellable signal to provider-owned OAuth refresh so expiring account credentials refresh correctly with Pi 0.84.x.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 0.49.8

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.49.7

### Patch Changes

- 25aa27e: Use Pi's native login dialog and selector for provider OAuth steps in TUI mode while preserving standard extension UI requests in RPC mode.

## 0.49.6

### Patch Changes

- d3242d6: Pass the account menu's abort signal to provider-owned OAuth login so interactive GitHub Copilot and other provider logins do not fail while Pi is idle and stop safely when their session closes.
