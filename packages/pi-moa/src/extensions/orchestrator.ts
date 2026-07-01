import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	completeSimple,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getPreset, getReferenceConcurrency } from "./config.js";
import {
	buildGuidanceBlock,
	buildReferenceContext,
	buildReferenceDisplayBlock,
	extractAssistantText,
	injectGuidance,
	injectGuidanceAsSystem,
	redactErrorMessage,
	stripPriorMoAGuidanceMessages,
} from "./messages.js";
import type { MoAConfig, MoAPreset, ModelSlot, ReferenceOutput } from "./types.js";

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
			pushFatalError(outerStream, model, "MoA request aborted before references started", "aborted");
			return;
		}

		const presetName = model.id || config.defaultPreset;
		const preset = getPreset(config, presetName);
		const strippedContext = stripPriorMoAGuidanceMessages(context);

		const referenceTasks: ReferenceTask[] = [];
		const prefilledOutputs: Array<ReferenceOutput | undefined> = new Array(preset.referenceModels.length);
		for (const [index, slot] of preset.referenceModels.entries()) {
			const referenceModel = resolveUnderlyingModel(registry, slot);
			if (referenceModel) {
				referenceTasks.push({ slot, model: referenceModel });
				continue;
			}
			const output = failedReferenceOutput(slot, `Model not found: ${slot.provider}/${slot.model}`);
			if (preset.failOnReferenceError) {
				throw new Error(output.errorMessage);
			}
			prefilledOutputs[index] = output;
		}

		const aggregatorModel = resolveUnderlyingModel(registry, preset.aggregator);
		if (!aggregatorModel) {
			throw new Error(`MoA aggregator model not found: ${preset.aggregator.provider}/${preset.aggregator.model}`);
		}

		const referenceContext = buildReferenceContext(strippedContext, preset);
		const resolvedReferenceOutputs = await runReferenceTasks({
			presetName,
			preset,
			referenceTasks,
			refContext: referenceContext,
			options,
			registry,
		});
		const referenceOutputs = mergeReferenceOutputs(preset, prefilledOutputs, resolvedReferenceOutputs);

		if (options?.signal?.aborted) {
			pushFatalError(outerStream, model, "MoA request aborted during reference phase", "aborted");
			return;
		}

		const guidanceBlock = buildGuidanceBlock({ presetName, preset, referenceOutputs });
		const referenceDisplayBlock = buildReferenceDisplayBlock({ preset, referenceOutputs });
		const aggregatorAuth = await registry.getApiKeyAndHeaders(aggregatorModel);
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

		const injectedContext = injectGuidanceAsSystem(strippedContext, guidanceBlock);
		const injectedResult = await forwardAggregatorStream({
			model: aggregatorModel,
			context: injectedContext,
			options: aggregatorOptions,
			outerStream,
			prefixText: referenceDisplayBlock,
		});

		if (injectedResult.kind === "consecutive-user-rejected") {
			const retriedContext = injectGuidanceAsSystem(strippedContext, guidanceBlock);
			const appendedResult = await forwardAggregatorStream({
				model: aggregatorModel,
				context: retriedContext,
				options: aggregatorOptions,
				outerStream,
				prefixText: referenceDisplayBlock,
			});
			if (appendedResult.kind === "error") {
				outerStream.end(appendedResult.error);
				return;
			}
			if (appendedResult.kind === "consecutive-user-rejected") {
				pushFatalError(outerStream, model, "MoA aggregator rejected consecutive user guidance fallback", "error");
				return;
			}
		} else if (injectedResult.kind === "error") {
			outerStream.end(injectedResult.error);
			return;
		}
		outerStream.end();
	})().catch((error: unknown) => {
		pushFatalError(outerStream, model, redactErrorMessage(errorToString(error)), "error");
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
	prefixText?: string;
}): Promise<AggregatorForwardResult> {
	const innerStream = streamSimple(args.model, args.context, args.options);
	let isFirstEvent = true;

	for await (const event of innerStream) {
		if (isFirstEvent && event.type === "error" && isConsecutiveUserRejection(event.error)) {
			return { kind: "consecutive-user-rejected" };
		}

		isFirstEvent = false;
		const forwardedEvent = args.prefixText ? prependTextToEvent(event, args.prefixText) : event;
		args.outerStream.push(forwardedEvent);
		if (forwardedEvent.type === "error") {
			return { kind: "error", error: forwardedEvent.error };
		}
	}

	return { kind: "completed" };
}

function prependTextToEvent(event: AssistantMessageEvent, text: string): AssistantMessageEvent {
	const prependMessage = (message: AssistantMessage): AssistantMessage => ({
		...message,
		content: [{ type: "text", text }, ...message.content],
	});
	const prependPartial = (partial: AssistantMessage): AssistantMessage => prependMessage(partial);
	const shiftContentIndex = (contentIndex: number): number => contentIndex + 1;

	switch (event.type) {
		case "start":
			return { ...event, partial: prependPartial(event.partial) };
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return { ...event, contentIndex: shiftContentIndex(event.contentIndex), partial: prependPartial(event.partial) };
		case "done":
			return { ...event, message: prependMessage(event.message) };
		case "error":
			return { ...event, error: prependMessage(event.error) };
	}
}

function isConsecutiveUserRejection(error: AssistantMessage): boolean {
	const message = error.errorMessage ?? "";
	return /consecutive|alternat|user.*user|expected.*assistant.*got.*user|roles? must/i.test(message);
}

async function runReferenceTasks(args: {
	presetName: string;
	preset: MoAPreset;
	referenceTasks: ReferenceTask[];
	refContext: Context;
	options: SimpleStreamOptions | undefined;
	registry: ModelRegistry;
}): Promise<ReferenceOutput[]> {
	const concurrency = Math.min(getReferenceConcurrency(args.preset), Math.max(1, args.referenceTasks.length));
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
	return results.filter((output): output is ReferenceOutput => output !== undefined);
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
			throw new Error(`Authentication failed for ${args.task.slot.provider}: ${auth.error}`);
		}
		const referenceOptions: SimpleStreamOptions = {
			...args.options,
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: args.options?.signal,
		};
		if (typeof args.preset.referenceTemperature === "number") {
			referenceOptions.temperature = args.preset.referenceTemperature;
		}
		const message = await completeSimple(args.task.model, args.refContext, referenceOptions);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `Reference stopped with ${message.stopReason}`);
		}
		if (message.stopReason === "toolUse" || message.content.some((block) => block.type === "toolCall")) {
			throw new Error("Reference attempted to use a tool, but MoA reference models run without tools");
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

function resolveUnderlyingModel(registry: ModelRegistry, slot: ModelSlot): Model<Api> | undefined {
	if (slot.provider === "moa") {
		throw new Error(`MoA cannot call recursive model ${slot.provider}/${slot.model}`);
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
		: preset.referenceModels.map((slot) => failedReferenceOutput(slot, "Reference was not run"));
}

function failedReferenceOutput(slot: ModelSlot, error: string): ReferenceOutput {
	const errorMessage = redactErrorMessage(error);
	return {
		slot,
		success: false,
		text: errorMessage,
		errorMessage,
	};
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
