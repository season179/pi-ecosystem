/** Retry helpers for transient buddy model/provider failures. */

const RETRIABLE_STATUS = /\b(?:408|425|429|500|502|503|504)\b/;
const RETRIABLE_TEXT =
	/(?:rate\s*limit|too\s*many\s*requests|overload(?:ed)?|temporar(?:y|ily)|timeout|timed?\s*out|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/i;

export const FOREGROUND_RETRY_ATTEMPTS = 2;
export const WATCHDOG_RETRY_ATTEMPTS = 2;
export const RETRY_BASE_DELAY_MS = 1500;
export const RETRY_JITTER_MS = 500;

export type BuddyErrorKind =
	| "auth"
	| "model"
	| "rate_limit"
	| "timeout"
	| "server"
	| "network"
	| "retriable"
	| "other";

export function isRetriableBuddyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return RETRIABLE_STATUS.test(message) || RETRIABLE_TEXT.test(message);
}

export function classifyBuddyError(error: unknown): BuddyErrorKind {
	const message = error instanceof Error ? error.message : String(error);
	if (/(?:auth(?:entication)? failed|unauthorized|invalid api key|\b401\b|\b403\b)/i.test(message)) {
		return "auth";
	}
	if (/(?:model .*not found|unknown model|invalid buddy model|expected provider\/id|model registry)/i.test(message)) {
		return "model";
	}
	if (/(?:rate\s*limit|too\s*many\s*requests|\b429\b)/i.test(message)) {
		return "rate_limit";
	}
	if (/(?:timeout|timed?\s*out|ETIMEDOUT|\b408\b|\b425\b)/i.test(message)) {
		return "timeout";
	}
	if (/(?:ECONNRESET|EAI_AGAIN)/i.test(message)) {
		return "network";
	}
	if (/\b(?:500|502|503|504)\b/.test(message)) {
		return "server";
	}
	if (isRetriableBuddyError(error)) return "retriable";
	return "other";
}

export function retryDelayMs(random = Math.random): number {
	return RETRY_BASE_DELAY_MS + Math.floor(random() * RETRY_JITTER_MS);
}

export function buddyRetryAttemptsForSource(source: string): number {
	return source === "watchdog"
		? WATCHDOG_RETRY_ATTEMPTS
		: FOREGROUND_RETRY_ATTEMPTS;
}

export function formatRetriableBuddyFailure(): string {
	return "Buddy review skipped: model was busy after retry.";
}

export async function delayWithAbort(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (!signal) {
		// Foreground/background callers normally pass a signal; this branch keeps
		// the helper usable in tests and other contexts with no abort channel.
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}
	if (signal.aborted) throw new Error("Buddy retry aborted");
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(cleanupResolve, ms);
		function cleanupResolve(): void {
			signal?.removeEventListener("abort", cleanupReject);
			resolve();
		}
		function cleanupReject(): void {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", cleanupReject);
			reject(new Error("Buddy retry aborted"));
		}
		signal.addEventListener("abort", cleanupReject, { once: true });
	});
}
