/**
 * TypeSafe Jev access for `herdr_select`.
 *
 * Follows the shared `<agentDir>/typesafe.json` convention used by pi-buddy and
 * pi-memory (top-level `model`, `timeoutMs`, `apiKeyFile`; `TYPESAFE_API_KEY`
 * wins) without importing those packages. Settings and key are re-read per
 * selection. The destination is pinned to the official endpoint, bodies are
 * bounded, SDK logging is off, and every error is replaced by a fixed,
 * credential-free message.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	APIConnectionError,
	APIError,
	APITimeoutError,
	APIUserAbortError,
	AuthenticationError,
	RateLimitError,
	TypeSafeClient,
	type Fetch,
	type Questions,
} from "@typesafe-ai/sdk";

export const JEV_MODEL_DEFAULT = "jev-1.13.0";
const JEV_TIMEOUT_MS_DEFAULT = 3_000;
const JEV_MAX_TIMEOUT_MS = 10_000;
const MODEL_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
const OFFICIAL_BASE_URL = "https://api.typesafe.ai";
const OFFICIAL_ENDPOINT = `${OFFICIAL_BASE_URL}/v1/systemone`;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;

export type JevFailureReason =
	| "not_configured"
	| "config_invalid"
	| "no_key"
	| "key_rejected"
	| "timeout"
	| "cancelled"
	| "rate_limit"
	| "network"
	| "service"
	| "invalid_response"
	| "error";

/** Fixed messages only: never provider bodies, headers, or credentials. */
export class JevError extends Error {
	constructor(readonly reason: JevFailureReason, message: string) {
		super(message);
		this.name = "JevError";
	}
}

export interface JevSettings {
	model: string;
	timeoutMs: number;
	apiKeyFile?: string;
}

export interface JevUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface JevResponse {
	/** Versioned model that answered, when reported. */
	model?: string;
	answers: Record<string, unknown>;
	usage?: JevUsage;
}

export interface JevSession {
	model: string;
	ask(state: unknown, questions: Questions, signal: AbortSignal): Promise<JevResponse>;
}

export type OpenJev = (signal: AbortSignal) => Promise<JevSession>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interrupted(signal: AbortSignal): JevError {
	return signal.reason instanceof JevError
		? signal.reason
		: new JevError("cancelled", "Jev request cancelled");
}

/** Strict top-level parse; other consumers' sections are ignored. */
export function parseJevSettings(raw: string): JevSettings {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new JevError("config_invalid", "typesafe.json is not valid JSON");
	}
	if (!isRecord(value)) throw new JevError("config_invalid", "typesafe.json must be an object");
	const model = value.model ?? JEV_MODEL_DEFAULT;
	const timeoutMs = value.timeoutMs ?? JEV_TIMEOUT_MS_DEFAULT;
	const apiKeyFile = value.apiKeyFile;
	if (typeof model !== "string" || !MODEL_PATTERN.test(model) ||
		typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > JEV_MAX_TIMEOUT_MS ||
		(apiKeyFile !== undefined && (typeof apiKeyFile !== "string" || !apiKeyFile.trim()))) {
		throw new JevError("config_invalid", "typesafe.json has an invalid model, timeoutMs or apiKeyFile");
	}
	return { model, timeoutMs, ...(typeof apiKeyFile === "string" ? { apiKeyFile: apiKeyFile.trim() } : {}) };
}

async function loadSettings(agentDir: string, signal: AbortSignal): Promise<JevSettings> {
	let raw: string;
	try {
		raw = await readFile(join(agentDir, "typesafe.json"), { encoding: "utf8", signal });
	} catch (error) {
		if (signal.aborted) throw interrupted(signal);
		throw (error as NodeJS.ErrnoException).code === "ENOENT"
			? new JevError("not_configured", "no typesafe.json in the Pi agent directory")
			: new JevError("config_invalid", "typesafe.json is unreadable");
	}
	return parseJevSettings(raw);
}

async function loadKey(agentDir: string, settings: JevSettings, signal: AbortSignal): Promise<string> {
	const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	if (settings.apiKeyFile !== undefined) {
		const path = isAbsolute(settings.apiKeyFile) ? settings.apiKeyFile : join(agentDir, settings.apiKeyFile);
		try {
			const key = (await readFile(path, { encoding: "utf8", signal })).trim();
			if (key) return key;
		} catch {
			if (signal.aborted) throw interrupted(signal);
		}
	}
	throw new JevError("no_key", "no TypeSafe API key (set TYPESAFE_API_KEY or apiKeyFile in typesafe.json)");
}

function cancelBody(response: Response): void {
	void response.body?.cancel().catch(() => {});
}

