import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCandidates } from "../src/engine/candidates.js";
import { buildSkeleton } from "../src/engine/skeleton.js";
import { MAX_SCORING_REQUEST_BYTES, ScoringError, TypeSafeScorer, validateAnswers, type Answers, type ScoreOptions, type Scorer } from "../src/scoring/client.js";
import { runScoring } from "../src/scoring/pass.js";
import { callQuestionKey, planBatches, questionsFor, resultQuestionKey } from "../src/scoring/questions.js";
import { singleTaskTranscript, withIds } from "./helpers/messages.js";

afterEach(() => vi.useRealTimers());

function fixture(groups = 12) {
	const entries = withIds(singleTaskTranscript(groups));
	const { candidates } = collectCandidates(entries, { protectRecentGroups: 2, pinned: new Set(), decided: new Set(), protectedTools: new Set() });
	const skeleton = buildSkeleton(entries, candidates, { maxStateTokens: 20_000 })!;
	return { entries, candidates, skeleton };
}

function fakeScorer(answer: (key: string) => number, options: { failOn?: number; delayMs?: number } = {}): Scorer & { calls: number } {
	const scorer = {
		configured: true,
		calls: 0,
		async score(_state: unknown, questions: Record<string, unknown>, opts: { signal?: AbortSignal }) {
			scorer.calls++;
			if (options.failOn === scorer.calls) throw new ScoringError("rate_limit", "429");
			if (options.delayMs) {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, options.delayMs);
					opts.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					});
				});
			}
			return Object.fromEntries(Object.keys(questions).map((key) => [key, answer(key)]));
		},
	};
	return scorer;
}

describe("questions", () => {
	it("judges result retention by upcoming usefulness, not irretrievability", () => {
		const { candidates } = fixture();
		const candidate = candidates[0];
		const question = questionsFor(candidate)[resultQuestionKey(candidate)];
		expect(question.type).toBe("noul");
		expect(question.instructions).toContain("should stay in the history verbatim");
		expect(question.instructions).toContain("assistant's next steps");
		expect(question.instructions).toContain("details remain necessary or are already captured elsewhere");
		expect(question.instructions).toContain("Being able to retrieve it again is not, by itself, a reason to remove it.");
		expect(question.instructions).toContain("When in doubt, answer yes.");
		expect(question.instructions).not.toContain("re-running the tool would not do");
	});

	it("asks two keep questions per candidate and plans batches within the request budget", () => {
		const { candidates } = fixture();
		const questions = questionsFor(candidates[0]);
		expect(Object.keys(questions)).toEqual([callQuestionKey(candidates[0]), resultQuestionKey(candidates[0])]);
		const plan = planBatches(candidates, 5_000, 5_400, 3);
		expect(plan.unbatched).toEqual([]);
		expect(plan.batches.length).toBeGreaterThan(1);
		expect(plan.batches.every((batch) => batch.candidates.length <= 3)).toBe(true);
		expect(planBatches(candidates, 5_000, 5_001, 3).unbatched).toHaveLength(candidates.length);
	});
});

