# pi-ecosystem

Season's Pi packages, published independently to npm.

## Packages

- [`@season179/pi-worktree`](./packages/pi-worktree) - Adds a Claude Code-like `--worktree` flag to Pi.
- [`@season179/pi-skills-status`](./packages/pi-skills-status) - Shows the skills used in the current Pi session.

## Development

```bash
npm install
npm run build
npm pack --workspace @season179/pi-worktree
npm pack --workspace @season179/pi-skills-status
```

## Publishing

Scoped public packages require `--access public`:

```bash
npm publish --workspace @season179/pi-worktree --access public
npm publish --workspace @season179/pi-skills-status --access public
```
