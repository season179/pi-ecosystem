/** On-demand Claude subscription usage from the local Claude Code login. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface ClaudeQuotaWindow {
	label: string;
	usedPercent: number;
	resetsAt: string | null;
}

export interface ClaudeQuotaSnapshot {
	checkedAt: string;
	windows: ClaudeQuotaWindow[];
}

interface FetchClaudeQuotaOptions {
	authPath?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readAccessToken(authPath: string | undefined, signal: AbortSignal): Promise<string> {
	const configDir = process.env.CLAUDE_CONFIG_DIR;
	let text: string;
	try {
		if (authPath || configDir || process.platform !== "darwin") {
			// Custom profiles must never fall back to the default account's Keychain entry.
			text = await readFile(authPath ?? join(configDir || join(homedir(), ".claude"), ".credentials.json"), { encoding: "utf8", signal });
		} else {
			text = await new Promise<string>((resolve, reject) => {
				execFile("/usr/bin/security", [
					"find-generic-password", "-s", "Claude Code-credentials", "-w",
				], { encoding: "utf8", signal, timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
					if (error) reject(error);
					else resolve(stdout);
				});
			});
		}
	} catch {
		throw new Error("Claude Code credentials unavailable; check the credential file or Keychain access and run `claude auth login`");
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("Claude Code credentials are invalid; run `claude auth login`");
	}
	const oauth = isRecord(data) && isRecord(data.claudeAiOauth) ? data.claudeAiOauth : undefined;
	if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.trim()) {
		throw new Error("No Claude Code OAuth login found; run `claude auth login`");
	}
	return oauth.accessToken;
}

function parseWindow(label: string, percent: unknown, reset: unknown): ClaudeQuotaWindow {
	if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 ||
		(reset !== null && (typeof reset !== "string" || !Number.isFinite(Date.parse(reset))))) {
		throw new Error("Claude usage endpoint returned an invalid quota window");
	}
	return { label, usedPercent: percent, resetsAt: reset === null ? null : new Date(reset as string).toISOString() };
}

function scopeName(value: unknown): string | undefined {
	const name = typeof value === "string" ? value
		: isRecord(value) ? value.display_name ?? value.id : undefined;
	return typeof name === "string" && name.trim()
		? name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120) : undefined;
}

function normalizeUsage(payload: unknown): ClaudeQuotaSnapshot {
	if (!isRecord(payload)) throw new Error("Claude usage endpoint returned an unrecognized response");
	const windows: ClaudeQuotaWindow[] = [];
	for (const [key, label] of [["five_hour", "5h"], ["seven_day", "Weekly"]]) {
		const value = payload[key];
		if (value === undefined || value === null) continue;
		if (!isRecord(value)) throw new Error("Claude usage endpoint returned an invalid quota window");
		windows.push(parseWindow(label, value.utilization, value.resets_at));
	}
	if (payload.limits !== undefined && payload.limits !== null) {
		if (!Array.isArray(payload.limits) || payload.limits.length > 50) {
			throw new Error("Claude usage endpoint returned invalid scoped limits");
		}
		for (const limit of payload.limits) {
			if (!isRecord(limit)) throw new Error("Claude usage endpoint returned an invalid scoped limit");
			if (limit.kind !== "weekly_scoped") continue;
			const scope = isRecord(limit.scope) ? limit.scope : {};
			const model = scopeName(scope.model);
			const surface = scopeName(scope.surface);
			const label = `Weekly (${[model, surface].filter(Boolean).join(" / ") || "scoped"})`;
			windows.push(parseWindow(label, limit.percent, limit.resets_at));
		}
	}
	if (windows.length === 0) throw new Error("Claude usage is unavailable: no quota windows reported");
	return { checkedAt: new Date().toISOString(), windows };
}

export async function fetchClaudeQuota(options: FetchClaudeQuotaOptions = {}): Promise<ClaudeQuotaSnapshot> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const interruption = (): Error | undefined => {
		if (options.signal?.aborted) return new Error("Claude quota check cancelled");
		if (timeout.aborted) return new Error(`Claude quota check timed out after ${timeoutMs}ms`);
		return undefined;
	};
	const cancelled = interruption();
	if (cancelled) throw cancelled;
	let token: string;
	try {
		token = await readAccessToken(options.authPath, signal);
	} catch (error) {
		// readAccessToken emits only fixed, credential-safe errors.
		throw interruption() ?? error;
	}
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				Accept: "application/json",
				"User-Agent": "pi-herdr",
			},
			signal,
		});
	} catch {
		throw interruption() ?? new Error("Claude usage request failed; check connectivity and Claude Code login");
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error(`Claude login expired or lacks usage access (HTTP ${response.status}); run \`claude auth login\``);
	}
	if (response.status === 429) throw new Error("Claude usage temporarily unavailable (HTTP 429); try again later");
	if (!response.ok) throw new Error(`Claude usage endpoint returned HTTP ${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw interruption() ?? new Error("Claude usage endpoint returned invalid JSON");
	}
	return normalizeUsage(payload);
}

export function formatClaudeQuota(snapshot: ClaudeQuotaSnapshot): string {
	return [`Claude usage checked ${snapshot.checkedAt}`, ...snapshot.windows.map(window =>
		`${window.label}: ${window.usedPercent}% used; ${window.resetsAt ? `resets ${window.resetsAt}` : "reset unknown"}`,
	)].join("\n");
}
