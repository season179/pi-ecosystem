import type { Skeleton } from "../engine/skeleton.js";
import type { Candidate, CandidateScores } from "../engine/types.js";
import { abortable, ScoringError, type Scorer, type ScoringFailureReason, type ScoringRequestMetric } from "./client.js";
import { callQuestionKey, planBatches, resultQuestionKey } from "./questions.js";

export interface ScoringRunInput {
	skeleton: Skeleton;
	candidates: readonly Candidate[];
	scorer: Scorer;
	maxRequestTokens: number;
	maxCandidatesPerBatch: number;
	concurrency: number;
	/** Per-request timeout. */
	timeoutMs: number;
	/** Total wall-clock budget for the whole pass. */
	deadlineMs: number;
	signal?: AbortSignal;
}

export interface ScoringRunResult {
	scores: Map<string, CandidateScores>;
	requests: number;
	failedRequests: number;
	latencyMs: number;
	/** Measured attempts; legacy scorers fall back to one metric per score call. */
	requestMetrics: ScoringRequestMetric[];
	/** First terminal batch failure, if any; recovered retry failures remain in metrics. */
	failure?: ScoringFailureReason;
	/** Candidates left unscored because their questions cannot fit a request. */
	unbatched: string[];
}

/**
 * Bounded concurrent batches sharing one state. Failed batches stay unscored (kept)
 * and stop new batches; already completed batches survive. Cancellation/deadlines
 * settle independently of the scorer, and late answers/metrics cannot mutate results.
 */
export async function runScoring(input: ScoringRunInput): Promise<ScoringRunResult> {
	const started = performance.now();
	const expires = started + input.deadlineMs;
	const plan = planBatches(input.candidates, input.skeleton.tokens, input.maxRequestTokens, input.maxCandidatesPerBatch);
	const result: ScoringRunResult = {
		scores: new Map(), requests: 0, failedRequests: 0, latencyMs: 0,
		requestMetrics: [], unbatched: plan.unbatched.map((candidate) => candidate.toolCallId),
	};
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) controller.abort();
	const deadline = setTimeout(() => controller.abort(), Math.max(0, expires - performance.now()));
	const passFailure = (): ScoringFailureReason | undefined => input.signal?.aborted ? "cancelled"
		: controller.signal.aborted || performance.now() >= expires ? "timeout" : undefined;
	const addMetric = (metric: ScoringRequestMetric) => {
		result.requestMetrics.push(metric);
		result.requests++;
		if (metric.outcome === "failed") result.failedRequests++;
	};
	let next = 0;
	let stopped = false;
	const worker = async (): Promise<void> => {
		while (!stopped && next < plan.batches.length) {
			const before = passFailure();
			if (before) { result.failure ??= before; stopped = true; break; }
			const batch = plan.batches[next++];
			const requestStarted = performance.now();
			const requestExpires = requestStarted + input.timeoutMs;
			const requestController = new AbortController();
			const abortRequest = () => requestController.abort();
			controller.signal.addEventListener("abort", abortRequest, { once: true });
			const timeout = setTimeout(abortRequest, Math.max(0, input.timeoutMs));
			const failure = () => passFailure() ?? (requestController.signal.aborted || performance.now() >= requestExpires ? "timeout" : undefined);
			const aborted = () => new ScoringError(failure() ?? "cancelled", "scoring request interrupted");
			let active = true;
			let metrics = 0;
			let attemptStarted: number | undefined;
			try {
				const answers = await abortable(input.scorer.score(input.skeleton.state, batch.questions, {
					signal: requestController.signal,
					timeoutMs: Math.min(input.timeoutMs, Math.max(1, expires - performance.now())),
					onRequestStart: () => {
						if (active && !failure()) attemptStarted = performance.now();
					},
					onRequestMetric: (metric) => {
						if (!active || failure()) return;
						addMetric({ ...metric, ...(metric.usage ? { usage: { ...metric.usage } } : {}) });
						attemptStarted = undefined;
						metrics++;
					},
				}), requestController.signal, aborted);
				if (failure()) throw aborted();
				const scored = batch.candidates.map((candidate) => {
					const keepCall = answers[callQuestionKey(candidate)];
					const keepResult = answers[resultQuestionKey(candidate)];
					if (![keepCall, keepResult].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
						throw new ScoringError("invalid_response", "missing or invalid scoring answer");
					}
					return [candidate.toolCallId, { keepCall, keepResult }] as const;
				});
				if (failure()) throw aborted();
				for (const [id, scores] of scored) result.scores.set(id, scores);
				if (!metrics) addMetric({ latencyMs: performance.now() - requestStarted, outcome: "completed" });
			} catch (error) {
				const reason = failure() ?? (error instanceof ScoringError ? error.reason : "error");
				stopped = true;
				result.failure ??= reason;
				// A transport may be in flight, or a legacy scorer may ignore the signal.
				// During SDK backoff there is no pending HTTP attempt to invent a metric for.
				if (attemptStarted !== undefined || metrics === 0) {
					addMetric({ latencyMs: performance.now() - (attemptStarted ?? requestStarted), outcome: "failed", failure: reason });
				}
			} finally {
				active = false;
				clearTimeout(timeout);
				controller.signal.removeEventListener("abort", abortRequest);
				requestController.abort();
			}
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency, plan.batches.length)) }, worker));
	} finally {
		clearTimeout(deadline);
		input.signal?.removeEventListener("abort", onAbort);
	}
	result.latencyMs = performance.now() - started;
	return result;
}