describe("runScoring", () => {
	it("scores all candidates across batches", async () => {
		const { candidates, skeleton } = fixture();
		const scorer = fakeScorer((key) => (key.startsWith("call_") ? 0.9 : 0.1));
		const result = await runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 4, concurrency: 2, timeoutMs: 1_000, deadlineMs: 5_000 });
		expect(result.scores.size).toBe(candidates.length);
		expect(result.requests).toBe(Math.ceil(candidates.length / 4));
		expect(result.failure).toBeUndefined();
		expect(result.requestMetrics).toHaveLength(result.requests);
		expect(result.requestMetrics.every((metric) => metric.outcome === "completed" && metric.latencyMs >= 0 && metric.usage === undefined)).toBe(true);
		expect(result.scores.get(candidates[0].toolCallId)).toEqual({ keepCall: 0.9, keepResult: 0.1 });
	});

	it("keeps successful batches when one fails and reports the reason", async () => {
		const { candidates, skeleton } = fixture();
		const scorer = fakeScorer(() => 0.5, { failOn: 2 });
		const result = await runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 4, concurrency: 1, timeoutMs: 1_000, deadlineMs: 5_000 });
		expect(result.failure).toBe("rate_limit");
		expect(result.failedRequests).toBe(1);
		expect(result.requestMetrics.map(({ outcome, failure }) => ({ outcome, failure }))).toEqual([
			{ outcome: "completed", failure: undefined }, { outcome: "failed", failure: "rate_limit" },
		]);
		expect(result.scores.size).toBe(4);
	});

	it("stops at the deadline and leaves the rest unscored", async () => {
		const { candidates, skeleton } = fixture();
		const scorer = fakeScorer(() => 0.5, { delayMs: 500 });
		const result = await runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 2, concurrency: 1, timeoutMs: 1_000, deadlineMs: 50 });
		expect(result.scores.size).toBe(0);
		expect(result.failure).toBe("timeout");
	});

	it("measures individual concurrent request durations, not pass duration divided by count", async () => {
		vi.useFakeTimers();
		const { candidates, skeleton } = fixture();
		let calls = 0;
		const scorer: Scorer = { configured: true, async score(_state, questions) {
			await new Promise((resolve) => setTimeout(resolve, ++calls === 1 ? 100 : 300));
			return Object.fromEntries(Object.keys(questions).map((key) => [key, 0.5]));
		} };
		const pending = runScoring({ skeleton, candidates: candidates.slice(0, 2), scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 1, concurrency: 2, timeoutMs: 1000, deadlineMs: 5000 });
		await vi.advanceTimersByTimeAsync(300);
		const result = await pending;
		expect(result.latencyMs).toBe(300);
		expect(result.requestMetrics.map((metric) => metric.latencyMs)).toEqual([100, 300]);
		expect(result.scores.size).toBe(2);
	});

	it.each(["deadline", "timeout", "cancelled"] as const)("returns at %s even when a scorer ignores abort, rejecting all late changes", async (kind) => {
		vi.useFakeTimers();
		const { candidates, skeleton } = fixture();
		const controller = new AbortController();
		const pendingCalls: Array<{ options: ScoreOptions; questions: Record<string, unknown>; resolve: (answers: Answers) => void }> = [];
		const scorer: Scorer = { configured: true, score(_state, questions, options) {
			return new Promise((resolve) => pendingCalls.push({ options, questions, resolve }));
		} };
		const pending = runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 1, concurrency: 2, timeoutMs: kind === "timeout" ? 50 : 1000, deadlineMs: kind === "deadline" ? 50 : 5000, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(50);
		if (kind === "cancelled") controller.abort();
		const result = await pending;
		const reason = kind === "cancelled" ? "cancelled" : "timeout";
		expect(result).toMatchObject({ requests: 2, failedRequests: 2, latencyMs: 50, failure: reason });
		expect(result.scores.size).toBe(0);
		expect(result.requestMetrics).toEqual(Array.from({ length: 2 }, () => ({ outcome: "failed", failure: reason, latencyMs: 50 })));
		for (const call of pendingCalls) {
			expect(call.options.signal?.aborted).toBe(true);
			call.options.onRequestStart?.();
			call.options.onRequestMetric?.({ latencyMs: 999, outcome: "completed", usage: { inputTokens: 1, outputTokens: 1 } });
			call.resolve(Object.fromEntries(Object.keys(call.questions).map((key) => [key, 0])));
		}
		await vi.advanceTimersByTimeAsync(1000);
		expect(result.scores.size).toBe(0);
		expect(result.requestMetrics).toHaveLength(2);
		expect(result.requestMetrics.every((metric) => metric.outcome === "failed" && metric.usage === undefined)).toBe(true);
		expect(pendingCalls).toHaveLength(2);
	});

	it("handles late rejection without an unhandled promise", async () => {
		vi.useFakeTimers();
		const { candidates, skeleton } = fixture();
		let reject!: (error: Error) => void;
		const scorer: Scorer = { configured: true, score: () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }) };
		const pending = runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 2, concurrency: 1, timeoutMs: 1000, deadlineMs: 50 });
		await vi.advanceTimersByTimeAsync(50);
		const result = await pending;
		reject(new Error("late private failure"));
		await vi.advanceTimersByTimeAsync(0);
		expect(result.failure).toBe("timeout");
		expect(result.requestMetrics).toHaveLength(1);
	});

	it.each(["cancelled", "expired"])("does not start scoring when already %s", async (kind) => {
		const { candidates, skeleton } = fixture();
		const controller = new AbortController();
		if (kind === "cancelled") controller.abort();
		const scorer = fakeScorer(() => 0);
		const result = await runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 4, concurrency: 2, timeoutMs: 1000, deadlineMs: kind === "expired" ? 0 : 1000, signal: controller.signal });
		expect(scorer.calls).toBe(0);
		expect(result).toMatchObject({ requests: 0, failedRequests: 0, requestMetrics: [], failure: kind === "expired" ? "timeout" : "cancelled" });
	});

	it("keeps budget-failed candidates unscored without sending their body", async () => {
		const { candidates, skeleton } = fixture();
		skeleton.state.context = "x".repeat(MAX_SCORING_REQUEST_BYTES);
		const fetch = vi.fn(async () => new Response("{}"));
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch });
		const result = await runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 4, concurrency: 1, timeoutMs: 1000, deadlineMs: 5000 });
		expect(result.failure).toBe("budget");
		expect(result.scores.size).toBe(0);
		expect(result.requestMetrics[0]).toMatchObject({ outcome: "failed", failure: "budget" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects invalid custom scorer answers atomically for the batch", async () => {
		const { candidates, skeleton } = fixture();
		const scorer = fakeScorer((key) => key === resultQuestionKey(candidates[1]) ? NaN : 0);
		const result = await runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 4, concurrency: 1, timeoutMs: 1000, deadlineMs: 5000 });
		expect(result.failure).toBe("invalid_response");
		expect(result.scores.size).toBe(0);
	});

	it("preserves measured SDK retries and usage in pass metrics", async () => {
		vi.useFakeTimers();
		const { candidates, skeleton } = fixture();
		let calls = 0;
		const scorer = new TypeSafeScorer({ apiKey: "k", maxRetries: 1, fetch: async (_url, init) => {
			await new Promise((resolve) => setTimeout(resolve, ++calls === 1 ? 10 : 30));
			if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } });
			const keys = Object.keys(JSON.parse(String(init?.body)).questions);
			return new Response(JSON.stringify({ answers: Object.fromEntries(keys.map((key) => [key, { type: "noul", noul: 0.2 }])), usage: { input_tokens: 50, output_tokens: 4 } }));
		} });
		const pending = runScoring({ skeleton, candidates: candidates.slice(0, 1), scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 1, concurrency: 1, timeoutMs: 1000, deadlineMs: 5000 });
		await vi.advanceTimersByTimeAsync(100);
		const result = await pending;
		expect(result).toMatchObject({ requests: 2, failedRequests: 1, latencyMs: 41 });
		expect(result.failure).toBeUndefined();
		expect(result.scores.size).toBe(1);
		expect(result.requestMetrics).toEqual([
			{ latencyMs: 10, outcome: "failed", failure: "rate_limit" },
			{ latencyMs: 30, outcome: "completed", usage: { inputTokens: 50, outputTokens: 4 } },
		]);
	});

	it("does not invent an HTTP request when the deadline interrupts retry backoff", async () => {
		vi.useFakeTimers();
		const { candidates, skeleton } = fixture();
		const fetch = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after-ms": "1000" } }));
		const scorer = new TypeSafeScorer({ apiKey: "k", maxRetries: 1, fetch });
		const pending = runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 4, concurrency: 1, timeoutMs: 1000, deadlineMs: 50 });
		await vi.advanceTimersByTimeAsync(50);
		const result = await pending;
		expect(result).toMatchObject({ requests: 1, failedRequests: 1, failure: "timeout" });
		expect(result.requestMetrics).toEqual([{ latencyMs: 0, outcome: "failed", failure: "rate_limit" }]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("TypeSafeScorer", () => {
	it("is unconfigured without a key and never touches the network", async () => {
		const scorer = new TypeSafeScorer({ apiKey: undefined, fetch: () => Promise.reject(new Error("network used")) });
		expect(scorer.configured).toBe(false);
		await expect(scorer.score({ context: "", goal: "", history: [] }, {}, { timeoutMs: 100 })).rejects.toMatchObject({ reason: "not_configured" });
	});

	it("posts to the SDK endpoint and validates noul answers", async () => {
		const seen: Array<{ url: string; body: unknown; auth: string | null }> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers = new Headers(init?.headers);
			seen.push({ url, body: JSON.parse(String(init?.body)), auth: headers.get("authorization") });
			return new Response(JSON.stringify({ answers: { call_t1: { type: "noul", noul: 0.8 }, result_t1: { type: "noul", noul: 0.2 } } }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const scorer = new TypeSafeScorer({ apiKey: "test-key", fetch, maxRetries: 0 });
		const { candidates, skeleton } = fixture();
		const answers = await scorer.score(skeleton.state, questionsFor(candidates[0]), { timeoutMs: 1_000 });
		expect(answers).toEqual({ call_t1: 0.8, result_t1: 0.2 });
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toMatch(/\/v1\/systemone$/);
		expect(seen[0].auth).toContain("test-key");
		expect((seen[0].body as { questions: Record<string, unknown> }).questions).toHaveProperty("call_t1");
	});

	it("maps HTTP failures to reason codes", async () => {
		const scorer = new TypeSafeScorer({ apiKey: "k", maxRetries: 0, fetch: async () => new Response("{}", { status: 429 }) });
		await expect(scorer.score({ context: "", goal: "", history: [] }, { q: { type: "noul", instructions: "x" } }, { timeoutMs: 1_000 })).rejects.toMatchObject({ reason: "rate_limit" });
		const auth = new TypeSafeScorer({ apiKey: "k", maxRetries: 0, fetch: async () => new Response("{}", { status: 401 }) });
		await expect(auth.score({ context: "", goal: "", history: [] }, { q: { type: "noul", instructions: "x" } }, { timeoutMs: 1_000 })).rejects.toMatchObject({ reason: "not_configured" });
	});

	it("rejects malformed answers", () => {
		expect(() => validateAnswers({ a: { type: "noul", noul: 1.5 } }, ["a"])).toThrow(ScoringError);
		expect(() => validateAnswers({}, ["a"])).toThrow(/missing/);
		expect(validateAnswers({ a: { type: "noul", noul: 0 } }, ["a"])).toEqual({ a: 0 });
	});
});
