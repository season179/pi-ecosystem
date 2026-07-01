import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	completeSimple,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type ThinkingContent,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getPreset, getReferenceConcurrency } from "./config.js";
import {
	appendGuidanceToLatestUser,
	buildGuidanceBlock,
	buildReferenceContext,
	buildReferenceThinkingText,
	extractAssistantText,
	injectGuidanceAsSystem,
	redactErrorMessage,
	stripPriorMoAGuidanceMessages,
	stripPrivateMoAGuidance,
} from "./messages.js";
import type {
	MoAConfig,
	MoAPreset,
	ModelSlot,
	ReferenceOutput,
} from "./types.js";

const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface ReferenceTask {
	slot: ModelSlot;
	model: Model<Api>;
}

type AggregatorForwardResult =
	| { kind: "completed" }
	| { kind: "consecutive-user-rejected" }
	| { kind: "error"; error: AssistantMessage };

export function streamMoA(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	registry: ModelRegistry,
	config: MoAConfig,
): AssistantMessageEventStream {
	const outerStream = createAssistantMessageEventStream();

	(async () => {
		if (options?.signal?.aborted) {
			pushFatalError(
				outerStream,
				model,
				"MoA request aborted before references started",
				"aborted",
			);
			return;
		}

		const presetName = model.id || config.defaultPreset;
		const preset = getPreset(config, presetName);
		const strippedContext = stripPriorMoAGuidanceMessages(context);

		const referenceTasks: ReferenceTask[] = [];
		const prefilledOutputs: Array<ReferenceOutput | undefined> = new Array(
			preset.referenceModels.length,
		);
		for (const [index, slot] of preset.referenceModels.entries()) {
			const referenceModel = resolveUnderlyingModel(registry, slot);
			if (referenceModel) {
				referenceTasks.push({ slot, model: referenceModel });
				continue;
			}
			const output = failedReferenceOutput(
				slot,
				`Model not found: ${slot.provider}/${slot.model}`,
			);
			if (preset.failOnReferenceError) {
				throw new Error(output.errorMessage);
			}
			prefilledOutputs[index] = output;
		}

		const aggregatorModel = resolveUnderlyingModel(registry, preset.aggregator);
		if (!aggregatorModel) {
			throw new Error(
				`MoA aggregator model not found: ${preset.aggregator.provider}/${preset.aggregator.model}`,
			);
		}

		const referenceContext = buildReferenceContext(strippedContext, preset);
		// Aggregator auth depends on nothing the reference phase produces, so resolve
		// it concurrently with the (network-bound) references instead of after them.
		// getApiKeyAndHeaders is side-effect-free and catches its own errors, so this
		// overlap is safe and takes one serial round-trip off the critical path.
		const aggregatorAuthPromise = registry.getApiKeyAndHeaders(aggregatorModel);
		const resolvedReferenceOutputs = await runReferenceTasks({
			presetName,
			preset,
			referenceTasks,
			refContext: referenceContext,
			options,
			registry,
		});
		const referenceOutputs = mergeReferenceOutputs(
			preset,
			prefilledOutputs,
			resolvedReferenceOutputs,
		);

		if (options?.signal?.aborted) {
			pushFatalError(
				outerStream,
				model,
				"MoA request aborted during reference phase",
				"aborted",
			);
			return;
		}

		const guidanceBlock = buildGuidanceBlock({
			presetName,
			preset,
			referenceOutputs,
		});
		const aggregatorAuth = await aggregatorAuthPromise;
		if (!aggregatorAuth.ok) {
			throw new Error(
				`MoA aggregator auth failed for ${preset.aggregator.provider}: ${redactErrorMessage(aggregatorAuth.error)}`,
			);
		}

		const aggregatorOptions: SimpleStreamOptions = {
			...options,
			apiKey: aggregatorAuth.apiKey,
			headers: aggregatorAuth.headers,
			signal: options?.signal,
		};
		if (typeof preset.aggregatorTemperature === "number") {
			aggregatorOptions.temperature = preset.aggregatorTemperature;
		}

		// Emit the reference outputs as a leading, display-only thinking block so
		// they render ABOVE the aggregator's answer (and during its compute pause).
		// The block is persisted on the assistant message for the human to see;
		// the `context` handler strips it (by its sentinel marker) before any model
		// is called again, so it never re-enters model context. The aggregator
		// receives the references as private guidance on its own turn (below).
		const referenceThinking: ThinkingContent = {
			type: "thinking",
			thinking: buildReferenceThinkingText(preset, referenceOutputs),
		};
		emitReferenceThinkingPrelude(outerStream, model, referenceThinking);

		// Guidance rides on the tail of the latest user message (matches hermes and
		// keeps the aggregator's stable system-prompt prefix cacheable across turns).
		const tailContext = appendGuidanceToLatestUser(
			strippedContext,
			guidanceBlock,
		);
		const tailResult = await forwardAggregatorStream({
			model: aggregatorModel,
			context: tailContext,
			options: aggregatorOptions,
			outerStream,
			referenceThinking,
		});

		if (tailResult.kind === "consecutive-user-rejected") {
			// A few strict providers reject a user turn whose tail we extended as a
			// role-alternation error. Fall back to folding the guidance into the
			// system prompt, which touches no message roles.
			const systemContext = injectGuidanceAsSystem(
				strippedContext,
				guidanceBlock,
			);
			const systemResult = await forwardAggregatorStream({
				model: aggregatorModel,
				context: systemContext,
				options: aggregatorOptions,
				outerStream,
				referenceThinking,
			});
			if (systemResult.kind === "error") {
				outerStream.end(systemResult.error);
				return;
			}
			if (systemResult.kind === "consecutive-user-rejected") {
				pushFatalError(
					outerStream,
					model,
					"MoA aggregator rejected guidance in both tail-user and system placements",
					"error",
				);
				return;
			}
		} else if (tailResult.kind === "error") {
			outerStream.end(tailResult.error);
			return;
		}
		outerStream.end();
	})().catch((error: unknown) => {
		pushFatalError(
			outerStream,
			model,
			redactErrorMessage(errorToString(error)),
			"error",
		);
	});

	return outerStream;
}

