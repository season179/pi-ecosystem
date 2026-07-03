import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type CacheRetention,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OpenRouterRouting,
	type SimpleStreamOptions,
	type ThinkingContent,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
// streamSimple moved to the compat entrypoint in pi-ai 0.80.x; pi's runtime
// aliases both specifiers to compat, so this is purely a type-resolution fix.
import { streamSimple } from "@earendil-works/pi-ai/compat";
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
import {
	type AggregatorTimer,
	createTurnTelemetry,
	type ReferenceTimer,
	type TurnTelemetry,
} from "./telemetry.js";
import {
	createReferenceTools,
	executeReferenceToolCall,
	type ReferenceTool,
} from "./reference-tools.js";
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

// Aggregator models observed to reject a *trailing* user turn placed after
// tool results (a role-alternation error) during this process, keyed by
// "provider/model". Whether that sequence is accepted is a stable property of the
// serving API — not a transient failure — so caching it process-wide is correct:
// once a model rejects the cache-friendly "trailing-message" placement we skip
// that doomed attempt on every later turn and go straight to the always-valid
// system-prompt fallback. Keyed per model (not per provider) because a gateway
// like OpenRouter fronts many upstream APIs with different alternation rules —
// one strict model must not disable the trailing attempt for every other model
// on the same gateway. This bounds the wasted-request cost of trailing-message
// on a strict model to one failed request per process instead of one on every
// tool-loop turn. It stays empty (so behavior is byte-identical) unless the opt-in
// trailing-message placement is used against a model that rejects the trailing
// turn; the default "latest-user" placement never attempts a trailing turn and so
// never touches this cache.
const trailingPlacementUnsupported = new Set<string>();

// Test-only hook: clears the process-wide trailing-placement rejection cache so
// tests that exercise the memoization can start from a known-empty state.
export function __resetTrailingPlacementCacheForTests(): void {
	trailingPlacementUnsupported.clear();
}

// Reference guidance cached per synthetic MoA model for the "user-turn"
// reference cadence: the outputs computed on a fresh user turn are reused by
// that turn's subsequent tool-loop turns instead of re-running the whole
// reference phase. Validity is anchored to the identity of the latest user
// message (position + timestamp in the guidance-stripped transcript), so a new
// user message — or a different conversation hitting the same preset in this
// process — misses the cache and recomputes. Stays empty (byte-identical
// behavior) unless a preset opts into referenceCadence: "user-turn".
const referenceGuidanceCache = new Map<
	string,
	{ userTurnKey: string; outputs: ReferenceOutput[] }
>();

// Test-only hook: clears the process-wide reference-guidance cache.
export function __resetReferenceGuidanceCacheForTests(): void {
	referenceGuidanceCache.clear();
}

function latestUserTurnKey(context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role === "user") {
			return `${index}:${message.timestamp}`;
		}
	}
	return undefined;
}

function contextEndsOnUserTurn(context: Context): boolean {
	const last = context.messages[context.messages.length - 1];
	return last?.role === "user";
}

// How long the real aggregator request will wait for a still-running pre-warm
// before proceeding cold. A warm-up this close to finishing is worth a beat
// (its committed cache write saves the real request's whole prefill); anything
// slower would ADD unbounded latency for the same bounded benefit.
const PREWARM_MAX_WAIT_MS = 250;

