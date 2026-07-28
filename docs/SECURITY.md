# Security Policy

## Reporting a Vulnerability

Please report security issues privately by opening a GitHub security advisory for this repository:

https://github.com/season179/pi-ecosystem/security/advisories/new

If GitHub advisories are unavailable, email the maintainer listed on the npm package.

## Scope

Security reports are welcome for published packages in this repository, including:

- `@season179/pi-worktree`
- `@season179/pi-skills-status`

For `@season179/pi-worktree`, remember that the package intentionally runs git commands, rewrites Pi tool paths, and manages local worktrees with the current user's permissions. It is a workflow guardrail, not an operating-system sandbox.

## Expectations

Please include:

- affected package and version;
- reproduction steps or proof of concept;
- expected impact;
- any relevant logs or environment details.

I will acknowledge valid reports as soon as practical and coordinate a fix or disclosure timeline based on severity.