export async function runReferences(args: {
	presetName: string;
	preset: MoAPreset;
	referenceModels: Model<Api>[];
	refContext: Context;
	options: SimpleStreamOptions | undefined;
	registry: ModelRegistry;
}): Promise<ReferenceOutput[]> {
	const referenceTasks = args.referenceModels.map((model, index) => ({
		model,
		slot: args.preset.referenceModels[index],
	}));
	return runReferenceTasks({ ...args, referenceTasks });
}

async function forwardAggregatorStream(args: {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions;
	outerStream: AssistantMessageEventStream;
	referenceThinking: ThinkingContent;
}): Promise<AggregatorForwardResult> {
	const innerStream = streamSimple(args.model, args.context, args.options);
	let isFirstEvent = true;

	for await (const event of innerStream) {
		if (
			isFirstEvent &&
			event.type === "error" &&
			isConsecutiveUserRejection(event.error)
		) {
			return { kind: "consecutive-user-rejected" };
		}
		isFirstEvent = false;

		if (event.type === "done") {
			const message = prepareAggregatorMessage(
				event.message,
				args.referenceThinking,
			);
			args.outerStream.push({ ...event, message });
			return { kind: "completed" };
		}
		if (event.type === "error") {
			const error = prepareAggregatorMessage(event.error);
			args.outerStream.push({ ...event, error });
			return { kind: "error", error };
		}
	}

	return { kind: "completed" };
}

function prepareAggregatorMessage(
	message: AssistantMessage,
	referenceThinking?: ThinkingContent,
): AssistantMessage {
	// Strip any private MoA guidance the aggregator may have echoed. A reasoning
	// aggregator can restate the guidance inside its own thinking, not just its
	// text, so sanitize both text-bearing block kinds and drop any that strip to
	// empty. The references render separately as the leading thinking block.
	const sanitizedContent = message.content
		.map((block) => {
			if (block.type === "text") {
				return {
					...block,
					text: stripPrivateMoAGuidance(block.text).trimStart(),
				};
			}
			if (block.type === "thinking") {
				return {
					...block,
					thinking: stripPrivateMoAGuidance(block.thinking).trimStart(),
				};
			}
			return block;
		})
		.filter((block) => {
			if (block.type === "text") return block.text.length > 0;
			if (block.type === "thinking") return block.thinking.length > 0;
			return true;
		});

	// Prepend the reference thinking block so it persists (and renders) above the
	// aggregator's answer. Only on the success path — error messages stay bare.
	const content = referenceThinking
		? [referenceThinking, ...sanitizedContent]
		: sanitizedContent;
	return { ...message, content };
}

function isConsecutiveUserRejection(error: AssistantMessage): boolean {
	const message = error.errorMessage ?? "";
	return /consecutive|alternat|user.*user|expected.*assistant.*got.*user|roles? must/i.test(
		message,
	);
}

async function runReferenceTasks(args: {
	presetName: string;
	preset: MoAPreset;
	referenceTasks: ReferenceTask[];
	refContext: Context;
	options: SimpleStreamOptions | undefined;
	registry: ModelRegistry;
}): Promise<ReferenceOutput[]> {
	const concurrency = Math.min(
		getReferenceConcurrency(args.preset),
		Math.max(1, args.referenceTasks.length),
	);
	const results: ReferenceOutput[] = new Array(args.referenceTasks.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (!args.options?.signal?.aborted) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= args.referenceTasks.length) return;
			const task = args.referenceTasks[index];
			results[index] = await runSingleReference({ ...args, task });
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return results.filter(
		(output): output is ReferenceOutput => output !== undefined,
	);
}