async function settlesWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
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
	let telemetry: TurnTelemetry | undefined;

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
		telemetry = createTurnTelemetry(
			config.telemetryPath,
			presetName,
			config.telemetryMaxBytes,
		);

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

		// Steer the aggregator's request to a faster upstream backend. OpenRouter fronts
		// several upstream providers per model and, by default, balances routing (weighted
		// by price/uptime) — which can land the aggregator on a slow backend. The
		// aggregator's generation is the dominant, UN-bounded per-turn cost (unlike
		// references, which quorum/timeout/output caps already bound), so pinning it to a
		// faster backend is the most direct latency lever left. The routing rides on the
		// model's `compat.openRouterRouting` (not the stream options: `sort: "throughput"`
		// = fastest tokens/sec, `sort: "latency"` = lowest TTFT, preferred_min_throughput /
		// preferred_max_latency = explicit floors/ceilings) and pi-ai applies it ONLY when
		// the model's baseUrl points at openrouter.ai, so it is a safe no-op elsewhere.
		// Aggregator-scoped (references keep their own routing) and unset by default. Kept
		// opt-in — not shipped in the default preset — because a different backend can
		// differ in quantization or behavior and so could subtly shift the answer, unlike a
		// pure cache/TTL hint. Computed up here (before auth/references) so the optional
		// prompt-cache pre-warm below hits the exact same routed backend as the real
		// aggregator request.
		const aggregatorStreamModel = withProviderRouting(
			aggregatorModel,
			preset.aggregatorProviderRouting,
		);

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
		void aggregatorAuthPromise.then(() =>
			telemetry?.markAggregatorAuthResolved(),
		);
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

		// Optionally pre-warm the aggregator's prompt cache DURING the reference phase.
		// The aggregator re-prefills its whole context every turn, and that prefill
		// currently runs entirely AFTER the references finish (the aggregator needs the
		// reference guidance to build its request) — it sits, un-overlapped, on the head
		// of the aggregator's generation. This fires a best-effort throwaway request to
		// the aggregator over the guidance-free transcript prefix — the exact byte-stable
		// prefix the real request shares (system prompt + tools + prior turns; only the
		// appended guidance differs) — so the provider prefills and writes its prompt
		// cache while the references are still streaming. When the real aggregator
		// request fires after the reference phase it reads that warm cache instead of
		// re-prefilling from cold, cutting its time-to-first-token. This is the one
		// structural lever that hides aggregator prefill latency under the reference
		// phase rather than shrinking either phase. It composes with (and is most
		// effective alongside) trailing-message placement + long cache retention, which
		// keep the shared prefix byte-stable and the warm cache alive. Opt-in and unset
		// by default: no warming request fires, so the turn is byte-identical. Kept
		// opt-in because the warming request costs an extra prefill (a prompt-cache
		// write) and only pays off on caching providers (the default openrouter/anthropic
		// aggregator is one).
		let prewarmPromise: Promise<void> | undefined;
		let cancelPrewarm: (() => void) | undefined;
		if (preset.aggregatorPrewarm === true) {
			// Give the pre-warm its own abort handle (still linked to the caller's
			// signal) so the bounded wait below can cancel a straggling warm-up when
			// the turn proceeds cold, instead of leaving it streaming in the background.
			const { controller, dispose } = linkAbortController(options?.signal);
			cancelPrewarm = () => controller.abort();
			telemetry?.markPrewarmStart();
			prewarmPromise = prewarmAggregatorCache(
				aggregatorStreamModel,
				strippedContext,
				{ ...(options ?? {}), signal: controller.signal },
				aggregatorAuthPromise,
				preset.aggregatorCacheRetention,
			).finally(() => {
				dispose();
				telemetry?.markPrewarmSettled();
			});
		}

		// Reference cadence: in an agentic tool loop MoA re-runs the whole reference
		// phase on EVERY model turn, but new strategic input mostly arrives at
		// user-turn boundaries — the tool-loop turns in between re-derive
		// near-identical advice at full reference latency. With referenceCadence:
		// "user-turn", references run only when the transcript ends on a fresh user
		// message; tool-loop turns (transcript ends on an assistant/tool message)
		// reuse the guidance computed for the SAME user turn, taking the entire
		// reference phase off those turns' critical path. Validity is anchored to the
		// latest user message's identity, so a new user message — or a different
		// conversation on the same preset — always recomputes. Opt-in and unset by
		// default: references run every turn exactly as before. The up-front
		// reference-auth prefetch still fires on reused turns (it is launched before
		// the cadence decision is knowable); that is one cached-token round-trip per
		// reference, not a reference request.
		const guidanceCacheKey = `${model.provider}/${model.id}`;
		const latestUserKey = latestUserTurnKey(strippedContext);
		const cachedGuidance =
			preset.referenceCadence === "user-turn"
				? referenceGuidanceCache.get(guidanceCacheKey)
				: undefined;
		const reuseGuidance =
			cachedGuidance !== undefined &&
			latestUserKey !== undefined &&
			cachedGuidance.userTurnKey === latestUserKey &&
			!contextEndsOnUserTurn(strippedContext);
		telemetry?.setGuidanceReused(reuseGuidance);

		let referenceOutputs: ReferenceOutput[];
		let progressiveReferenceStream:
			| ReturnType<typeof beginProgressiveReferenceThinking>
			| undefined;
		if (reuseGuidance) {
			referenceOutputs = cachedGuidance.outputs;
		} else {
			const renderStart = performance.now();
			const referenceContext = renderReferenceContext(strippedContext, preset);
			telemetry?.setRenderMs(performance.now() - renderStart);

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
			progressiveReferenceStream = useProgressiveReferenceStream
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
				telemetry,
			});
			referenceOutputs = mergeReferenceOutputs(
				preset,
				prefilledOutputs,
				resolvedReferenceOutputs,
			);
			if (
				preset.referenceCadence === "user-turn" &&
				latestUserKey !== undefined
			) {
				referenceGuidanceCache.set(guidanceCacheKey, {
					userTurnKey: latestUserKey,
					outputs: referenceOutputs,
				});
			}
		}
		telemetry?.markReferencePhaseDone();

		if (options?.signal?.aborted) {
			telemetry?.setOutcome("aborted");
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
		// A few strict APIs reject a trailing user turn after tool results. That is a
		// stable property of the model's serving API, so once we have seen it we skip
		// the doomed trailing attempt on later turns (see trailingPlacementUnsupported)
		// and go straight to the system-prompt placement, which touches no message
		// roles — turning trailing-message's worst case on a strict model from a
		// wasted request every tool-loop turn into one wasted request per process.
		const aggregatorProviderKey = `${preset.aggregator.provider}/${preset.aggregator.model}`;
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
			telemetry?.setPlacement("trailing-message");
			telemetry?.setGuidanceChars(guidanceBlock.length);
		} else if (wantsTrailing) {
			// Trailing requested, but this provider already rejected it this process:
			// skip straight to the always-valid system-prompt placement.
			primaryContext = injectGuidanceAsSystem(strippedContext, guidanceBlock);
			telemetry?.setPlacement("system");
			telemetry?.setGuidanceChars(guidanceBlock.length);
		} else {
			primaryContext = appendGuidanceToLatestUser(strippedContext, guidanceBlock);
			telemetry?.setPlacement("latest-user");
			telemetry?.setGuidanceChars(guidanceBlock.length);
		}
		// Give the pre-warm (fired at the top of the turn, overlapping the reference
		// phase) a short grace to settle before the real aggregator request reads its
		// cache. When the references dominated the wall-clock it settled long ago and
		// this waits ~0ms — the common case. But the warm-up is a FULL aggregator
		// prefill, so with fast references, a huge transcript, or a stalled provider
		// it can still be mid-flight here, and waiting for it would add unbounded
		// latency for a benefit that at best saves one prefill. After the grace the
		// turn proceeds cold and cancels the straggling warm-up (stopping its
		// background cost) rather than paying an unbounded wait.
		if (prewarmPromise) {
			const waitStart = performance.now();
			const settled = await settlesWithin(prewarmPromise, PREWARM_MAX_WAIT_MS);
			if (!settled) {
				cancelPrewarm?.();
			}
			telemetry?.setPrewarmWait(performance.now() - waitStart, !settled);
		}
		const streamIncremental = preset.streamAggregator === true;
		const primaryResult = await forwardAggregatorStream({
			model: aggregatorStreamModel,
			context: primaryContext,
			options: aggregatorOptions,
			outerStream,
			referenceThinking,
			streamIncremental,
			timing: telemetry?.aggregatorTimer(),
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
			telemetry?.markTrailingFallback();
			telemetry?.setPlacement("system");
			const systemContext = injectGuidanceAsSystem(
				strippedContext,
				guidanceBlock,
			);
			telemetry?.setGuidanceChars(guidanceBlock.length);
			const systemResult = await forwardAggregatorStream({
				model: aggregatorStreamModel,
				context: systemContext,
				options: aggregatorOptions,
				outerStream,
				referenceThinking,
				streamIncremental,
				timing: telemetry?.aggregatorTimer(),
			});
			if (systemResult.kind === "error") {
				telemetry?.setOutcome("error");
				outerStream.end(systemResult.error);
				return;
			}
			if (systemResult.kind === "consecutive-user-rejected") {
				telemetry?.setOutcome("error");
				pushFatalError(
					outerStream,
					model,
					"MoA aggregator rejected guidance in both tail-user and system placements",
					"error",
				);
				return;
			}
		} else if (primaryResult.kind === "error") {
			telemetry?.setOutcome("error");
			outerStream.end(primaryResult.error);
			return;
		}
		outerStream.end();
	})()
		.catch((error: unknown) => {
			telemetry?.setOutcome("error");
			pushFatalError(
				outerStream,
				model,
				redactErrorMessage(errorToString(error)),
				"error",
			);
		})
		.finally(() => telemetry?.emit());

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
	timing?: AggregatorTimer;
}): Promise<AggregatorForwardResult> {
	args.timing?.requestStart();
	const innerStream = streamSimple(args.model, args.context, args.options);
	let isFirstEvent = true;
	let sawFirstContent = false;

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
			args.timing?.done(event.message.usage);
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
		if (event.type === "start") {
			args.timing?.headers();
		} else if (!sawFirstContent) {
			sawFirstContent = true;
			args.timing?.firstToken();
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
	telemetry?: TurnTelemetry;
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
	const { controller: phaseController, dispose: unlinkAbort } =
		linkAbortController(parentSignal);
	const phaseOptions: SimpleStreamOptions = {
		...(args.options ?? {}),
		signal: phaseController.signal,
	};

	// Created only when a quorum can resolve the phase early; the default
	// (quorum-off) path just awaits every reference and never consumes it.
	let onQuorumMet: (() => void) | undefined;
	const quorumMet =
		quorum !== undefined
			? new Promise<void>((resolve) => {
					onQuorumMet = resolve;
				})
			: undefined;

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
				referenceTimer: args.telemetry?.referenceTimer(index, task.slot),
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
		if (quorumMet === undefined) {
			await allSettled;
		} else {
			// The abandoned workers may reject later (a superseded reference throwing
			// under failOnReferenceError); swallow it so it never surfaces as an
			// unhandled rejection once the quorum has already resolved the phase.
			allSettled.catch(() => {});
			await Promise.race([allSettled, quorumMet]);
		}
	} finally {
		unlinkAbort();
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
	referenceTimer?: ReferenceTimer;
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
		const referenceOptions = buildSubRequestOptions(
			args.options,
			auth,
			args.options?.signal,
		);
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
		//
		// Applied ONLY when no reasoning effort is in play for this reference. On
		// completions-style APIs (the default openrouter fleet, where OpenRouter
		// derives the Anthropic thinking budget as a fraction of max_tokens with a
		// 1024-token provider minimum) thinking tokens share the max_tokens budget,
		// so a small cap on a thinking reference can get the request rejected
		// outright or let thinking starve the kept advice text — turning a pure
		// cost bound into a failure mode. A thinking reference is instead bounded
		// by the stream-level abort above (which stops it at the kept text budget)
		// and, optionally, referenceReasoning/referenceTimeoutMs.
		if (
			typeof args.preset.referenceMaxTokens === "number" &&
			referenceOptions.reasoning === undefined
		) {
			referenceOptions.maxTokens =
				referenceOptions.maxTokens !== undefined
					? Math.min(referenceOptions.maxTokens, args.preset.referenceMaxTokens)
					: args.preset.referenceMaxTokens;
		}
		// Bound the client-side retry attempts for this reference's request. The
		// underlying SDK retries transient errors (429/5xx) with exponential backoff —
		// two attempts by default — and each retry, plus any server-requested
		// Retry-After wait, sits on the aggregator-blocking critical path: the
		// aggregator cannot start until the slowest (or quorum-th) reference settles,
		// so a rate-limited reference silently retrying can add seconds of backoff to
		// the whole turn. References are advisory and failure-tolerant (a failed one
		// simply drops out of the guidance rather than failing the turn, unless
		// failOnReferenceError is set), so capping their retries lets a transient-error
		// reference give up fast and let the phase move on with whatever succeeded —
		// bounding a worst-case latency source the length/time/quorum caps don't touch
		// (they bound generation and wall-clock; this bounds the retry-backoff before
		// the stream even opens). This is deliberately reference-only: the aggregator
		// produces the final answer, so failing it faster on a transient error would be
		// a robustness regression rather than a speed win. Opt-in and unset by default,
		// so references keep the caller/SDK retry behavior exactly as before; a preset
		// that sets it (e.g. 0 or 1) trades a little reference resilience for a bounded
		// tail. maxRetries is forwarded to the SDK client by pi-ai's openai-completions
		// provider (the default openrouter fleet) and ignored by providers that don't
		// support client-side retries.
		if (typeof args.preset.referenceMaxRetries === "number") {
			referenceOptions.maxRetries = args.preset.referenceMaxRetries;
		}
		// Ask each reference's provider to keep its prompt cache alive for the
		// configured retention — the reference-side mirror of aggregatorCacheRetention.
		// A reference is a single provider call *per MoA turn*, but MoA is re-invoked on
		// every turn of an agentic tool loop, and each turn re-runs the references over
		// the SAME transcript grown append-only (prior MoA guidance is stripped back out,
		// so the reference's rendered view stays a byte-stable growing prefix). So — like
		// the aggregator — a reference re-prefills that shared prefix every turn, and
		// prompt caching avoids it only while the cache lives. The provider default
		// ("short", ~5min on Anthropic) expires when a tool run or review pause between
		// turns exceeds it, forcing the reference to re-prefill the whole prefix from cold
		// on the aggregator-blocking critical path. "long" survives those gaps so the next
		// turn's reference stays a cache hit (lower reference TTFT → shorter reference
		// phase). Set AFTER the caller-options spread so a preset governs reference
		// retention independent of the caller AND of aggregatorCacheRetention — completing
		// the role-scoped retention matrix (previously only the aggregator was tunable).
		// It is a pure cache-TTL hint, so the reference advice (and thus the persisted
		// answer) is byte-identical regardless. Unset by default, so references inherit the
		// caller/provider retention exactly as before. Kept opt-in — not shipped in the
		// default preset — because references are smaller/cheaper prefillers than the
		// aggregator, so the pricier long-cache WRITE only pays off when reference turn
		// gaps routinely exceed the short TTL; a non-caching reference provider ignores it.
		if (args.preset.referenceCacheRetention !== undefined) {
			referenceOptions.cacheRetention = args.preset.referenceCacheRetention;
		}
		// Steer this reference's request to a faster upstream backend, mirroring the
		// aggregator's routing knob on the reference side. References sit on the
		// aggregator-blocking critical path — the aggregator waits for the slowest (or
		// the quorum-th fastest) reference — so pinning them to a faster OpenRouter
		// backend (`sort: "latency"` / `"throughput"`) directly shortens that phase.
		// Routing lives on the model's `compat` (not the stream options), so clone the
		// model rather than mutate the shared registry object; pi-ai applies it only
		// for openrouter.ai models, so it is a safe no-op elsewhere. Opt-in and unset
		// by default; kept opt-in (not shipped in the default preset) because a
		// different backend can differ in quantization/behavior and so could subtly
		// shift the reference advice that feeds the aggregator's persisted answer.
		const referenceStreamModel = withProviderRouting(
			args.task.model,
			args.preset.referenceProviderRouting,
		);
		const message =
			args.preset.referenceTools === undefined
				? await streamReferenceUntilBudget(
						referenceStreamModel,
						args.refContext,
						referenceOptions,
						getMaxReferenceOutputChars(args.preset),
						args.preset.referenceTimeoutMs,
						args.referenceTimer,
					)
				: await runAgenticReference({
						preset: args.preset,
						model: referenceStreamModel,
						refContext: args.refContext,
						referenceOptions,
						referenceTimer: args.referenceTimer,
					});
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
		const text = extractAssistantText(message);
		args.referenceTimer?.settle({
			stop: message.stopReason,
			keptChars: text.length,
			usage: message.usage,
		});
		return {
			slot: args.task.slot,
			success: true,
			text,
			usage: message.usage,
		};
	} catch (error) {
		// Distinguish our own cancellation from a genuine upstream failure: the
		// phase signal fires when a reached quorum supersedes this reference (or
		// the whole turn is aborted), and that cancellation used to be recorded as
		// "error" — indistinguishable in the timings from a provider that is
		// actually failing. Label it "aborted" so "error" keeps meaning unhealthy.
		args.referenceTimer?.settle({
			stop: args.options?.signal?.aborted ? "aborted" : "error",
		});
		const output = failedReferenceOutput(args.task.slot, errorToString(error));
		if (args.preset.failOnReferenceError) {
			throw new Error(output.errorMessage);
		}
		return output;
	}
}

