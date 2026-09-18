import {
	APIConnectionError,
	APITimeoutError,
	APIUserAbortError,
	AuthenticationError,
	RateLimitError,
	TypeSafeClient,
	TypeSafeError,
	type Fetch,
} from "@typesafe-ai/sdk";
import type { SkeletonState } from "../engine/skeleton.js";
import type { QuestionSet } from "./questions.js";

/** Stable failure classes; they double as telemetry reason codes. */
export type ScoringFailureReason =
	| "not_configured"
	| "cancelled"
	| "timeout"
	| "rate_limit"
	| "network"
	| "invalid_response"
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

export interface ScoreOptions {
	signal?: AbortSignal;
	/** Per-attempt timeout in milliseconds. */
	timeoutMs: number;
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
	/** Retries per request; default 1 (one retry after the initial attempt). */
	maxRetries?: number;
}

/**
 * Bounded TypeSafe System One client. Requests go only to the SDK's official base URL,
 * bodies are never logged, and every failure is reduced to a reason code plus a short
 * message that never echoes request or response bodies.
 */
export class TypeSafeScorer implements Scorer {
	private readonly client: TypeSafeClient | undefined;
	private readonly model: string | undefined;

	constructor(options: TypeSafeScorerOptions) {
		const apiKey = options.apiKey?.trim();
		this.model = options.model;
		this.client = apiKey
			? new TypeSafeClient({
					apiKey,
					fetch: options.fetch,
					logLevel: "off",
					retry: { maxRetries: options.maxRetries ?? 1, backoffInitialMs: 250, backoffMaxMs: 2000 },
				})
			: undefined;
	}

	get configured(): boolean {
		return this.client !== undefined;
	}

	async score(state: SkeletonState, questions: QuestionSet, options: ScoreOptions): Promise<Answers> {
		if (!this.client) throw new ScoringError("not_configured", "TYPESAFE_API_KEY is not configured");
		if (options.signal?.aborted) throw new ScoringError("cancelled", "scoring cancelled before request");
		let result: { answers: Record<string, unknown> };
		try {
			result = (await this.client.systemOne(
				{ state: state as unknown as Record<string, never>, questions, ...(this.model ? { model: this.model } : {}) },
				{ signal: options.signal, timeout: options.timeoutMs },
			)) as unknown as { answers: Record<string, unknown> };
		} catch (error) {
			throw classify(error);
		}
		return validateAnswers(result?.answers, Object.keys(questions));
	}
}

export function validateAnswers(answers: unknown, expectedKeys: readonly string[]): Answers {
	if (answers === null || typeof answers !== "object") throw new ScoringError("invalid_response", "response has no answers object");
	const record = answers as Record<string, unknown>;
	const output: Answers = {};
	for (const key of expectedKeys) {
		const answer = record[key] as { type?: unknown; noul?: unknown } | undefined;
		if (!answer || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
			throw new ScoringError("invalid_response", `missing or invalid answer for ${key}`);
		}
		output[key] = answer.noul;
	}
	return output;
}

function classify(error: unknown): ScoringError {
	if (error instanceof ScoringError) return error;
	if (error instanceof APIUserAbortError) return new ScoringError("cancelled", "scoring cancelled");
	if (error instanceof APITimeoutError) return new ScoringError("timeout", "scoring request timed out");
	if (error instanceof RateLimitError) return new ScoringError("rate_limit", "scoring rate limited");
	if (error instanceof AuthenticationError) return new ScoringError("not_configured", "scoring credential rejected");
	if (error instanceof APIConnectionError) return new ScoringError("network", "scoring connection failed");
	if (error instanceof TypeSafeError) return new ScoringError("error", `scoring failed (${error.name})`);
	if (error instanceof Error && error.name === "AbortError") return new ScoringError("cancelled", "scoring cancelled");
	return new ScoringError("error", "scoring failed");
}
