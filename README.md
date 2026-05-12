# pi-ecosystem

Season's Pi packages, published independently to npm.

## Packages

- [`@season179/pi-worktree`](./packages/pi-worktree) - Adds a Claude Code-like `--worktree` flag to Pi.
- [`@season179/pi-skills-status`](./packages/pi-skills-status) - Shows the skills used in the current Pi session.
- [`@season179/pi-readbeam`](./packages/pi-readbeam) - Automatically replaces assistant messages with highlighted placeholders (proof-of-concept).

## Development

```bash
npm install
npm run build
npm pack --workspace @season179/pi-worktree
npm pack --workspace @season179/pi-skills-status
npm pack --workspace @season179/pi-readbeam
```

## Publishing

Scoped public packages require `--access public`:

```bash
npm publish --workspace @season179/pi-worktree --access public
npm publish --workspace @season179/pi-skills-status --access public
npm publish --workspace @season179/pi-readbeam --access public
```
