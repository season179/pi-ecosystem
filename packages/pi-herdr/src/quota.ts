/**
 * Built-in Codex quota check: a thin, fresh read of the same usage endpoint
 * the Codex CLI itself calls, authenticated with the OAuth token Codex CLI
 * already stores on disk. Deliberately minimal — no cache, no background
 * polling, no refresh-token handling, no account binding, and no quota
 * arithmetic (the removed collector's mistakes are not repeated here).
 *
 * The access token exists in memory only for the duration of one call; it
 * never appears in snapshots, error messages, or telemetry. Errors are safe
 * to show: they carry status codes and remediation hints, never credentials.
 */

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
	if (!isRecord(value)) return undefined;
	const usedPercent = value.used_percent;
	const windowSeconds = value.limit_window_seconds;
	const resetAfterSeconds = value.reset_after_seconds;
	if (
		typeof usedPercent !== "number" ||
		typeof windowSeconds !== "number" ||
		typeof resetAfterSeconds !== "number"
	) {
		return undefined;
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
	if (typeof allowed !== "boolean" && primary === undefined && secondary === undefined) {
		throw new Error("Codex usage endpoint returned an unrecognized response shape");
	}
	const planType = root.plan_type;
	return {
		checkedAt,
		allowed: allowed === true,
		limitReached: rateLimit.limit_reached === true,
		...(primary !== undefined ? { primary } : {}),
		...(secondary !== undefined ? { secondary } : {}),
		...(typeof planType === "string" && planType.length > 0 ? { planType } : {}),
	};
}

/**
 * Fetch and normalize one Codex quota observation. Throws plain `Error`s with
 * remediation hints; every message is safe to surface (no token contents).
 */
export async function fetchCodexQuota(
	options: FetchCodexQuotaOptions = {},
): Promise<QuotaSnapshot> {
	const authPath = options.authPath ?? defaultAuthPath();
	const url = options.url ?? DEFAULT_USAGE_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		if (name === "TimeoutError" || name === "AbortError") {
			throw new Error(`Codex usage request timed out after ${timeoutMs}ms`);
		}
		throw new Error(
			`Codex usage request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
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
		throw new Error("Codex usage endpoint returned invalid JSON");
	}
	return normalizeUsage(payload, new Date().toISOString());
}
