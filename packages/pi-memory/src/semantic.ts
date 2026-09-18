import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	APIConnectionError,
	APIError,
	APITimeoutError,
	APIUserAbortError,
	noul,
	TypeSafeClient,
	TypeSafeError,
	type Fetch,
	type NoulQuestion,
} from "@typesafe-ai/sdk";
import type { ScopedMemory } from "./runtime.js";

// ---------------------------------------------------------------------------
// Jev semantic recall (shared typesafe.json contract).
//
// Reads <agentDir>/typesafe.json and the API key (TYPESAFE_API_KEY, else the
// optional apiKeyFile) at every call so key-file activation takes effect
// without process environment mutation. The official SDK is used directly;
// no new internal package, no cross-package source import. Strictly read-only
// against the store: this module never mutates storage, injection policy, or
// the write path.
// ---------------------------------------------------------------------------

export const TYPESAFE_CONFIG_FILE = "typesafe.json";

/**
 * Pinned official API root. Setting it explicitly (not via env) means a
 * stray TYPESAFE_BASE_URL cannot redirect memories or the key elsewhere.
 */
export const TYPESAFE_OFFICIAL_BASE_URL = "https://api.typesafe.ai";

export const SEMANTIC_MODEL_DEFAULT = "jev-1.13.0";
export const SEMANTIC_TIMEOUT_MS_DEFAULT = 3000;
export const SEMANTIC_MIN_RELEVANCE_DEFAULT = 0.5;
/** Shared top-level bounds, aligned with the Buddy consumer of typesafe.json. */
export const SEMANTIC_MODEL_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
export const SEMANTIC_MAX_TIMEOUT_MS = 10_000;
/** Candidates per request; keeps state+largest question far below 32k tokens. */
export const SEMANTIC_STATE_BATCH_CANDIDATES = 16;
/** Serialized state bytes per request; far below the 32k-token single-state cap. */
export const SEMANTIC_STATE_BATCH_BYTES = 96 * 1024;
/** Concurrent batch requests; more waves finish inside one whole-call deadline. */
export const SEMANTIC_BATCH_CONCURRENCY = 4;

export const SEMANTIC_QUERY_MAX_CHARS = 2000;
export const SEMANTIC_TITLE_MAX_CHARS = 400;
export const SEMANTIC_TAGS_MAX_CHARS = 400;
export const SEMANTIC_CUE_MAX_CHARS = 600;
export const SEMANTIC_BODY_MAX_CHARS = 1200;

export interface TypesafeMemorySettings {
	enabled: boolean;
	minRelevance: number;
}

export interface TypesafeSettings {
	model: string;
	timeoutMs: number;
	apiKeyFile: string | undefined;
	memory: TypesafeMemorySettings;
}

export type LoadedTypesafeConfig =
	| { state: "absent" }
	| { state: "malformed" }
	| { state: "loaded"; settings: TypesafeSettings };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Strict parse of the shared typesafe.json. Unknown fields (for example the
 * buddy worker's settings) are ignored so both consumers share one file.
 * Anything malformed disables the feature with a visible warning — never a
 * silent apparent success.
 */
export function parseTypesafeConfig(raw: string): LoadedTypesafeConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { state: "malformed" };
	}
	if (!isRecord(parsed)) return { state: "malformed" };

	let model = SEMANTIC_MODEL_DEFAULT;
	if (parsed.model !== undefined) {
		if (typeof parsed.model !== "string" || !SEMANTIC_MODEL_PATTERN.test(parsed.model)) return { state: "malformed" };
		model = parsed.model;
	}

	let timeoutMs = SEMANTIC_TIMEOUT_MS_DEFAULT;
	if (parsed.timeoutMs !== undefined) {
		if (
			!isFiniteNumber(parsed.timeoutMs) ||
			!Number.isInteger(parsed.timeoutMs) ||
			parsed.timeoutMs < 1 ||
			parsed.timeoutMs > SEMANTIC_MAX_TIMEOUT_MS
		) {
			return { state: "malformed" };
		}
		timeoutMs = parsed.timeoutMs;
	}

	let apiKeyFile: string | undefined;
	if (parsed.apiKeyFile !== undefined) {
		if (typeof parsed.apiKeyFile !== "string" || parsed.apiKeyFile.trim() === "") return { state: "malformed" };
		apiKeyFile = parsed.apiKeyFile.trim();
	}

	let memory: TypesafeMemorySettings = { enabled: false, minRelevance: SEMANTIC_MIN_RELEVANCE_DEFAULT };
	if (parsed.memory !== undefined) {
		if (!isRecord(parsed.memory)) return { state: "malformed" };
		// Absent enabled reads as disabled, matching the Buddy consumer's
		// reading of the same shared file.
		if (parsed.memory.enabled !== undefined && typeof parsed.memory.enabled !== "boolean") {
			return { state: "malformed" };
		}
		let minRelevance = SEMANTIC_MIN_RELEVANCE_DEFAULT;
		if (parsed.memory.minRelevance !== undefined) {
			if (!isFiniteNumber(parsed.memory.minRelevance) || parsed.memory.minRelevance < 0 || parsed.memory.minRelevance > 1) {
				return { state: "malformed" };
			}
			minRelevance = parsed.memory.minRelevance;
		}
		memory = { enabled: parsed.memory.enabled === true, minRelevance };
	}

	return { state: "loaded", settings: { model, timeoutMs, apiKeyFile, memory } };
}

