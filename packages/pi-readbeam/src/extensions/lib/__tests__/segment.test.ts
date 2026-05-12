import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	segmentContent,
	isProtected,
	isProse,
	type Segment,
	type ProtectedSegment,
	type SegmentKind,
} from "../segment.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function protecteds(segments: Segment[]): ProtectedSegment[] {
	return segments.filter(isProtected);
}

function proseText(segments: Segment[]): string {
	return segments
		.filter(isProse)
		.map((s) => s.content)
		.join("");
}

function kinds(segments: Segment[]): SegmentKind[] {
	return protecteds(segments).map((s) => s.kind);
}

/** Verify concatenating all segments reproduces the original text. */
function assertRoundtrip(text: string) {
	const segments = segmentContent(text);
	const reconstructed = segments.map((s) => s.content).join("");
	assert.strictEqual(reconstructed, text, "roundtrip: segments must reconstruct original text");
}

/** Return the first protected segment, or fail. */
function firstProtected(segments: Segment[]): ProtectedSegment {
	const p = protecteds(segments);
	assert.ok(p.length > 0, "expected at least one protected segment");
	return p[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("segmentContent", () => {
	// ---- Edge cases ----

	describe("edge cases", () => {
		it("returns empty array for empty string", () => {
			assert.deepStrictEqual(segmentContent(""), []);
		});

		it("returns a single prose segment for plain text", () => {
			const s = segmentContent("hello world");
			assert.strictEqual(s.length, 1);
			assert.deepStrictEqual(s[0], { type: "prose", content: "hello world" });
		});

		it("roundtrips arbitrary text", () => {
			const samples = [
				"",
				"just prose",
				"# Heading\n\nSome `code` and https://example.com\n",
				"```js\nconst x = 1;\n```\n\nAfter code",
				"- bullet\n- bullet 2\n",
				"$ npm install foo\n",
			];
			for (const sample of samples) {
				assertRoundtrip(sample);
			}
		});
	});

	// ---- Code fences ----

	describe("code fences", () => {
		it("preserves fenced code blocks exactly", () => {
			const text = "Before\n```typescript\nconst x = 1;\n```\nAfter";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "code-fence");
			assert.strictEqual(p.content, "```typescript\nconst x = 1;\n```");
		});

		it("handles code fence with no language tag", () => {
			const text = "```\nraw code\n```";
			const segments = segmentContent(text);
			assertRoundtrip(text);
			assert.strictEqual(firstProtected(segments).kind, "code-fence");
		});

		it("handles multiple code fences", () => {
			const text = "A\n```\nfirst\n```\nB\n```python\nsecond\n```\nC";
			const segments = segmentContent(text);
			assertRoundtrip(text);
			const p = protecteds(segments);
			assert.strictEqual(p.length, 2);
			assert.strictEqual(p[0].kind, "code-fence");
			assert.strictEqual(p[1].kind, "code-fence");
		});

		it("does not treat unclosed code fence as protected", () => {
			const text = "no closing fence\n```\nstill open";
			const segments = segmentContent(text);
			// Should not have any code-fence segments
			assert.ok(!protecteds(segments).some((s) => s.kind === "code-fence"));
		});
	});

	// ---- Inline code ----

	describe("inline code", () => {
		it("protects inline code", () => {
			const text = "Use the `useState` hook for state.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "inline-code");
			assert.strictEqual(p.content, "`useState`");
		});

		it("handles multiple inline code spans", () => {
			const text = "Call `foo()` then `bar()`.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments);
			assert.strictEqual(p.length, 2);
			assert.strictEqual(p[0].content, "`foo()`");
			assert.strictEqual(p[1].content, "`bar()`");
		});

		it("does not protect empty backticks", () => {
			// `` alone shouldn't match — requires at least one char
			const text = "nothing `` here";
			const segments = segmentContent(text);
			assert.ok(protecteds(segments).length === 0);
		});
	});

	// ---- URLs ----

	describe("URLs", () => {
		it("protects http URLs", () => {
			const text = "See http://example.com for details.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "url");
			assert.strictEqual(p.content, "http://example.com");
		});

		it("protects https URLs with paths", () => {
			const text = "Visit https://github.com/season179/pi-ecosystem/issues/2";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "url");
			assert.ok(p.content.startsWith("https://"));
		});

		it("does not include trailing punctuation in URL", () => {
			const text = "Go to https://example.com.";
			const segments = segmentContent(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "url");
			assert.strictEqual(p.content, "https://example.com");
		});

		it("does not include trailing parenthesis in URL", () => {
			const text = "Link: https://example.com/path).";
			const segments = segmentContent(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.content, "https://example.com/path");
		});
	});

	// ---- File paths ----

	describe("file paths", () => {
		it("protects absolute file paths", () => {
			const text = "Edit /usr/local/bin/node to fix it.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "file-path");
			assert.strictEqual(p.content, "/usr/local/bin/node");
		});

		it("protects relative file paths", () => {
			const text = "See ./src/index.ts for the entry point.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "file-path");
			assert.strictEqual(p.content, "./src/index.ts");
		});

		it("protects home-relative paths", () => {
			const text = "Config at ~/.config/app/settings.json";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "file-path");
			assert.strictEqual(p.content, "~/.config/app/settings.json");
		});

		it("protects parent-relative paths", () => {
			const text = "See ../other-module/lib.ts";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "file-path");
			assert.strictEqual(p.content, "../other-module/lib.ts");
		});
	});

	// ---- Shell commands ----

	describe("shell commands", () => {
		it("protects shell command lines", () => {
			const text = "Run this:\n$ npm install\nThen continue.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments).filter(
				(s) => s.kind === "shell-command",
			);
			assert.strictEqual(p.length, 1);
			assert.strictEqual(p[0].content.trim(), "$ npm install");
		});

		it("protects shell commands with arguments", () => {
			const text = "$ git commit -m 'initial'";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "shell-command");
		});
	});

	// ---- Diff hunks ----

	describe("diffs", () => {
		it("protects unified diff hunks", () => {
			const text =
				"Here is the diff:\n" +
				"@@ -1,3 +1,4 @@\n" +
				" context\n" +
				"-old line\n" +
				"+new line\n" +
				"+added line\n" +
				"Done.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments).filter((s) => s.kind === "diff");
			assert.strictEqual(p.length, 1);
			assert.ok(p[0].content.includes("@@ -1,3 +1,4 @@"));
			assert.ok(p[0].content.includes("+new line"));
		});

		it("protects file header diffs", () => {
			const text = "--- a/file.ts\n+++ b/file.ts\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments).filter((s) => s.kind === "diff");
			assert.ok(p.length >= 1);
		});
	});

	// ---- Stack traces ----

	describe("stack traces", () => {
		it("protects Node.js-style stack traces", () => {
			const text =
				"Something broke:\n" +
				"TypeError: Cannot read property 'x' of undefined\n" +
				"    at Object.<anonymous> (/app/index.js:10:5)\n" +
				"    at Module._compile (node:internal/modules/cjs/loader:1198:14)\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments).filter(
				(s) => s.kind === "stack-trace",
			);
			assert.strictEqual(p.length, 1);
			assert.ok(p[0].content.includes("TypeError:"));
			assert.ok(p[0].content.includes("at Object.<anonymous>"));
		});

		it("protects Python-style stack traces", () => {
			const text =
				"Traceback (most recent call last):\n" +
				'  File "app.py", line 5, in <module>\n' +
				"    main()\n" +
				"ValueError: invalid literal\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments).filter(
				(s) => s.kind === "stack-trace",
			);
			assert.ok(p.length >= 1);
			assert.ok(p[0].content.includes("Traceback"));
		});

		it("does not treat standalone 'at' lines as stack traces", () => {
			const text = "at the beginning of the function, we initialize state.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			assert.ok(!protecteds(segments).some((s) => s.kind === "stack-trace"));
		});
	});

	// ---- Log output ----

	describe("log output", () => {
		it("protects ISO-timestamped log lines", () => {
			const text =
				"Logs:\n" +
				"[2024-01-15T10:30:00Z] INFO  Server started\n" +
				"[2024-01-15T10:30:01Z] ERROR Connection refused\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments).filter(
				(s) => s.kind === "log-output",
			);
			assert.strictEqual(p.length, 1);
			assert.ok(p[0].content.includes("ERROR"));
		});

		it("protects bracket-level log lines", () => {
			const text = "[INFO] Starting\n[WARN] Low memory\n[ERROR] OOM\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments).filter(
				(s) => s.kind === "log-output",
			);
			assert.strictEqual(p.length, 1);
		});
	});

	// ---- Headings ----

	describe("headings", () => {
		it("protects Markdown headings", () => {
			const text = "# Title\n\n## Subtitle\n\nSome prose.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const h = protecteds(segments).filter((s) => s.kind === "heading");
			assert.strictEqual(h.length, 2);
			assert.strictEqual(h[0].content.trim(), "# Title");
			assert.strictEqual(h[1].content.trim(), "## Subtitle");
		});

		it("protects h1 through h6", () => {
			for (let level = 1; level <= 6; level++) {
				const text = `${"#".repeat(level)} Heading`;
				const segments = segmentContent(text);
				const p = firstProtected(segments);
				assert.strictEqual(p.kind, "heading");
			}
		});

		it("does not treat ### without space as heading", () => {
			const text = "###no-space";
			const segments = segmentContent(text);
			assert.ok(protecteds(segments).length === 0);
		});
	});

	// ---- Bullets ----

	describe("bullets", () => {
		it("protects dash bullets", () => {
			const text = "- Item one\n- Item two\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const b = protecteds(segments).filter((s) => s.kind === "bullet");
			assert.strictEqual(b.length, 2);
		});

		it("protects asterisk bullets", () => {
			const text = "* Item\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			assert.strictEqual(firstProtected(segments).kind, "bullet");
		});

		it("protects numbered list items", () => {
			const text = "1. First\n2. Second\n3. Third\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const b = protecteds(segments).filter((s) => s.kind === "bullet");
			assert.strictEqual(b.length, 3);
		});

		it("protects indented bullets", () => {
			const text = "  - nested item\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			assert.strictEqual(firstProtected(segments).kind, "bullet");
		});
	});

	// ---- Markdown links ----

	describe("links", () => {
		it("protects Markdown links", () => {
			const text = "Check [the docs](https://example.com/docs) for info.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "link");
			assert.strictEqual(p.content, "[the docs](https://example.com/docs)");
		});

		it("handles multiple links", () => {
			const text = "[a](http://a.com) and [b](http://b.com)";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments).filter((s) => s.kind === "link");
			assert.strictEqual(p.length, 2);
		});
	});

	// ---- Package references ----

	describe("package references", () => {
		it("protects scoped package refs", () => {
			const text = "Install @scope/pkg@1.2.3 to proceed.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "package-ref");
			assert.strictEqual(p.content, "@scope/pkg@1.2.3");
		});

		it("protects unscoped package refs", () => {
			const text = "Upgrade express@4.18.2 to fix it.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = firstProtected(segments);
			assert.strictEqual(p.kind, "package-ref");
			assert.strictEqual(p.content, "express@4.18.2");
		});
	});

	// ---- Mixed content ----

	describe("mixed content", () => {
		it("segments a realistic assistant summary", () => {
			const text = [
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

			const segments = segmentContent(text);
			assertRoundtrip(text);

			const k = kinds(segments);

			// Verify all expected kinds appear
			assert.ok(k.includes("heading"), "should have headings");
			assert.ok(k.includes("code-fence"), "should have code fences");
			assert.ok(k.includes("shell-command"), "should have shell commands");
			assert.ok(k.includes("url"), "should have URLs");
			assert.ok(k.includes("bullet"), "should have bullets");
			assert.ok(k.includes("inline-code"), "should have inline code");
			assert.ok(k.includes("file-path"), "should have file paths");
			assert.ok(k.includes("log-output"), "should have log output");
			assert.ok(k.includes("package-ref"), "should have package refs");

			// Prose should still be present
			const prose = proseText(segments);
			assert.ok(prose.includes("The issue was"), "prose should contain section text");
			assert.ok(
				prose.includes("HTTP client configuration"),
				"prose should contain explanatory text",
			);
		});

		it("handles content with no protected segments", () => {
			const text = "Just a normal paragraph with no special content at all.";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			assert.strictEqual(segments.length, 1);
			assert.strictEqual(segments[0].type, "prose");
		});

		it("handles content that is mostly protected with interstitial whitespace", () => {
			const text = "# Heading\n\n- bullet\n- bullet 2\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			// All non-whitespace-only segments should be protected
			for (const seg of segments) {
				if (seg.type === "prose") {
					assert.match(seg.content, /^\s*$/, "prose between protected lines is only whitespace");
				}
			}
		});

		it("preserves original line breaks", () => {
			const text = "Line 1\n\nLine 3\n\n\nLine 6";
			const segments = segmentContent(text);
			assertRoundtrip(text);
		});

		it("handles bullets containing inline code and URLs (bullet is whole-line protected)", () => {
			const text =
				"- Install `node@18` from https://nodejs.org\n" +
				"- Run `$ npm init`\n";
			const segments = segmentContent(text);
			assertRoundtrip(text);

			const p = protecteds(segments);
			// Bullets are line-level protected, so inline code/URLs inside them
			// are implicitly protected (the whole line passes through unchanged).
			assert.strictEqual(p.length, 2);
			assert.ok(p.every((s) => s.kind === "bullet"));
		});
	});

	// ---- Type guards ----

	describe("type guards", () => {
		it("isProtected correctly identifies protected segments", () => {
			const seg: Segment = { type: "protected", kind: "url", content: "https://x.com" };
			assert.ok(isProtected(seg));
			assert.ok(!isProse(seg));
		});

		it("isProse correctly identifies prose segments", () => {
			const seg: Segment = { type: "prose", content: "hello" };
			assert.ok(isProse(seg));
			assert.ok(!isProtected(seg));
		});
	});
});
