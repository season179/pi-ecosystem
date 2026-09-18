import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint } from "../engine/identity.js";
import { DEFAULT_PAIR_DROPPABLE_TOOLS } from "../engine/policy.js";

export interface CompactionConfig {
	/** Default enablement for new sessions; `/compaction on|off` overrides per branch. */
	enabled: boolean;
	/** Minimum keep probability for a call or result to stay. Lower keeps more. */
	keepThreshold: number;
	/** Newest assistant tool-call groups (calls plus results) never pruned, across user turns. */
	protectRecentGroups: number;
	/** Estimated token ceiling for the Jev state. */
	maxStateTokens: number;
	/** Estimated token ceiling for state plus one batch of questions. */
	maxRequestTokens: number;
	maxCandidatesPerBatch: number;
	concurrency: number;
	/** Per-request timeout in milliseconds. */
	timeoutMs: number;
	/** Total scoring budget per pass in milliseconds. */
	deadlineMs: number;
	/** Fraction of estimated savings credited when predicting headroom. */
	savingsFactor: number;
	/** Fixed tokens kept free below Pi's compaction threshold. */
	marginTokens: number;
	/** Additional margin as a fraction of the context window. */
	marginFraction: number;
	/** Minimum milliseconds between scoring passes on one branch. */
	scoringCooldownMs: number;
	/** Jev model name; undefined uses the SDK default. */
	model?: string;
	/** Tools whose completed calls may be removed together with their results. */
	pairDroppableTools: string[];
}

export const DEFAULT_CONFIG: CompactionConfig = {
	enabled: false,
	keepThreshold: 0.35,
	protectRecentGroups: 4,
	maxStateTokens: 20_000,
	maxRequestTokens: 28_000,
	maxCandidatesPerBatch: 24,
	concurrency: 2,
	timeoutMs: 8_000,
	deadlineMs: 20_000,
	savingsFactor: 0.8,
	marginTokens: 1_024,
	marginFraction: 0.05,
	scoringCooldownMs: 15_000,
	pairDroppableTools: [...DEFAULT_PAIR_DROPPABLE_TOOLS],
};

export const CONFIG_FILE_NAME = "pi-compaction.json";

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export interface LoadedConfig {
	config: CompactionConfig;
	source: "file" | "defaults";
	/** Human-readable validation problems; offending fields fall back to defaults. */
	problems: string[];
}

interface Range {
	min: number;
	max: number;
	integer?: boolean;
}

const NUMERIC_FIELDS: Record<Exclude<keyof CompactionConfig, "enabled" | "model" | "pairDroppableTools">, Range> = {
	keepThreshold: { min: 0, max: 1 },
	protectRecentGroups: { min: 1, max: 500, integer: true },
	maxStateTokens: { min: 1_000, max: 100_000, integer: true },
	maxRequestTokens: { min: 2_000, max: 120_000, integer: true },
	maxCandidatesPerBatch: { min: 1, max: 200, integer: true },
	concurrency: { min: 1, max: 4, integer: true },
	timeoutMs: { min: 500, max: 60_000, integer: true },
	deadlineMs: { min: 1_000, max: 120_000, integer: true },
	savingsFactor: { min: 0, max: 1 },
	marginTokens: { min: 0, max: 200_000, integer: true },
	marginFraction: { min: 0, max: 0.5 },
	scoringCooldownMs: { min: 0, max: 3_600_000, integer: true },
};

export function parseConfig(raw: unknown): { config: CompactionConfig; problems: string[] } {
	const problems: string[] = [];
	const config: CompactionConfig = { ...DEFAULT_CONFIG, pairDroppableTools: [...DEFAULT_CONFIG.pairDroppableTools] };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		if (raw !== undefined) problems.push("config must be a JSON object");
		return { config, problems };
	}
	const record = raw as Record<string, unknown>;
	if (record.enabled !== undefined) {
		if (typeof record.enabled === "boolean") config.enabled = record.enabled;
		else problems.push("enabled must be a boolean");
	}
	for (const [key, range] of Object.entries(NUMERIC_FIELDS) as Array<[keyof typeof NUMERIC_FIELDS, Range]>) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < range.min || value > range.max || (range.integer && !Number.isInteger(value))) {
			problems.push(`${key} must be a number in [${range.min}, ${range.max}]${range.integer ? " (integer)" : ""}`);
			continue;
		}
		(config as unknown as Record<string, number>)[key] = value;
	}
	if (record.model !== undefined) {
		if (typeof record.model === "string" && record.model.trim()) config.model = record.model.trim();
		else problems.push("model must be a non-empty string");
	}
	if (record.pairDroppableTools !== undefined) {
		if (Array.isArray(record.pairDroppableTools) && record.pairDroppableTools.every((item) => typeof item === "string")) {
			config.pairDroppableTools = [...new Set(record.pairDroppableTools as string[])];
		} else problems.push("pairDroppableTools must be an array of tool names");
	}
	if (config.maxRequestTokens <= config.maxStateTokens) {
		problems.push("maxRequestTokens must exceed maxStateTokens; using defaults for both");
		config.maxStateTokens = DEFAULT_CONFIG.maxStateTokens;
		config.maxRequestTokens = DEFAULT_CONFIG.maxRequestTokens;
	}
	return { config, problems };
}

export async function loadConfig(agentDir: string): Promise<LoadedConfig> {
	let text: string;
	try {
		text = await readFile(configPath(agentDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: parseConfig(undefined).config, source: "defaults", problems: [] };
		return { config: parseConfig(undefined).config, source: "defaults", problems: ["config file could not be read"] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { config: parseConfig(undefined).config, source: "defaults", problems: ["config file is not valid JSON"] };
	}
	const parsed = parseConfig(raw);
	return { config: parsed.config, source: "file", problems: parsed.problems };
}

/** Fingerprint of the decision-relevant configuration (excludes enablement and transport knobs). */
export function configFingerprint(config: CompactionConfig): string {
	return fingerprint({
		keepThreshold: config.keepThreshold,
		protectRecentGroups: config.protectRecentGroups,
		maxStateTokens: config.maxStateTokens,
		model: config.model ?? null,
		pairDroppableTools: [...config.pairDroppableTools].sort(),
	});
}
