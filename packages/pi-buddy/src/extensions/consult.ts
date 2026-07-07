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
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
// streamSimple moved to the compat entrypoint in pi-ai 0.80.x; pi's runtime
// aliases both specifiers to compat, so this is purely a type-resolution fix.
import { streamSimple } from "@earendil-works/pi-ai/compat";
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

/** Smaller recent-context budget for automatic watchdog/run-end reviews. */
const AUTO_KEEP_HEAD_BLOCKS = 4;
const AUTO_KEEP_TAIL_BLOCKS = 16;
const AUTO_MAX_TRANSCRIPT_TOKENS = 48_000;

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
	/**
	 * Optional memory/digest block appended to the system prompt after the
	 * persona. Rides the SYSTEM prompt, so it is not subject to transcript
	 * trimming — callers keep it small (≤4KB by construction).
	 */
	memoryBlock?: string;
	entries: readonly SessionEntry[];
	cwd: string;
	model: Model<Api>;
	registry: ModelRegistry;
	signal?: AbortSignal;
	/** Additional read-only tools (e.g. web tools) beyond read/grep/find/ls. */
	extraTools?: readonly BuddyTool[];
	/** Optional source-specific transcript budget; foreground consults omit this. */
	transcriptBudget?: TranscriptBudget;
	onActivity?: (line: string) => void;
}

export interface BuddyUsageTelemetry {
	/** Provider-reported uncached input tokens, summed across model calls. */
	inputTokens: number;
	/** Provider-reported output tokens, summed across model calls. */
	outputTokens: number;
	/** Provider-reported cache-read input tokens, summed across model calls. */
	cacheReadTokens: number;
	/** Provider-reported cache-write input tokens, summed across model calls. */
	cacheWriteTokens: number;
	/** Provider-reported reasoning tokens, if the provider exposes them. */
	reasoningTokens?: number;
	/** Provider-reported total tokens, summed across model calls. */
	totalTokens: number;
	/** Provider-reported dollar cost, when pi-ai has pricing metadata. */
	costUsd: number;
	/** Provider-reported input tokens for the final model call only. */
	finalRoundInputTokens: number;
	/** Provider-reported total tokens for the final model call only. */
	finalRoundTotalTokens: number;
}

export interface UsageSnapshot {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens?: number;
	totalTokens: number;
	costUsd: number;
}

export function defaultTranscriptBudget(contextWindow: number): TranscriptBudget {
	return {
		maxTokens: Math.floor(contextWindow * TRANSCRIPT_WINDOW_FRACTION),
		keepHeadBlocks: KEEP_HEAD_BLOCKS,
		keepTailBlocks: KEEP_TAIL_BLOCKS,
	};
}

export function automaticTranscriptBudget(contextWindow: number): TranscriptBudget {
	const defaultBudget = defaultTranscriptBudget(contextWindow);
	return {
		maxTokens: Math.min(defaultBudget.maxTokens, AUTO_MAX_TRANSCRIPT_TOKENS),
		keepHeadBlocks: AUTO_KEEP_HEAD_BLOCKS,
		keepTailBlocks: AUTO_KEEP_TAIL_BLOCKS,
	};
}

export interface ConsultResult {
	answer: string;
	/** One line per buddy tool call, e.g. "read src/foo.ts". */
	activity: string[];
	rounds: number;
	transcriptTokens: number;
	/** Best-effort provider-reported usage. Missing/malformed usage is ignored. */
	usage?: BuddyUsageTelemetry;
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

	const budget =
		request.transcriptBudget ?? defaultTranscriptBudget(request.model.contextWindow);
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

	const tools = [
		...createBuddyTools(request.cwd),
		...(request.extraTools ?? []),
	];
	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal: request.signal,
	};

	const activity: string[] = [];
	let messages: Message[] = [initialUserMessage];
	let rounds = 0;
	let cumulativeUsage: UsageSnapshot | undefined;
	let finalRoundUsage: UsageSnapshot | undefined;

	const baseSystemPrompt = request.memoryBlock
		? `${request.systemPrompt}\n\n${request.memoryBlock}`
		: request.systemPrompt;

	for (;;) {
		rounds += 1;
		const finalRound = rounds > MAX_TOOL_ROUNDS;
		const context: Context = {
			systemPrompt: finalRound
				? `${baseSystemPrompt}\n\nYour tool budget is exhausted. Give your final answer now from what you already know.`
				: baseSystemPrompt,
			messages,
		};
		if (!finalRound) {
			context.tools = tools;
		}

		const message = await streamToMessage(request.model, context, options);
		const roundUsage = snapshotUsage(message.usage);
		if (roundUsage) {
			cumulativeUsage = addUsage(cumulativeUsage, roundUsage);
			finalRoundUsage = roundUsage;
		}
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
			usage: usageTelemetry(cumulativeUsage, finalRoundUsage),
		};
	}
}

export function snapshotUsage(usage: unknown): UsageSnapshot | undefined {
	if (typeof usage !== "object" || usage === null) return undefined;
	const record = usage as Partial<Usage>;
	const inputTokens = finiteNumber(record.input);
	const outputTokens = finiteNumber(record.output);
	const cacheReadTokens = finiteNumber(record.cacheRead);
	const cacheWriteTokens = finiteNumber(record.cacheWrite);
	const totalTokens = finiteNumber(record.totalTokens);
	const hasAnyTokenField =
		inputTokens !== undefined ||
		outputTokens !== undefined ||
		cacheReadTokens !== undefined ||
		cacheWriteTokens !== undefined ||
		totalTokens !== undefined;
	if (!hasAnyTokenField) return undefined;
	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		cacheReadTokens: cacheReadTokens ?? 0,
		cacheWriteTokens: cacheWriteTokens ?? 0,
		reasoningTokens: finiteNumber(record.reasoning),
		totalTokens:
			totalTokens ??
			(inputTokens ?? 0) +
				(outputTokens ?? 0) +
				(cacheReadTokens ?? 0) +
				(cacheWriteTokens ?? 0),
		costUsd: finiteNumber(record.cost?.total) ?? 0,
	};
}

export function addUsage(
	current: UsageSnapshot | undefined,
	next: UsageSnapshot,
): UsageSnapshot {
	if (!current) return { ...next };
	const reasoningTokens =
		current.reasoningTokens === undefined && next.reasoningTokens === undefined
			? undefined
			: (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
	return {
		inputTokens: current.inputTokens + next.inputTokens,
		outputTokens: current.outputTokens + next.outputTokens,
		cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
		cacheWriteTokens: current.cacheWriteTokens + next.cacheWriteTokens,
		reasoningTokens,
		totalTokens: current.totalTokens + next.totalTokens,
		costUsd: current.costUsd + next.costUsd,
	};
}

export function usageTelemetry(
	cumulative: UsageSnapshot | undefined,
	finalRound: UsageSnapshot | undefined,
): BuddyUsageTelemetry | undefined {
	if (!cumulative || !finalRound) return undefined;
	return {
		...cumulative,
		finalRoundInputTokens: finalRound.inputTokens,
		finalRoundTotalTokens: finalRound.totalTokens,
	};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
