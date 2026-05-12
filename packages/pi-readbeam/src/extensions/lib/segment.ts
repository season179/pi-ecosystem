/**
 * Content segmentation for pi-readbeam.
 *
 * Splits Markdown assistant summaries into prose segments (eligible for
 * linguistic highlighting) and protected segments (technical evidence
 * that must pass through unchanged).
 *
 * Protected segment kinds:
 * - code-fence   — fenced code blocks (``` … ```)
 * - inline-code  — backtick-wrapped inline code
 * - url          — HTTP/HTTPS URLs
 * - file-path    — absolute, relative, and home-dir file paths
 * - shell-command — shell command lines (starting with $)
 * - diff         — unified-diff hunks and file headers
 * - stack-trace  — error/exception traces and stack frames
 * - log-output   — log lines with timestamps or log levels
 * - heading      — Markdown headings
 * - bullet       — bulleted and numbered list items
 * - link         — Markdown links [text](url)
 * - package-ref  — npm-style package references with versions
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SegmentKind =
	| "code-fence"
	| "inline-code"
	| "url"
	| "file-path"
	| "shell-command"
	| "diff"
	| "stack-trace"
	| "log-output"
	| "heading"
	| "bullet"
	| "link"
	| "package-ref";

export interface ProtectedSegment {
	type: "protected";
	kind: SegmentKind;
	content: string;
}

export interface ProseSegment {
	type: "prose";
	content: string;
}

export type Segment = ProtectedSegment | ProseSegment;

export function isProtected(segment: Segment): segment is ProtectedSegment {
	return segment.type === "protected";
}

export function isProse(segment: Segment): segment is ProseSegment {
	return segment.type === "prose";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split `text` into alternating prose and protected segments.
 * Concatenating all `.content` values reproduces the original text exactly.
 */
export function segmentContent(text: string): Segment[] {
	if (!text) return [];

	// Pass 1: extract fenced code blocks (multi-line, highest precedence).
	const segments: Segment[] = [];
	const codeFenceRegex = /^```[^\n]*\n[\s\S]*?^```[^\n]*/gm;
	let lastEnd = 0;
	let match: RegExpExecArray | null;

	while ((match = codeFenceRegex.exec(text)) !== null) {
		if (match.index > lastEnd) {
			segments.push(...segmentNonCode(text.slice(lastEnd, match.index)));
		}
		segments.push({
			type: "protected",
			kind: "code-fence",
			content: match[0],
		});
		lastEnd = match.index + match[0].length;
	}

	if (lastEnd < text.length) {
		segments.push(...segmentNonCode(text.slice(lastEnd)));
	}

	return mergeAdjacentProse(segments);
}

// ---------------------------------------------------------------------------
// Non-code-fence processing (line-level + inline)
// ---------------------------------------------------------------------------

/** Process text that lives outside fenced code blocks. */
function segmentNonCode(text: string): Segment[] {
	const segments: Segment[] = [];
	const lines = text.split("\n");
	let i = 0;
	let proseBuffer = "";

	function flushProse() {
		if (proseBuffer) {
			segments.push(...segmentInline(proseBuffer));
			proseBuffer = "";
		}
	}

	while (i < lines.length) {
		const line = lines[i];
		const isLastLine = i === lines.length - 1;
		const suffix = isLastLine ? "" : "\n";

		// Multi-line blocks (diff, stack trace, log).
		const block = tryConsumeBlock(lines, i);
		if (block) {
			flushProse();
			segments.push(block.segment);
			i = block.nextLine;
			continue;
		}

		// Single-line protected patterns.
		const kind = classifyLine(line);
		if (kind) {
			flushProse();
			segments.push({ type: "protected", kind, content: line + suffix });
			i++;
			continue;
		}

		// Prose — accumulate.
		proseBuffer += line + suffix;
		i++;
	}

	flushProse();
	return segments;
}

// ---------------------------------------------------------------------------
// Multi-line block detection
// ---------------------------------------------------------------------------

function tryConsumeBlock(
	lines: string[],
	start: number,
): { segment: ProtectedSegment; nextLine: number } | null {
	return (
		tryConsumeDiffBlock(lines, start) ??
		tryConsumeStackTrace(lines, start) ??
		tryConsumeLogBlock(lines, start)
	);
}

function tryConsumeDiffBlock(
	lines: string[],
	start: number,
): { segment: ProtectedSegment; nextLine: number } | null {
	const line = lines[start];
	if (!/^(@@|\+\+\+|---)\s/.test(line)) return null;

	let end = start + 1;
	while (end < lines.length) {
		const l = lines[end];
		if (
			/^(@@|\+\+\+|---)\s/.test(l) ||
			/^[+-][^\s]/.test(l) ||
			/^ /.test(l)
		) {
			end++;
		} else {
			break;
		}
	}

	return {
		segment: {
			type: "protected",
			kind: "diff",
			content: joinLines(lines, start, end),
		},
		nextLine: end,
	};
}

