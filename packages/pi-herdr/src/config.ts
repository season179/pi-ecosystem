/**
 * Loads `~/.pi/agent/herdr.json` (the optional pi-herdr config) into a
 * validated `HerdrConfig`. Synchronous and strict: any deviation from the
 * contract (unknown key, wrong type, unparseable JSON) throws `ConfigError`
 * so misconfiguration is loud, not silent.
 *
 * Missing file yields a deep copy of `DEFAULT_CONFIG` (callers may mutate it
 * freely). The leading `~/` in `telemetryPath` is expanded to `os.homedir()`
 * so the value is ready to hand straight to `appendTelemetry`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./types.js";
import type { HerdrConfig } from "./types.js";

export const DEFAULT_CONFIG: HerdrConfig = {
	maxWatches: 8,
	wakeBudget: 20,
	includeTailLines: 20,
	toastOn: ["blocked"],
	telemetryPath: "~/.pi/agent/herdr-telemetry.jsonl",
};

const CONFIG_FILENAME = "herdr.json";

const KNOWN_KEYS = [
	"maxWatches",
	"wakeBudget",
	"includeTailLines",
	"toastOn",
	"telemetryPath",
] as const;
const KNOWN_KEY_SET: ReadonlySet<string> = new Set(KNOWN_KEYS);

export function loadHerdrConfig(agentDir: string): HerdrConfig {
	const path = join(agentDir, CONFIG_FILENAME);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (isENOENT(error)) {
			const defaults = cloneDefaults();
			defaults.telemetryPath = expandTilde(defaults.telemetryPath);
			return defaults;
		}
		throw new ConfigError(`Could not read ${path}: ${errorToString(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ConfigError(`${path} is not valid JSON: ${errorToString(error)}`);
	}

	if (!isRecord(parsed)) {
		throw new ConfigError(`${path} must contain a JSON object.`);
	}

	for (const key of Object.keys(parsed)) {
		if (!KNOWN_KEY_SET.has(key)) {
			throw new ConfigError(
				`Unknown key "${key}" in ${path}; allowed keys are ${KNOWN_KEYS.join(", ")}.`,
			);
		}
	}

	const result = cloneDefaults();

	if (parsed.maxWatches !== undefined) {
		if (!isNonNegativeInteger(parsed.maxWatches)) {
			throw new ConfigError(
				`${path}: "maxWatches" must be a non-negative integer, got ${describe(parsed.maxWatches)}.`,
			);
		}
		result.maxWatches = parsed.maxWatches;
	}

	if (parsed.wakeBudget !== undefined) {
		if (!isNonNegativeInteger(parsed.wakeBudget)) {
			throw new ConfigError(
				`${path}: "wakeBudget" must be a non-negative integer, got ${describe(parsed.wakeBudget)}.`,
			);
		}
		result.wakeBudget = parsed.wakeBudget;
	}

	if (parsed.includeTailLines !== undefined) {
		if (!isNonNegativeInteger(parsed.includeTailLines)) {
			throw new ConfigError(
				`${path}: "includeTailLines" must be a non-negative integer, got ${describe(parsed.includeTailLines)}.`,
			);
		}
		result.includeTailLines = parsed.includeTailLines;
	}

	if (parsed.toastOn !== undefined) {
		if (!isStringArray(parsed.toastOn)) {
			throw new ConfigError(
				`${path}: "toastOn" must be an array of strings, got ${describe(parsed.toastOn)}.`,
			);
		}
		result.toastOn = [...parsed.toastOn];
	}

	if (parsed.telemetryPath !== undefined) {
		if (typeof parsed.telemetryPath !== "string") {
			throw new ConfigError(
				`${path}: "telemetryPath" must be a string, got ${describe(parsed.telemetryPath)}.`,
			);
		}
		result.telemetryPath = parsed.telemetryPath;
	}

	result.telemetryPath = expandTilde(result.telemetryPath);
	return result;
}

/** Fresh deep copy of the defaults so callers can mutate without surprise. */
function cloneDefaults(): HerdrConfig {
	return {
		maxWatches: DEFAULT_CONFIG.maxWatches,
		wakeBudget: DEFAULT_CONFIG.wakeBudget,
		includeTailLines: DEFAULT_CONFIG.includeTailLines,
		toastOn: [...DEFAULT_CONFIG.toastOn],
		telemetryPath: DEFAULT_CONFIG.telemetryPath,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isENOENT(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isInteger(value) &&
		value >= 0
	);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

/** Expand a leading `~/` (or a bare `~`) to the user's home directory. */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
