# @season179/pi-readbeam

A Pi extension that intercepts finalized assistant messages, segments them into prose and protected regions, and extracts linguistic spans for calm summary scanning.

## What it does

- Listens for `message_end` lifecycle events
- Segments Markdown into **prose** (eligible for highlighting) and **protected** regions (code, URLs, paths, diffs, etc.)
- Extracts **action verbs** and **noun phrases** from prose via a `LinguisticAnalyzer` adapter
- Preserves the assistant role and all other message properties (usage, etc.)
- Skips user and tool result messages entirely
- Includes an anti-recursion guard to prevent double-processing

## Architecture

```
readbeam.ts          — Pi extension entry point (message_end hook)
lib/segment.ts       — Content segmentation (prose vs. protected)
lib/analyzer.ts      — Linguistic span extraction (action verbs, noun phrases)
lib/__tests__/       — Unit tests for both layers
```

### Content segmentation (segment.ts)

Splits Markdown into alternating prose and protected segments. Concatenating all segment `.content` values reproduces the original text exactly.

Protected kinds: `code-fence`, `inline-code`, `url`, `file-path`, `shell-command`, `diff`, `stack-trace`, `log-output`, `heading`, `bullet`, `link`, `package-ref`.

### Linguistic analyzer (analyzer.ts)

Extracts typed spans from prose segments behind a `LinguisticAnalyzer` interface:

- **Action verbs** — past, present, and gerund forms. Auxiliaries, copulas, modals, and weak verbs are suppressed.
- **Noun phrases** — multi-word NPs preferred over single nouns when spans overlap. Determiners are stripped from the returned text. Generic single-word nouns ("things", "issue") are suppressed.

Each span carries `start`/`end` character offsets into the original prose string.

**NLP dependency:** [compromise](https://github.com/spencermountain/compromise) v14 — zero dependencies, ~100 KB, TypeScript-first. Provides POS tagging and noun-phrase chunking. Swap the body of `createAnalyzer()` to switch libraries; the `LinguisticAnalyzer` interface stays unchanged.

## Local smoke test

### Quick test (no install)

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

### Global install (for testing across projects)

```bash
npm run build --workspace @season179/pi-readbeam
ln -s "$(pwd)/packages/pi-readbeam/dist/extensions/readbeam.js" \
  ~/.pi/agent/extensions/readbeam.js
```

## What to look for

After sending a prompt, every assistant message in the TUI should show the placeholder text instead of the original response. User messages and tool results should be unaffected.

## Development

```bash
# Build
npm run build --workspace @season179/pi-readbeam

# Test (segmentation + linguistic analyzer)
npm test --workspace @season179/pi-readbeam

# Watch mode
npx tsc -p packages/pi-readbeam/tsconfig.json --watch
```

## Public API

```typescript
import {
  segmentContent, isProtected, isProse,
  createAnalyzer, CompromiseAnalyzer,
} from "@season179/pi-readbeam";

import type {
  Segment, ProtectedSegment, ProseSegment, SegmentKind,
  LinguisticSpan, LinguisticAnalyzer, SpanKind,
} from "@season179/pi-readbeam";
```
