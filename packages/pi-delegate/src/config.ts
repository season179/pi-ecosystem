/**
 * Optional config at <agentDir>/delegate.json. Missing file → defaults.
 * A present-but-invalid file fails extension load loudly (ecosystem taste:
 * a typo'd config should never silently fall back to defaults).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DelegateConfig {
	/** Worker model as provider/id. */
	workerModel: string;
	/** Worker wall-clock cap in ms. */
	workerTimeoutMs: number;
	/** Verify command cap in ms. */
	verifyTimeoutMs: number;
	/** JSONL file receiving one record per delegation. */
	telemetryPath: string;
}

export const CONFIG_FILENAME = "delegate.json";

export class ConfigError extends Error {}

export function defaultConfig(agentDir: string): DelegateConfig {
	return {
		workerModel: "zai/glm-5.2",
		workerTimeoutMs: 10 * 60 * 1000,
		verifyTimeoutMs: 5 * 60 * 1000,
		telemetryPath: path.join(agentDir, "delegate-telemetry.jsonl"),
	};
}

function expandTilde(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

export function loadConfig(agentDir: string): DelegateConfig {
	const defaults = defaultConfig(agentDir);
	const configPath = path.join(agentDir, CONFIG_FILENAME);
	if (!fs.existsSync(configPath)) return defaults;

	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (error) {
		throw new ConfigError(`${configPath} is not valid JSON: ${error instanceof Error ? error.message : error}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new ConfigError(`${configPath} must contain a JSON object`);
	}

	const overrides = raw as Record<string, unknown>;
	for (const key of Object.keys(overrides)) {
		if (!(key in defaults)) {
			throw new ConfigError(`${configPath}: unknown key "${key}" (valid: ${Object.keys(defaults).join(", ")})`);
		}
	}

	const config = { ...defaults, ...overrides } as DelegateConfig;

	if (typeof config.workerModel !== "string" || !config.workerModel.trim()) {
		throw new ConfigError(`${configPath}: workerModel must be a non-empty string (provider/id)`);
	}
	for (const key of ["workerTimeoutMs", "verifyTimeoutMs"] as const) {
		if (typeof config[key] !== "number" || !Number.isFinite(config[key]) || config[key] <= 0) {
			throw new ConfigError(`${configPath}: ${key} must be a positive number of milliseconds`);
		}
	}
	if (typeof config.telemetryPath !== "string" || !config.telemetryPath.trim()) {
		throw new ConfigError(`${configPath}: telemetryPath must be a non-empty string`);
	}
	config.telemetryPath = expandTilde(config.telemetryPath);

	return config;
}
