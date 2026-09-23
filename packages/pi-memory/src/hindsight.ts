import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Minimal Hindsight HTTP client (API 0.10.x): recall and async retain only.
//
// Every call has a hard deadline and honors caller cancellation. Responses are
// size-bounded and shape-validated. Errors are classified without payloads so
// diagnostics never echo memory content or server bodies. Nothing here retries:
// a timed-out retain may already have been accepted, so repeating it could
// duplicate memory.
// ---------------------------------------------------------------------------

export type HindsightFetch = (input: string, init: RequestInit) => Promise<Response>;

export const HINDSIGHT_RESPONSE_MAX_BYTES = 512 * 1024;

export interface HindsightTarget {
	/** Loopback base URL, validated by the automation config. */
	url: string;
	bank: string;
}

export interface RecalledMemory {
	id: string;
	text: string;
	type?: string;
	mentionedAt?: string;
	/** Tags exactly as returned; undefined when the server returned none. */
	tags?: string[];
	/** String metadata as returned (raw facts only; observations carry none). */
	metadata?: Record<string, string>;
}

/** Hindsight 0.10 compound tag filter (tag_groups); groups in a list are AND-ed. */
export type TagGroup =
	| { tags: string[]; match: "any" | "all" | "any_strict" | "all_strict" | "exact" }
	| { or: TagGroup[] }
	| { and: TagGroup[] };

export type HindsightErrorKind = "timeout" | "unreachable" | "http" | "malformed";

export type HindsightOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; kind: "aborted" }
	/** `ambiguous`: the request may have reached the server (a write may have been accepted). */
	| { ok: false; kind: HindsightErrorKind; detail: string; ambiguous: boolean };

interface CallOptions {
	fetch: HindsightFetch;
	timeoutMs: number;
	signal?: AbortSignal;
}

function bankPath(target: HindsightTarget, suffix: string): string {
	return `${target.url.replace(/\/+$/u, "")}/v1/default/banks/${encodeURIComponent(target.bank)}/${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function postJson(url: string, body: unknown, options: CallOptions): Promise<HindsightOutcome<unknown>> {
	if (options.signal?.aborted) return { ok: false, kind: "aborted" };
	const controller = new AbortController();
	let timedOut = false;
	let sent = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs);
	const forwardAbort = () => controller.abort();
	options.signal?.addEventListener("abort", forwardAbort, { once: true });
	let rejectHard!: (error: Error) => void;
	const hardWall = new Promise<never>((_resolve, reject) => {
		rejectHard = reject;
	});
	hardWall.catch(() => undefined);
	controller.signal.addEventListener("abort", () => rejectHard(new Error("aborted")), { once: true });
	try {
		const run = async (): Promise<HindsightOutcome<unknown>> => {
			sent = true;
			const response = await options.fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			const text = await response.text();
			if (!response.ok) {
				return { ok: false, kind: "http", detail: `HTTP ${response.status}`, ambiguous: response.status >= 500 };
			}
			if (Buffer.byteLength(text, "utf8") > HINDSIGHT_RESPONSE_MAX_BYTES) {
				return { ok: false, kind: "malformed", detail: "response too large", ambiguous: true };
			}
			try {
				return { ok: true, value: JSON.parse(text) as unknown };
			} catch {
				return { ok: false, kind: "malformed", detail: "invalid JSON", ambiguous: true };
			}
		};
		// Race a hard wall so a transport that ignores the signal cannot hang us.
		return await Promise.race([run(), hardWall]);
	} catch (error) {
		if (options.signal?.aborted && !timedOut) return { ok: false, kind: "aborted" };
		if (timedOut) return { ok: false, kind: "timeout", detail: `no response within ${options.timeoutMs} ms`, ambiguous: sent };
		const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
		// Connection refused/reset before a response: nothing was accepted.
		return { ok: false, kind: "unreachable", detail: typeof code === "string" ? code : "connection failed", ambiguous: false };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", forwardAbort);
	}
}

export interface RecallParams {
	query: string;
	maxTokens: number;
	maxResults: number;
	tagGroups?: TagGroup[];
}

/** Read-only recall; results are validated and bounded, never trusted as instructions. */
export async function hindsightRecall(
	target: HindsightTarget,
	params: RecallParams,
	options: CallOptions,
): Promise<HindsightOutcome<RecalledMemory[]>> {
	const outcome = await postJson(
		bankPath(target, "memories/recall"),
		{
			query: params.query,
			budget: "low",
			max_tokens: params.maxTokens,
			// Chunks and source facts are not tag-filtered server-side: never request them.
			include: { entities: null, chunks: null, source_facts: null },
			...(params.tagGroups !== undefined ? { tag_groups: params.tagGroups } : {}),
		},
		options,
	);
	// 0.10.1 answers 404 for a bank nobody created yet; retain creates it lazily.
	// An empty result (not an outage) keeps the first retain from being blocked.
	if (!outcome.ok && outcome.kind === "http" && outcome.detail === "HTTP 404") return { ok: true, value: [] };
	if (!outcome.ok) return outcome;
	const results = isRecord(outcome.value) ? outcome.value.results : undefined;
	if (!Array.isArray(results)) return { ok: false, kind: "malformed", detail: "missing results", ambiguous: false };
	const memories: RecalledMemory[] = [];
	for (const item of results) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.text !== "string") {
			return { ok: false, kind: "malformed", detail: "invalid result item", ambiguous: false };
		}
		const text = item.text.trim();
		if (text === "") continue;
		memories.push({
			id: item.id,
			text,
			...(typeof item.type === "string" ? { type: item.type } : {}),
			...(typeof item.mentioned_at === "string" ? { mentionedAt: item.mentioned_at } : {}),
			...(Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string") ? { tags: item.tags as string[] } : {}),
			...(isRecord(item.metadata)
				? {
						metadata: Object.fromEntries(
							Object.entries(item.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
						),
					}
				: {}),
		});
		if (memories.length >= params.maxResults) break;
	}
	return { ok: true, value: memories };
}

export interface RetainItem {
	content: string;
	context: string;
	metadata: Record<string, string>;
	tags: string[];
	timestamp: string;
}

export interface RetainAccepted {
	/** Client-generated idempotency id sent with the request. */
	operationId: string;
	/** True when the server acknowledged asynchronous processing (queued, not yet stored). */
	queued: boolean;
}

/**
 * Submit one async retain of independent items. Each item gets its own fresh
 * random document_id: without explicit ids Hindsight groups every item of a
 * request into one generated document, and a fresh id can never match (and so
 * never replace) an existing document.
 */
export async function hindsightRetain(
	target: HindsightTarget,
	items: readonly RetainItem[],
	options: CallOptions,
): Promise<HindsightOutcome<RetainAccepted> & { operationId: string }> {
	const operationId = randomUUID();
	const outcome = await postJson(
		bankPath(target, "memories"),
		{
			items: items.map((item) => ({
				content: item.content,
				context: item.context,
				metadata: item.metadata,
				tags: item.tags,
				timestamp: item.timestamp,
				document_id: `pi-memory-auto-${randomUUID()}`,
				observation_scopes: "combined",
			})),
			async: true,
			operation_id: operationId,
		},
		options,
	);
	if (!outcome.ok) return { ...outcome, operationId };
	const value = outcome.value;
	if (!isRecord(value) || value.success !== true) {
		return { ok: false, kind: "malformed", detail: "retain not acknowledged", ambiguous: true, operationId };
	}
	return { ok: true, value: { operationId, queued: value.async === true }, operationId };
}
