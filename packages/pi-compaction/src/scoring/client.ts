import {
	APIConnectionError,
	APITimeoutError,
	APIUserAbortError,
	AuthenticationError,
	RateLimitError,
	TypeSafeClient,
	type Fetch,
} from "@typesafe-ai/sdk";
import type { SkeletonState } from "../engine/skeleton.js";
import type { QuestionSet } from "./questions.js";

/** Local safety caps, not advertised service limits. */
export const MAX_SCORING_REQUEST_BYTES = 1024 * 1024;
export const MAX_SCORING_RESPONSE_BYTES = 256 * 1024;
const OFFICIAL_BASE_URL = "https://api.typesafe.ai";
const OFFICIAL_ENDPOINT = `${OFFICIAL_BASE_URL}/v1/systemone`;

/** Stable failure classes; they double as telemetry reason codes. */
export type ScoringFailureReason =
	| "not_configured"
	| "cancelled"
	| "timeout"
	| "rate_limit"
	| "network"
	| "invalid_response"
	| "budget"
	| "error";

export class ScoringError extends Error {
	constructor(
		readonly reason: ScoringFailureReason,
		message: string,
	) {
		super(message);
		this.name = "ScoringError";
	}
}

/** Only token fields documented by SDK 0.6.0's SystemOneResult.usage. */
export interface ScoringUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface ScoringRequestMetric {
	latencyMs: number;
	outcome: "completed" | "failed";
	failure?: ScoringFailureReason;
	usage?: ScoringUsage;
}

export interface ScoreOptions {
	signal?: AbortSignal;
	/** Per-attempt timeout in milliseconds. */
	timeoutMs: number;
	/** Optional transport hooks; existing fake scorers need not implement these. */
	onRequestStart?: () => void;
	onRequestMetric?: (metric: ScoringRequestMetric) => void;
}

/** Answers keyed by question name, each a probability in [0, 1]. */
export type Answers = Record<string, number>;

export interface Scorer {
	/** True when a credential is configured; scoring is impossible otherwise. */
	readonly configured: boolean;
	score(state: SkeletonState, questions: QuestionSet, options: ScoreOptions): Promise<Answers>;
}

export interface TypeSafeScorerOptions {
	apiKey: string | undefined;
	/** Jev model name; defaults to the SDK default (`jev-latest`). */
	model?: string;
	fetch?: Fetch;
	/** Retries per request; default 0. Explicit retries each emit their own metric. */
	maxRetries?: number;
}

/** Fixed official destination, bounded bodies, and no body/credential error logging. */
export class TypeSafeScorer implements Scorer {
	private readonly createClient: ((fetch: Fetch) => TypeSafeClient) | undefined;
	private readonly fetch: Fetch;
	private readonly model: string | undefined;

	constructor(options: TypeSafeScorerOptions) {
		const apiKey = options.apiKey?.trim();
		this.model = options.model;
		this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		const maxRetries = options.maxRetries ?? 0;
		// Per-score clients keep concurrent attempt observers isolated. Explicit config
		// overrides TYPESAFE_BASE_URL and TYPESAFE_LOG_LEVEL in the installed SDK.
		this.createClient = apiKey
			? (fetch) => new TypeSafeClient({
				apiKey,
				baseURL: OFFICIAL_BASE_URL,
				fetch,
				logLevel: "off",
				retry: { maxRetries, backoffInitialMs: 250, backoffMaxMs: 2000 },
			})
			: undefined;
	}

	get configured(): boolean {
		return this.createClient !== undefined;
	}

