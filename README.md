# pi-ecosystem

Season's Pi package workspace. Packages are versioned independently and published to npm when ready.

## Packages

- [`@season179/pi-buddy`](./packages/pi-buddy) — Published. Read-only sparring partner for requested consultations and automatic review.
- [`@season179/pi-herdr`](./packages/pi-herdr) — Pre-release. Non-blocking watch/wake bridge for a Pi orchestrator already operating through Herdr.
- [`@season179/pi-guard`](./packages/pi-guard) — Pre-release. Intent reviewer that blocks unauthorized or unrelated tool actions.
- [`@season179/pi-memory`](./packages/pi-memory) — Pre-release. Scoped project/legacy-global memory with explicit tools and mode-controlled transient catalogs.
- [`@season179/pi-model-fallback`](./packages/pi-model-fallback) — Published. Automatic model failover driven by a standalone `fallback-models.json` config.
- [`@season179/pi-worktree`](./packages/pi-worktree) — Published. Adds a Claude Code-like `--worktree` flag to Pi.
- [`@season179/pi-skills-status`](./packages/pi-skills-status) — Published. Shows the skills used in the current Pi session.
- [`@season179/pi-readbeam`](./packages/pi-readbeam) — Pre-release proof of concept for calmer assistant-message scanning.

Retired: `packages/pi-moa` (superseded by pi-buddy — see its
[docs/DESIGN.md](./packages/pi-moa/docs/DESIGN.md)) and
`packages/pi-delegate` (failed experiment, never published — see
[docs/DELEGATE.md](./docs/DELEGATE.md)).

Design docs live in `docs/` — at the repo root for cross-package history
(shelved/retired designs), and per package for living or proposed work. The
[`pi-runbook` design](./packages/pi-runbook/docs/DESIGN.md) is design-stage
only; it is not yet a package.

## Development

```bash
npm install
npm run build          # all workspaces
npm run validate       # build + configured npm pack dry-runs (not every pre-release workspace yet)
```

## Publishing

Calver versioning (`YY.M.PATCH`). Use the GitHub Actions `Publish`
workflow (`workflow_dispatch`, trusted publishing) for packages listed
there; a brand-new package needs one manual first publish:

```bash
npm publish --workspace @season179/<package> --access public
```
