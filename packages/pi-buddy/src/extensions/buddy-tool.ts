import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";

type BuddyToolResult = Pick<ToolResultMessage, "content" | "details">;

/**
 * The read-only tool Interface shared by repository, web, and verdict Adapters.
 *
 * This lives at the common seam rather than inside any concrete tool
 * implementation so no Adapter depends on another Adapter for its contract.
 */
export type BuddyTool = Tool & {
	prepareArguments?: (args: unknown) => Record<string, unknown>;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<BuddyToolResult>;
};