	async score(state: SkeletonState, questions: QuestionSet, options: ScoreOptions): Promise<Answers> {
		if (!this.createClient) throw new ScoringError("not_configured", "TYPESAFE_API_KEY is not configured");
		if (options.signal?.aborted) throw new ScoringError("cancelled", "scoring cancelled before request");
		const expectedKeys = Object.keys(questions);
		try {
			const client = this.createClient(async (url, init) => {
				if (url !== OFFICIAL_ENDPOINT || init?.method !== "POST") {
					throw new ScoringError("network", "scoring destination rejected");
				}
				if (typeof init.body !== "string" || Buffer.byteLength(init.body, "utf8") > MAX_SCORING_REQUEST_BYTES) {
					throw new ScoringError("budget", "scoring request exceeds byte budget");
				}
				const signal = init.signal;
				const aborted = () => new ScoringError(options.signal?.aborted ? "cancelled" : "timeout", "scoring request interrupted");
				if (signal?.aborted) throw aborted();
				const started = performance.now();
				const expires = started + options.timeoutMs;
				const checkInterrupted = () => {
					if (signal?.aborted || performance.now() >= expires) throw aborted();
				};
				notify(options.onRequestStart);
				let failure: ScoringFailureReason | undefined;
				let usage: ScoringUsage | undefined;
				try {
					const response = await abortable(this.fetch(url, { ...init, redirect: "error" }), signal, aborted,
						(late) => cancelBody(late));
					try { checkInterrupted(); } catch (error) { cancelBody(response); throw error; }
					if (response.redirected || (response.status >= 300 && response.status < 400)) {
						cancelBody(response);
						throw new ScoringError("invalid_response", "scoring redirect rejected");
					}
					const body = await readBounded(response, signal, aborted, checkInterrupted);
					checkInterrupted();
					if (response.ok) {
						// Inspect only the bounded body. Preserve real usage even if answers fail validation.
						try {
							const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
							usage = normalizeUsage(record(parsed)?.usage);
							validateAnswers(record(parsed)?.answers, expectedKeys);
						} catch { failure = "invalid_response"; }
					} else {
						failure = response.status === 429 ? "rate_limit" : response.status === 401 ? "not_configured" : "error";
					}
					checkInterrupted();
					return new Response(response.status === 204 || response.status === 205 ? null : body, {
						status: response.status, headers: response.headers,
					});
				} catch (error) {
					const safe = signal?.aborted ? aborted() : classify(error);
					// A fetch/stream exception is a network failure unless already classified locally.
					failure = error instanceof ScoringError || signal?.aborted ? safe.reason : "network";
					throw new ScoringError(failure, "scoring transport failed");
				} finally {
					notify(() => options.onRequestMetric?.({
						latencyMs: performance.now() - started,
						outcome: failure ? "failed" : "completed",
						...(failure ? { failure } : {}),
						...(usage ? { usage } : {}),
					}));
				}
			});
			const result = await client.systemOne(
				{ state: state as unknown as Record<string, never>, questions, ...(this.model ? { model: this.model } : {}) },
				{ signal: options.signal, timeout: options.timeoutMs },
			);
			if (options.signal?.aborted) throw new ScoringError("cancelled", "scoring cancelled");
			return validateAnswers(result?.answers, expectedKeys);
		} catch (error) {
			throw classify(error);
		}
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Missing, malformed, partial or undocumented usage is not a measurement. */
export function normalizeUsage(value: unknown): ScoringUsage | undefined {
	const usage = record(value);
	const input = usage?.input_tokens;
	const output = usage?.output_tokens;
	if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 ||
		typeof output !== "number" || !Number.isSafeInteger(output) || output < 0) return undefined;
	return { inputTokens: input, outputTokens: output };
}

export function validateAnswers(answers: unknown, expectedKeys: readonly string[]): Answers {
	const values = record(answers);
	if (!values) throw new ScoringError("invalid_response", "response has no answers object");
	const output: Answers = {};
	for (const key of expectedKeys) {
		const answer = record(values[key]);
		if (!answer || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
			throw new ScoringError("invalid_response", "missing or invalid scoring answer");
		}
		output[key] = answer.noul;
	}
	return output;
}

/** Race cancellation explicitly: injected fetch, stream readers and scorers may ignore abort. */
export function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal | null | undefined,
	aborted: () => ScoringError, onLate?: (value: T) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			action();
		};
		const onAbort = () => finish(() => reject(aborted()));
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		Promise.resolve(operation).then(
			(value) => settled ? notify(() => onLate?.(value)) : finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}

function notify(callback: (() => void) | undefined): void {
	try { callback?.(); } catch { /* Diagnostics must never change scoring. */ }
}

function cancelBody(response: Response): void {
	void response.body?.cancel().catch(() => {});
}

async function readBounded(response: Response, signal: AbortSignal | null | undefined,
	aborted: () => ScoringError, checkInterrupted: () => void): Promise<Uint8Array<ArrayBuffer>> {
	const declared = Number(response.headers.get("content-length"));
	if (declared > MAX_SCORING_RESPONSE_BYTES) {
		cancelBody(response);
		throw new ScoringError("budget", "scoring response exceeds byte budget");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const body = new Uint8Array(MAX_SCORING_RESPONSE_BYTES);
	let size = 0;
	try {
		while (true) {
			// Also check elapsed time: endlessly ready/empty chunks can starve timer callbacks.
			checkInterrupted();
			const { done, value } = await abortable(reader.read(), signal, aborted);
			if (done) break;
			if (value.byteLength > MAX_SCORING_RESPONSE_BYTES - size) throw new ScoringError("budget", "scoring response exceeds byte budget");
			body.set(value, size);
			size += value.byteLength;
		}
		return body.subarray(0, size);
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function classify(error: unknown): ScoringError {
	if (error instanceof ScoringError) return error;
	if (error instanceof APIUserAbortError) return new ScoringError("cancelled", "scoring cancelled");
	if (error instanceof APITimeoutError) return new ScoringError("timeout", "scoring request timed out");
	if (error instanceof RateLimitError) return new ScoringError("rate_limit", "scoring rate limited");
	if (error instanceof AuthenticationError) return new ScoringError("not_configured", "scoring credential rejected");
	// The SDK wraps fetch failures. Only unwrap our own allowlisted, body-free error.
	if (error instanceof APIConnectionError && error.cause instanceof ScoringError) return error.cause;
	if (error instanceof APIConnectionError) return new ScoringError("network", "scoring connection failed");
	if (error instanceof Error && error.name === "AbortError") return new ScoringError("cancelled", "scoring cancelled");
	return new ScoringError("error", "scoring failed");
}
