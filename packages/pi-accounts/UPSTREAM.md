# Upstream provenance

- Source: https://github.com/narumiruna/pi-extensions
- Commit: `decdf985bcb39c32afb89cc48305a4f724760f24`
- Package: `packages/pi-accounts`, version `0.52.2`
- Imported: 2026-09-23
- License: MIT, copyright (c) 2026 narumiruna, retained in `LICENSE`.

Only the account package and the helpers required by its build/tests were imported. No other upstream extension, credential file, or repository instruction file was copied.

Relocated helpers:

- `scripts/runtime-builder.mjs` → this package's `scripts/runtime-builder.mjs`
- `test/support.ts` → this package's `test/support.ts`
- `test/runtime-builder-contract.ts` → this package's `test/runtime-builder-contract.ts`

Local changes:

- Workspace/package identity, CalVer, package-local helper imports, and Pi 0.87.1 compatibility floor.
- Codex priority/fallback policy (default `oc-codex` → built-in login when that account exists; persistent `off`), verified usage checks, session-owned cooldowns, safe boundary continuation, and `/accounts-auto`.
- Prevent manual account changes during active responses.
- Focused regression and real Pi session-loop tests; fork documentation.

Keep upstream authentication, storage, menus, and provider behavior recognizable. Future updates should compare against the pinned snapshot and deliberately merge changes, not overwrite this fork. `CHANGELOG.md` below the fork entry retains the upstream release history.
