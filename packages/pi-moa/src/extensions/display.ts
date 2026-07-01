import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { MoAReferenceDisplayDetails } from "./types.js";

const COLLAPSED_PREVIEW_CHARS = 240;

/**
 * TUI renderer for the display-only reference-outputs custom message.
 *
 * Registered via `pi.registerMessageRenderer(MOA_REFERENCE_CUSTOM_TYPE, ...)`.
 * Renders the structured `details` payload as a distinct, collapsible block —
 * this is what replaces prepending a marker-delimited markdown blob onto the
 * aggregator's answer. Falls back to the plain-text `content` when `details`
 * is absent (e.g. an older session entry).
 */
export const renderReferenceOutputs: MessageRenderer<MoAReferenceDisplayDetails> = (message, { expanded }, theme) => {
	const details = message.details;
	if (!details) {
		const fallback = typeof message.content === "string" ? message.content : "";
		return new Text(theme.fg("customMessageText", fallback), 1, 0);
	}

	const count = details.outputs.length;
	const lines: string[] = [
		theme.fg(
			"customMessageLabel",
			`MoA references · ${count} model${count === 1 ? "" : "s"} · aggregator ${details.aggregator}`,
		),
	];

	details.outputs.forEach((output, index) => {
		const name = `${output.provider}/${output.model}`;
		if (output.success) {
			lines.push(theme.fg("success", `\n▍ Reference ${index + 1} — ${name}`));
			lines.push(theme.fg("customMessageText", expanded ? output.text : previewText(output.text)));
		} else {
			lines.push(theme.fg("error", `\n▍ Reference ${index + 1} — ${name} (failed)`));
			lines.push(theme.fg("dim", output.errorMessage ?? "Unknown reference failure"));
		}
	});

	if (!expanded && details.outputs.some((output) => output.success && output.text.length > COLLAPSED_PREVIEW_CHARS)) {
		lines.push(theme.fg("dim", "\n(expand for full reference text)"));
	}

	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
};

function previewText(text: string, maxChars = COLLAPSED_PREVIEW_CHARS): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}
