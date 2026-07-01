import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OpenRouterRouting,
	type SimpleStreamOptions,
	streamSimple,
	type ThinkingContent,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	getMaxReferenceOutputChars,
	getPreset,
	getReferenceConcurrency,
} from "./config.js";
import {
	appendGuidanceAsTrailingTurn,
	appendGuidanceToLatestUser,
	buildGuidanceBlock,
	buildReferenceThinkingHeader,
	buildReferenceThinkingSection,
	buildReferenceThinkingText,
	extractAssistantText,
	injectGuidanceAsSystem,
	redactErrorMessage,
	renderReferenceContext,
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

// Aggregator providers observed to reject a *trailing* user turn placed after
// tool results (a role-alternation error) during this process, keyed by provider
// id. Whether a provider's API accepts that sequence is a stable property of the
// API — not a transient failure — so caching it process-wide is correct: once a
// provider rejects the cache-friendly "trailing-message" placement we skip that
// doomed attempt on every later turn and go straight to the always-valid
// system-prompt fallback. This bounds the wasted-request cost of trailing-message
// on a strict provider to one failed request per process instead of one on every
// tool-loop turn. It stays empty (so behavior is byte-identical) unless the opt-in
// trailing-message placement is used against a provider that rejects the trailing
// turn; the default "latest-user" placement never attempts a trailing turn and so
// never touches this cache.
const trailingPlacementUnsupported = new Set<string>();

// Test-only hook: clears the process-wide trailing-placement rejection cache so
// tests that exercise the memoization can start from a known-empty state.
export function __resetTrailingPlacementCacheForTests(): void {
	trailingPlacementUnsupported.clear();
}

interface ReferenceTask {
	slot: ModelSlot;
	model: Model<Api>;
}

type AuthResult = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

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

		const referenceTasks: ReferenceTask[] = [];
		const prefilledOutputs: Array<ReferenceOutput | undefined> = new Array(
			preset.referenceModels.length,
		);
		let hasPrefilledOutput = false;
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
			hasPrefilledOutput = true;
		}

		const aggregatorModel = resolveUnderlyingModel(registry, preset.aggregator);
		if (!aggregatorModel) {
			throw new Error(
				`MoA aggregator model not found: ${preset.aggregator.provider}/${preset.aggregator.model}`,
			);
		}

		// Resolve auth for the aggregator AND every reference concurrently, up front —
		// before building the reference context and before any reference streams.
		// getApiKeyAndHeaders depends on nothing the reference phase produces, is
		// side-effect-free, always resolves (it catches its own errors), and dedups
		// shared-provider token refreshes via an internal per-provider lock. Firing all
		// of it now — instead of the aggregator alone (iteration 1) plus a lazy
		// per-reference fetch inside each worker — overlaps every auth round-trip with
		// the reference-context CPU work and with each other, so a reference whose
		// concurrency slot opens late no longer blocks on a fresh auth fetch when it
		// finally runs. For a single-provider fleet the per-provider lock collapses
		// these to one round-trip (behavior unchanged); a multi-provider or
		// concurrency-limited fleet takes the per-reference auth latency off the
		// reference-streaming critical path.
		const aggregatorAuthPromise = registry.getApiKeyAndHeaders(aggregatorModel);
		const referenceAuthPromises = referenceTasks.map((task) =>
			registry.getApiKeyAndHeaders(task.model),
		);

		// Strip prior MoA guidance *after* firing the auth round-trips (not before, as
		// the model-resolution above requires) so this O(n) transcript pass overlaps
		// the auth network I/O rather than sitting un-overlapped ahead of it — the same
		// overlap principle iteration 1 applied to the aggregator-auth resolution. The
		// single stripped context is then shared by both paths: renderReferenceContext
		// consumes it directly (no redundant second strip), and the aggregator guidance
		// placement below reuses it too.
		const strippedContext = stripPriorMoAGuidanceMessages(context);

		const referenceContext = renderReferenceContext(strippedContext, preset);

		// Progressive reference streaming reveals the reference thinking block as it
		// fills in — the header immediately (before any reference finishes) and each
		// reference's advice the moment it settles — instead of one atomic burst after
		// the whole reference phase completes. This closes the reference-phase feedback
		// gap (the phase otherwise shows nothing until its slowest reference returns),
		// complementing streamAggregator's answer streaming. It is display-only: the
		// persisted `done` message is still built atomically below, so the streamed
		// prelude never changes what re-enters model context. Opt-in and unset by
		// default. Scoped to the clean case — no quorum (dropped references would leave
		// gaps in the slot-ordered reveal) and no prefilled model-not-found failures
		// (their slots shift the merged output order) — otherwise the atomic prelude
		// runs, so those paths are byte-identical.
		const useProgressiveReferenceStream =
			preset.streamReferences === true &&
			preset.referenceQuorum === undefined &&
			!hasPrefilledOutput &&
			referenceTasks.length > 0;
		const progressiveReferenceStream = useProgressiveReferenceStream
			? beginProgressiveReferenceThinking(
					outerStream,
					model,
					preset,
					referenceTasks.length,
				)
			: undefined;

		const resolvedReferenceOutputs = await runReferenceTasks({
			presetName,
			preset,
			referenceTasks,
			referenceAuthPromises,
			refContext: referenceContext,
			options,
			registry,
			onReferenceSettled: progressiveReferenceStream?.reveal,
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
		// Pin the aggregator's reasoning effort independent of the caller. The
		// aggregator's generation is the dominant per-turn latency cost, and a
		// reasoning aggregator spends much of its wall-clock thinking before it
		// answers — so capping its effort is the most direct lever on that cost. The
		// caller's `options.reasoning` applies to the aggregator by default (via the
		// spread above) and there is otherwise no way to lower the aggregator's
		// reasoning without also lowering the references' inherited default; this knob
		// decouples them, mirroring referenceReasoning on the aggregator side. Set
		// AFTER the caller-options spread so the preset governs the aggregator's
		// reasoning; references keep their own (caller or referenceReasoning) effort.
		// Unlike a pure TTL/placement hint this trades answer quality for latency, so
		// it stays opt-in and unset by default — leaving the aggregator inheriting the
		// caller's reasoning exactly as before. A non-reasoning aggregator clamps it
		// away to a provider-side no-op.
		if (preset.aggregatorReasoning !== undefined) {
			aggregatorOptions.reasoning = preset.aggregatorReasoning;
		}
		// Ask the aggregator's provider to keep its prompt cache alive for the
		// configured retention (a cache-TTL hint mapped to Anthropic `cache_control.ttl`
		// / OpenAI `prompt_cache_retention`). The aggregator re-prefills its whole
		// transcript every tool-loop turn; prompt caching avoids that only while the
		// cache lives, and the provider default ("short") can expire between turns when
		// a tool run or a review pause exceeds the short TTL, forcing a full re-prefill.
		// "long" survives those gaps so the next turn is a cache hit (lower TTFT). Set
		// AFTER the caller-options spread so the preset governs the aggregator's
		// retention; the references keep the caller/provider default (they are
		// single-turn advisory calls that never re-hit their own cache, so paying the
		// pricier long-cache write for them would be wasted). Unset by default, so the
		// aggregator inherits the caller's retention exactly as before — and this is a
		// pure TTL hint, so the persisted answer is byte-identical regardless.
		if (preset.aggregatorCacheRetention !== undefined) {
			aggregatorOptions.cacheRetention = preset.aggregatorCacheRetention;
		}

		// Steer OpenRouter's provider routing for the aggregator's request. OpenRouter
		// fronts several upstream providers per model and, by default, balances routing
		// (weighted by price/uptime) — which can land the aggregator on a slow backend.
		// The aggregator's generation is the dominant, UN-bounded per-turn cost (unlike
		// references, which quorum/timeout/output caps already bound), so pinning it to a
		// high-throughput / low-latency backend is the most direct latency lever left:
		// `sort: "throughput"` routes to the fastest tokens/sec provider, `sort:
		// "latency"` to the lowest time-to-first-token, and preferred_min_throughput /
		// preferred_max_latency set explicit floors/ceilings. This lives on the model's
		// `compat` (not the stream options), and pi-ai's openai-completions provider
		// applies it ONLY when the model's baseUrl points at OpenRouter — so it is a safe
		// no-op for a non-openrouter aggregator. Aggregator-scoped (references keep their
		// own routing) and unset by default. Kept opt-in — not shipped in the default
		// preset — because a different backend can differ in quantization or behavior and
		// so could subtly shift the answer, unlike a pure cache/TTL hint.
		const aggregatorStreamModel =
			preset.aggregatorProviderRouting !== undefined
				? withOpenRouterRouting(
						aggregatorModel,
						preset.aggregatorProviderRouting,
					)
				: aggregatorModel;

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
		if (progressiveReferenceStream) {
			// The header + every settled section were already streamed live; close the
			// block on the canonical full text (which equals what was accumulated in
			// this scoped case, and reconciles the display if anything was left
			// unrevealed) instead of re-emitting the whole prelude.
			progressiveReferenceStream.finish(referenceThinking.thinking);
		} else {
			emitReferenceThinkingPrelude(outerStream, model, referenceThinking);
		}

		// Guidance rides on the tail of the latest user message (matches hermes and
		// keeps the aggregator's stable system-prompt prefix cacheable across turns).
		// The opt-in "trailing-message" placement instead appends the guidance as a
		// new trailing user turn when the transcript ends on an assistant/tool turn,
		// so the whole prior transcript stays a byte-stable prefix the aggregator's
		// provider can reuse from its prompt cache across tool-loop turns (the
		// latest-user default would mutate the early task message and bust that cache).
		//
		// A few strict providers reject a trailing user turn after tool results. That
		// is a stable property of the provider's API, so once we have seen it we skip
		// the doomed trailing attempt on later turns (see trailingPlacementUnsupported)
		// and go straight to the system-prompt placement, which touches no message
		// roles — turning trailing-message's worst case on a strict provider from a
		// wasted request every tool-loop turn into one wasted request per process.
		const aggregatorProviderKey = preset.aggregator.provider;
		const wantsTrailing =
			preset.aggregatorGuidancePlacement === "trailing-message";
		const attemptTrailing =
			wantsTrailing && !trailingPlacementUnsupported.has(aggregatorProviderKey);
		let primaryContext: Context;
		if (attemptTrailing) {
			primaryContext = appendGuidanceAsTrailingTurn(
				strippedContext,
				guidanceBlock,
			);
		} else if (wantsTrailing) {
			// Trailing requested, but this provider already rejected it this process:
			// skip straight to the always-valid system-prompt placement.
			primaryContext = injectGuidanceAsSystem(strippedContext, guidanceBlock);
		} else {
			primaryContext = appendGuidanceToLatestUser(strippedContext, guidanceBlock);
		}
		const streamIncremental = preset.streamAggregator === true;
		const primaryResult = await forwardAggregatorStream({
			model: aggregatorStreamModel,
			context: primaryContext,
			options: aggregatorOptions,
			outerStream,
			referenceThinking,
			streamIncremental,
		});

		if (primaryResult.kind === "consecutive-user-rejected") {
			// Only the trailing-message placement can trigger this — appending to an
			// existing user turn (latest-user) or the system prompt never creates
			// consecutive user turns. Remember the provider so future turns skip the
			// trailing attempt, then fall back to folding the guidance into the system
			// prompt, which touches no message roles.
			if (attemptTrailing) {
				trailingPlacementUnsupported.add(aggregatorProviderKey);
			}
			const systemContext = injectGuidanceAsSystem(
				strippedContext,
				guidanceBlock,
			);
			const systemResult = await forwardAggregatorStream({
				model: aggregatorStreamModel,
				context: systemContext,
				options: aggregatorOptions,
				outerStream,
				referenceThinking,
				streamIncremental,
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
		} else if (primaryResult.kind === "error") {
			outerStream.end(primaryResult.error);
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
	// When true, forward the aggregator's incremental content events so its answer
	// streams to the user token-by-token (time-to-first-token) instead of appearing
	// in one burst on `done`. Off by default, so the default path is byte-identical.
	streamIncremental: boolean;
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
		// event is now `start` or an incremental content event.
		if (args.streamIncremental && event.type !== "start") {
			// Forward the aggregator's content deltas live. Skip its own `start` — the
			// reference-thinking prelude already emitted one to the outer stream, and a
			// second would push a duplicate assistant message into the consumer. Offset
			// each content index by +1 to reserve index 0 for that prelude, and prepend
			// the prelude to every partial so the streamed message shape matches the
			// final `done` message (reference thinking at 0, aggregator content at 1+).
			args.outerStream.push({
				...event,
				contentIndex: event.contentIndex + 1,
				partial: withReferenceThinkingPrelude(
					event.partial,
					args.referenceThinking,
				),
			});
		}
	}

	return { kind: "completed" };
}

// Prepend the display-only reference thinking block to a streaming partial so the
// live-streamed aggregator message matches the final `done` message's shape
// (reference thinking at content index 0, aggregator content shifted to 1+). Any
// COMPLETE private-guidance block the aggregator echoed is stripped so it never
// flashes mid-stream, mirroring the final message's sanitization; empty blocks are
// deliberately NOT filtered here (unlike the final message) so the partial's
// content indices stay aligned with the forwarded contentIndex.
function withReferenceThinkingPrelude(
	partial: AssistantMessage,
	referenceThinking: ThinkingContent,
): AssistantMessage {
	const content: AssistantMessage["content"] = [referenceThinking];
	for (const block of partial.content) {
		if (block.type === "text") {
			content.push({ ...block, text: stripPrivateMoAGuidance(block.text) });
		} else if (block.type === "thinking") {
			content.push({
				...block,
				thinking: stripPrivateMoAGuidance(block.thinking),
			});
		} else {
			content.push(block);
		}
	}
	return { ...partial, content };
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
	// Auth pre-resolved up front, index-aligned with referenceTasks. When omitted
	// (e.g. the public runReferences helper) each worker falls back to a lazy fetch.
	referenceAuthPromises?: Promise<AuthResult>[];
	refContext: Context;
	options: SimpleStreamOptions | undefined;
	registry: ModelRegistry;
	// Invoked with (task index, output) the moment a reference records its result,
	// so the progressive-streaming path can reveal it live. Only wired up when
	// quorum is unset, so every task records exactly once and this fires once per
	// reference; superseded-by-quorum references never record and so never fire it.
	onReferenceSettled?: (index: number, output: ReferenceOutput) => void;
}): Promise<ReferenceOutput[]> {
	const concurrency = Math.min(
		getReferenceConcurrency(args.preset),
		Math.max(1, args.referenceTasks.length),
	);
	const quorum = args.preset.referenceQuorum;
	const results: ReferenceOutput[] = new Array(args.referenceTasks.length);
	let nextIndex = 0;
	let successCount = 0;
	let quorumReached = false;

	// A phase-level controller lets a reached quorum abort the still-running
	// (slower) references without touching the caller's signal. It is linked to
	// the parent so a genuine caller abort still propagates to every reference;
	// with no quorum set it only ever fires via the parent, so behavior is
	// identical to awaiting every reference as before.
	const parentSignal = args.options?.signal;
	const phaseController = new AbortController();
	if (parentSignal?.aborted) {
		phaseController.abort();
	}
	const forwardParentAbort = () => phaseController.abort();
	parentSignal?.addEventListener("abort", forwardParentAbort, { once: true });
	const phaseOptions: SimpleStreamOptions = {
		...(args.options ?? {}),
		signal: phaseController.signal,
	};

	let onQuorumMet: (() => void) | undefined;
	const quorumMet = new Promise<void>((resolve) => {
		onQuorumMet = resolve;
	});

	async function worker(): Promise<void> {
		while (!phaseController.signal.aborted) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= args.referenceTasks.length) return;
			const task = args.referenceTasks[index];
			const output = await runSingleReference({
				...args,
				options: phaseOptions,
				task,
				authPromise: args.referenceAuthPromises?.[index],
			});
			// A reference superseded mid-flight by an already-reached quorum (the
			// phase was aborted without a caller abort) is a benign drop: its advice
			// is no longer needed, so leave its slot empty rather than recording a
			// spurious failure.
			if (quorumReached && !parentSignal?.aborted) {
				return;
			}
			results[index] = output;
			args.onReferenceSettled?.(index, output);
			if (
				output.success &&
				quorum !== undefined &&
				!quorumReached &&
				++successCount >= quorum
			) {
				// Enough references have succeeded: stop waiting for the rest. Abort
				// the ones we can (real streams honor it, capping their cost) and
				// resolve immediately — a reference that stalls before it streams can't
				// be unblocked by abort, so we must not await it (mirrors
				// referenceTimeoutMs).
				quorumReached = true;
				phaseController.abort();
				onQuorumMet?.();
				return;
			}
		}
	}

	const allSettled = Promise.all(
		Array.from({ length: concurrency }, () => worker()),
	);
	try {
		if (quorum === undefined) {
			await allSettled;
		} else {
			// The abandoned workers may reject later (a superseded reference throwing
			// under failOnReferenceError); swallow it so it never surfaces as an
			// unhandled rejection once the quorum has already resolved the phase.
			allSettled.catch(() => {});
			await Promise.race([allSettled, quorumMet]);
		}
	} finally {
		parentSignal?.removeEventListener("abort", forwardParentAbort);
	}
	return results.filter(
		(output): output is ReferenceOutput => output !== undefined,
	);
}

