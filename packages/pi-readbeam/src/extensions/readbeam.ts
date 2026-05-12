/**
 * Readbeam Extension
 *
 * Automatically intercepts finalized assistant messages after an agent turn
 * (via the `message_end` lifecycle hook) and segments the content into
 * prose (eligible for highlighting) and protected technical evidence
 * (code, paths, URLs, diffs, stack traces, etc.) that passes through unchanged.
 *
 * Protected segment layer (issue #2):
 * The segmenter splits Markdown into alternating prose and protected chunks.
 * Protected kinds: code-fence, inline-code, url, file-path, shell-command,
 * diff, stack-trace, log-output, heading, bullet, link, package-ref.
 *
 * Linguistic span layer (issue #3):
 * The analyzer extracts action verbs and meaningful noun phrases from prose
 * segments, optimized for calm summary scanning. Uses compromise under the
 * hood behind a `LinguisticAnalyzer` adapter interface.
 *
 * Renderer layer (issue #4):
 * The renderer takes prose segments and their spans, then applies terminal-safe
 * ANSI formatting: bold for action verbs, underline for noun phrases. Protected
 * segments pass through unchanged. Includes an idempotency guard to prevent
 * double-formatting.
 *
 * Usage:
 *   pi -e ./dist/extensions/readbeam.js
 *
 * Or install as a pi package (see README).
 */

export { segmentContent, isProtected, isProse } from "./lib/segment.js";
export type {
	Segment,
	ProtectedSegment,
	ProseSegment,
	SegmentKind,
} from "./lib/segment.js";

export { createAnalyzer, CompromiseAnalyzer } from "./lib/analyzer.js";
export type {
	LinguisticSpan,
	LinguisticAnalyzer,
	SpanKind,
} from "./lib/analyzer.js";

import { renderContent } from "./lib/renderer.js";
import type { RenderOptions } from "./lib/renderer.js";

export { renderContent };
export type { RenderOptions };

interface ContentPart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface MessageEndEvent {
	message: {
		role: string;
		content?: string | ContentPart[];
		[key: string]: unknown;
	};
}

interface ExtensionAPI {
	on: (event: string, handler: (...args: any[]) => unknown) => void;
}

const READBEAM_MARKER = "[readbeam]";

function extractText(content: string | ContentPart[] | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;

	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

export default function readbeamExtension(pi: ExtensionAPI) {
	pi.on("message_end", async (event: MessageEndEvent) => {
		const { message } = event;
		if (message.role !== "assistant") return;

		const originalText = extractText(message.content);
		if (!originalText || originalText.startsWith(READBEAM_MARKER)) return;

		const rendered = renderContent(originalText);

		return {
			message: {
				...message,
				content: READBEAM_MARKER + "\n" + rendered,
			},
		};
	});
}
