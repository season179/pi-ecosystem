import type { Skeleton } from "../engine/skeleton.js";
import type { Candidate, CandidateScores } from "../engine/types.js";
import { ScoringError, type Scorer, type ScoringFailureReason } from "./client.js";
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
	/** Reason of the first failure, if any request failed. */
	failure?: ScoringFailureReason;
	/** Candidates left unscored because their questions cannot fit a request. */
	unbatched: string[];
}

/**
 * Score candidates in bounded, concurrent batches sharing one state. A failing batch
 * leaves its candidates unscored (kept) and stops further batches; successful batches
 * still count. The pass never exceeds `deadlineMs` and honours the caller's signal.
 */
export async function runScoring(input: ScoringRunInput): Promise<ScoringRunResult> {
	const started = Date.now();
	const plan = planBatches(input.candidates, input.skeleton.tokens, input.maxRequestTokens, input.maxCandidatesPerBatch);
	const scores = new Map<string, CandidateScores>();
	const result: ScoringRunResult = {
		scores,
		requests: 0,
		failedRequests: 0,
		latencyMs: 0,
		unbatched: plan.unbatched.map((candidate) => candidate.toolCallId),
	};
	if (plan.batches.length === 0) {
		result.latencyMs = Date.now() - started;
		return result;
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) controller.abort();
	const deadline = setTimeout(() => controller.abort(), input.deadlineMs);
	let next = 0;
	let stopped = false;
	const worker = async (): Promise<void> => {
		while (!stopped && next < plan.batches.length) {
			const batch = plan.batches[next++];
			result.requests++;
			try {
				const answers = await input.scorer.score(input.skeleton.state, batch.questions, {
					signal: controller.signal,
					timeoutMs: input.timeoutMs,
				});
				for (const candidate of batch.candidates) {
					scores.set(candidate.toolCallId, {
						keepCall: answers[callQuestionKey(candidate)],
						keepResult: answers[resultQuestionKey(candidate)],
					});
				}
			} catch (error) {
				result.failedRequests++;
				stopped = true;
				if (!result.failure) {
					result.failure = error instanceof ScoringError ? error.reason : "error";
					if (input.signal?.aborted) result.failure = "cancelled";
					else if (controller.signal.aborted) result.failure = "timeout";
				}
			}
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency, plan.batches.length)) }, worker));
	} finally {
		clearTimeout(deadline);
		input.signal?.removeEventListener("abort", onAbort);
	}
	result.latencyMs = Date.now() - started;
	return result;
}
