/**
 * Read-only toolset for the buddy's nested loop.
 *
 * The buddy may read, grep, find, and ls — never write, edit, or bash.
 * Built from pi's own tool factories so behavior (truncation, @-prefix
 * normalization, rendering-friendly details) matches the main agent's tools.
 */

import {
	type TextContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@earendil-works/pi-coding-agent";

export const BUDDY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export type BuddyToolName = (typeof BUDDY_TOOL_NAMES)[number];

type BuddyToolResult = Pick<ToolResultMessage, "content" | "details">;

export type BuddyTool = Tool & {
	prepareArguments?: (args: unknown) => Record<string, unknown>;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<BuddyToolResult>;
};

export function createBuddyTools(cwd: string): BuddyTool[] {
	return [
		createReadTool(cwd) as unknown as BuddyTool,
		createGrepTool(cwd) as unknown as BuddyTool,
		createFindTool(cwd) as unknown as BuddyTool,
		createLsTool(cwd) as unknown as BuddyTool,
	];
}

/** One line describing a tool call, for activity logs and progress updates. */
export function describeToolCall(toolCall: ToolCall): string {
	const args = toolCall.arguments ?? {};
	const target =
		typeof args.path === "string"
			? args.path
			: typeof args.pattern === "string"
				? args.pattern
				: typeof args.url === "string"
					? args.url
					: typeof args.repo === "string"
						? args.repo
						: "";
	return target ? `${toolCall.name} ${target}` : toolCall.name;
}

export async function executeBuddyToolCall(
	tools: readonly BuddyTool[],
	toolCall: ToolCall,
	signal?: AbortSignal,
): Promise<ToolResultMessage> {
	if (signal?.aborted) {
		throw new Error("Buddy tool execution aborted");
	}
	const tool = tools.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		return buildToolError(
			toolCall,
			`Tool "${toolCall.name}" is not available. You have read-only access: ${tools.map((t) => t.name).join(", ")}.`,
		);
	}
	try {
		const preparedArguments = tool.prepareArguments
			? tool.prepareArguments(toolCall.arguments)
			: toolCall.arguments;
		const args = validateToolArguments(tool, {
			...toolCall,
			arguments: preparedArguments,
		});
		const result = await tool.execute(toolCall.id, args, signal);
		if (signal?.aborted) {
			throw new Error("Buddy tool execution aborted");
		}
		return {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError: false,
			timestamp: Date.now(),
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		return buildToolError(toolCall, errorToString(error));
	}
}

function buildToolError(
	toolCall: ToolCall,
	errorMessage: string,
): ToolResultMessage {
	const content: TextContent[] = [{ type: "text", text: errorMessage }];
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content,
		isError: true,
		timestamp: Date.now(),
	};
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
