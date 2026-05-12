import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createAnalyzer,
	CompromiseAnalyzer,
	type LinguisticSpan,
	type LinguisticAnalyzer,
} from "../analyzer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verbs(spans: LinguisticSpan[]): LinguisticSpan[] {
	return spans.filter((s) => s.kind === "action-verb");
}

function nouns(spans: LinguisticSpan[]): LinguisticSpan[] {
	return spans.filter((s) => s.kind === "noun-phrase");
}

function texts(spans: LinguisticSpan[]): string[] {
	return spans.map((s) => s.text);
}

/** Assert that every span offset is within bounds of the original text. */
function assertOffsetsValid(text: string, spans: LinguisticSpan[]) {
	for (const span of spans) {
		assert.ok(
			span.start >= 0 && span.end <= text.length && span.start < span.end,
			`span "${span.text}" has out-of-bounds offset [${span.start}, ${span.end}) in text of length ${text.length}`,
		);
		assert.strictEqual(
			text.slice(span.start, span.end),
			span.text,
			`span text mismatch: expected "${span.text}" at [${span.start}, ${span.end}), got "${text.slice(span.start, span.end)}"`,
		);
	}
}

/** Assert no two spans overlap. */
function assertNoOverlaps(spans: LinguisticSpan[]) {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		assert.ok(
			sorted[i].start >= sorted[i - 1].end,
			`spans overlap: "${sorted[i - 1].text}" [${sorted[i - 1].start},${sorted[i - 1].end}) and "${sorted[i].text}" [${sorted[i].start},${sorted[i].end})`,
		);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CompromiseAnalyzer (LinguisticAnalyzer)", () => {
	const analyzer = createAnalyzer();

	// ---- Interface contract ------------------------------------------------

	describe("interface", () => {
		it("returns an object implementing LinguisticAnalyzer", () => {
			assert.ok(typeof analyzer.extractSpans === "function");
		});

		it("is a CompromiseAnalyzer instance", () => {
			assert.ok(analyzer instanceof CompromiseAnalyzer);
		});
	});

	// ---- Edge cases -------------------------------------------------------

	describe("edge cases", () => {
		it("returns empty array for empty string", () => {
			assert.deepStrictEqual(analyzer.extractSpans(""), []);
		});

		it("returns empty array for whitespace-only input", () => {
			assert.deepStrictEqual(analyzer.extractSpans("   \n\n  "), []);
		});

		it("returns empty array for text with no useful spans", () => {
			const spans = analyzer.extractSpans("... !!! ???");
			assert.deepStrictEqual(spans, []);
		});

		it("returns only verbs when text has no noun phrases", () => {
			const text = "Created and updated successfully.";
			const spans = analyzer.extractSpans(text);
			assert.ok(nouns(spans).length === 0, "should have no noun spans");
			assert.ok(verbs(spans).length >= 2, "should have verb spans");
		});
	});

	// ---- Action verb extraction --------------------------------------------

	describe("action verbs", () => {
		it("extracts past-tense action verbs", () => {
			const text = "Created a new module and updated the config.";
			const spans = analyzer.extractSpans(text);
			const v = verbs(spans);
			const vTexts = texts(v);

			assert.ok(vTexts.includes("Created"), `expected "Created" in ${vTexts}`);
			assert.ok(vTexts.includes("updated"), `expected "updated" in ${vTexts}`);
		});

		it("extracts present-tense action verbs", () => {
			const text = "The script creates files and deletes old data.";
			const spans = analyzer.extractSpans(text);
			const vTexts = texts(verbs(spans));

			assert.ok(
				vTexts.some((t) => /creates/i.test(t)),
				`expected a "creates" verb in ${vTexts}`,
			);
		});

		it("extracts gerund action verbs", () => {
			const text = "Installing dependencies and configuring the server.";
			const spans = analyzer.extractSpans(text);
			const vTexts = texts(verbs(spans));

			assert.ok(
				vTexts.some((t) => /installing/i.test(t)),
				`expected an "installing" verb in ${vTexts}`,
			);
		});

		it("includes common agent-summary verbs", () => {
			const text =
				"Fixed the bug, tested the change, deployed to staging, and refactored the module.";
			const spans = analyzer.extractSpans(text);
			const vTexts = texts(verbs(spans)).map((t) => t.toLowerCase());

			assert.ok(vTexts.includes("fixed"), `expected "fixed" in ${vTexts}`);
			assert.ok(vTexts.includes("tested"), `expected "tested" in ${vTexts}`);
			assert.ok(vTexts.includes("deployed"), `expected "deployed" in ${vTexts}`);
			assert.ok(vTexts.includes("refactored"), `expected "refactored" in ${vTexts}`);
		});

		it("all verb offsets are valid", () => {
			const text = "Built the project, ran the tests, and shipped the release.";
			const spans = analyzer.extractSpans(text);
			assertOffsetsValid(text, verbs(spans));
		});
	});

	// ---- Weak verb suppression --------------------------------------------

	describe("weak verb suppression", () => {
		it("suppresses copula 'was'", () => {
			const text = "The issue was critical and caused downtime.";
			const spans = analyzer.extractSpans(text);
			const vTexts = texts(verbs(spans)).map((t) => t.toLowerCase());

			assert.ok(
				!vTexts.includes("was"),
				`"was" (copula) should be suppressed, got ${vTexts}`,
			);
			// "caused" and "critical" — at least "caused" should survive
			assert.ok(
				vTexts.some((t) => /caused/.test(t)),
				`expected an action verb, got ${vTexts}`,
			);
		});

		it("suppresses 'is', 'are', 'were'", () => {
			const text = "Tests are passing. The build is green. Errors were found.";
			const spans = analyzer.extractSpans(text);
			const vTexts = texts(verbs(spans)).map((t) => t.toLowerCase());

			for (const weak of ["is", "are", "were"]) {
				assert.ok(
					!vTexts.includes(weak),
					`"${weak}" should be suppressed, got ${vTexts}`,
				);
			}
		});

		it("suppresses weak verb 'seem'", () => {
			const text = "The output seems correct and matches expectations.";
			const spans = analyzer.extractSpans(text);
			const vTexts = texts(verbs(spans)).map((t) => t.toLowerCase());

			assert.ok(
				!vTexts.includes("seem") && !vTexts.includes("seems"),
				`"seems" should be suppressed, got ${vTexts}`,
			);
		});
	});

	// ---- Noun-phrase extraction --------------------------------------------

	describe("noun phrases", () => {
		it("extracts multi-word noun phrases", () => {
			const text =
				"Updated the HTTP client configuration and added retry logic.";
			const spans = analyzer.extractSpans(text);
			const nTexts = texts(nouns(spans));

			assert.ok(
				nTexts.some((t) => /client configuration/i.test(t)),
				`expected "client configuration" NP in ${nTexts}`,
			);
		});

		it("strips determiners from noun phrases", () => {
			const text = "Created a new authentication module.";
			const spans = analyzer.extractSpans(text);
			const nTexts = texts(nouns(spans));

			// The NP root should not start with "a" or "the"
			for (const t of nTexts) {
				assert.ok(
					!/^(a|an|the)\s/i.test(t),
					`NP "${t}" should not start with a determiner`,
				);
			}
		});

		it("extracts compound noun phrases", () => {
			const text = "The API handler returns the error response object.";
			const spans = analyzer.extractSpans(text);
			const nTexts = texts(nouns(spans));

			assert.ok(
				nTexts.some((t) => /api handler/i.test(t)),
				`expected "API handler" NP in ${nTexts}`,
			);
		});

		it("all noun-phrase offsets are valid", () => {
			const text =
				"The error handler processes the timeout response gracefully.";
			const spans = analyzer.extractSpans(text);
			assertOffsetsValid(text, nouns(spans));
		});
	});

	// ---- Weak noun suppression --------------------------------------------

	describe("weak noun suppression", () => {
		it("suppresses standalone 'things'", () => {
			const text = "There are many things to consider about the module.";
			const spans = analyzer.extractSpans(text);
			const nTexts = texts(nouns(spans)).map((t) => t.toLowerCase());

			assert.ok(
				!nTexts.includes("things"),
				`"things" should be suppressed, got ${nTexts}`,
			);
		});

		it("suppresses standalone 'issue'", () => {
			const text = "The main issue was resolved by the patch.";
			const spans = analyzer.extractSpans(text);
			const nTexts = texts(nouns(spans)).map((t) => t.toLowerCase());

			// "issue" alone should be suppressed
			assert.ok(
				!nTexts.includes("issue"),
				`standalone "issue" should be suppressed, got ${nTexts}`,
			);
		});
	});

	// ---- Multi-word preference --------------------------------------------

	describe("multi-word noun preference", () => {
		it("prefers multi-word NP over contained single noun", () => {
			const text = "The authentication module was created. Module exports are clean.";
			const spans = analyzer.extractSpans(text);
			const nTexts = texts(nouns(spans));

			// "authentication module" should appear
			assert.ok(
				nTexts.some((t) => /authentication module/i.test(t)),
				`expected "authentication module" in ${nTexts}`,
			);
		});

		it("does not produce overlapping noun spans", () => {
			const text =
				"Updated the HTTP client configuration. The client responded correctly.";
			const spans = analyzer.extractSpans(text);
			assertNoOverlaps(spans);
		});
	});

	// ---- No overlaps across kinds ------------------------------------------

	describe("cross-kind overlap prevention", () => {
		it("verb and noun spans do not overlap", () => {
			const text =
				"Created a new module. Updated the configuration. Fixed the error handler.";
			const spans = analyzer.extractSpans(text);
			assertNoOverlaps(spans);
		});
	});

	// ---- Full behavioural scenario -----------------------------------------

	describe("realistic agent summary", () => {
		it("extracts a mix of action verbs and noun phrases from a summary", () => {
			const text = [
				"Fixed the API timeout error by adding a retry mechanism.",
				"Updated the HTTP client configuration in src/client.ts.",
				"Installed the new authentication module and tested the login flow.",
				"The build passes and the tests are green.",
			].join(" ");

			const spans = analyzer.extractSpans(text);
			assertOffsetsValid(text, spans);
			assertNoOverlaps(spans);

			const vTexts = texts(verbs(spans)).map((t) => t.toLowerCase());
			const nTexts = texts(nouns(spans)).map((t) => t.toLowerCase());

			// Action verbs
			assert.ok(vTexts.includes("fixed"), `expected "fixed" in ${vTexts}`);
			assert.ok(vTexts.includes("updated"), `expected "updated" in ${vTexts}`);
			assert.ok(vTexts.includes("installed"), `expected "installed" in ${vTexts}`);

			// "are" should be suppressed (copula)
			assert.ok(!vTexts.includes("are"), `"are" should be suppressed in ${vTexts}`);

			// Noun phrases
			assert.ok(
				nTexts.some((t) => /client configuration/i.test(t)),
				`expected "client configuration" in ${nTexts}`,
			);
			assert.ok(
				nTexts.some((t) => /authentication module/i.test(t)),
				`expected "authentication module" in ${nTexts}`,
			);

			// Total span count should be reasonable (not every word highlighted)
			assert.ok(
				spans.length >= 4 && spans.length <= 12,
				`expected 4-12 spans for a summary, got ${spans.length}`,
			);
		});
	});

	// ---- Span ordering -----------------------------------------------------

	describe("span ordering", () => {
		it("returns spans in document order", () => {
			const text = "Fixed the timeout error. Updated the client config.";
			const spans = analyzer.extractSpans(text);

			for (let i = 1; i < spans.length; i++) {
				assert.ok(
					spans[i].start >= spans[i - 1].start,
					`spans not in order: "${spans[i - 1].text}" (${spans[i - 1].start}) before "${spans[i].text}" (${spans[i].start})`,
				);
			}
		});
	});
});