function tryConsumeStackTrace(
	lines: string[],
	start: number,
): { segment: ProtectedSegment; nextLine: number } | null {
	const line = lines[start];
	if (
		!/^[A-Za-z]*Error:/.test(line) &&
		!/^(Exception|Unhandled|Uncaught|FATAL|panic|Traceback)\b/.test(
			line,
		)
	) {
		return null;
	}

	let end = start + 1;
	while (end < lines.length) {
		const l = lines[end];
		if (
			/^\s*at\s+/.test(l) ||
			/^\s*File\s+/.test(l) ||
			/^\s+\^/.test(l) ||
			/^\s+~+\^*/.test(l) ||
			/^\s*\[.*\]$/.test(l) ||
			/^Caused by:/.test(l) ||
			/^\s*\.\.\.\s*\d+\s+more/.test(l)
		) {
			end++;
		} else {
			break;
		}
	}

	// Trim trailing blank lines from the block.
	while (end > start + 1 && /^\s*$/.test(lines[end - 1])) {
		end--;
	}

	return {
		segment: {
			type: "protected",
			kind: "stack-trace",
			content: joinLines(lines, start, end),
		},
		nextLine: end,
	};
}

function tryConsumeLogBlock(
	lines: string[],
	start: number,
): { segment: ProtectedSegment; nextLine: number } | null {
	if (!isLogLine(lines[start])) return null;

	let end = start + 1;
	while (end < lines.length && isLogLine(lines[end])) {
		end++;
	}

	return {
		segment: {
			type: "protected",
			kind: "log-output",
			content: joinLines(lines, start, end),
		},
		nextLine: end,
	};
}

function isLogLine(line: string): boolean {
	return (
		/^\[?\d{4}[-/]\d{2}[-/]\d{2}[T\s]/.test(line) ||
		/^\[(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL)\]/i.test(line)
	);
}

// ---------------------------------------------------------------------------
// Single-line classification
// ---------------------------------------------------------------------------

function classifyLine(line: string): SegmentKind | null {
	if (/^#{1,6}\s/.test(line)) return "heading";
	if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) return "bullet";
	if (/^\s*\$\s/.test(line)) return "shell-command";
	return null;
}

// ---------------------------------------------------------------------------
// Inline pattern extraction
// ---------------------------------------------------------------------------

function segmentInline(text: string): Segment[] {
	const segments: Segment[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		const match = findNextInline(remaining);

		if (!match) {
			segments.push({ type: "prose", content: remaining });
			break;
		}

		if (match.start > 0) {
			segments.push({
				type: "prose",
				content: remaining.slice(0, match.start),
			});
		}

		segments.push(match.segment);
		remaining = remaining.slice(
			match.start + match.segment.content.length,
		);
	}

	return segments;
}

interface InlineMatch {
	start: number;
	segment: ProtectedSegment;
}

interface InlinePattern {
	regex: RegExp;
	kind: SegmentKind;
}

const URL_TRAILING_PUNCT = /[.,;:!?'")\]]+$/;

const INLINE_PATTERNS: InlinePattern[] = [
	// 1. Inline code (highest precedence)
	{ regex: /`[^`\n]+`/, kind: "inline-code" },
	// 2. Markdown links
	{ regex: /\[([^\]]+)\]\(([^)]+)\)/, kind: "link" },
	// 3. URLs
	{ regex: /https?:\/\/[^\s)]+/, kind: "url" },
	// 4. Scoped package refs  (@scope/name@version)
	{
		regex: /@[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+@\d+\.[\d.a-zA-Z+-]+/,
		kind: "package-ref",
	},
	// 5. Unscoped package refs  (name@version)
	{
		regex: /(?<![/\w@-])[a-zA-Z0-9._-]+@\d+\.[\d.a-zA-Z+-]+/,
		kind: "package-ref",
	},
	// 6. File paths
	{
		regex: /(?<=^|[\s(`])(~?(?:\.\.?\/|\/)[\w./@-]+)/m,
		kind: "file-path",
	},
];

function findNextInline(text: string): InlineMatch | null {
	let earliest: InlineMatch | null = null;

	for (const { regex, kind } of INLINE_PATTERNS) {
		const m = regex.exec(text);
		if (!m) continue;

		let content = m[0];
		if (kind === "url") {
			content = content.replace(URL_TRAILING_PUNCT, "");
		}

		if (earliest === null || m.index < earliest.start) {
			earliest = { start: m.index, segment: { type: "protected", kind, content } };
		}
	}

	return earliest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinLines(lines: string[], start: number, end: number): string {
	const joined = lines.slice(start, end).join("\n");
	return end >= lines.length ? joined : joined + "\n";
}

function mergeAdjacentProse(segments: Segment[]): Segment[] {
	const merged: Segment[] = [];
	for (const seg of segments) {
		const last = merged[merged.length - 1];
		if (last && last.type === "prose" && seg.type === "prose") {
			last.content += seg.content;
		} else {
			merged.push(seg);
		}
	}
	return merged;
}
