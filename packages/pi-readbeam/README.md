# @season179/pi-readbeam

A Pi extension that intercepts finalized assistant messages, segments them into prose and protected regions, extracts linguistic spans, and renders them with terminal-safe ANSI formatting for calm summary scanning.

## What it does

- Listens for `message_end` lifecycle events
- Segments Markdown into **prose** (eligible for highlighting) and **protected** regions (code, URLs, paths, diffs, etc.)
- Extracts **action verbs** and **noun phrases** from prose via a `LinguisticAnalyzer` adapter
- Renders prose with ANSI formatting: **bold** for action verbs, <u>underline</u> for noun phrases
- Preserves the assistant role and all other message properties (usage, etc.)
- Skips user and tool result messages entirely
- Includes an anti-recursion guard to prevent double-processing

## Architecture

```
readbeam.ts          — Pi extension entry point (message_end hook)
lib/segment.ts       — Content segmentation (prose vs. protected)
lib/analyzer.ts      — Linguistic span extraction (action verbs, noun phrases)
lib/renderer.ts      — ANSI rendering of linguistic spans
lib/__tests__/       — Unit tests + end-to-end pipeline tests
```

### Content segmentation (segment.ts)

Splits Markdown into alternating prose and protected segments. Concatenating all segment `.content` values reproduces the original text exactly.

Protected kinds: `code-fence`, `inline-code`, `url`, `file-path`, `shell-command`, `diff`, `stack-trace`, `log-output`, `heading`, `bullet`, `link`, `package-ref`.

### Linguistic analyzer (analyzer.ts)

Extracts typed spans from prose segments behind a `LinguisticAnalyzer` interface:

- **Action verbs** — past, present, and gerund forms. Auxiliaries, copulas, modals, and weak verbs are suppressed.
- **Noun phrases** — multi-word NPs preferred over single nouns when spans overlap. Determiners are stripped from the returned text. Generic single-word nouns ("things", "issue") are suppressed.

Each span carries `start`/`end` character offsets into the original prose string.

### Content renderer (renderer.ts)

Takes raw Markdown text through the full pipeline: segment → analyze → render.

- **Action verbs** → bold (`\x1b[1m…\x1b[22m`)
- **Noun phrases** → underline (`\x1b[4m…\x1b[24m`)
- **Protected segments** → pass through unchanged

Both ANSI treatments are universally supported across modern terminals and remain readable when ANSI rendering is unavailable (escape codes are harmlessly ignored, leaving raw text intact). Stripping all ANSI codes from rendered output recovers the original text exactly.

The renderer includes an idempotency guard: if the input already contains our ANSI formatting codes, it is returned unchanged.

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

After sending a prompt, every assistant message in the TUI should show the summary with **bold** action verbs and <u>underlined</u> noun phrases. Protected content (code, URLs, paths, diffs, etc.) passes through unchanged. User messages and tool results should be unaffected.

## Development

```bash
# Build
npm run build --workspace @season179/pi-readbeam

# Test (segmentation + linguistic analyzer + renderer + e2e)
npm test --workspace @season179/pi-readbeam

# Watch mode
npx tsc -p packages/pi-readbeam/tsconfig.json --watch
```

## Public API

```typescript
import {
  segmentContent, isProtected, isProse,
  createAnalyzer, CompromiseAnalyzer,
  renderContent,
} from "@season179/pi-readbeam";

import type {
  Segment, ProtectedSegment, ProseSegment, SegmentKind,
  LinguisticSpan, LinguisticAnalyzer, SpanKind,
  RenderOptions,
} from "@season179/pi-readbeam";
```
