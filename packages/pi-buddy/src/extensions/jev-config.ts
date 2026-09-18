import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface JevConfig {
	model: string;
	timeoutMs: number;
	skipThreshold: number;
	auditEvery: number;
	apiKeyFile?: string;
}
export type JevConfigResult =
	| { kind: "disabled" }
	| { kind: "fallback"; reason: "config" }
	| { kind: "enabled"; config: JevConfig };

/** Shared typesafe.json; only the Buddy section is owned here. */
export async function loadJevConfig(agentDir = getAgentDir()): Promise<JevConfigResult> {
	let raw: string;
	try {
		raw = await readFile(resolve(agentDir, "typesafe.json"), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "disabled" } : { kind: "fallback", reason: "config" };
	}
	try {
		const value = JSON.parse(raw);
		if (!object(value)) throw new Error();
		if (value.buddy === undefined) return { kind: "disabled" };
		if (!object(value.buddy)) throw new Error();
		if (value.buddy.enabled === undefined || value.buddy.enabled === false) return { kind: "disabled" };
		if (value.buddy.enabled !== true) throw new Error();
		const model = value.model ?? "jev-1.13.0";
		const timeoutMs = value.timeoutMs ?? 3000;
		const skipThreshold = value.buddy.skipThreshold ?? 0.85;
		const auditEvery = value.buddy.auditEvery ?? 5;
		if (typeof model !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(model) ||
			!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
			typeof skipThreshold !== "number" || !Number.isFinite(skipThreshold) || skipThreshold < 0.5 || skipThreshold > 1 ||
			!Number.isInteger(auditEvery) || auditEvery < 1 || auditEvery > 100 ||
			(value.apiKeyFile !== undefined && (typeof value.apiKeyFile !== "string" || !value.apiKeyFile.trim()))) throw new Error();
		return { kind: "enabled", config: { model, timeoutMs, skipThreshold, auditEvery, apiKeyFile: value.apiKeyFile } };
	} catch {
		return { kind: "fallback", reason: "config" };
	}
}

/** Read anew per decision: installing the key file requires no process restart. */
export async function loadJevKey(config: JevConfig, agentDir = getAgentDir()): Promise<string | undefined> {
	const envKey = process.env.TYPESAFE_API_KEY?.trim();
	if (envKey) return envKey;
	if (!config.apiKeyFile) return undefined;
	try {
		return (await readFile(resolve(agentDir, config.apiKeyFile), "utf8")).trim() || undefined;
	} catch {
		return undefined;
	}
}

function object(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
