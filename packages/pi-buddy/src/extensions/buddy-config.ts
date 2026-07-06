import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const BUDDY_CONFIG_FILENAME = "buddy.json";

export interface BuddyModelCandidate {
	id: string;
	priority: number;
	label?: string;
}

export interface BuddyConfigLoadResult {
	path: string;
	found: boolean;
	models: BuddyModelCandidate[];
	perModelRetries?: number;
	warnings: string[];
}

type ReadTextFile = (path: string, encoding: "utf8") => Promise<string>;

export function buddyConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, BUDDY_CONFIG_FILENAME);
}

export async function loadBuddyConfig(
	path = buddyConfigPath(),
	readTextFile: ReadTextFile = readFile,
): Promise<BuddyConfigLoadResult> {
	let raw: string;
	try {
		raw = await readTextFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) {
			return { path, found: false, models: [], warnings: [] };
		}
		return {
			path,
			found: false,
			models: [],
			warnings: [`Could not read ${path}: ${errorToString(error)}`],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			path,
			found: true,
			models: [],
			warnings: [`Could not parse ${path}: ${errorToString(error)}`],
		};
	}

	return parseBuddyConfig(parsed, path);
}

export function parseBuddyConfig(
	value: unknown,
	path = BUDDY_CONFIG_FILENAME,
): BuddyConfigLoadResult {
	const warnings: string[] = [];
	if (!isRecord(value)) {
		return {
			path,
			found: true,
			models: [],
			warnings: [`${path} must contain a JSON object.`],
		};
	}

	const models = parseModels(value.models, path, warnings);
	const perModelRetries = parsePerModelRetries(value.retry, path, warnings);
	return { path, found: true, models, perModelRetries, warnings };
}

function parseModels(
	value: unknown,
	path: string,
	warnings: string[],
): BuddyModelCandidate[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		warnings.push(`${path}: "models" must be an array.`);
		return [];
	}
	const candidates: BuddyModelCandidate[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < value.length; i += 1) {
		const item = value[i];
		const prefix = `${path}: models[${i}]`;
		if (!isRecord(item)) {
			warnings.push(`${prefix} must be an object.`);
			continue;
		}
		const id = typeof item.id === "string" ? item.id.trim() : "";
		if (!isValidModelSpec(id)) {
			warnings.push(
				`${prefix}.id must be provider/model, e.g. zai/glm-5.2.`,
			);
			continue;
		}
		if (seen.has(id)) {
			warnings.push(`${prefix}.id duplicates ${id}; ignoring duplicate.`);
			continue;
		}
		const priority = item.priority;
		if (
			typeof priority !== "number" ||
			!Number.isFinite(priority) ||
			!Number.isInteger(priority)
		) {
			warnings.push(`${prefix}.priority must be an integer.`);
			continue;
		}
		const label = typeof item.label === "string" ? item.label.trim() : "";
		candidates.push({
			id,
			priority,
			...(label ? { label } : {}),
		});
		seen.add(id);
	}
	return candidates.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function parsePerModelRetries(
	value: unknown,
	path: string,
	warnings: string[],
): number | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		warnings.push(`${path}: "retry" must be an object.`);
		return undefined;
	}
	const retries = value.perModelRetries;
	if (retries === undefined) return undefined;
	if (
		typeof retries !== "number" ||
		!Number.isFinite(retries) ||
		!Number.isInteger(retries) ||
		retries < 0
	) {
		warnings.push(`${path}: retry.perModelRetries must be a non-negative integer.`);
		return undefined;
	}
	return retries;
}

export function isValidModelSpec(spec: string): boolean {
	const slash = spec.indexOf("/");
	return slash > 0 && slash < spec.length - 1;
}

export function splitModelSpec(spec: string): { provider: string; id: string } {
	if (!isValidModelSpec(spec)) {
		throw new Error(`Invalid buddy model "${spec}" — expected provider/id`);
	}
	const slash = spec.indexOf("/");
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
