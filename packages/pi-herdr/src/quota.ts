/** On-demand Codex usage from the local CLI login; no polling or token refresh. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QuotaSnapshot, QuotaWindow } from "./types.js";

const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchCodexQuotaOptions {
	/** Default: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
	authPath?: string;
	/** Default: the ChatGPT backend usage endpoint used by the Codex CLI. */
	url?: string;
	/** Default 10 000 ms; the request aborts (and errors) past it. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

function defaultAuthPath(): string {
	const codexHome = process.env.CODEX_HOME;
	return join(
		codexHome !== undefined && codexHome.length > 0
			? codexHome
			: join(homedir(), ".codex"),
		"auth.json",
	);
}

interface AuthTokens {
	accessToken: string;
	accountId?: string;
}

function readAuthTokens(authPath: string): AuthTokens {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		throw new Error(
			`Codex CLI credentials not found or unreadable at ${authPath}; run \`codex login\``,
		);
	}
	const tokens =
		typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>).tokens
			: undefined;
	const accessToken =
		typeof tokens === "object" && tokens !== null
			? (tokens as Record<string, unknown>).access_token
			: undefined;
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new Error(
			`no Codex OAuth access token in ${authPath}; run \`codex login\``,
		);
	}
	const accountId =
		typeof tokens === "object" &&
		tokens !== null &&
		typeof (tokens as Record<string, unknown>).account_id === "string"
			? ((tokens as Record<string, unknown>).account_id as string)
			: undefined;
	return { accessToken, accountId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWindow(value: unknown): QuotaWindow | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new Error("Codex usage endpoint returned an invalid window");
	const usedPercent = value.used_percent;
	const windowSeconds = value.limit_window_seconds;
	const resetAfterSeconds = value.reset_after_seconds;
	if (
		typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 ||
		typeof windowSeconds !== "number" || !Number.isFinite(windowSeconds) || windowSeconds <= 0 ||
		typeof resetAfterSeconds !== "number" || !Number.isFinite(resetAfterSeconds) || resetAfterSeconds < 0
	) {
		throw new Error("Codex usage endpoint returned an invalid window");
	}
	return { usedPercent, windowSeconds, resetAfterSeconds };
}

/** Whitelist the known fields; tolerate both observed response shapes. */
function normalizeUsage(payload: unknown, checkedAt: string): QuotaSnapshot {
	const root = isRecord(payload) ? payload : {};
	const rateLimit = isRecord(root.rate_limit) ? root.rate_limit : root;
	const primary = normalizeWindow(rateLimit.primary_window);
	const secondary = normalizeWindow(rateLimit.secondary_window);
	const allowed = rateLimit.allowed;
	const limitReached = rateLimit.limit_reached;
	if (typeof allowed !== "boolean" || typeof limitReached !== "boolean") {
		throw new Error("Codex usage endpoint returned an unrecognized response shape");
	}
	const planType = root.plan_type;
	return {
		checkedAt,
		allowed,
		limitReached,
		...(primary !== undefined ? { primary } : {}),
		...(secondary !== undefined ? { secondary } : {}),
		...(typeof planType === "string" && planType.length > 0 ? { planType } : {}),
	};
}

/** Returns only usage fields; transport errors must not expose credentials. */
export async function fetchCodexQuota(
	options: FetchCodexQuotaOptions = {},
): Promise<QuotaSnapshot> {
	const authPath = options.authPath ?? defaultAuthPath();
	const url = options.url ?? DEFAULT_USAGE_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const interruption = (): Error | undefined => {
		if (options.signal?.aborted) return new Error("Codex usage request cancelled");
		if (timeout.aborted) return new Error(`Codex usage request timed out after ${timeoutMs}ms`);
		return undefined;
	};
	const cancelled = interruption();
	if (cancelled) throw cancelled;
	const doFetch = options.fetchImpl ?? fetch;
	const { accessToken, accountId } = readAuthTokens(authPath);

	let response: Response;
	try {
		response = await doFetch(url, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...(accountId !== undefined
					? { "ChatGPT-Account-ID": accountId }
					: {}),
				Accept: "application/json",
			},
			signal,
		});
	} catch {
		// Native header errors can quote the entire Authorization value.
		throw interruption() ?? new Error("Codex usage request failed; check connectivity and Codex login");
	}

	if (response.status === 401 || response.status === 403) {
		throw new Error(
			`Codex access token expired or rejected (HTTP ${response.status}); open codex or run \`codex login\` to refresh it`,
		);
	}
	if (!response.ok) {
		throw new Error(`Codex usage endpoint returned HTTP ${response.status}`);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw interruption() ?? new Error("Codex usage endpoint returned invalid JSON");
	}
	return normalizeUsage(payload, new Date().toISOString());
}
