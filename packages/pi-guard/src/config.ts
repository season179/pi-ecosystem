import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ReviewerConfig {
	model?: string;
	timeoutMs: number;
	maxTokens: number;
}

export interface GuardConfig {
	cwd: string;
	mode: "intent";
	globalConfigPath: string;
	projectConfigPath: string;
	protectedPaths: string[];
	reviewer: ReviewerConfig;
	warnings: string[];
}

interface GlobalConfigInput {
	protectedPaths?: string[];
	reviewer?: Partial<ReviewerConfig>;
	warnings: string[];
}

interface ProjectConfigInput {
	protectedPaths?: string[];
	warnings: string[];
}

const DEFAULT_PROTECTED_PATHS = [".git", ".pi/guard.json", ".env", ".env.*"];
const DEFAULT_REVIEWER: ReviewerConfig = {
	timeoutMs: 30_000,
	maxTokens: 256,
};

export function guardConfigPaths(cwd: string): {
	globalConfigPath: string;
	projectConfigPath: string;
} {
	return {
		globalConfigPath: join(getAgentDir(), "pi-guard.json"),
		projectConfigPath: join(cwd, ".pi", "guard.json"),
	};
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must contain a JSON object`);
	}
	return value as Record<string, unknown>;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${label} must be an array of strings`);
	}
	return [...value];
}

function parseReviewer(value: unknown): {
	reviewer?: Partial<ReviewerConfig>;
	warnings: string[];
} {
	if (value === undefined) return { warnings: [] };
	const raw = assertObject(value, "reviewer");
	const warnings: string[] = [];
	if (raw.mode !== undefined) {
		warnings.push("reviewer.mode is obsolete; Pi Guard now always enforces intent review");
	}
	if (raw.model !== undefined && typeof raw.model !== "string") {
		throw new Error("reviewer.model must be a provider/model string");
	}
	for (const key of ["timeoutMs", "maxTokens"] as const) {
		if (
			raw[key] !== undefined &&
			(typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] <= 0)
		) {
			throw new Error(`reviewer.${key} must be a positive number`);
		}
	}
	return {
		reviewer: {
			model: raw.model as string | undefined,
			timeoutMs: raw.timeoutMs as number | undefined,
			maxTokens: raw.maxTokens as number | undefined,
		},
		warnings,
	};
}

export function parseGlobalConfig(value: unknown): GlobalConfigInput {
	const input = assertObject(value, "Global pi-guard config");
	const warnings: string[] = [];
	for (const obsolete of ["mode", "shell", "trustedTools"] as const) {
		if (input[obsolete] !== undefined) {
			warnings.push(`${obsolete} is obsolete and ignored by intent-review mode`);
		}
	}
	const parsedReviewer = parseReviewer(input.reviewer);
	warnings.push(...parsedReviewer.warnings);
	return {
		protectedPaths: optionalStringArray(input.protectedPaths, "protectedPaths"),
		reviewer: parsedReviewer.reviewer,
		warnings,
	};
}

export function parseProjectConfig(value: unknown): ProjectConfigInput {
	const input = assertObject(value, "Project pi-guard config");
	for (const forbidden of ["mode", "reviewer", "trustedTools"] as const) {
		if (input[forbidden] !== undefined) {
			throw new Error(`Project pi-guard config cannot configure ${forbidden}`);
		}
	}
	const warnings: string[] = [];
	if (input.shell !== undefined) {
		warnings.push("project shell restrictions are obsolete and ignored by intent-review mode");
	}
	return {
		protectedPaths: optionalStringArray(input.protectedPaths, "protectedPaths"),
		warnings,
	};
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

export async function loadGuardConfig(cwd: string): Promise<GuardConfig> {
	const paths = guardConfigPaths(cwd);
	const globalRaw = await readJsonIfPresent(paths.globalConfigPath);
	const projectRaw = await readJsonIfPresent(paths.projectConfigPath);
	const global = globalRaw === undefined ? { warnings: [] } : parseGlobalConfig(globalRaw);
	const project = projectRaw === undefined ? { warnings: [] } : parseProjectConfig(projectRaw);
	return {
		cwd,
		mode: "intent",
		...paths,
		protectedPaths: unique([
			...DEFAULT_PROTECTED_PATHS,
			...(global.protectedPaths ?? []),
			...(project.protectedPaths ?? []),
		]),
		reviewer: { ...DEFAULT_REVIEWER, ...(global.reviewer ?? {}) },
		warnings: unique([...global.warnings, ...project.warnings]),
	};
}