interface AgenticReferenceArgs {
	preset: MoAPreset;
	model: Model<Api>;
	refContext: Context;
	referenceOptions: SimpleStreamOptions;
	referenceTimer?: ReferenceTimer;
}

async function runAgenticReference(args: AgenticReferenceArgs): Promise<AssistantMessage> {
	const toolNames = args.preset.referenceTools;
	if (toolNames === undefined) {
		throw new Error("Agentic reference loop requires referenceTools");
	}
	const referenceTools = createReferenceTools(toolNames, process.cwd());
	const maxToolRounds = args.preset.referenceToolRounds ?? 3;
	const keptOutputChars = getMaxReferenceOutputChars(args.preset);
	const { controller, dispose: unlinkAbort } = linkAbortController(
		args.referenceOptions.signal,
	);
	const loopOptions: SimpleStreamOptions = {
		...args.referenceOptions,
		signal: controller.signal,
	};
	let messages = args.refContext.messages.slice();
	let round = 0;
	let forceFinal = false;
	let finalAdviceStarted = false;
	let latestFinalPartial: AssistantMessage | undefined;
	let latestFinalUsageRound: number | undefined;

	const runLoop = async (): Promise<AssistantMessage> => {
		for (;;) {
			round += 1;
			args.referenceTimer?.setRounds(round);
			const toolsForRound = forceFinal ? undefined : referenceTools;
			const finalRound = toolsForRound === undefined;
			const roundContext = buildAgenticRoundContext(
				args.refContext,
				messages,
				toolsForRound,
			);
			const message = await streamAgenticReferenceRound({
				model: args.model,
				context: roundContext,
				options: loopOptions,
				controller,
				referenceTimer: args.referenceTimer,
				keptOutputChars: finalRound ? keptOutputChars : undefined,
				onFinalText: (partial) => {
					finalAdviceStarted = true;
					latestFinalPartial = partial;
					latestFinalUsageRound = round;
				},
			});
			args.referenceTimer?.recordRoundUsage({ round, usage: message.usage });
			messages = [...messages, message];
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(
					message.errorMessage ?? `Reference stopped with ${message.stopReason}`,
				);
			}
			const toolCalls = extractToolCalls(message);
			if (
				toolsForRound !== undefined &&
				message.stopReason === "toolUse" &&
				toolCalls.length > 0
			) {
				const toolResults = await executeReferenceToolCalls(
					referenceTools,
					toolCalls,
					round,
					controller.signal,
					args.referenceTimer,
				);
				messages = [...messages, ...toolResults];
				if (round >= maxToolRounds) {
					forceFinal = true;
				}
				continue;
			}
			const text = extractAssistantText(message);
			if (text.length === 0) {
				throw new Error("Reference produced no final advice text");
			}
			return message;
		}
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (args.preset.referenceTimeoutMs === undefined) {
			return await runLoop();
		}
		const loopPromise = runLoop();
		loopPromise.catch(() => {});
		const deadline = new Promise<AssistantMessage>((resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				if (finalAdviceStarted && latestFinalPartial) {
					if (latestFinalUsageRound !== undefined) {
						args.referenceTimer?.recordRoundUsage({
							round: latestFinalUsageRound,
							usage: latestFinalPartial.usage,
						});
					}
					resolve(finalizeBudgetedReference(latestFinalPartial));
					return;
				}
				reject(
					new Error(
						`Reference exceeded referenceTimeoutMs (${args.preset.referenceTimeoutMs}ms) before producing final advice`,
					),
				);
			}, args.preset.referenceTimeoutMs);
		});
		return await Promise.race([loopPromise, deadline]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		unlinkAbort();
	}
}

