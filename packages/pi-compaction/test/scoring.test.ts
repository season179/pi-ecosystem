import { describe, expect, it } from "vitest";
import { collectCandidates } from "../src/engine/candidates.js";
import { buildSkeleton } from "../src/engine/skeleton.js";
import { ScoringError, TypeSafeScorer, validateAnswers, type Scorer } from "../src/scoring/client.js";
import { runScoring } from "../src/scoring/pass.js";
import { callQuestionKey, planBatches, questionsFor, resultQuestionKey } from "../src/scoring/questions.js";
import { singleTaskTranscript, withIds } from "./helpers/messages.js";

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
		expect(result.scores.get(candidates[0].toolCallId)).toEqual({ keepCall: 0.9, keepResult: 0.1 });
	});

	it("keeps successful batches when one fails and reports the reason", async () => {
		const { candidates, skeleton } = fixture();
		const scorer = fakeScorer(() => 0.5, { failOn: 2 });
		const result = await runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 4, concurrency: 1, timeoutMs: 1_000, deadlineMs: 5_000 });
		expect(result.failure).toBe("rate_limit");
		expect(result.failedRequests).toBe(1);
		expect(result.scores.size).toBe(4);
	});

	it("stops at the deadline and leaves the rest unscored", async () => {
		const { candidates, skeleton } = fixture();
		const scorer = fakeScorer(() => 0.5, { delayMs: 500 });
		const result = await runScoring({ skeleton, candidates, scorer, maxRequestTokens: 28_000, maxCandidatesPerBatch: 2, concurrency: 1, timeoutMs: 1_000, deadlineMs: 50 });
		expect(result.scores.size).toBe(0);
		expect(["timeout", "cancelled"]).toContain(result.failure);
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
