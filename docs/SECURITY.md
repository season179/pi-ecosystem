# Security Policy

## Reporting a Vulnerability

Please report security issues privately by opening a GitHub security advisory for this repository:

https://github.com/season179/pi-ecosystem/security/advisories/new

If GitHub advisories are unavailable, email the maintainer listed in the affected package metadata.

## Scope

Security reports are welcome for every active package in this repository,
whether published or pre-release. Retired code is out of maintenance scope unless
the report affects an artifact that is still publicly distributed.

These extensions execute with the current user's permissions and are workflow
guardrails, not operating-system sandboxes. In particular:

- `pi-worktree` runs Git commands, rewrites Pi tool paths, and manages local worktrees.
- `pi-buddy` sends persisted session/context data to configured model providers and can send documentation questions to DeepWiki; its model-facing tools are read-only, not a data-isolation boundary.
- `pi-herdr` starts bounded watch children and POSIX shell commands with the Pi process's cwd, environment, and permissions. Command summaries and bounded output can be persisted in Pi session cards even though command text/output is omitted from its JSONL telemetry.
- `pi-guard` reviews whether an action matches authenticated user intent; it is not a general risk classifier or shell sandbox.

## Expectations

Please include:

- affected package and version;
- reproduction steps or proof of concept;
- expected impact;
- any relevant logs or environment details.

I will acknowledge valid reports as soon as practical and coordinate a fix or disclosure timeline based on severity.