function buildAgenticRoundContext(
	base: Context,
	messages: Context["messages"],
	tools: ReferenceTool[] | undefined,
): Context {
	const context: Context = {
		systemPrompt: base.systemPrompt,
		messages,
	};
	if (tools !== undefined) {
		context.tools = tools;
	}
	return context;
}

async function executeReferenceToolCalls(
	referenceTools: readonly ReferenceTool[],
	toolCalls: readonly ToolCall[],
	round: number,
	signal: AbortSignal,
	referenceTimer: ReferenceTimer | undefined,
): Promise<ToolResultMessage[]> {
	const executed = await Promise.all(
		toolCalls.map((toolCall) =>
			executeReferenceToolCall(referenceTools, toolCall, signal),
		),
	);
	for (const result of executed) {
		if (result.telemetry) {
			referenceTimer?.recordToolCall({ round, ...result.telemetry });
		}
	}
	return executed.map((result) => result.message);
}

function extractToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter(
		(block): block is ToolCall => block.type === "toolCall",
	);
}

async function streamAgenticReferenceRound(args: {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions;
	controller: AbortController;
	referenceTimer?: ReferenceTimer;
	keptOutputChars?: number;
	onFinalText?: (partial: AssistantMessage) => void;
}): Promise<AssistantMessage> {
	let keptTextChars = 0;
	let budgetReached = false;
	let latestPartial: AssistantMessage | undefined;
	let sawFirstContent = false;

	args.referenceTimer?.requestStart();
	const stream = streamSimple(args.model, args.context, {
		...args.options,
		signal: args.controller.signal,
	});
	for await (const event of stream) {
		if (event.type === "done") {
			return event.message;
		}
		if (event.type === "error") {
			if (budgetReached && latestPartial) {
				return finalizeBudgetedReference(latestPartial);
			}
			throw new Error(
				event.error.errorMessage ??
					`Reference stopped with ${event.error.stopReason}`,
			);
		}
		if (event.type === "start") {
			args.referenceTimer?.headers();
		} else if (!sawFirstContent) {
			sawFirstContent = true;
			args.referenceTimer?.firstToken();
		}
		latestPartial = event.partial;
		if (event.type === "text_delta" && args.keptOutputChars !== undefined) {
			keptTextChars += event.delta.length;
			args.onFinalText?.(latestPartial);
			if (!budgetReached && keptTextChars >= args.keptOutputChars) {
				budgetReached = true;
				args.controller.abort();
				return finalizeBudgetedReference(latestPartial);
			}
		}
	}
	if (latestPartial) {
		return latestPartial;
	}
	throw new Error("Reference produced no output before the stream ended");
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
	referenceTimer?: ReferenceTimer,
): Promise<AssistantMessage> {
	const { controller, dispose: unlinkAbort } = linkAbortController(
		referenceOptions.signal,
	);

	let keptTextChars = 0;
	let sawToolCall = false;
	let budgetReached = false;
	let deadlineReached = false;
	let latestPartial: AssistantMessage | undefined;

	// Consume the reference stream to its budget/abort. Shares the mutable state
	// above with the deadline timer (single-threaded, so no data race) so a
	// timeout can surface the partial advice produced up to that point.
	let sawFirstContent = false;
	const consume = async (): Promise<AssistantMessage> => {
		referenceTimer?.requestStart();
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
			if (event.type === "start") {
				referenceTimer?.headers();
			} else if (!sawFirstContent) {
				sawFirstContent = true;
				referenceTimer?.firstToken();
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
		unlinkAbort();
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
// (which varies by api) for this openrouter-shaped augmentation. When the knob is
// unset the model is returned untouched (no clone, no synthetic compat), so the
// request stays byte-identical.
function withProviderRouting(
	model: Model<Api>,
	routing: OpenRouterRouting | undefined,
): Model<Api> {
	if (routing === undefined) {
		return model;
	}
	return {
		...model,
		compat: { ...model.compat, openRouterRouting: routing },
	} as Model<Api>;
}

// Best-effort prompt-cache pre-warm for the aggregator, fired at the top of the
// turn so its prefill overlaps the reference phase. It sends the guidance-free
// transcript prefix — byte-identical to the prefix the real aggregator request
// will share (the real one only appends the reference guidance) — to the same
// (optionally routed) aggregator backend, prompting the provider to prefill and
// write its prompt cache. The real request, firing after the references settle,
// then reads that warm cache instead of prefilling from cold.
//
// It is deliberately cheap and side-effect-free:
//   - `onPayload`/`onResponse` are dropped (an `onResponse` here would fire the
//     acting agent's response hook on a throwaway ping; `onPayload` is dropped
//     symmetrically to avoid double-running a payload mutator).
//   - `reasoning` is pinned to "minimal" so a reasoning aggregator does not burn a
//     full thinking budget on the warm request; the prompt-cache prefix is keyed by
//     the message content, not the generation params, so this does not change what
//     the real request can read.
//   - The preset's aggregatorCacheRetention (when set) is applied to the warm request
//     too, so the warm cache write carries the same TTL the real request will ask for.
//   - The stream is aborted at the provider's first CONTENT event — not at `start`.
//     pi-ai pushes `start` as soon as the HTTP response HEADERS arrive, which for a
//     long context is typically while the provider is still prefilling; aborting
//     there could cancel the request before the prompt-cache write commits. The
//     first content event, by contrast, proves the prompt has been fully processed
//     (prefill + cache write precede the first token), so breaking there pays for
//     the cache write while generating essentially nothing.
//
// Any failure (auth, network, provider rejection, abort) is swallowed — the warm-up
// must never affect the real turn. Returns a promise that never rejects.
async function prewarmAggregatorCache(
	model: Model<Api>,
	strippedContext: Context,
	options: SimpleStreamOptions | undefined,
	authPromise: Promise<AuthResult>,
	cacheRetention: CacheRetention | undefined,
): Promise<void> {
	const parentSignal = options?.signal;
	if (parentSignal?.aborted) {
		return;
	}
	try {
		const auth = await authPromise;
		if (!auth.ok || parentSignal?.aborted) {
			return;
		}
		const { controller, dispose: unlinkAbort } =
			linkAbortController(parentSignal);
		try {
			const warmOptions: SimpleStreamOptions = {
				...buildSubRequestOptions(options, auth, controller.signal),
				reasoning: "minimal",
			};
			if (cacheRetention !== undefined) {
				warmOptions.cacheRetention = cacheRetention;
			}
			const stream = streamSimple(model, strippedContext, warmOptions);
			for await (const event of stream) {
				if (event.type === "error" || event.type === "done") {
					return;
				}
				if (event.type === "start") {
					// `start` fires when the HTTP response headers arrive — the provider
					// may still be prefilling. Keep consuming until a content event
					// proves the prompt (and its cache write) has been fully processed.
					continue;
				}
				// First content event: prefill + cache write are committed. Abort now to
				// avoid generating a real (billable, latency-adding) completion.
				controller.abort();
				return;
			}
		} finally {
			unlinkAbort();
		}
	} catch {
		// Best-effort: never let a warm-up failure surface on the real turn.
	}
}

// Create a child AbortController mirrored from a parent signal: an
// already-aborted parent aborts the child immediately, a later parent abort
// forwards to it, and the returned dispose (call it in a `finally`) removes the
// forwarding listener so the parent signal never accumulates dead listeners.
function linkAbortController(parentSignal: AbortSignal | undefined): {
	controller: AbortController;
	dispose: () => void;
} {
	const controller = new AbortController();
	if (parentSignal?.aborted) {
		controller.abort();
	}
	const forwardAbort = () => controller.abort();
	parentSignal?.addEventListener("abort", forwardAbort, { once: true });
	return {
		controller,
		dispose: () => parentSignal?.removeEventListener("abort", forwardAbort),
	};
}

// Build the options forwarded to a synthetic MoA sub-request (a reference or the
// aggregator pre-warm): drop the acting agent's payload-mutation hooks and inject
// the sub-request's own auth and abort signal. `onPayload` runs against the raw
// provider payload right before send and could inject tool schemas (the one path
// by which a tool-free sub-request could still receive tools); `onResponse` is an
// acting-agent concern that must not fire for advisory or throwaway requests.
function buildSubRequestOptions(
	options: SimpleStreamOptions | undefined,
	auth: Pick<SimpleStreamOptions, "apiKey" | "headers">,
	signal: AbortSignal | undefined,
): SimpleStreamOptions {
	const {
		onPayload: _onPayload,
		onResponse: _onResponse,
		...forwardableOptions
	} = options ?? {};
	return {
		...forwardableOptions,
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal,
	};
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

// Assistant-message shell for the synthetic events the orchestrator emits
// itself (the thinking preludes and the fatal-error path), so the three
// emitters stamp one shape instead of drifting copies.
function assistantPartial(
	model: Model<Api>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: Date.now(),
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
	const partial = (content: AssistantMessage["content"]): AssistantMessage =>
		assistantPartial(model, content);
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
	const thinkingPartial = (thinking: string): AssistantMessage =>
		assistantPartial(model, [{ type: "thinking", thinking }]);

	const header = buildReferenceThinkingHeader(preset, referenceCount);
	let accumulated = header;
	const settled: Array<ReferenceOutput | undefined> = new Array(referenceCount);
	let revealPointer = 0;

	outerStream.push({ type: "start", partial: assistantPartial(model, []) });
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
		...assistantPartial(model, [], stopReason),
		errorMessage,
	};
	stream.push({ type: "error", reason: stopReason, error: message });
	stream.end(message);
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
