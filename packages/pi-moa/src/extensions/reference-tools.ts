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
import type { ReferenceToolName } from "./types.js";

type ReferenceToolResult = Pick<ToolResultMessage, "content" | "details"> & {
	terminate?: boolean;
};

export type ReferenceTool = Tool & {
	prepareArguments?: (args: unknown) => Record<string, unknown>;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partialResult: ReferenceToolResult) => void,
	) => Promise<ReferenceToolResult>;
};

export interface ExecutedReferenceToolCall {
	message: ToolResultMessage;
	telemetry?: {
		name: ReferenceToolName;
		isError: boolean;
	};
}

type ReferenceToolFactory = (
	names: readonly ReferenceToolName[],
	cwd: string,
) => ReferenceTool[];

let testToolFactory: ReferenceToolFactory | undefined;

export function __setReferenceToolFactoryForTests(
	factory: ReferenceToolFactory | undefined,
): void {
	testToolFactory = factory;
}

export function createReferenceTools(
	names: readonly ReferenceToolName[],
	cwd: string,
): ReferenceTool[] {
	if (testToolFactory) {
		return testToolFactory(names, cwd);
	}
	return names.map((name) => {
		switch (name) {
			case "read":
				return createReadTool(cwd) as unknown as ReferenceTool;
			case "grep":
				return createGrepTool(cwd) as unknown as ReferenceTool;
			case "find":
				return createFindTool(cwd) as unknown as ReferenceTool;
			case "ls":
				return createLsTool(cwd) as unknown as ReferenceTool;
		}
	});
}

export async function executeReferenceToolCall(
	tools: readonly ReferenceTool[],
	toolCall: ToolCall,
	signal?: AbortSignal,
): Promise<ExecutedReferenceToolCall> {
	if (signal?.aborted) {
		throw new Error("Reference tool execution aborted");
	}
	const tool = tools.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		return buildToolError(toolCall, `Tool "${toolCall.name}" is not available`);
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
			throw new Error("Reference tool execution aborted");
		}
		return {
			message: {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: result.content,
				details: result.details,
				isError: false,
				timestamp: Date.now(),
			},
			telemetry: referenceToolTelemetry(toolCall.name, false),
		};
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		return buildToolError(toolCall, errorToString(error));
	}
}

function buildToolError(
	toolCall: ToolCall,
	errorMessage: string,
): ExecutedReferenceToolCall {
	const content: TextContent[] = [{ type: "text", text: errorMessage }];
	return {
		message: {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content,
			isError: true,
			timestamp: Date.now(),
		},
		telemetry: referenceToolTelemetry(toolCall.name, true),
	};
}

function referenceToolTelemetry(
	name: string,
	isError: boolean,
): ExecutedReferenceToolCall["telemetry"] {
	return isReferenceToolName(name) ? { name, isError } : undefined;
}

function isReferenceToolName(name: string): name is ReferenceToolName {
	return name === "read" || name === "grep" || name === "find" || name === "ls";
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