async function runSingleReference(args: {
	presetName: string;
	preset: MoAPreset;
	task: ReferenceTask;
	refContext: Context;
	options: SimpleStreamOptions | undefined;
	registry: ModelRegistry;
}): Promise<ReferenceOutput> {
	try {
		if (args.refContext.tools !== undefined) {
			throw new Error("MoA reference context unexpectedly includes tools");
		}
		const auth = await args.registry.getApiKeyAndHeaders(args.task.model);
		if (!auth.ok) {
			throw new Error(
				`Authentication failed for ${args.task.slot.provider}: ${auth.error}`,
			);
		}
		// Drop the payload-mutation hooks before forwarding options to a reference.
		// `onPayload` runs against the raw provider payload right before send and
		// could inject tool schemas (the one path by which a reference could still
		// receive tools even though the Context carries none); `onResponse` is an
		// acting-agent concern. References are advisory and must stay tool-free.
		const {
			onPayload: _onPayload,
			onResponse: _onResponse,
			...forwardableOptions
		} = args.options ?? {};
		const referenceOptions: SimpleStreamOptions = {
			...forwardableOptions,
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: args.options?.signal,
		};
		if (typeof args.preset.referenceTemperature === "number") {
			referenceOptions.temperature = args.preset.referenceTemperature;
		}
		// Reference output is truncated to maxReferenceOutputChars before it reaches
		// the aggregator or the display, so tokens generated past that budget are
		// discarded. Bound reference generation to the preset's cap (never raising a
		// smaller caller-supplied limit) to keep verbose references off the critical
		// path — the aggregator waits for the slowest reference to finish.
		if (typeof args.preset.referenceMaxTokens === "number") {
			referenceOptions.maxTokens =
				referenceOptions.maxTokens !== undefined
					? Math.min(referenceOptions.maxTokens, args.preset.referenceMaxTokens)
					: args.preset.referenceMaxTokens;
		}
		const message = await completeSimple(
			args.task.model,
			args.refContext,
			referenceOptions,
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(
				message.errorMessage ?? `Reference stopped with ${message.stopReason}`,
			);
		}
		if (
			message.stopReason === "toolUse" ||
			message.content.some((block) => block.type === "toolCall")
		) {
			throw new Error(
				"Reference attempted to use a tool, but MoA reference models run without tools",
			);
		}
		return {
			slot: args.task.slot,
			success: true,
			text: extractAssistantText(message),
			usage: message.usage,
		};
	} catch (error) {
		const output = failedReferenceOutput(args.task.slot, errorToString(error));
		if (args.preset.failOnReferenceError) {
			throw new Error(output.errorMessage);
		}
		return output;
	}
}

function resolveUnderlyingModel(
	registry: ModelRegistry,
	slot: ModelSlot,
): Model<Api> | undefined {
	if (slot.provider === "moa") {
		throw new Error(
			`MoA cannot call recursive model ${slot.provider}/${slot.model}`,
		);
	}
	return registry.find(slot.provider, slot.model);
}

function mergeReferenceOutputs(
	preset: MoAPreset,
	prefilledOutputs: Array<ReferenceOutput | undefined>,
	resolvedOutputs: ReferenceOutput[],
): ReferenceOutput[] {
	const outputs: ReferenceOutput[] = [];
	let resolvedIndex = 0;
	for (const prefilledOutput of prefilledOutputs) {
		if (prefilledOutput) {
			outputs.push(prefilledOutput);
		} else {
			const output = resolvedOutputs[resolvedIndex];
			resolvedIndex += 1;
			if (output) outputs.push(output);
		}
	}
	return outputs.length > 0
		? outputs
		: preset.referenceModels.map((slot) =>
				failedReferenceOutput(slot, "Reference was not run"),
			);
}

function failedReferenceOutput(
	slot: ModelSlot,
	error: string,
): ReferenceOutput {
	const errorMessage = redactErrorMessage(error);
	return {
		slot,
		success: false,
		text: errorMessage,
		errorMessage,
	};
}

// Push the reference thinking block onto the outer stream as a live prelude: a
// `start`, then thinking start/delta/end for content index 0. This surfaces the
// references during the reference/aggregator compute pause. The same block is
// prepended to the final `done` message (see prepareAggregatorMessage) so it
// persists on the assistant message; these events are the streaming view of it.
// The EventStream does not accumulate partials, so each event carries the full
// partial assistant message it represents.
function emitReferenceThinkingPrelude(
	outerStream: AssistantMessageEventStream,
	model: Model<Api>,
	referenceThinking: ThinkingContent,
): void {
	const partial = (content: AssistantMessage["content"]): AssistantMessage => ({
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const text = referenceThinking.thinking;
	outerStream.push({ type: "start", partial: partial([]) });
	outerStream.push({
		type: "thinking_start",
		contentIndex: 0,
		partial: partial([{ type: "thinking", thinking: "" }]),
	});
	outerStream.push({
		type: "thinking_delta",
		contentIndex: 0,
		delta: text,
		partial: partial([referenceThinking]),
	});
	outerStream.push({
		type: "thinking_end",
		contentIndex: 0,
		content: text,
		partial: partial([referenceThinking]),
	});
}

function pushFatalError(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	errorMessage: string,
	stopReason: "error" | "aborted",
): void {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: stopReason, error: message });
	stream.end(message);
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
