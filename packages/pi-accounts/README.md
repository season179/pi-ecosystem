# pi-accounts

OAuth account manager with automatic ChatGPT primary/fallback switching.
Local fork of [`@narumitw/pi-accounts`](https://github.com/narumiruna/pi-extensions/tree/decdf985bcb39c32afb89cc48305a4f724760f24/packages/pi-accounts); see [UPSTREAM.md](UPSTREAM.md) and [LICENSE](LICENSE).

## Install locally

Requires Pi **0.87.1 or newer**. From the workspace root:

```sh
npm install
npm run check --workspace @season179/pi-accounts
pi remove npm:@narumitw/pi-accounts
pi install ./packages/pi-accounts
```

Restart Pi after replacing the original extension. Do not load both versions (or the deprecated `pi-codex-accounts`) together: they can refresh the same rotating OAuth credentials.
This package is not yet published to npm.

The fork reuses `~/.pi/agent/pi-accounts.json` (or `$PI_CODING_AGENT_DIR/pi-accounts.json`), Pi's built-in login, and existing session selections. No credential import or new login is necessary.

## Automatic ChatGPT accounts

**No setup command is needed.** When a saved ChatGPT account named **`oc-codex`** exists (add it once with `/accounts`) and no policy is stored, the default policy is **`oc-codex` first, Pi's built-in ChatGPT login (`default`) second**. New, resumed, and reloaded sessions on Pi's login switch to `oc-codex` before their next Codex request; sessions pinned to another saved account are left alone. Without an `oc-codex` account, the default policy is off and Pi's normal login is used unchanged.

To use a different pair, run **`/accounts-auto` → Configure primary and fallback**. `default` means **Pi's built-in ChatGPT login**, not a copied credential.

Commands also work without a picker:

```text
/accounts-auto default backup    # built-in login first; named backup second
/accounts-auto backup default    # named account first; built-in login second
/accounts-auto status            # shows "(default policy)" when nothing is stored
/accounts-auto off               # persistent: stores "autoSwitch": false
/accounts-auto retry
```

Replace `backup` with an account name from `/accounts`. Both accounts must already be usable ChatGPT logins.
A configured pair also selects the primary for the current session and makes it the startup default; the implicit default policy writes nothing to `pi-accounts.json` and records only each session's own account selection. The policy is user-wide; quota cooldowns are session-local and survive resume/reload.

### Behavior

1. Prefer the primary before each Codex turn, between responses—not during streaming or tool execution.
2. After Pi finishes its own retries on a possible quota error, check the **active session account's** ChatGPT usage endpoint once. An ordinary rate limit with remaining quota, an auth error, a network error, or an unavailable usage endpoint does **not** switch accounts.
3. Confirmed exhaustion records the reset deadline and activates the fallback through the existing verified auth path. When safe, an append-only context edit omits the failed assistant attempt and retries the same prompt; raw session history retains the failure. No synthetic user message or completed tool execution is replayed.
4. Use the primary again on the first request after its reported reset, with a one-second timing margin. If both five-hour and weekly windows are exhausted, wait for the later reset. Availability is ultimately confirmed by the next provider request; reset estimates can change.
5. If both accounts are exhausted, stop and show reset times. Later prompts remain blocked until a cooldown expires. If the service reports exhaustion without a usable reset time, report that uncertainty and allow a retry after five minutes.

There are no background timers or usage polls. Idle sessions do not change accounts until a request arrives. Each recovery incident tries an account at most once; a successful turn or a new prompt resets the attempt guard.

`retry` clears this session's saved quota cooldowns; it does not refresh credentials or issue a model request. `off` disables the shared policy, including the default one, without changing the current account; configure a pair to enable it again. Changing settings or accounts is refused while a response is active.

With automatic switching enabled, selecting an account **outside the pair** pauses switching in that session. Selecting back into the pair resumes it. Because `default` is in the default pair, choosing `default` in `/accounts` does **not** pin Pi's login; run `/accounts-auto off` first. If `oc-codex` cannot authenticate or lacks the selected model, Codex requests stop with an error and the session keeps its previous account instead of silently using another identity; fix it through `/accounts` or run `/accounts-auto off`. Missing configured accounts or malformed policy/state block Codex requests rather than silently choosing another identity; reconfigure, disable the policy, or clear quota state with `retry` as appropriate.

## Manual account management

`/accounts` retains the upstream manager:

- Log in to save named OAuth accounts.
- Switch one provider's account in the current session.
- Set provider defaults for new sessions, without changing existing selections.
- Remove saved accounts with confirmation.

Providers: OpenAI Codex, Anthropic, GitHub Copilot, Kimi For Coding, OpenRouter, Radius, and xAI. **Automatic switching is Codex-only.** Model selection is unchanged. API-key profile management is not supported.

Sessions keep independent selections, including on resume/reload. Forks and new sessions start from saved defaults. Selecting `default` restores Pi's original authentication; Pi's built-in credentials are never deleted. Authentication failures fail closed for the affected provider.

The upstream private atomic storage, cross-process credential lock, provider-specific overlays, connection invalidation, and verified `oauth:credential-source:v1` / readiness protocol are retained. See the [pinned upstream documentation](https://github.com/narumiruna/pi-extensions/blob/decdf985bcb39c32afb89cc48305a4f724760f24/packages/pi-accounts/README.md) for provider details and legacy storage migration.

## Storage and privacy

Policy is stored alongside the provider's accounts:

```json
"autoSwitch": { "primary": "default", "fallback": "backup" }
```

An absent field means the default policy; `false` means off. This is the `providers.openai-codex.autoSwitch` field, **not a complete credentials file**. Prefer the command rather than editing it manually. Existing unknown fields and credentials are preserved.

Quota deadlines are non-context custom session entries containing only account names, times, and the owning session ID. They contain no tokens, raw service responses, or usage payloads. The usage check uses the session's effective OAuth token, never the Codex CLI login; it rejects redirects, times out after five seconds, and sanitizes errors.

Quota state is not coordinated between concurrent sessions. Each session independently observes exhaustion. The usage endpoint is an undocumented ChatGPT endpoint and can change; unrecognized responses stop automatic recovery rather than guessing. This feature does not increase either account's allowance. Account entitlements and provider terms still apply.

## Verification and rollback

```sh
npm run check --workspace @season179/pi-accounts
npm pack --workspace @season179/pi-accounts --dry-run
```

Tests include the upstream account/storage/lifecycle/build suites, quota classification and cooldown recovery, plus actual in-memory Pi sessions that fail over and restore primary authentication without live model requests, including a fresh session using the default `oc-codex` → built-in login policy.

To roll back, run `/accounts-auto off`, stop Pi sessions, remove this local package, reinstall `npm:@narumitw/pi-accounts`, and restart. The original reads the same account file; no credential copy is needed. Do not restore stale refresh-token backups over current credentials.
