# pi-ecosystem

Season's Pi packages, published independently to npm.

## Packages

- [`@season179/pi-buddy`](./packages/pi-buddy) - A cheap buddy model that watches the session and raises concerns.
- [`@season179/pi-herdr`](./packages/pi-herdr) - Non-blocking watches + wake so a pi orchestrator can herd workers inside herdr.
- [`@season179/pi-guard`](./packages/pi-guard) - Intent reviewer that blocks unauthorized or unrelated tool actions.
- [`@season179/pi-model-fallback`](./packages/pi-model-fallback) - Automatic model failover driven by a standalone fallback-models.json config.
- [`@season179/pi-worktree`](./packages/pi-worktree) - Adds a Claude Code-like `--worktree` flag to Pi.
- [`@season179/pi-skills-status`](./packages/pi-skills-status) - Shows the skills used in the current Pi session.
- [`@season179/pi-readbeam`](./packages/pi-readbeam) - Replaces assistant messages with highlighted placeholders (proof-of-concept).

Retired: `packages/pi-moa` (superseded by pi-buddy — see its
[docs/DESIGN.md](./packages/pi-moa/docs/DESIGN.md)) and
`packages/pi-delegate` (failed experiment, never published — see
[docs/DELEGATE.md](./docs/DELEGATE.md)).

Design docs live in `docs/` — at the repo root for cross-package history
(shelved/retired designs), and per package for the living ones
(e.g. `packages/pi-herdr/docs/DESIGN.md`).

## Development

```bash
npm install
npm run build          # all workspaces
npm run validate       # build + npm pack dry-runs
```

## Publishing

Calver versioning (`YY.M.PATCH`). Use the GitHub Actions `Publish`
workflow (`workflow_dispatch`, trusted publishing) for packages listed
there; a brand-new package needs one manual first publish:

```bash
npm publish --workspace @season179/<package> --access public
```
