/** On-demand personal Coding Plan quota from Z.ai's global usage endpoint. */
const USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

export interface ZaiQuotaWindow {
	type: "TOKENS_LIMIT" | "CREDIT_LIMIT" | "TIME_LIMIT";
	label: string;
	usedPercent: number;
	resetsAt: string | null;
	limit?: number;
	used?: number;
	remaining?: number;
}

export interface ZaiQuotaSnapshot {
	checkedAt: string;
	windows: ZaiQuotaWindow[];
}

interface FetchZaiQuotaOptions {
	getApiKey: () => Promise<string | undefined>;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUsage(payload: unknown): ZaiQuotaSnapshot {
	if (!isRecord(payload) || payload.success !== true || payload.code !== 200) {
		throw new Error("Z.ai usage request was rejected; check your API key and Coding Plan");
	}
	const limits = isRecord(payload.data) ? payload.data.limits : undefined;
	if (!Array.isArray(limits) || limits.length > 50) throw new Error("Z.ai usage endpoint returned invalid quota data");
	const windows: ZaiQuotaWindow[] = [];
	for (const raw of limits) {
		if (!isRecord(raw)) throw new Error("Z.ai usage endpoint returned an invalid limit");
		if (raw.type !== "TOKENS_LIMIT" && raw.type !== "CREDIT_LIMIT" && raw.type !== "TIME_LIMIT") continue;
		if (typeof raw.percentage !== "number" || !Number.isFinite(raw.percentage) || raw.percentage < 0 ||
			typeof raw.unit !== "number" || !Number.isInteger(raw.unit) ||
			typeof raw.number !== "number" || !Number.isInteger(raw.number) || raw.number <= 0) {
			throw new Error("Z.ai usage endpoint returned an invalid quota window");
		}
		const units: Record<number, string> = { 1: "day", 3: "hour", 5: "minute", 6: "week" };
		const unit = units[raw.unit];
		// TIME_LIMIT's 5/1 marker means monthly MCP, not one minute.
		const monthlyMcp = raw.type === "TIME_LIMIT" && raw.unit === 5 && raw.number === 1;
		const period = monthlyMcp ? "monthly" : unit
			? `${raw.number} ${unit}${raw.number === 1 ? "" : "s"}` : "period unknown";
		const category = raw.type === "TIME_LIMIT" ? "MCP calls" : raw.type === "CREDIT_LIMIT" ? "Coding credits" : "Coding";
		const reset = raw.nextResetTime;
		if (reset !== undefined && reset !== null &&
			(typeof reset !== "number" || !Number.isSafeInteger(reset) || reset <= 0 || !Number.isFinite(new Date(reset).getTime()))) {
			throw new Error("Z.ai usage endpoint returned an invalid reset time");
		}
		const window: ZaiQuotaWindow = {
			type: raw.type, label: `${category} (${period})`, usedPercent: raw.percentage,
			resetsAt: typeof reset === "number" ? new Date(reset).toISOString() : null,
		};
		for (const [source, target] of [["usage", "limit"], ["currentValue", "used"], ["remaining", "remaining"]] as const) {
			const value = raw[source];
			if (value === undefined || value === null) continue;
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
				throw new Error("Z.ai usage endpoint returned an invalid usage count");
			}
			window[target] = value;
		}
		windows.push(window);
	}
	if (windows.length === 0) throw new Error("Z.ai usage is unavailable: no recognized quota windows reported");
	return { checkedAt: new Date().toISOString(), windows };
}

export async function fetchZaiQuota(options: FetchZaiQuotaOptions): Promise<ZaiQuotaSnapshot> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const interruption = (): Error | undefined => {
		if (options.signal?.aborted) return new Error("Z.ai quota check cancelled");
		if (timeout.aborted) return new Error(`Z.ai quota check timed out after ${timeoutMs}ms`);
		return undefined;
	};
	const cancelled = interruption();
	if (cancelled) throw cancelled;
	// Pi's credential resolver has no signal parameter. Bound our wait and handle
	// late settlement without exposing its errors or starting a cancelled request.
	let onAbort: () => void = () => {};
	let key: string | undefined;
	try {
		key = await new Promise<string | undefined>((resolve, reject) => {
			onAbort = () => reject(interruption());
			signal.addEventListener("abort", onAbort, { once: true });
			Promise.resolve().then(options.getApiKey).then(resolve, () =>
				reject(new Error("Z.ai credentials unavailable; configure the zai provider in Pi")));
		});
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	const interrupted = interruption();
	if (interrupted) throw interrupted;
	if (typeof key !== "string" || !key.trim()) throw new Error("No Z.ai API key configured; log in to the zai provider in Pi");
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(USAGE_URL, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "pi-herdr" },
			signal,
		});
	} catch {
		throw interruption() ?? new Error("Z.ai usage request failed; check connectivity and provider credentials");
	}
	if (response.status === 401 || response.status === 403) throw new Error(`Z.ai API key rejected (HTTP ${response.status}); check the zai provider in Pi`);
	if (response.status === 429) throw new Error("Z.ai usage temporarily unavailable (HTTP 429); try again later");
	if (!response.ok) throw new Error(`Z.ai usage endpoint returned HTTP ${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw interruption() ?? new Error("Z.ai usage endpoint returned invalid JSON");
	}
	return normalizeUsage(payload);
}

export function formatZaiQuota(snapshot: ZaiQuotaSnapshot): string {
	return [`Z.ai usage checked ${snapshot.checkedAt}`, ...snapshot.windows.map(window => {
		const counts = window.used !== undefined && window.limit !== undefined ? ` (${window.used}/${window.limit})` : "";
		return `${window.label}: ${window.usedPercent}% used${counts}; ${window.resetsAt ? `resets ${window.resetsAt}` : "reset unknown"}`;
	})].join("\n");
}
