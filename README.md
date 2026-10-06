# pi-ecosystem

Season's Pi package workspace. Packages are versioned independently and published to npm when ready.

## Packages

- [`@season179/pi-accounts`](./packages/pi-accounts) — Unpublished. OAuth account manager fork with quota-aware ChatGPT primary/fallback switching.

- [`@season179/pi-buddy`](./packages/pi-buddy) — Published. Read-only sparring partner for requested consultations and automatic review.
- [`@season179/pi-herdr`](./packages/pi-herdr) — Pre-release. Non-blocking watch/wake bridge for a Pi orchestrator already operating through Herdr.
- [`@season179/pi-model-fallback`](./packages/pi-model-fallback) — Published. Automatic model failover driven by a standalone `fallback-models.json` config.
- [`@season179/pi-worktree`](./packages/pi-worktree) — Published. Adds a Claude Code-like `--worktree` flag to Pi.
- [`@season179/pi-skills-status`](./packages/pi-skills-status) — Published. Shows the skills used in the current Pi session.
- [`@season179/pi-hindsight`](./packages/pi-hindsight) — Unpublished. Thin official-derived Hindsight integration: automatic capture, Reflect-based retrieval, and scoped fact curation, sharing one bank per repository with the official Claude Code integration.

Retired and removed: `pi-delegate` (superseded by Herdr-managed delegation),
`pi-moa` (superseded by pi-buddy), and the failed `pi-memory` and
`pi-compaction` experiments, including pi-memory's legacy migration script.
Their source remains available in git history.

Cross-package reference docs live in `docs/`; per-package design notes live
under each package. The
[`pi-runbook` design](./packages/pi-runbook/docs/DESIGN.md) is design-stage
only; it is not yet a package.

## Development

```bash
npm install
npm run build          # all workspaces
npm run validate       # build + configured npm pack dry-runs (not every pre-release workspace yet)
```

### Formatting

Prettier is shared at the workspace root. Run from the root with an explicit target:

```bash
npm run format -- 'packages/pi-hindsight/**/*.{ts,mjs,json}'
npm run format:check -- 'packages/pi-hindsight/**/*.{ts,mjs,json}'
```

Replace the package path to format another package, or use `.` for the whole repository.
Generated files and Hindsight's vendored source are excluded. Only pi-hindsight has
been formatted so far; other packages can adopt the shared style separately.

## Publishing

Calver versioning (`YY.M.PATCH`). Use the GitHub Actions `Publish`
workflow (`workflow_dispatch`, trusted publishing) for packages listed
there; a brand-new package needs one manual first publish:

```bash
npm publish --workspace @season179/<package> --access public
```
