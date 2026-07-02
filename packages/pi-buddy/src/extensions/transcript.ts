/**
 * Serializes a session branch into a plain-text transcript for the buddy,
 * with a context-budget guard that trims the middle (oldest tool outputs
 * first) when the transcript would not fit the buddy model's window.
 *
 * Pure functions — no pi runtime dependencies — so they are unit-testable.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface TranscriptBlock {
	/** Rendered text for this block, including its role header. */
	text: string;
	/** Blocks eligible for trimming first (bulky, re-fetchable by the buddy). */
	isToolOutput: boolean;
}

export interface TranscriptBudget {
	/** Maximum tokens the rendered transcript may occupy. */
	maxTokens: number;
	/** Never trim the first N blocks (conversation head incl. compaction summary). */
	keepHeadBlocks: number;
	/** Never trim the last N blocks (most recent turns). */
	keepTailBlocks: number;
}

export const TRIM_MARKER =
	"[... transcript trimmed to fit the context budget: some older tool outputs " +
	"and messages were omitted. Use your read-only tools to re-fetch anything " +
	"you need to verify. ...]";

/** chars/4 heuristic; good enough for a budget guard. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function contentToText(
	content: string | ReadonlyArray<{ type: string; [key: string]: unknown }>,
): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push("[image attachment]");
		}
	}
	return parts.join("\n");
}

export function entryToBlock(entry: SessionEntry): TranscriptBlock | undefined {
	switch (entry.type) {
		case "message": {
			const message = entry.message as {
				role: string;
				content?: unknown;
				customType?: string;
				toolName?: string;
				isError?: boolean;
			};
			switch (message.role) {
				case "user":
					return {
						text: `## USER\n${contentToText(message.content as never)}`,
						isToolOutput: false,
					};
				case "assistant": {
					const content = message.content as ReadonlyArray<{
						type: string;
						text?: string;
						name?: string;
						arguments?: Record<string, unknown>;
					}>;
					const parts: string[] = [];
					for (const block of content) {
						if (block.type === "text" && block.text) {
							parts.push(block.text);
						} else if (block.type === "toolCall") {
							parts.push(
								`[tool call: ${block.name}(${JSON.stringify(block.arguments ?? {})})]`,
							);
						}
						// Thinking blocks are deliberately omitted: they are private
						// scratch work, often huge, and other models' reasoning would
						// anchor the buddy instead of informing it.
					}
					if (parts.length === 0) return undefined;
					return { text: `## AGENT\n${parts.join("\n")}`, isToolOutput: false };
				}
				case "toolResult": {
					const status = message.isError ? " (ERROR)" : "";
					return {
						text: `## TOOL RESULT: ${message.toolName}${status}\n${contentToText(
							message.content as never,
						)}`,
						isToolOutput: true,
					};
				}
				default: {
					// Custom messages injected by extensions (incl. buddy interjections).
					const label = message.customType
						? `## NOTE (${message.customType})`
						: "## NOTE";
					return {
						text: `${label}\n${contentToText((message.content ?? "") as never)}`,
						isToolOutput: false,
					};
				}
			}
		}
		case "compaction":
			return {
				text: `## EARLIER CONVERSATION (compacted summary)\n${entry.summary}`,
				isToolOutput: false,
			};
		case "branch_summary":
			return {
				text: `## ABANDONED BRANCH (summary)\n${entry.summary}`,
				isToolOutput: false,
			};
		case "custom_message":
			return {
				text: `## NOTE (${entry.customType})\n${contentToText(entry.content as never)}`,
				isToolOutput: false,
			};
		default:
			// model_change, thinking_level_change, custom, label, session_info:
			// no conversational value for the buddy.
			return undefined;
	}
}

export function branchToBlocks(
	entries: readonly SessionEntry[],
): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	for (const entry of entries) {
		const block = entryToBlock(entry);
		if (block) blocks.push(block);
	}
	return blocks;
}

/**
 * Renders blocks to a transcript, trimming middle blocks when over budget.
 * Trims oldest tool outputs first, then oldest non-tool middle blocks.
 * Head and tail blocks are never trimmed. A TRIM_MARKER is inserted at the
 * first trim position so the buddy knows content was omitted.
 */
export function renderTranscript(
	blocks: readonly TranscriptBlock[],
	budget: TranscriptBudget,
): string {
	const render = (kept: readonly (TranscriptBlock | undefined)[]): string => {
		const parts: string[] = [];
		let trimMarkerEmitted = false;
		for (const block of kept) {
			if (block === undefined) {
				if (!trimMarkerEmitted) {
					parts.push(TRIM_MARKER);
					trimMarkerEmitted = true;
				}
				continue;
			}
			parts.push(block.text);
		}
		return parts.join("\n\n");
	};

	const full = render(blocks);
	if (estimateTokens(full) <= budget.maxTokens) return full;

	const kept: (TranscriptBlock | undefined)[] = blocks.slice();
	const headEnd = Math.min(budget.keepHeadBlocks, blocks.length);
	const tailStart = Math.max(headEnd, blocks.length - budget.keepTailBlocks);

	const middleIndexes: number[] = [];
	for (let i = headEnd; i < tailStart; i++) middleIndexes.push(i);

	// Pass 1: oldest tool outputs. Pass 2: oldest remaining middle blocks.
	const trimOrder = [
		...middleIndexes.filter((i) => blocks[i].isToolOutput),
		...middleIndexes.filter((i) => !blocks[i].isToolOutput),
	];

	for (const index of trimOrder) {
		kept[index] = undefined;
		if (estimateTokens(render(kept)) <= budget.maxTokens) break;
	}

	return render(kept);
}
