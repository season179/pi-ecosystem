import { createHash } from "node:crypto";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { stripOwnedContent } from "./runtime.js";

// ---------------------------------------------------------------------------
// Bounded, role-labeled conversation excerpt for automatic memory decisions.
//
// Only user text and assistant text are kept. Thinking, tool arguments, tool
// results, summaries, custom and bash messages are omitted: they are either
// private reasoning, potentially huge raw output, or derived text. Our own
// transient memory blocks are stripped structurally first, so injected memory
// never feeds back into a retain decision or a recall query.
// ---------------------------------------------------------------------------

type AgentContextMessage = ContextEvent["messages"][number];

export const TRANSCRIPT_MAX_MESSAGES = 12;
export const TRANSCRIPT_MESSAGE_MAX_CHARS = 1_500;
export const TRANSCRIPT_TOTAL_MAX_CHARS = 8_000;

export interface TranscriptEntry {
	/** Stable identity (role + timestamp + content hash); survives re-fed/cloned contexts. */
	key: string;
	role: "user" | "assistant";
	text: string;
}

const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
	/\b((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)["']?[^\s"']{6,}/gi,
];

/** Best-effort redaction of common credential shapes; not a guarantee. */
export function redactSecrets(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, (_match, prefix?: string) =>
			typeof prefix === "string" && prefix.length > 0 && prefix.length < 40 ? `${prefix}[REDACTED]` : "[REDACTED]",
		);
	}
	return result;
}

function bound(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; text?: unknown; name?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		else if (typed.type === "image") parts.push("[image]");
		else if (typed.type === "toolCall" && typeof typed.name === "string") parts.push(`[called tool ${typed.name}]`);
		// thinking and any other block types are intentionally omitted
	}
	return parts.join("\n");
}

function entryKey(role: string, timestamp: unknown, text: string): string {
	const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
	return `${role}:${typeof timestamp === "number" ? timestamp : "?"}:${digest}`;
}

/**
 * Build the bounded excerpt: newest messages first until the message or
 * character cap is reached, returned oldest→newest. Each entry is redacted
 * and truncated individually.
 */
export function buildTranscript(messages: readonly AgentContextMessage[]): TranscriptEntry[] {
	const { messages: kept } = stripOwnedContent(messages);
	const entries: TranscriptEntry[] = [];
	let total = 0;
	for (let index = kept.length - 1; index >= 0 && entries.length < TRANSCRIPT_MAX_MESSAGES; index -= 1) {
		const message = kept[index] as { role?: unknown; content?: unknown; timestamp?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const raw = textOf(message.content).trim();
		// Tool-call-only turns carry no judgeable text; skip them entirely.
		if (raw === "" || /^(?:\[called tool [^\]]*\]\s*)+$/u.test(raw)) continue;
		const text = bound(redactSecrets(raw), TRANSCRIPT_MESSAGE_MAX_CHARS);
		if (total + text.length > TRANSCRIPT_TOTAL_MAX_CHARS && entries.length > 0) break;
		total += text.length;
		entries.push({ key: entryKey(message.role, message.timestamp, raw), role: message.role, text });
	}
	return entries.reverse();
}

/** Deterministic recall query: the latest user request, plus current assistant work for periodic checks. */
export function buildRecallQuery(entries: readonly TranscriptEntry[], includeAssistant: boolean): string | undefined {
	const latestUser = [...entries].reverse().find((entry) => entry.role === "user");
	if (latestUser === undefined) return undefined;
	const parts = [bound(latestUser.text, 1_000)];
	if (includeAssistant) {
		const latestAssistant = [...entries].reverse().find((entry) => entry.role === "assistant");
		if (latestAssistant !== undefined && entries.indexOf(latestAssistant) > entries.indexOf(latestUser)) {
			parts.push(bound(latestAssistant.text, 500));
		}
	}
	return parts.join("\n");
}

/** Render entries as role-labeled plain text for retention. */
export function renderTranscript(entries: readonly TranscriptEntry[]): string {
	return entries.map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`).join("\n\n");
}
