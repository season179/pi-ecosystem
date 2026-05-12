/**
 * Readbeam Extension
 *
 * Automatically intercepts finalized assistant messages after an agent turn
 * (via the `message_end` lifecycle hook) and replaces the assistant message
 * with a visibly marked placeholder version.
 *
 * This is a proof-of-concept to validate the message replacement extension path
 * before NLP work starts. It demonstrates:
 * - Automatic behavior (no slash command needed)
 * - Message replacement (not duplication)
 * - Preserving assistant role
 * - Safe anti-recursion guard
 *
 * Usage:
 *   pi -e ./dist/extensions/readbeam.js
 *
 * Or install as a pi package (see README).
 */

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

		const originalText = extractText(message.content as string | ContentPart[] | undefined);
		if (!originalText || originalText.startsWith(READBEAM_MARKER)) return;

		return {
			message: {
				...message,
				content: buildPlaceholder(originalText),
			},
		};
	});
}
