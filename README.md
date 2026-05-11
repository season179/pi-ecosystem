# pi-ecosystem

Season's Pi packages, published independently to npm.

## Packages

- [`@season179/pi-worktree`](./packages/pi-worktree) - Run Pi inside an isolated git worktree with path guardrails.

## Development

```bash
npm install
npm run build
npm pack --workspace @season179/pi-worktree
```

## Publishing

Scoped public packages require `--access public`:

```bash
npm publish --workspace @season179/pi-worktree --access public
```

