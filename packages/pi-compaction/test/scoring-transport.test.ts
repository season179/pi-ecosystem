import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_SCORING_REQUEST_BYTES, MAX_SCORING_RESPONSE_BYTES,
	normalizeUsage, TypeSafeScorer, type ScoringRequestMetric,
} from "../src/scoring/client.js";

const state = { context: "private narrative", goal: "private goal", history: [] };
const questions = { q: { type: "noul" as const, instructions: "keep?" } };
const valid = { answers: { q: { type: "noul", noul: 0.25 } } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("fixed and bounded scoring transport", () => {
	it("overrides hostile endpoint/log environment and forces redirect:error", async () => {
		vi.stubEnv("TYPESAFE_BASE_URL", "https://hostile.example/transcripts");
		vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
		const logs = [vi.spyOn(console, "debug"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json(valid));
		const scorer = new TypeSafeScorer({ apiKey: "private-test-key", fetch });
		await expect(scorer.score(state, questions, { timeoutMs: 1000 })).resolves.toEqual({ q: 0.25 });
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(init).toMatchObject({ redirect: "error", method: "POST" });
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-test-key");
		for (const log of logs) expect(log).not.toHaveBeenCalled();
	});

	it.each([301, 302, 303, 304, 307, 308])("rejects redirect status %s without reading or following it", async (status) => {
		const cancelled = vi.fn();
		const body = new ReadableStream({ cancel: cancelled });
		const response = new Response(status === 304 ? null : body, { status, headers: { location: "https://hostile.example/secret" } });
		const fetch = vi.fn(async () => response);
		const metrics: ScoringRequestMetric[] = [];
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch });
		await expect(scorer.score(state, questions, { timeoutMs: 1000, onRequestMetric: (metric) => metrics.push(metric) })).rejects.toMatchObject({ reason: "invalid_response" });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(metrics).toEqual([expect.objectContaining({ outcome: "failed", failure: "invalid_response" })]);
		if (status !== 304) expect(cancelled).toHaveBeenCalledTimes(1);
	});

	it("rejects an already redirected response from an injected transport", async () => {
		const response = json(valid);
		Object.defineProperty(response, "redirected", { value: true });
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => response });
		await expect(scorer.score(state, questions, { timeoutMs: 1000 })).rejects.toMatchObject({ reason: "invalid_response" });
	});

	it("caps the complete request's actual UTF-8 bytes before fetch", async () => {
		const fetch = vi.fn(async () => json(valid));
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch });
		const context = "界".repeat(Math.ceil(MAX_SCORING_REQUEST_BYTES / 3));
		expect(context.length).toBeLessThan(MAX_SCORING_REQUEST_BYTES);
		await expect(scorer.score({ ...state, context }, questions, { timeoutMs: 1000 })).rejects.toMatchObject({ reason: "budget" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([200, 429])("caps streamed bytes regardless of understated length on HTTP %s", async (status) => {
		const cancelled = vi.fn();
		let chunks = 0;
		const response = new Response(new ReadableStream({
			pull(controller) { controller.enqueue(new Uint8Array(32 * 1024)); chunks++; },
			cancel: cancelled,
		}), { status, headers: { "content-length": "1" } });
		const metrics: ScoringRequestMetric[] = [];
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => response });
		await expect(scorer.score(state, questions, { timeoutMs: 1000, onRequestMetric: (metric) => metrics.push(metric) })).rejects.toMatchObject({ reason: "budget" });
		expect(chunks * 32 * 1024).toBeGreaterThan(MAX_SCORING_RESPONSE_BYTES);
		expect(cancelled).toHaveBeenCalledTimes(1);
		expect(metrics[0]).toMatchObject({ outcome: "failed", failure: "budget" });
	});

	it("caps a single chunk's UTF-8 bytes, including without Content-Length", async () => {
		const bytes = new TextEncoder().encode("界".repeat(Math.ceil(MAX_SCORING_RESPONSE_BYTES / 3)));
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => new Response(bytes) });
		await expect(scorer.score(state, questions, { timeoutMs: 1000 })).rejects.toMatchObject({ reason: "budget" });
	});

	it("rejects declared oversize bodies before waiting for their contents", async () => {
		const cancelled = vi.fn();
		const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-length": String(MAX_SCORING_RESPONSE_BYTES + 1) } });
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => response });
		await expect(scorer.score(state, questions, { timeoutMs: 1000 })).rejects.toMatchObject({ reason: "budget" });
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	it("bounds an endlessly ready stream even when empty chunks starve timer callbacks", async () => {
		const cancelled = vi.fn();
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => new Response(new ReadableStream({
			pull(controller) { controller.enqueue(new Uint8Array()); }, cancel: cancelled,
		})) });
		const started = performance.now();
		await expect(scorer.score(state, questions, { timeoutMs: 20 })).rejects.toMatchObject({ reason: "timeout" });
		expect(performance.now() - started).toBeLessThan(500);
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	it("accepts a response at the exact byte cap", async () => {
		const body = JSON.stringify(valid).padEnd(MAX_SCORING_RESPONSE_BYTES, " ");
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => new Response(body) });
		await expect(scorer.score(state, questions, { timeoutMs: 1000 })).resolves.toEqual({ q: 0.25 });
	});

	it("times out fetch ignoring abort and cancels a late response", async () => {
		vi.useFakeTimers();
		let finish!: (response: Response) => void;
		const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
		const metrics: ScoringRequestMetric[] = [];
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch });
		const pending = scorer.score(state, questions, { timeoutMs: 40, onRequestMetric: (metric) => metrics.push(metric) });
		const rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" });
		await vi.advanceTimersByTimeAsync(40);
		await rejected;
		expect(metrics).toEqual([{ latencyMs: 40, outcome: "failed", failure: "timeout" }]);
		const cancelled = vi.fn();
		finish(new Response(new ReadableStream({ cancel: cancelled })));
		await vi.advanceTimersByTimeAsync(0);
		expect(cancelled).toHaveBeenCalledTimes(1);
		expect(metrics).toHaveLength(1);
	});

	it.each(["timeout", "cancelled"] as const)("settles a stalled stream on %s even if cancel never resolves", async (reason) => {
		vi.useFakeTimers();
		const cancelled = vi.fn(() => new Promise<void>(() => {}));
		const response = new Response(new ReadableStream({
			start(controller) { controller.enqueue(new TextEncoder().encode('{"answers":')); },
			cancel: cancelled,
		}));
		const controller = new AbortController();
		const metrics: ScoringRequestMetric[] = [];
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => response });
		const pending = scorer.score(state, questions, { signal: controller.signal, timeoutMs: 40, onRequestMetric: (metric) => metrics.push(metric) });
		const rejected = expect(pending).rejects.toMatchObject({ reason });
		await vi.advanceTimersByTimeAsync(10);
		if (reason === "cancelled") controller.abort("private abort reason");
		else await vi.advanceTimersByTimeAsync(30);
		await rejected;
		expect(cancelled).toHaveBeenCalledTimes(1);
		expect(metrics).toEqual([{ latencyMs: reason === "timeout" ? 40 : 10, outcome: "failed", failure: reason }]);
	});

	it("honours pre-abort without calling fetch", async () => {
		const controller = new AbortController();
		controller.abort("private abort reason");
		const fetch = vi.fn(async () => json(valid));
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch });
		await expect(scorer.score(state, questions, { timeoutMs: 1000, signal: controller.signal })).rejects.toMatchObject({ reason: "cancelled" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("sanitizes native redirect/network errors and HTTP response bodies", async () => {
		for (const fetch of [
			async () => { throw new Error("private-test-key private narrative redirect to hostile.example"); },
			async () => json({ error: { message: "private-test-key private narrative", type: "private type" } }, 500),
			async () => new Response("private narrative", { status: 200 }),
		]) {
			const scorer = new TypeSafeScorer({ apiKey: "private-test-key", fetch });
			const error = await scorer.score(state, questions, { timeoutMs: 1000 }).catch((error: Error) => error);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toMatch(/private|hostile/);
			expect(error).not.toHaveProperty("cause");
		}
	});
});

