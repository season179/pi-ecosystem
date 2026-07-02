import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	getModel,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
	type ToolCall,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SPIKE_DIR, "../../..");
const TOOL_ROUNDS = 3;
const OPENROUTER_MODEL_ID = "anthropic/claude-haiku-4.5";

interface RoundMetadata {
	round: number;
	toolsAvailable: boolean;
	stopReason: AssistantMessage["stopReason"];
	toolCalls: Array<{
		id: string;
		name: string;
		isError?: boolean;
	}>;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		costUsd: number;
	};
}

interface AgenticReferenceResult {
	rounds: RoundMetadata[];
	finalAdvice: string;
}

function usageOf(message: AssistantMessage): RoundMetadata["usage"] {
	return {
		input: message.usage.input,
		output: message.usage.output,
		cacheRead: message.usage.cacheRead,
		cacheWrite: message.usage.cacheWrite,
		totalTokens: message.usage.totalTokens,
		costUsd: message.usage.cost.total,
	};
}

function textFromAssistant(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

function toolCallsFrom(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

async function collectAssistantMessage(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const stream = streamSimple(model, context, options);
	let finalMessage: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done") {
			finalMessage = event.message;
		}
		if (event.type === "error") {
			finalMessage = event.error;
		}
	}
	return finalMessage ?? stream.result();
}

async function executeToolCall(
	tools: AgentTool[],
	toolCall: ToolCall,
	signal: AbortSignal | undefined,
): Promise<ToolResultMessage> {
	const tool = tools.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		return toolErrorResult(toolCall, `Tool "${toolCall.name}" is not enabled`);
	}
	try {
		const preparedCall = tool.prepareArguments
			? { ...toolCall, arguments: tool.prepareArguments(toolCall.arguments) }
			: toolCall;
		const params = validateToolArguments(tool, preparedCall);
		const result = await tool.execute(toolCall.id, params, signal);
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
		return toolErrorResult(
			toolCall,
			error instanceof Error ? error.message : String(error),
		);
	}
}

function toolErrorResult(toolCall: ToolCall, message: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: message }],
		details: {},
		isError: true,
		timestamp: Date.now(),
	};
}

async function runAgenticReference(args: {
	model: Model<Api>;
	context: Context;
	tools: AgentTool[];
	options: SimpleStreamOptions;
	toolRounds: number;
}): Promise<AgenticReferenceResult> {
	const context: Context = {
		systemPrompt: args.context.systemPrompt,
		messages: [...args.context.messages],
	};
	const rounds: RoundMetadata[] = [];

	for (let round = 1; round <= args.toolRounds + 1; round++) {
		const toolsAvailable = round <= args.toolRounds;
		const roundContext: Context = {
			...context,
			tools: toolsAvailable ? args.tools : undefined,
		};
		const message = await collectAssistantMessage(
			args.model,
			roundContext,
			args.options,
		);
		context.messages.push(message);

		const toolCalls = toolCallsFrom(message);
		const metadata: RoundMetadata = {
			round,
			toolsAvailable,
			stopReason: message.stopReason,
			toolCalls: toolCalls.map((toolCall) => ({
				id: toolCall.id,
				name: toolCall.name,
			})),
			usage: usageOf(message),
		};
		rounds.push(metadata);

		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(
				message.errorMessage ?? `Reference stopped with ${message.stopReason}`,
			);
		}

		if (message.stopReason === "toolUse" && toolCalls.length > 0 && toolsAvailable) {
			const results = await Promise.all(
				toolCalls.map((toolCall) =>
					executeToolCall(args.tools, toolCall, args.options.signal),
				),
			);
			for (const [index, result] of results.entries()) {
				metadata.toolCalls[index].isError = result.isError;
				context.messages.push(result);
			}
			continue;
		}

		const finalAdvice = textFromAssistant(message);
		if (!finalAdvice) {
			throw new Error("Reference produced no final advice text");
		}
		return { rounds, finalAdvice };
	}

	throw new Error("Reference loop exhausted without final advice");
}

function makeBaseContext(): Context {
	return {
		systemPrompt: [
			"You are a private MoA reference advisor.",
			"Inspect the repository with read-only tools when useful.",
			"Do not solve the whole user task. Return concise implementation advice for the aggregator.",
			"When tools are unavailable, stop calling tools and produce final advice.",
		].join("\n"),
		messages: [
			{
				role: "user",
				content: [
					"Give advice for adding agentic references to packages/pi-moa.",
					"Focus on orchestrator.ts reference handling, config validation, and telemetry.",
					"Use the read-only tools to inspect the relevant files before advising.",
				].join(" "),
				timestamp: Date.now(),
			},
		],
	};
}

