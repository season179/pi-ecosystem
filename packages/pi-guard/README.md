# @season179/pi-guard

Intent review for Pi coding agents.

Pi Guard asks one question before every model-initiated CLI or custom-tool action:

> Is this what the user asked for, or a reasonable necessary step toward it?

Aligned actions run normally. Unrelated, broader-than-requested, prompt-injected, or unclear actions are blocked.

Pi Guard does **not** make a separate risk judgment. If the user requested an action, it may run even when it is destructive, irreversible, networked, authenticated, publishes, deploys, or deletes.

## Install

This package is not yet published to npm. From a built `pi-ecosystem` checkout:

```bash
npm install
npm run build --workspace @season179/pi-guard
pi install /absolute/path/to/pi-ecosystem/packages/pi-guard
```

Restart Pi or run `/reload` after installation.

## Behavior

| Action | Behavior |
| --- | --- |
| Built-in `read`, `grep`, `find`, `ls` | Always allowed; no Pi Guard path restrictions |
| Model-initiated `bash`/CLI | Every command receives intent review |
| Approved CLI | Runs through Pi’s normal local bash with normal filesystem, network, environment, and user permissions |
| Built-in workspace `write`/`edit` | Canonical path checks plus recovery snapshot; no reviewer latency |
| Custom/MCP tool | Intent-reviewed; approved tool runs in its owning extension process |
| Human `!` shell | Unchanged; Pi Guard does not intercept it |
| Reviewer failure, timeout, malformed response, or truncated action | Blocked |

Built-in `write`/`edit` skip the reviewer deliberately: they cannot execute arbitrary CLI programs, so path checks plus a recovery snapshot cover them without adding reviewer latency to every ordinary workspace write.

There is no restrictive shell sandbox, network domain allowlist, credential stripping, destructive-command denylist, or unknown-CLI denylist after approval. These mechanisms were deliberately removed — each one could override an aligned approval, contradicting the policy above — so do not re-add any of them as a "safety improvement".

## Reviewer policy

The reviewer sees:

- the exact tool call and arguments;
- the latest authenticated interactive/RPC user input;
- bounded recent user messages and executable tool calls;
- tool source identity.

It does not receive assistant prose, hidden reasoning, or tool-result text as authorization. This prevents instructions found in source files, web pages, PR descriptions, or command output from presenting themselves as user intent.

For bash, the reviewer receives the complete raw command before shell expansion. It must assess substitutions, expansions, pipelines, redirects, environment assignments, nested interpreter payloads, and chained commands individually; an aligned outer command does not authorize an unrelated nested action.

The structured response is:

```json
{
  "outcome": "allow | deny",
  "alignment": "direct | necessary-step | unrelated | broader-than-requested | unclear",
  "rationale": "brief explanation"
}
```

`direct` and `necessary-step` allow execution. Every other alignment blocks.

Historical user messages can resolve context such as “do it,” but only the current authenticated human input can authorize newly broadened scope.

## Configuration

Optional global configuration:

`~/.pi/agent/pi-guard.json`

```json
{
  "protectedPaths": [".git", ".pi/guard.json", ".env", ".env.*"],
  "reviewer": {
    "model": "zai/glm-5.2",
    "timeoutMs": 30000,
    "maxTokens": 256
  }
}
```

- `reviewer.model` defaults to the current Pi model and must use `provider/model` syntax when set.
- `protectedPaths` applies only to built-in `write` and `edit`; the list shown above is the default.
- Legacy `mode`, `shell`, `trustedTools`, and `reviewer.mode` settings are ignored with a warning.

A project may only add protected write paths in `<workspace>/.pi/guard.json`:

```json
{
  "protectedPaths": ["fixtures/production"]
}
```

Project configuration cannot select the reviewer or loosen user policy — a project config that sets `mode`, `reviewer`, or `trustedTools` fails config loading outright rather than being ignored.

## Commands

```text
/guard status
/guard explain
/guard allow-once [last]
/guard restore <snapshot-id>
/guard audit [count]
/guard reload
```

`allow-once` approves the exact fingerprint of the latest eligible denial and is consumed by one matching action. A changed command, argument, cwd, or tool source requires another review.

After three consecutive intent denials, Pi Guard stops the current agent run to prevent retry loops. New genuine user input resets the counter.

## Snapshots and audit

Built-in `write` and `edit` create bounded recovery snapshots under `~/.pi/agent/pi-guard/` before modification. Clean Git-tracked files reference Git objects; dirty, staged, untracked, and non-Git files use compressed content-addressed blobs.

Audit records are stored as bounded JSONL with user-only permissions. They contain redacted action summaries and decisions, not write content or credential values.

## Security boundary

Pi Guard is an intent gate, not an operating-system sandbox. Approved CLI commands have the same authority as commands run by Pi without this extension.

The reviewer is model-based and may make mistakes, including missing disguised shell behavior or prompt injection. Reviewer failures fail closed, but an incorrect `allow` decision is not constrained by a second sandbox layer. Approved commands receive the normal user environment, so a mistaken approval can expose credentials or modify any user-accessible resource. Custom/MCP tools also execute with their extension’s normal permissions.

Review the package source and this trade-off before installation.

## Development

```bash
npm run build --workspace @season179/pi-guard
npm test --workspace @season179/pi-guard
npm pack --workspace @season179/pi-guard --dry-run
```