async function runSingleReference(args: {
	presetName: string;
	preset: MoAPreset;
	task: ReferenceTask;
	// Pre-resolved auth for this reference (fired up front alongside the others).
	// Falls back to a lazy fetch when absent so runReferences stays self-contained.
	authPromise?: Promise<AuthResult>;
	refContext: Context;
	options: SimpleStreamOptions | undefined;
	registry: ModelRegistry;
}): Promise<ReferenceOutput> {
	try {
		if (args.refContext.tools !== undefined) {
			throw new Error("MoA reference context unexpectedly includes tools");
		}
		const auth = await (args.authPromise ??
			args.registry.getApiKeyAndHeaders(args.task.model));
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
		// A reasoning reference model can spend most of its wall-clock thinking
		// before it emits any text — and that thinking is discarded downstream
		// (only the reference's text advice reaches the aggregator/display). The
		// stream-and-abort below counts text chars, so it cannot shorten that
		// leading thinking phase. Overriding the reference's reasoning effort is the
		// only lever that does: it decouples reference reasoning from the caller's,
		// letting a heavy-thinking reference (e.g. a "flash" model that reasons by
		// default) be capped to a lower effort so its discarded thinking stops
		// holding up the aggregator. Opt-in and unset by default, so behavior is
		// unchanged unless a preset sets it; a non-reasoning reference model clamps
		// it away to a no-op provider-side.
		if (args.preset.referenceReasoning !== undefined) {
			referenceOptions.reasoning = args.preset.referenceReasoning;
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
		const message = await streamReferenceUntilBudget(
			args.task.model,
			args.refContext,
			referenceOptions,
			getMaxReferenceOutputChars(args.preset),
			args.preset.referenceTimeoutMs,
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

// Only the first `keptOutputChars` of a reference's text ever reaches the
// aggregator or the display — buildGuidanceBlock/buildReferenceThinkingText
// head-truncate to that budget, so any text generated past it is discarded.
// Consume the reference as a stream and abort it once that many characters of
// text have arrived, taking the discarded tail off the critical path (the
// aggregator waits for the slowest reference before it can start). The kept
// advisory text is byte-identical to reading the full response and truncating;
// only the truncation marker's reported total reflects the early stop rather
// than the full would-be length. This complements the referenceMaxTokens cap:
// the token cap is an upper bound, this stops precisely at the kept budget.
//
// When `timeoutMs` is set, also bound the reference's wall-clock time: at the
// deadline the request is aborted and the advice produced so far is surfaced as
// success (or the reference fails gracefully if it produced no text). This is
// the only lever that caps reference TIME rather than length/cost, so a stalled
// or slow provider can no longer hold the whole turn hostage. It is opt-in and
// unset by default, so default behavior is unchanged.
async function streamReferenceUntilBudget(
	model: Model<Api>,
	refContext: Context,
	referenceOptions: SimpleStreamOptions,
	keptOutputChars: number,
	timeoutMs?: number,
): Promise<AssistantMessage> {
	const parentSignal = referenceOptions.signal;
	const controller = new AbortController();
	if (parentSignal?.aborted) {
		controller.abort();
	}
	const forwardAbort = () => controller.abort();
	parentSignal?.addEventListener("abort", forwardAbort, { once: true });

	let keptTextChars = 0;
	let sawToolCall = false;
	let budgetReached = false;
	let deadlineReached = false;
	let latestPartial: AssistantMessage | undefined;

	// Consume the reference stream to its budget/abort. Shares the mutable state
	// above with the deadline timer (single-threaded, so no data race) so a
	// timeout can surface the partial advice produced up to that point.
	const consume = async (): Promise<AssistantMessage> => {
		const stream = streamSimple(model, refContext, {
			...referenceOptions,
			signal: controller.signal,
		});
		for await (const event of stream) {
			if (event.type === "done") {
				return event.message;
			}
			if (event.type === "error") {
				// A budget or deadline abort is our own doing and yields a
				// complete-enough reference, so surface the accumulated partial as
				// success. Every other error — including a genuine parent abort —
				// propagates.
				if ((budgetReached || deadlineReached) && latestPartial) {
					return finalizeBudgetedReference(latestPartial);
				}
				throw new Error(
					event.error.errorMessage ??
						`Reference stopped with ${event.error.stopReason}`,
				);
			}
			latestPartial = event.partial;
			if (
				event.type === "toolcall_start" ||
				event.type === "toolcall_delta" ||
				event.type === "toolcall_end"
			) {
				// A reference must not call tools. Stop early-aborting so the full
				// (tool-bearing) message is assembled and rejected by the caller,
				// exactly as before.
				sawToolCall = true;
			}
			if (event.type === "text_delta") {
				keptTextChars += event.delta.length;
			}
			if (!sawToolCall && !budgetReached && keptTextChars >= keptOutputChars) {
				budgetReached = true;
				controller.abort();
				return finalizeBudgetedReference(latestPartial);
			}
		}
		if (latestPartial) {
			return latestPartial;
		}
		throw new Error("Reference produced no output before the stream ended");
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (timeoutMs === undefined) {
			return await consume();
		}
		const consumePromise = consume();
		// The consume promise may settle after the deadline wins the race; swallow
		// any late rejection so it never surfaces as an unhandled rejection.
		consumePromise.catch(() => {});
		const deadline = new Promise<AssistantMessage>((resolve, reject) => {
			timer = setTimeout(() => {
				deadlineReached = true;
				controller.abort();
				// Surface partial advice as success only when the reference actually
				// produced text; a stall with no output fails gracefully instead of
				// injecting an empty reference.
				if (keptTextChars > 0 && latestPartial) {
					resolve(finalizeBudgetedReference(latestPartial));
				} else {
					reject(
						new Error(
							`Reference exceeded referenceTimeoutMs (${timeoutMs}ms) before producing output`,
						),
					);
				}
			}, timeoutMs);
		});
		return await Promise.race([consumePromise, deadline]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		parentSignal?.removeEventListener("abort", forwardAbort);
	}
}

// Snapshot the partial assembled up to the kept-output budget into a standalone
// success message. Deep-copy the content so it can't be mutated by any lingering
// stream producer, and mark the stop reason as `length` — the reference stopped
// because it reached its output budget, which the caller treats as success.
function finalizeBudgetedReference(
	partial: AssistantMessage,
): AssistantMessage {
	return {
		...partial,
		content: structuredClone(partial.content),
		stopReason: "length",
	};
}

// Return a shallow clone of the model with OpenRouter provider routing merged into
// its `compat`. The registry hands out a SHARED model object, so this never mutates
// it in place (which would leak the routing to every other caller of that model);
// it clones and layers the routing on top of any existing compat. The provider only
// reads `compat.openRouterRouting` for OpenRouter-hosted models, so a non-openrouter
// model carries it harmlessly. The cast bridges pi-ai's conditional `compat` type
// (which varies by api) for this openrouter-shaped augmentation.
function withOpenRouterRouting(
	model: Model<Api>,
	routing: OpenRouterRouting,
): Model<Api> {
	return {
		...model,
		compat: { ...model.compat, openRouterRouting: routing },
	} as Model<Api>;
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

// The progressive counterpart to emitReferenceThinkingPrelude: instead of pushing
// the whole reference thinking block at once after the reference phase, it pushes
// the header immediately (before any reference finishes) and then one section per
// reference as each settles, so the block fills in live. Sections are revealed in
// slot order (a reference that finishes ahead of an earlier slot is buffered until
// that slot reveals) so the streamed order matches the atomic block, and the
// accumulated text is byte-identical to buildReferenceThinkingText. The events are
// display-only — the outer stream's result() is fixed by the aggregator's later
// `done` event — so this never affects the persisted message or model context.
export function beginProgressiveReferenceThinking(
	outerStream: AssistantMessageEventStream,
	model: Model<Api>,
	preset: MoAPreset,
	referenceCount: number,
): {
	reveal: (index: number, output: ReferenceOutput) => void;
	finish: (fullText: string) => void;
} {
	const base = (): Omit<AssistantMessage, "content"> => ({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const thinkingPartial = (thinking: string): AssistantMessage => ({
		...base(),
		content: [{ type: "thinking", thinking }],
	});

	const header = buildReferenceThinkingHeader(preset, referenceCount);
	let accumulated = header;
	const settled: Array<ReferenceOutput | undefined> = new Array(referenceCount);
	let revealPointer = 0;

	outerStream.push({ type: "start", partial: { ...base(), content: [] } });
	outerStream.push({
		type: "thinking_start",
		contentIndex: 0,
		partial: thinkingPartial(""),
	});
	outerStream.push({
		type: "thinking_delta",
		contentIndex: 0,
		delta: header,
		partial: thinkingPartial(accumulated),
	});

	return {
		reveal(index, output) {
			settled[index] = output;
			while (
				revealPointer < settled.length &&
				settled[revealPointer] !== undefined
			) {
				const section = buildReferenceThinkingSection(
					preset,
					revealPointer,
					settled[revealPointer] as ReferenceOutput,
				);
				const delta = `\n\n${section}`;
				accumulated += delta;
				outerStream.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta,
					partial: thinkingPartial(accumulated),
				});
				revealPointer += 1;
			}
		},
		finish(fullText) {
			outerStream.push({
				type: "thinking_end",
				contentIndex: 0,
				content: fullText,
				partial: thinkingPartial(fullText),
			});
		},
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
