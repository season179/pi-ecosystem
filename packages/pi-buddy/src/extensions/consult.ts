/**
 * Consultation orchestration: builds the buddy's context (system prompt +
 * transcript + request), runs a nested agentic loop against the buddy model
 * via streamSimple, executes the buddy's read-only tool calls, and returns
 * the buddy's final answer plus an activity log.
 */

import {
	type Api,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type BuddyTool,
	createBuddyTools,
	describeToolCall,
	executeBuddyToolCall,
} from "./buddy-tools.js";
import {
	branchToBlocks,
	estimateTokens,
	renderTranscript,
	type TranscriptBudget,
} from "./transcript.js";

/** Cap on tool-loop rounds before the buddy is forced to answer. */
const MAX_TOOL_ROUNDS = 10;

/** Blocks always kept at the head/tail of the transcript when trimming. */
const KEEP_HEAD_BLOCKS = 6;
const KEEP_TAIL_BLOCKS = 30;

/**
 * Fraction of the buddy model's context window budgeted for the transcript.
 * The remainder is headroom for the system prompt, the buddy's own tool-loop
 * results, and its (reasoning + answer) output.
 */
const TRANSCRIPT_WINDOW_FRACTION = 0.6;

export interface ConsultRequest {
	/** The consultation request rendered after the transcript. */
	requestText: string;
	/** System prompt (stance or watchdog persona). */
	systemPrompt: string;
	entries: readonly SessionEntry[];
	cwd: string;
	model: Model<Api>;
	registry: ModelRegistry;
	signal?: AbortSignal;
	onActivity?: (line: string) => void;
}

export interface ConsultResult {
	answer: string;
	/** One line per buddy tool call, e.g. "read src/foo.ts". */
	activity: string[];
	rounds: number;
	transcriptTokens: number;
}

export async function consultBuddy(
	request: ConsultRequest,
): Promise<ConsultResult> {
	const auth = await request.registry.getApiKeyAndHeaders(request.model);
	if (!auth.ok) {
		throw new Error(
			`Buddy authentication failed for ${request.model.provider}/${request.model.id}: ${auth.error}`,
		);
	}

	const budget: TranscriptBudget = {
		maxTokens: Math.floor(
			request.model.contextWindow * TRANSCRIPT_WINDOW_FRACTION,
		),
		keepHeadBlocks: KEEP_HEAD_BLOCKS,
		keepTailBlocks: KEEP_TAIL_BLOCKS,
	};
	const transcript = renderTranscript(
		branchToBlocks(request.entries),
		budget,
	);

	const initialUserMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text:
					`# Session transcript\n\n${transcript}\n\n` +
					`# Consultation request\n\n${request.requestText}`,
			},
		],
		timestamp: Date.now(),
	};

	const tools = createBuddyTools(request.cwd);
	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal: request.signal,
	};

	const activity: string[] = [];
	let messages: Message[] = [initialUserMessage];
	let rounds = 0;

	for (;;) {
		rounds += 1;
		const finalRound = rounds > MAX_TOOL_ROUNDS;
		const context: Context = {
			systemPrompt: finalRound
				? `${request.systemPrompt}\n\nYour tool budget is exhausted. Give your final answer now from what you already know.`
				: request.systemPrompt,
			messages,
		};
		if (!finalRound) {
			context.tools = tools;
		}

		const message = await streamToMessage(request.model, context, options);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(
				message.errorMessage ?? `Buddy stopped with ${message.stopReason}`,
			);
		}
		messages = [...messages, message];

		const toolCalls = extractToolCalls(message);
		if (!finalRound && message.stopReason === "toolUse" && toolCalls.length > 0) {
			const results = await executeToolCalls(
				tools,
				toolCalls,
				request.signal,
				(line) => {
					activity.push(line);
					request.onActivity?.(line);
				},
			);
			messages = [...messages, ...results];
			continue;
		}

		const answer = extractText(message);
		if (answer.length === 0) {
			throw new Error("Buddy produced no answer text");
		}
		return {
			answer,
			activity,
			rounds,
			transcriptTokens: estimateTokens(transcript),
		};
	}
}

async function streamToMessage(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const stream = streamSimple(model, context, options);
	let latestPartial: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done") return event.message;
		if (event.type === "error") {
			throw new Error(
				event.error.errorMessage ??
					`Buddy stream stopped with ${event.error.stopReason}`,
			);
		}
		if (event.type !== "start") {
			latestPartial = event.partial;
		}
	}
	if (latestPartial) return latestPartial;
	throw new Error("Buddy produced no output before the stream ended");
}

async function executeToolCalls(
	tools: readonly BuddyTool[],
	toolCalls: readonly ToolCall[],
	signal: AbortSignal | undefined,
	onActivity: (line: string) => void,
): Promise<Message[]> {
	const results: Message[] = [];
	for (const toolCall of toolCalls) {
		onActivity(describeToolCall(toolCall));
		results.push(await executeBuddyToolCall(tools, toolCall, signal));
	}
	return results;
}

function extractToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter(
		(block): block is ToolCall => block.type === "toolCall",
	);
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}
