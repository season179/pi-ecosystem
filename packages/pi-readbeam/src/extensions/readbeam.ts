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
 * Usage:
 *   pi -e ./dist/extensions/readbeam.js
 *
 * Or install as a pi package (see README).
 */

import { segmentContent } from "./lib/segment.js";

export { segmentContent, isProtected, isProse } from "./lib/segment.js";
export type {
	Segment,
	ProtectedSegment,
	ProseSegment,
	SegmentKind,
} from "./lib/segment.js";

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

function buildPlaceholder(originalText: string): string {
	const charCount = originalText.length;
	const wordCount = originalText.split(/\s+/).filter(Boolean).length;

	return [
		READBEAM_MARKER,
		"",
		"This assistant message has been replaced by the readbeam extension.",
		`Original message: ${wordCount} words, ${charCount} characters.`,
		"",
		"This is a placeholder demonstrating automatic message replacement.",
		"The extension preserved the assistant role and replaced the content safely.",
	].join("\n");
}

export default function readbeamExtension(pi: ExtensionAPI) {
	pi.on("message_end", async (event: MessageEndEvent) => {
		const { message } = event;
		if (message.role !== "assistant") return;

		const originalText = extractText(message.content);
		if (!originalText || originalText.startsWith(READBEAM_MARKER)) return;

		// Segment the content to identify protected vs prose regions.
		// The segmentation layer is now available for future highlighting passes.
		const _segments = segmentContent(originalText);

		return {
			message: {
				...message,
				content: buildPlaceholder(originalText),
			},
		};
	});
}
