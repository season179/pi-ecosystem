import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderContent } from "../renderer.ts";
import type { LinguisticAnalyzer, LinguisticSpan } from "../analyzer.ts";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const UL_ON = "\x1b[4m";
const UL_OFF = "\x1b[24m";

function bold(text: string): string {
	return `${BOLD_ON}${text}${BOLD_OFF}`;
}

function underline(text: string): string {
	return `${UL_ON}${text}${UL_OFF}`;
}

/** Strip all ANSI escape sequences from text. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Stub analyzer for deterministic tests
// ---------------------------------------------------------------------------

/**
 * Create a stub analyzer that returns fixed spans.
 * Useful for testing the renderer in isolation from compromise.
 */
function stubAnalyzer(spans: LinguisticSpan[]): LinguisticAnalyzer {
	return {
		extractSpans(_prose: string): LinguisticSpan[] {
			return [...spans].sort((a, b) => a.start - b.start);
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderContent", () => {
	// ---- Edge cases -------------------------------------------------------

	describe("edge cases", () => {
		it("returns empty string for empty input", () => {
			assert.strictEqual(renderContent(""), "");
		});

		it("returns plain prose unchanged when analyzer finds no spans", () => {
			const text = "no highlights here";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});
			assert.strictEqual(result, text);
		});
	});

	// ---- Action verbs (bold) -----------------------------------------------

	describe("action verb formatting", () => {
		it("wraps a single action verb in bold", () => {
			const text = "Fixed the error.";
			const analyzer = stubAnalyzer([
				{ kind: "action-verb", text: "Fixed", start: 0, end: 5 },
			]);
			const result = renderContent(text, { analyzer });

			assert.strictEqual(result, `${bold("Fixed")} the error.`);
		});

		it("wraps multiple action verbs in bold", () => {
			const text = "Fixed and deployed.";
			const analyzer = stubAnalyzer([
				{ kind: "action-verb", text: "Fixed", start: 0, end: 5 },
				{ kind: "action-verb", text: "deployed", start: 10, end: 18 },
			]);
			const result = renderContent(text, { analyzer });

			assert.strictEqual(
				result,
				`${bold("Fixed")} and ${bold("deployed")}.`,
			);
		});
	});

	// ---- Noun phrases (underline) -----------------------------------------

	describe("noun phrase formatting", () => {
		it("wraps a noun phrase in underline", () => {
			const text = "Updated the client configuration.";
			const analyzer = stubAnalyzer([
				{
					kind: "noun-phrase",
					text: "client configuration",
					start: 12,
					end: 32,
				},
			]);
			const result = renderContent(text, { analyzer });

			assert.strictEqual(
				result,
				`Updated the ${underline("client configuration")}.`,
			);
		});

		it("wraps multiple noun phrases in underline", () => {
			const text = "The API handler and error response.";
			const analyzer = stubAnalyzer([
				{
					kind: "noun-phrase",
					text: "API handler",
					start: 4,
					end: 15,
				},
				{
					kind: "noun-phrase",
					text: "error response",
					start: 20,
					end: 34,
				},
			]);
			const result = renderContent(text, { analyzer });

			assert.strictEqual(
				result,
				`The ${underline("API handler")} and ${underline("error response")}.`,
			);
		});
	});

	// ---- Mixed formatting -------------------------------------------------

	describe("mixed verb and noun formatting", () => {
		it("applies bold and underline to different span kinds", () => {
			const text = "Fixed the timeout error.";
			const analyzer = stubAnalyzer([
				{ kind: "action-verb", text: "Fixed", start: 0, end: 5 },
				{
					kind: "noun-phrase",
					text: "timeout error",
					start: 10,
					end: 23,
				},
			]);
			const result = renderContent(text, { analyzer });

			assert.strictEqual(
				result,
				`${bold("Fixed")} the ${underline("timeout error")}.`,
			);
		});

		it("handles adjacent spans without gap", () => {
			const text = "Deployed server.";
			const analyzer = stubAnalyzer([
				{ kind: "action-verb", text: "Deployed", start: 0, end: 8 },
				{
					kind: "noun-phrase",
					text: "server",
					start: 9,
					end: 15,
				},
			]);
			const result = renderContent(text, { analyzer });

			assert.strictEqual(
				result,
				`${bold("Deployed")} ${underline("server")}.`,
			);
		});
	});

	// ---- Protected segments -----------------------------------------------

	describe("protected segment passthrough", () => {
		it("preserves code fences unchanged", () => {
			const text = "Before\n```js\nconst x = 1;\n```\nAfter";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("```js\nconst x = 1;\n```"));
			assert.strictEqual(stripAnsi(result), text);
		});

		it("preserves inline code unchanged", () => {
			const text = "Use the `useState` hook.";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("`useState`"));
			assert.strictEqual(stripAnsi(result), text);
		});

		it("preserves URLs unchanged", () => {
			const text = "See https://example.com for info.";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("https://example.com"));
			assert.strictEqual(stripAnsi(result), text);
		});

		it("preserves headings unchanged", () => {
			const text = "# Title\n\nSome prose.";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("# Title"));
			assert.strictEqual(stripAnsi(result), text);
		});

		it("preserves bullets unchanged", () => {
			const text = "- Item one\n- Item two\n";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("- Item one"));
			assert.strictEqual(stripAnsi(result), text);
		});

		it("preserves file paths unchanged", () => {
			const text = "Edit /usr/local/bin/node to fix it.";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("/usr/local/bin/node"));
			assert.strictEqual(stripAnsi(result), text);
		});
	});

	// ---- End-to-end with real analyzer ------------------------------------

	describe("end-to-end with default analyzer", () => {
		it("renders action verbs in bold and noun phrases in underline", () => {
			const text = "Fixed the API timeout error by adding retry logic.";
			const result = renderContent(text);

			// Should contain at least one bold sequence (action verb)
			assert.ok(
				result.includes(BOLD_ON),
				`expected bold ANSI codes in output: ${JSON.stringify(result)}`,
			);

			// Stripping ANSI should recover the original text
			assert.strictEqual(stripAnsi(result), text);
		});

		it("does not format protected segments", () => {
			const text =
				"Fixed the error.\n\n```js\nconst x = 1;\n```\n\nDeployed the fix.";
			const result = renderContent(text);

			// Code fence should be intact (no ANSI codes inside it)
			const codeFenceMatch = result.match(/```js\n[\s\S]*?```/);
			assert.ok(codeFenceMatch, "code fence should be present");
			assert.strictEqual(
				codeFenceMatch![0],
				"```js\nconst x = 1;\n```",
				"code fence should have no ANSI codes",
			);

			// Stripping ANSI should recover the original text
			assert.strictEqual(stripAnsi(result), text);
		});
	});

	// ---- Idempotency ------------------------------------------------------

	describe("idempotency guard", () => {
		it("returns text unchanged if it already contains bold ANSI codes", () => {
			const already = `pre ${BOLD_ON}word${BOLD_OFF} post`;
			const result = renderContent(already);
			assert.strictEqual(result, already);
		});

		it("returns text unchanged if it already contains underline ANSI codes", () => {
			const already = `pre ${UL_ON}word${UL_OFF} post`;
			const result = renderContent(already);
			assert.strictEqual(result, already);
		});

		it("returns text unchanged if it contains both bold and underline", () => {
			const already = `${BOLD_ON}verb${BOLD_OFF} the ${UL_ON}noun${UL_OFF}`;
			const result = renderContent(already);
			assert.strictEqual(result, already);
		});

		it("double-rendering is idempotent", () => {
			const text = "Fixed the API timeout error.";
			const first = renderContent(text);
			const second = renderContent(first);

			assert.strictEqual(first, second);
		});

		it("does not false-positive on ANSI codes inside a code fence", () => {
			const text =
				"Fixed the error.\n\n```bash\necho -e \"\x1b[1mBold\x1b[22m\"\n```";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([
					{ kind: "action-verb", text: "Fixed", start: 0, end: 5 },
				]),
			});

			// The prose verb should still be bolded — the guard must not
			// trip on ANSI codes that live inside a protected code fence.
			assert.ok(
				result.includes(`${BOLD_ON}Fixed${BOLD_OFF}`),
				"prose verb should be formatted even when code fence contains ANSI codes",
			);

			// The code fence body must be unchanged (still has the raw ANSI bytes).
			assert.ok(
				result.includes(`\x1b[1mBold\x1b[22m`),
				"ANSI codes inside code fence should be preserved unchanged",
			);
		});
	});

	// ---- Roundtrip property ------------------------------------------------

	describe("roundtrip property", () => {
		it("stripping ANSI from rendered output recovers original text", () => {
			const samples = [
				"Fixed the error.",
				"Updated the HTTP client configuration and deployed the fix.",
				"# Title\n\nSome prose with `code` and https://example.com.",
				"Installed dependencies.\n\n```js\nconsole.log('hi');\n```\n\nDone.",
				"- bullet one\n- bullet two\n",
			];

			for (const text of samples) {
				const rendered = renderContent(text);
				assert.strictEqual(
					stripAnsi(rendered),
					text,
					`roundtrip failed for: ${text.slice(0, 50)}...`,
				);
			}
		});
	});

	// ---- Rendering preserves structure ------------------------------------

	describe("structural preservation", () => {
		it("preserves line breaks", () => {
			const text = "Line 1\n\nLine 3\n\n\nLine 6";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			// Newlines are in protected segments (no kind, but they're prose)
			// The roundtrip check is the real assertion
			assert.strictEqual(stripAnsi(result), text);
		});

		it("preserves markdown links", () => {
			const text = "Check [the docs](https://example.com) for info.";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("[the docs](https://example.com)"));
			assert.strictEqual(stripAnsi(result), text);
		});

		it("preserves inline code within prose", () => {
			const text = "Use `renderContent()` to format text.";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("`renderContent()`"));
			assert.strictEqual(stripAnsi(result), text);
		});

		it("preserves shell commands", () => {
			const text = "Run this:\n$ npm install\nThen continue.";
			const result = renderContent(text, {
				analyzer: stubAnalyzer([]),
			});

			assert.ok(result.includes("$ npm install"));
			assert.strictEqual(stripAnsi(result), text);
		});
	});
});
