/**
 * Content renderer for pi-readbeam.
 *
 * Takes raw Markdown text, segments it into prose and protected regions,
 * extracts linguistic spans from prose, and applies terminal-safe ANSI
 * formatting: bold for action verbs, underline for noun phrases.
 *
 * Protected segments (code, URLs, paths, diffs, etc.) pass through unchanged.
 *
 * Visual treatments:
 * - Action verbs  → bold  (\x1b[1m … \x1b[22m)
 * - Noun phrases  → underline (\x1b[4m … \x1b[24m)
 *
 * Both treatments are universally supported across modern terminals and
 * remain readable when ANSI rendering is unavailable (the escape codes
 * are harmlessly ignored or invisible, leaving the raw text intact).
 *
 * Idempotency:
 * If any prose segment already contains ANSI bold-on or underline-on
 * sequences matching our formatting patterns, the renderer returns the
 * text unchanged. Protected segments (code fences, etc.) are excluded
 * from the check so that legitimate ANSI examples in code don't trigger
 * a false positive.
 */

import { segmentContent, isProtected } from "./segment.ts";
import { createAnalyzer, type LinguisticAnalyzer } from "./analyzer.ts";

// ---------------------------------------------------------------------------
// ANSI escape sequences (universal terminal support)
// ---------------------------------------------------------------------------

const BOLD = { on: "\x1b[1m", off: "\x1b[22m" } as const;
const UNDERLINE = { on: "\x1b[4m", off: "\x1b[24m" } as const;

/**
 * Pattern matching our specific ANSI formatting codes.
 * Used to detect already-rendered content for idempotency.
 */
const RENDERED_PATTERN = /\x1b\[(1|4)m/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RenderOptions {
	/** Custom linguistic analyzer. Defaults to the built-in CompromiseAnalyzer. */
	analyzer?: LinguisticAnalyzer;
}

/**
 * Render `text` with ANSI formatting for linguistic spans.
 *
 * - Action verbs are wrapped in bold.
 * - Noun phrases are wrapped in underline.
 * - Protected segments (code, URLs, paths, etc.) pass through unchanged.
 *
 * If the text already contains our ANSI formatting codes, it is returned
 * unchanged (idempotency guard).
 *
 * @returns The formatted string, safe for terminal output.
 */
export function renderContent(text: string, options?: RenderOptions): string {
	if (!text) return "";

	const segments = segmentContent(text);

	// Idempotency guard: skip if any prose segment already carries our
	// formatting.  Protected segments are excluded — ANSI codes inside a
	// code fence are not evidence of prior rendering.
	const alreadyRendered = segments.some(
		(s) => !isProtected(s) && RENDERED_PATTERN.test(s.content),
	);
	if (alreadyRendered) return text;

	const analyzer = options?.analyzer ?? createAnalyzer();
	return segments
		.map((segment) => {
			if (isProtected(segment)) return segment.content;
			return renderProse(segment.content, analyzer);
		})
		.join("");
}

// ---------------------------------------------------------------------------
// Internal rendering
// ---------------------------------------------------------------------------

/**
 * Apply ANSI formatting to linguistic spans within a prose segment.
 * Spans are applied in document order, preserving all surrounding text.
 */
function renderProse(prose: string, analyzer: LinguisticAnalyzer): string {
	const spans = analyzer.extractSpans(prose);
	if (spans.length === 0) return prose;

	let result = "";
	let cursor = 0;

	for (const span of spans) {
		if (span.start > cursor) {
			result += prose.slice(cursor, span.start);
		}

		const chunk = prose.slice(span.start, span.end);
		const fmt = span.kind === "action-verb" ? BOLD : UNDERLINE;
		result += `${fmt.on}${chunk}${fmt.off}`;

		cursor = span.end;
	}

	if (cursor < prose.length) {
		result += prose.slice(cursor);
	}

	return result;
}