describe("measured attempt metrics and SDK usage", () => {
	it("records each explicitly enabled retry and defaults to no retry", async () => {
		vi.useFakeTimers();
		for (const retries of [undefined, 1]) {
			const metrics: ScoringRequestMetric[] = [];
			const start = vi.fn();
			let calls = 0;
			const scorer = new TypeSafeScorer({ apiKey: "k", maxRetries: retries, fetch: async () => {
				await new Promise((resolve) => setTimeout(resolve, ++calls === 1 ? 15 : 60));
				return calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } })
					: json({ ...valid, usage: { input_tokens: 11, output_tokens: 2 } });
			} });
			const pending = scorer.score(state, questions, { timeoutMs: 1000, onRequestStart: start, onRequestMetric: (metric) => metrics.push(metric) });
			const checked = retries ? expect(pending).resolves.toEqual({ q: 0.25 }) : expect(pending).rejects.toMatchObject({ reason: "rate_limit" });
			await vi.advanceTimersByTimeAsync(1000);
			await checked;
			expect(calls).toBe(retries ? 2 : 1);
			expect(start).toHaveBeenCalledTimes(calls);
			expect(metrics[0]).toEqual({ latencyMs: 15, outcome: "failed", failure: "rate_limit" });
			if (retries) expect(metrics[1]).toEqual({ latencyMs: 60, outcome: "completed", usage: { inputTokens: 11, outputTokens: 2 } });
		}
	});

	it.each([
		undefined, null, [], {}, { input_tokens: 1 }, { input_tokens: -1, output_tokens: 2 },
		{ input_tokens: "1", output_tokens: 2 }, { input_tokens: 1.5, output_tokens: 2 },
		{ input_tokens: Infinity, output_tokens: 2 }, { input_tokens: NaN, output_tokens: 2 },
		{ input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 2 },
		{ input_tokens: 1, output_tokens: -2 }, { inputTokens: 1, outputTokens: 2 },
	])("leaves invalid or unavailable SDK usage absent: %j", (usage) => {
		expect(normalizeUsage(usage)).toBeUndefined();
	});

	it("retains only documented usage, including real zero values", async () => {
		const metrics: ScoringRequestMetric[] = [];
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => json({ ...valid,
			usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 88, paid_cost: 9, secret: "private" },
		}) });
		await scorer.score(state, questions, { timeoutMs: 1000, onRequestMetric: (metric) => metrics.push(metric) });
		expect(metrics[0].usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	it("keeps usage for a response whose answers fail validation", async () => {
		const metrics: ScoringRequestMetric[] = [];
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => json({ answers: {}, usage: { input_tokens: 10, output_tokens: 1 } }) });
		await expect(scorer.score(state, questions, { timeoutMs: 1000, onRequestMetric: (metric) => metrics.push(metric) })).rejects.toMatchObject({ reason: "invalid_response" });
		expect(metrics[0]).toMatchObject({ outcome: "failed", failure: "invalid_response", usage: { inputTokens: 10, outputTokens: 1 } });
	});

	it("does not invent usage when absent and isolates failing observers", async () => {
		const metrics: ScoringRequestMetric[] = [];
		const scorer = new TypeSafeScorer({ apiKey: "k", fetch: async () => json(valid) });
		await expect(scorer.score(state, questions, { timeoutMs: 1000, onRequestStart: () => { throw new Error("observer"); }, onRequestMetric: (metric) => { metrics.push(metric); throw new Error("observer"); } })).resolves.toEqual({ q: 0.25 });
		expect(metrics[0]).not.toHaveProperty("usage");
		await tick();
	});
});