/** Re-read <agentDir>/typesafe.json on every call; absent config stays absent. */
export async function loadTypesafeConfig(agentDir: string): Promise<LoadedTypesafeConfig> {
	let raw: string;
	try {
		raw = await readFile(join(agentDir, TYPESAFE_CONFIG_FILE), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { state: "absent" };
		return { state: "malformed" };
	}
	return parseTypesafeConfig(raw);
}

/**
 * TYPESAFE_API_KEY takes precedence over the optional apiKeyFile (relative to
 * agentDir, or absolute). The key is never logged or included in diagnostics.
 */
export async function resolveTypesafeApiKey(
	agentDir: string,
	settings: TypesafeSettings,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	const fromEnv = env.TYPESAFE_API_KEY?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	if (settings.apiKeyFile === undefined) return undefined;
	const path = isAbsolute(settings.apiKeyFile) ? settings.apiKeyFile : join(agentDir, settings.apiKeyFile);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Request formation
// ---------------------------------------------------------------------------

export type SemanticCandidateView = {
	title: string;
	cue: string;
	tags: string[];
	body: string;
};

export interface SemanticBatch {
	/** State sent with one request; candidates reference the request-local array. */
	state: { task: string; query: string; candidates: SemanticCandidateView[] };
	/** Question key per candidate, aligned with state.candidates. */
	keys: string[];
	/** Index of the first candidate of this batch in the canonical ordering. */
	base: number;
}

const SEMANTIC_TASK =
	"Answer each question independently about only the memory candidate it names; questions cannot see each other's answers.";

function boundText(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

function candidateView(memory: ScopedMemory["memory"]): SemanticCandidateView {
	return {
		title: boundText(memory.title, SEMANTIC_TITLE_MAX_CHARS),
		cue: boundText(memory.cue, SEMANTIC_CUE_MAX_CHARS),
		tags: memory.tags.slice(0, 12).map((tag) => boundText(tag, 64)).slice(0, 12),
		body: boundText(memory.body, SEMANTIC_BODY_MAX_CHARS),
	};
}

/**
 * Explicit state path in every question: question IDs are not sent to the
 * model, so the instruction must name the candidate's index itself.
 */
export function semanticQuestionInstructions(index: number): string {
	return (
		`state.query holds a memory search query. state.candidates[${index}] holds one memory candidate ` +
		`with title, tags, cue, and body fields. Would someone who issued state.query benefit from retrieving ` +
		`the memory described at state.candidates[${index}]? Judge meaning, not keywords: paraphrases, synonyms, ` +
		`and conceptually related content count as a match even when no words are shared.`
	);
}

const NOUL_CRITERIA = {
	true: "The candidate memory matches the information need behind state.query",
	false: "The candidate memory is unrelated to state.query",
} as const;

/** Project-first, then legacy-global; the same ordering the recall ranking uses. */
export function canonicalScopeOrder(candidates: readonly ScopedMemory[]): ScopedMemory[] {
	return [
		...candidates.filter((candidate) => candidate.scope === "project"),
		...candidates.filter((candidate) => candidate.scope === "legacy-global"),
	];
}

/**
 * Pack candidates into bounded batches: at most SEMANTIC_STATE_BATCH_CANDIDATES
 * candidates and SEMANTIC_STATE_BATCH_BYTES of serialized state per request.
 * Every candidate is placed in exactly one batch; none is dropped.
 */
export function buildSemanticBatches(query: string, candidates: readonly ScopedMemory[]): SemanticBatch[] {
	const boundedQuery = boundText(query.trim(), SEMANTIC_QUERY_MAX_CHARS);
	const batches: SemanticBatch[] = [];
	let current: SemanticCandidateView[] = [];
	let base = 0;
	const closeBatch = () => {
		if (current.length === 0) return;
		batches.push({
			state: { task: SEMANTIC_TASK, query: boundedQuery, candidates: current },
			keys: current.map((_view, index) => `q${index}`),
			base,
		});
		base += current.length;
		current = [];
	};
	for (const candidate of candidates) {
		const view = candidateView(candidate.memory);
		const serialized = JSON.stringify({ task: SEMANTIC_TASK, query: boundedQuery, candidates: [...current, view] });
		if (current.length > 0 && (current.length >= SEMANTIC_STATE_BATCH_CANDIDATES || Buffer.byteLength(serialized, "utf8") > SEMANTIC_STATE_BATCH_BYTES)) {
			closeBatch();
		}
		current.push(view);
	}
	closeBatch();
	return batches;
}

/**
 * Defensive answer validation: every candidate's noul probability must be a
 * finite number in [0, 1]. The SDK does not validate the response shape
 * against the questions, so this is the authoritative check.
 */
export function extractNoulProbability(answers: unknown, key: string): number | undefined {
	if (!isRecord(answers)) return undefined;
	const answer = answers[key];
	if (!isRecord(answer)) return undefined;
	if (answer.type !== undefined && answer.type !== "noul") return undefined;
	const probability = answer.noul;
	if (!isFiniteNumber(probability) || probability < 0 || probability > 1) return undefined;
	return probability;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank semantically scored candidates. `scores` must align with
 * canonicalScopeOrder(candidates) — the same ordering semanticRecall scores.
 * Order: relevance desc, then recency desc, then id asc; the project-first
 * stable input order makes scope the final tie-break, mirroring the
 * deterministic ranking. Scores outside [0,1] or below minRelevance are
 * excluded; the limit is clamped to 1..10 exactly like the store ranking.
 * There is no lexical backfill: a candidate below the threshold stays out
 * even when the result count is below the limit.
 */
export function rankSemanticMatches(
	candidates: readonly ScopedMemory[],
	scores: readonly number[],
	minRelevance: number,
	limit = 5,
): ScopedMemory[] {
	const boundedLimit = Math.max(1, Math.min(10, Math.trunc(limit) || 5));
	const threshold = Math.min(1, Math.max(0, minRelevance));
	return canonicalScopeOrder(candidates)
		.map((candidate, index) => ({ candidate, score: scores[index] }))
		.filter(
			(pair): pair is { candidate: ScopedMemory; score: number } =>
				isFiniteNumber(pair.score) && pair.score >= 0 && pair.score <= 1 && pair.score >= threshold,
		)
		.sort(
			(left, right) =>
				right.score - left.score ||
				Date.parse(right.candidate.memory.updated) - Date.parse(left.candidate.memory.updated) ||
				left.candidate.memory.id.localeCompare(right.candidate.memory.id),
		)
		.slice(0, boundedLimit)
		.map((pair) => pair.candidate);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type SemanticFallbackReason =
	| "no-candidates"
	| "config-absent"
	| "disabled"
	| "malformed-config"
	| "missing-key"
	| "api-error"
	| "timeout"
	| "incomplete-response";

export interface SemanticRecallOptions {
	agentDir: string;
	env?: NodeJS.ProcessEnv;
	limit?: number;
	/** User/session cancellation; aborting publishes nothing. */
	signal?: AbortSignal;
	/** Injectable transport for tests (real SDK boundary). */
	fetch?: Fetch;
	now?: () => number;
}

export type SemanticRecallOutcome =
	| {
			kind: "matches";
			matches: ScopedMemory[];
			model: string;
			scored: number;
			batches: number;
			minRelevance: number;
	  }
	| { kind: "fallback"; reason: SemanticFallbackReason; detail?: string }
	| { kind: "aborted" };

/** Bounded, payload-free error classification for diagnostics. */
function classifySemanticError(error: unknown): string {
	if (error instanceof APIError) return `APIError ${error.status}`;
	if (error instanceof APIUserAbortError) return "request aborted";
	if (error instanceof APITimeoutError) return "request timed out";
	if (error instanceof APIConnectionError) return "connection error";
	if (error instanceof TypeSafeError) return "client error";
	return "request failed";
}

/**
 * Score every candidate against the query through Jev noul questions and rank
 * the results. Batches run with bounded concurrency under one whole-operation
 * deadline (config timeoutMs) enforced by an AbortSignal plus a hard race, so
 * neither retries nor response-body parsing can exceed the budget. Any error,
 * timeout, or incomplete/malformed answer set falls back to the caller's
 * deterministic ranking — semantic coverage is all candidates or none. User
 * cancellation is distinct: it aborts and publishes nothing.
 */
export async function semanticRecall(
	query: string,
	candidates: readonly ScopedMemory[],
	options: SemanticRecallOptions,
): Promise<SemanticRecallOutcome> {
	if (candidates.length === 0) return { kind: "fallback", reason: "no-candidates" };
	const env = options.env ?? process.env;
	// Injected clocks are for deterministic tests only: the deadline timer and
	// the SDK still run on real time, so a fake now() must stay Date.now-like.
	const now = options.now ?? Date.now;

	const config = await loadTypesafeConfig(options.agentDir);
	if (config.state === "absent") return { kind: "fallback", reason: "config-absent" };
	if (config.state === "malformed") return { kind: "fallback", reason: "malformed-config" };
	const settings = config.settings;
	if (!settings.memory.enabled) return { kind: "fallback", reason: "disabled" };
	const apiKey = await resolveTypesafeApiKey(options.agentDir, settings, env);
	if (apiKey === undefined) return { kind: "fallback", reason: "missing-key" };

	const userSignal = options.signal;
	if (userSignal?.aborted) return { kind: "aborted" };

	const ordered = canonicalScopeOrder(candidates);
	const batches = buildSemanticBatches(query, ordered);
	const scores: Array<number | undefined> = new Array<number | undefined>(ordered.length).fill(undefined);

	const deadline = now() + settings.timeoutMs;
	let deadlineExceeded = false;
	const controller = new AbortController();
	let rejectDeadline!: (error: Error) => void;
	const deadlineRejection = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject;
	});
	// The rejection is always observed by in-flight races; mark it handled for
	// the case where every batch already settled when the timer fires.
	deadlineRejection.catch(() => undefined);
	const timer = setTimeout(() => {
		deadlineExceeded = true;
		controller.abort();
		rejectDeadline(new Error("semantic recall deadline exceeded"));
	}, settings.timeoutMs);
	const forwardUserAbort = () => controller.abort();
	userSignal?.addEventListener("abort", forwardUserAbort, { once: true });
	const cleanup = () => {
		clearTimeout(timer);
		userSignal?.removeEventListener("abort", forwardUserAbort);
	};

	let firstError: unknown;
	try {
		let client: TypeSafeClient;
		try {
			client = new TypeSafeClient({
				apiKey,
				baseURL: TYPESAFE_OFFICIAL_BASE_URL,
				defaultModel: settings.model,
				// Explicit "off": TYPESAFE_LOG_LEVEL=debug would otherwise log
				// request headers and bodies (memories, key) to the console.
				logLevel: "off",
				// No retries: recall is latency-sensitive and the whole-operation
				// deadline above is the real bound.
				retry: { maxRetries: 0 },
				timeout: settings.timeoutMs,
				...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
			});
		} catch (error) {
			return { kind: "fallback", reason: "api-error", detail: classifySemanticError(error) };
		}

		const runBatch = async (batch: SemanticBatch): Promise<void> => {
			const questions: Record<string, NoulQuestion> = {};
			for (let index = 0; index < batch.state.candidates.length; index += 1) {
				questions[batch.keys[index]] = noul(semanticQuestionInstructions(index), NOUL_CRITERIA);
			}
			const remaining = deadline - now();
			if (remaining <= 0) throw new Error("semantic recall deadline exceeded before request");
			const request = client.systemOne(
				{ state: batch.state, questions, model: settings.model },
				{
					signal: controller.signal,
					timeout: Math.max(1, Math.floor(remaining)),
					retry: { maxRetries: 0 },
				},
			);
			// The SDK timeout is per attempt and body parsing is not signal-bound;
			// race the whole-operation deadline as the hard wall. Invariant: every
			// request is passed to Promise.race synchronously after creation — race
			// attaches reactions to all entries, so a request rejecting after the
			// deadline already won (or after sibling teardown aborted it) stays
			// handled and can never crash the process as an unhandled rejection.
			const result = await Promise.race([request, deadlineRejection]);
			const answers: unknown = (result as { answers?: unknown }).answers;
			for (let index = 0; index < batch.state.candidates.length; index += 1) {
				scores[batch.base + index] = extractNoulProbability(answers, batch.keys[index]);
			}
		};

		let nextBatch = 0;
		const worker = async (): Promise<void> => {
			for (;;) {
				if (firstError !== undefined || userSignal?.aborted === true) return;
				const index = nextBatch;
				nextBatch += 1;
				if (index >= batches.length) return;
				try {
					await runBatch(batches[index]);
				} catch (error) {
					firstError ??= error;
					// Tear down sibling in-flight requests; their rejections are
					// observed through each race and by the SDK's own handlers.
					controller.abort();
				}
			}
		};
		const workers = Array.from(
			{ length: Math.min(SEMANTIC_BATCH_CONCURRENCY, batches.length) },
			() => worker(),
		);
		await Promise.all(workers); // workers never reject
	} finally {
		cleanup();
	}

	if (userSignal?.aborted) return { kind: "aborted" };
	if (firstError !== undefined) {
		if (deadlineExceeded || now() >= deadline) return { kind: "fallback", reason: "timeout" };
		return { kind: "fallback", reason: "api-error", detail: classifySemanticError(firstError) };
	}
	if (scores.some((score) => score === undefined)) {
		return { kind: "fallback", reason: "incomplete-response" };
	}
	const validatedScores = scores as number[];
	const matches = rankSemanticMatches(candidates, validatedScores, settings.memory.minRelevance, options.limit ?? 5);
	return {
		kind: "matches",
		matches,
		model: settings.model,
		scored: ordered.length,
		batches: batches.length,
		minRelevance: settings.memory.minRelevance,
	};
}

// ---------------------------------------------------------------------------
// Status (config + key state at status time; no request is made)
// ---------------------------------------------------------------------------

export type SemanticRecallStatus =
	| { state: "active"; model: string; minRelevance: number }
	| { state: "off"; reason: "config-absent" | "disabled" }
	| { state: "unavailable"; reason: "malformed-config" | "missing-key" };

export async function describeSemanticRecallStatus(
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SemanticRecallStatus> {
	const config = await loadTypesafeConfig(agentDir);
	if (config.state === "absent") return { state: "off", reason: "config-absent" };
	if (config.state === "malformed") return { state: "unavailable", reason: "malformed-config" };
	if (!config.settings.memory.enabled) return { state: "off", reason: "disabled" };
	const apiKey = await resolveTypesafeApiKey(agentDir, config.settings, env);
	if (apiKey === undefined) return { state: "unavailable", reason: "missing-key" };
	return {
		state: "active",
		model: config.settings.model,
		minRelevance: config.settings.memory.minRelevance,
	};
}

/** One bounded line for /pi-memory status. */
export function semanticRecallStatusLine(status: SemanticRecallStatus): string {
	switch (status.state) {
		case "active":
			return `Semantic recall: active (model ${status.model}, min relevance ${status.minRelevance})`;
		case "off":
			return status.reason === "disabled"
				? "Semantic recall: off (memory.enabled is false in typesafe.json)"
				: "Semantic recall: off (no typesafe.json)";
		case "unavailable":
			return status.reason === "missing-key"
				? "Semantic recall: unavailable (no API key configured); recall uses deterministic matching"
				: "Semantic recall: unavailable (typesafe.json is malformed); recall uses deterministic matching";
	}
}