/** Pins destination and bounds bytes before the SDK buffers or parses a body. */
function guardedFetch(fetchImpl: Fetch): Fetch {
	return async (url, init) => {
		if (url !== OFFICIAL_ENDPOINT || init?.method !== "POST") {
			throw new JevError("network", "Jev destination rejected");
		}
		if (typeof init.body !== "string" || Buffer.byteLength(init.body, "utf8") > MAX_REQUEST_BYTES) {
			throw new JevError("invalid_response", "Jev request exceeds the local size limit");
		}
		const signal = init.signal ?? undefined;
		const response = await fetchImpl(url, { ...init, redirect: "error" });
		if (response.redirected || (response.status >= 300 && response.status < 400)) {
			cancelBody(response);
			throw new JevError("network", "Jev redirect rejected");
		}
		if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
			cancelBody(response);
			throw new JevError("invalid_response", "Jev response exceeds the local size limit");
		}
		const reader = response.body?.getReader();
		if (!reader) return response;
		const cancel = () => { void reader.cancel().catch(() => {}); };
		signal?.addEventListener("abort", cancel, { once: true });
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			while (true) {
				signal?.throwIfAborted();
				const { done, value } = await reader.read();
				signal?.throwIfAborted();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > MAX_RESPONSE_BYTES) throw new JevError("invalid_response", "Jev response exceeds the local size limit");
				chunks.push(value);
			}
		} catch (error) {
			cancel();
			throw error;
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
		return new Response(Buffer.concat(chunks), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

function classify(error: unknown, signal: AbortSignal): JevError {
	if (signal.aborted) return interrupted(signal);
	if (error instanceof JevError) return error;
	if (error instanceof APIUserAbortError) return new JevError("cancelled", "Jev request cancelled");
	if (error instanceof APITimeoutError) return new JevError("timeout", "Jev request timed out");
	if (error instanceof RateLimitError) return new JevError("rate_limit", "Jev rate limited the request");
	if (error instanceof AuthenticationError) return new JevError("key_rejected", "TypeSafe rejected the API key");
	// The SDK wraps transport failures; only our own fixed errors are unwrapped.
	if (error instanceof APIConnectionError && error.cause instanceof JevError) return error.cause;
	if (error instanceof APIConnectionError) return new JevError("network", "Jev connection failed");
	if (error instanceof APIError) return new JevError("service", "Jev service returned an error");
	return new JevError("error", "Jev request failed");
}

/** Releases the caller even if an injected transport ignores abort. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		work.catch(() => {});
		return Promise.reject(interrupted(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(interrupted(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
	});
}

function normalizeUsage(value: unknown): JevUsage | undefined {
	if (!isRecord(value)) return undefined;
	const input = value.input_tokens;
	const output = value.output_tokens;
	return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 &&
		typeof output === "number" && Number.isSafeInteger(output) && output >= 0
		? { inputTokens: input, outputTokens: output }
		: undefined;
}

export function createJevOpener(options: { agentDir: string; fetch?: Fetch }): OpenJev {
	return async (signal) => {
		const settings = await raceAbort(loadSettings(options.agentDir, signal), signal);
		const apiKey = await raceAbort(loadKey(options.agentDir, settings, signal), signal);
		// Explicit settings override TYPESAFE_BASE_URL / TYPESAFE_LOG_LEVEL.
		const client = new TypeSafeClient({
			apiKey,
			baseURL: OFFICIAL_BASE_URL,
			defaultModel: settings.model,
			logLevel: "off",
			timeout: settings.timeoutMs,
			retry: { maxRetries: 1, backoffInitialMs: 250, backoffMaxMs: 1_000, maxRetryAfterMs: 1_000 },
			fetch: guardedFetch(options.fetch ?? ((url, init) => globalThis.fetch(url, init))),
		});
		return {
			model: settings.model,
			async ask(state, questions, askSignal) {
				try {
					const result = await raceAbort(Promise.resolve(client.systemOne(
						{ model: settings.model, state: state as never, questions },
						{ signal: askSignal },
					)), askSignal);
					const raw = result as unknown;
					if (!isRecord(raw) || !isRecord(raw.answers)) {
						throw new JevError("invalid_response", "Jev response has no answers");
					}
					const usage = normalizeUsage(raw.usage);
					return {
						...(typeof raw.model === "string" && MODEL_PATTERN.test(raw.model) ? { model: raw.model } : {}),
						answers: raw.answers,
						...(usage ? { usage } : {}),
					};
				} catch (error) {
					throw classify(error, askSignal);
				}
			},
		};
	};
}