function printResult(label: string, result: AgenticReferenceResult): void {
	console.log(`\n=== ${label} ===`);
	for (const round of result.rounds) {
		const toolList =
			round.toolCalls.length === 0
				? "none"
				: round.toolCalls
						.map((toolCall) =>
							toolCall.isError === undefined
								? toolCall.name
								: `${toolCall.name}${toolCall.isError ? ":error" : ":ok"}`,
						)
						.join(", ");
		console.log(
			[
				`round=${round.round}`,
				`tools=${round.toolsAvailable ? "on" : "off"}`,
				`stop=${round.stopReason}`,
				`toolCalls=${toolList}`,
				`tokens=${round.usage.input}+${round.usage.output}/${round.usage.totalTokens}`,
				`cache=${round.usage.cacheRead}/${round.usage.cacheWrite}`,
				`cost=$${round.usage.costUsd.toFixed(6)}`,
			].join(" | "),
		);
	}
	console.log("\nFinal advice:\n");
	console.log(result.finalAdvice);
}

async function runFauxVariant(): Promise<void> {
	const registration = registerFauxProvider({
		provider: "faux-agentic-reference",
		models: [{ id: "advisor", name: "Faux Agentic Advisor" }],
	});
	try {
		registration.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ls", {
					path: "packages/pi-moa/src/extensions",
					limit: 20,
				}, { id: "faux-ls-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("find", {
					path: "packages/pi-moa/src/extensions",
					pattern: "*.ts",
					limit: 20,
				}, { id: "faux-find-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("read", {
						path: "packages/pi-moa/src/extensions/orchestrator.ts",
						offset: 867,
						limit: 42,
					}, { id: "faux-read-1" }),
					fauxToolCall("grep", {
						path: "packages/pi-moa/src/extensions",
						pattern: "referenceTimeoutMs|referenceQuorum|streamReferences",
						glob: "*.ts",
						limit: 12,
					}, { id: "faux-grep-1" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const toolResults = context.messages.filter(
					(message): message is ToolResultMessage =>
						message.role === "toolResult",
				);
				return fauxAssistantMessage(
					[
						"Final advice from faux reference:",
						`- Saw ${toolResults.length} tool results across the private loop.`,
						"- Keep the non-agentic reference path untouched when referenceTools is unset.",
						"- Move output-char aborting to the final advice stream only.",
						"- Use the phase AbortSignal for model rounds and tool executions so quorum can drop slow references.",
					].join("\n"),
				);
			},
		]);

		const model = registration.getModel("advisor") as Model<Api>;
		const result = await runAgenticReference({
			model,
			context: makeBaseContext(),
			tools: createReadOnlyTools(REPO_ROOT),
			options: { maxTokens: 800 },
			toolRounds: TOOL_ROUNDS,
		});
		printResult("faux provider, no network", result);
	} finally {
		registration.unregister();
	}
}

async function runOpenRouterVariant(): Promise<void> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		console.log(
			[
				"\n=== OpenRouter reference ===",
				"Skipped: OPENROUTER_API_KEY is not set.",
				"Set it and rerun with --openrouter to exercise the live provider.",
			].join("\n"),
		);
		return;
	}

	const model = getModel("openrouter", OPENROUTER_MODEL_ID) as Model<Api>;
	const result = await runAgenticReference({
		model,
		context: makeBaseContext(),
		tools: createReadOnlyTools(REPO_ROOT),
		options: {
			apiKey,
			maxTokens: 900,
			maxRetries: 0,
			temperature: 0.2,
			headers: {
				"HTTP-Referer": "https://github.com/season179/pi-ecosystem",
				"X-OpenRouter-Title": "pi-moa agentic reference spike",
			},
		},
		toolRounds: TOOL_ROUNDS,
	});
	printResult(`OpenRouter ${OPENROUTER_MODEL_ID}`, result);
}

async function main(): Promise<void> {
	const mode = process.argv[2];
	if (mode === "--faux") {
		await runFauxVariant();
		return;
	}
	if (mode === "--openrouter") {
		await runOpenRouterVariant();
		return;
	}
	await runFauxVariant();
	await runOpenRouterVariant();
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exitCode = 1;
});
