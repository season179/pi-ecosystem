/**
 * End-to-end test for the pi-readbeam rendering pipeline.
 *
 * Exercises the full path: segment → analyze → render, verifying that
 * the final output makes action verbs and noun phrases visually distinct
 * while preserving protected segments and Markdown structure.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderContent } from "../renderer.ts";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const BOLD_ON = "\x1b[1m";
const UL_ON = "\x1b[4m";

/** Strip all ANSI escape sequences from text. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Extract the text content of ANSI-wrapped spans matching a given
 * opening code. Returns the inner text of each match.
 */
function extractFormatted(text: string, code: string): string[] {
	const escaped = code.replace(/\[/g, "\\[");
	const pattern = new RegExp(`${escaped}([^\\x1b]+)\\x1b\\[\\d+m`, "g");
	const matches: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = pattern.exec(text)) !== null) {
		matches.push(m[1]);
	}
	return matches;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-readbeam end-to-end pipeline", () => {
	// ---- Realistic assistant summary --------------------------------------

	describe("realistic assistant summary", () => {
		const summary = [
			"# Fix: API Timeout Error",
			"",
			"The issue was in the HTTP client configuration.",
			"",
			"## Root Cause",
			"",
			"The `fetch` call in `src/client.ts` had no timeout:",
			"",
			"```typescript",
			"const res = await fetch(url);",
			"```",
			"",
			"Added a 5-second timeout:",
			"",
			"$ npm install abort-controller",
			"",
			"```diff",
			"@@ -10,3 +10,4 @@",
			" const controller = new AbortController();",
			"+const timeout = setTimeout(() => controller.abort(), 5000);",
			" const res = await fetch(url, { signal: controller.signal });",
			"+clearTimeout(timeout);",
			"```",
			"",
			"See https://developer.mozilla.org/en-US/docs/Web/API/AbortController.",
			"",
			"Fix applied in /app/src/client.ts — see the diff above.",
			"",
			"- Tested with `curl https://api.example.com`",
			"- File: /app/src/client.ts",
			"",
			"[2024-01-15T10:30:00Z] INFO  Request completed in 120ms",
			"",
			"Installed abort-controller@5.0.0 to fix the issue.",
		].join("\n");

		it("preserves the original text when ANSI is stripped", () => {
			const rendered = renderContent(summary);
			assert.strictEqual(stripAnsi(rendered), summary);
		});

		it("contains bold formatting for action verbs", () => {
			const rendered = renderContent(summary);
			const bolds = extractFormatted(rendered, BOLD_ON);

			// At least some action verbs should be bolded.
			// The exact set depends on compromise's POS tagging, but we
			// can assert that *some* bold spans exist and they look like
			// verbs (not structural text).
			assert.ok(
				bolds.length > 0,
				`expected at least one bold span, got: ${JSON.stringify(bolds)}`,
			);

			// Common agent-summary verbs that should appear
			const boldJoined = bolds.join(" ").toLowerCase();
			const expectedVerbs = ["added", "installed", "tested"];
			const found = expectedVerbs.filter((v) =>
				boldJoined.includes(v),
			);
			assert.ok(
				found.length > 0,
				`expected at least one of ${expectedVerbs} in bold spans, got: ${JSON.stringify(bolds)}`,
			);
		});

		it("contains underline formatting for noun phrases", () => {
			const rendered = renderContent(summary);
			const underlines = extractFormatted(rendered, UL_ON);

			assert.ok(
				underlines.length > 0,
				`expected at least one underline span, got: ${JSON.stringify(underlines)}`,
			);
		});

		it("preserves code fences without ANSI codes inside them", () => {
			const rendered = renderContent(summary);

			// The TypeScript code fence should be intact
			assert.ok(
				rendered.includes("```typescript\nconst res = await fetch(url);\n```"),
				"TypeScript code fence should be preserved exactly",
			);

			// The diff code fence should be intact
			assert.ok(
				rendered.includes("```diff\n@@ -10,3 +10,4 @@"),
				"diff code fence should be preserved exactly",
			);

			// No ANSI codes inside code fences
			const codeFenceRegex = /```[^\n]*\n([\s\S]*?)```/g;
			let match: RegExpExecArray | null;
			while ((match = codeFenceRegex.exec(rendered)) !== null) {
				const body = match[1];
				assert.ok(
					!body.includes("\x1b["),
					`code fence body should not contain ANSI codes: ${JSON.stringify(body)}`,
				);
			}
		});

		it("preserves inline code unchanged", () => {
			const rendered = renderContent(summary);

			// Inline code should not have ANSI codes inside
			const inlineCodeRegex = /`([^`\n]+)`/g;
			let match: RegExpExecArray | null;
			while ((match = inlineCodeRegex.exec(rendered)) !== null) {
				const code = match[0];
				assert.ok(
					!code.includes("\x1b["),
					`inline code should not contain ANSI codes: ${JSON.stringify(code)}`,
				);
			}
		});

		it("preserves URLs unchanged", () => {
			const rendered = renderContent(summary);

			assert.ok(
				rendered.includes("https://developer.mozilla.org/en-US/docs/Web/API/AbortController"),
				"MDN URL should be preserved",
			);
		});

		it("preserves file paths unchanged", () => {
			const rendered = renderContent(summary);

			assert.ok(
				rendered.includes("/app/src/client.ts"),
				"file path should be preserved",
			);
		});

		it("preserves shell commands unchanged", () => {
			const rendered = renderContent(summary);

			assert.ok(
				rendered.includes("$ npm install abort-controller"),
				"shell command should be preserved",
			);
		});

		it("preserves bullets unchanged", () => {
			const rendered = renderContent(summary);

			assert.ok(rendered.includes("- Tested with"));
			assert.ok(rendered.includes("- File:"));
		});

		it("preserves log output unchanged", () => {
			const rendered = renderContent(summary);

			assert.ok(
				rendered.includes("[2024-01-15T10:30:00Z] INFO  Request completed in 120ms"),
				"log line should be preserved",
			);
		});

		it("preserves package references unchanged", () => {
			const rendered = renderContent(summary);

			assert.ok(
				rendered.includes("abort-controller@5.0.0"),
				"package ref should be preserved",
			);
		});

		it("preserves headings unchanged", () => {
			const rendered = renderContent(summary);

			assert.ok(rendered.includes("# Fix: API Timeout Error"));
			assert.ok(rendered.includes("## Root Cause"));
		});

		it("preserves markdown links unchanged", () => {
			// The summary doesn't have [text](url) links, but let's add one
			const withLink =
				"Fixed the bug. See [the PR](https://github.com/pr/42) for details.";
			const rendered = renderContent(withLink);

			assert.ok(
				rendered.includes("[the PR](https://github.com/pr/42)"),
				"markdown link should be preserved",
			);
		});
	});

	// ---- Idempotency in the pipeline --------------------------------------

	describe("idempotency", () => {
		it("re-rendering produces identical output", () => {
			const text =
				"Fixed the API timeout error by adding retry logic to the HTTP client.";
			const first = renderContent(text);
			const second = renderContent(first);

			assert.strictEqual(first, second);
		});

		it("re-rendering a full summary is idempotent", () => {
			const text = [
				"# Fix: Timeout",
				"",
				"Fixed the error and deployed the fix.",
				"",
				"```js",
				"const x = 1;",
				"```",
				"",
				"See https://example.com.",
			].join("\n");

			const first = renderContent(text);
			const second = renderContent(first);
			const third = renderContent(second);

			assert.strictEqual(first, second);
			assert.strictEqual(second, third);
		});
	});

	// ---- Visual distinctness ----------------------------------------------

	describe("visual distinctness", () => {
		it("action verbs and noun phrases use different ANSI codes", () => {
			const text =
				"Fixed the timeout error and updated the client configuration.";
			const rendered = renderContent(text);

			const hasBold = rendered.includes(BOLD_ON);
			const hasUnderline = rendered.includes(UL_ON);

			// At minimum, if both span types are present, they use different codes.
			// If only one type is found, that's also acceptable (the other kind
			// may not have been detected by the analyzer).
			if (hasBold && hasUnderline) {
				// Verify they're different codes
				const boldFormatted = extractFormatted(rendered, BOLD_ON);
				const ulFormatted = extractFormatted(rendered, UL_ON);

				// No span should appear in both sets
				for (const b of boldFormatted) {
					assert.ok(
						!ulFormatted.includes(b),
						`"${b}" should not be both bold and underlined`,
					);
				}
			}

			// At least one kind of formatting should be present
			assert.ok(
				hasBold || hasUnderline,
				"expected at least one kind of ANSI formatting",
			);
		});
	});

	// ---- Readability without ANSI support ----------------------------------

	describe("readability without ANSI", () => {
		it("output without ANSI codes is the original text", () => {
			const text =
				"Fixed the API timeout error. Updated the client configuration and deployed the fix.";
			const rendered = renderContent(text);
			const plain = stripAnsi(rendered);

			assert.strictEqual(plain, text);
		});

		it("ANSI codes do not break word boundaries", () => {
			const text = "Fixed the error and deployed the fix.";
			const rendered = renderContent(text);

			// Splitting on whitespace should produce the same words
			const originalWords = text.split(/\s+/);
			const renderedWords = stripAnsi(rendered).split(/\s+/);

			assert.deepStrictEqual(renderedWords, originalWords);
		});
	});
});
