# @season179/pi-readbeam

A Pi extension that automatically intercepts finalized assistant messages and replaces them with highlighted placeholders. This is a proof-of-concept to validate the message replacement extension path before NLP summarization work begins.

## What it does

- Listens for `message_end` lifecycle events
- Replaces assistant message content with a clearly marked placeholder
- Preserves the assistant role and all other message properties (usage, etc.)
- Skips user and tool result messages entirely
- Skips messages with no extractable text content
- Includes an anti-recursion guard to prevent double-processing

## Local smoke test

### Quick test (no install)

Build the package and run pi with the extension directly:

```bash
cd pi-ecosystem
npm install
npm run build --workspace @season179/pi-readbeam
pi -e ./packages/pi-readbeam/dist/extensions/readbeam.js
```

### Project-local install

Add the extension path to your project's `.pi/settings.json`:

```json
{
  "extensions": [
    "./packages/pi-readbeam/dist/extensions/readbeam.js"
  ]
}
```

Then run `pi` normally from the project root.

### Global install (for testing across projects)

Symlink or copy the built extension into `~/.pi/agent/extensions/`:

```bash
# From pi-ecosystem root
npm run build --workspace @season179/pi-readbeam
ln -s "$(pwd)/packages/pi-readbeam/dist/extensions/readbeam.js" \
  ~/.pi/agent/extensions/readbeam.js
```

## What to look for

After sending a prompt, every assistant message in the TUI should show the placeholder text instead of the original response. You should see:

```
[readbeam]

This assistant message has been replaced by the readbeam extension.
Original message: N words, M characters.

This is a placeholder demonstrating automatic message replacement.
The extension preserved the assistant role and replaced the content safely.
```

User messages and tool results should be unaffected.

## Development

```bash
# From pi-ecosystem root
npm run build --workspace @season179/pi-readbeam

# Watch mode (manual, no watcher configured)
npx tsc -p packages/pi-readbeam/tsconfig.json --watch
```

## Architecture

The extension is intentionally minimal:

- **Single event**: Only `message_end` is used
- **Single file**: All logic in `readbeam.ts`
- **Anti-recursion**: Checks for `[readbeam]` prefix before replacing
- **Role preservation**: Spreads all original message properties; only `content` is changed

This proves the core product path: automatic behavior, no slash command, no duplicate message, and safe preservation of assistant message role/content shape.
