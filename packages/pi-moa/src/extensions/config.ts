import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	MoAConfig,
	MoAPreset,
	ModelSlot,
	ReferenceToolName,
} from "./types.js";

const DEFAULT_MAX_REFERENCES = 8;
const DEFAULT_REFERENCE_CONCURRENCY = 4;
const DEFAULT_MAX_REFERENCE_OUTPUT_CHARS = 2000;

// Shown when no moa.json exists: the smallest config that passes validation,
// as a copy-paste starting point. The provider/model pairs must name models
// that exist in pi's own model registry.
const MINIMAL_MOA_CONFIG_EXAMPLE = `{
  "defaultPreset": "default",
  "presets": {
    "default": {
      "enabled": true,
      "referenceModels": [
        { "provider": "openrouter", "model": "anthropic/claude-haiku-4.5" }
      ],
      "aggregator": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" }
    }
  }
}`;

// moa.json is compulsory by design: there is no bundled default config, so
// which models advise and aggregate is always an explicit user decision. A
// missing or invalid config throws here, setup() propagates it, and pi turns
// a failed extension load into a fatal startup diagnostic — the app refuses
// to run rather than running with models the user never chose.
export function loadMoAConfig(cwd: string): MoAConfig {
	const projectPath = join(cwd, ".pi", "moa.json");
	if (existsSync(projectPath)) {
		return readMoAConfig(projectPath);
	}

	const globalPath = join(getGlobalConfigDir(), "moa.json");
	if (existsSync(globalPath)) {
		return readMoAConfig(globalPath);
	}

	throw new Error(
		[
			"MoA requires a moa.json config file and none was found. Searched:",
			`  - ${projectPath} (project)`,
			`  - ${globalPath} (global)`,
			"Create one with at least one enabled preset. Minimal example:",
			MINIMAL_MOA_CONFIG_EXAMPLE,
		].join("\n"),
	);
}

function getGlobalConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readMoAConfig(path: string): MoAConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse MoA config at ${path}: ${message}`);
	}

	// Validation messages name the offending field; add WHICH file is bad so
	// the user can go fix it directly.
	try {
		validateMoAConfig(parsed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid MoA config at ${path} — ${message}`);
	}
	return parsed;
}

export function validateMoAConfig(config: unknown): asserts config is MoAConfig {
	if (!isRecord(config)) {
		throw new Error("MoA config: expected an object");
	}
	if (!isNonEmptyString(config.defaultPreset)) {
		throw new Error('MoA config: "defaultPreset" must be a non-empty string');
	}
	if (!isRecord(config.presets) || Object.keys(config.presets).length === 0) {
		throw new Error('MoA config: "presets" must be a non-empty object');
	}
	if (!isRecord(config.presets[config.defaultPreset])) {
		throw new Error(`MoA config: defaultPreset "${config.defaultPreset}" does not exist in presets`);
	}
	if (config.telemetryPath !== undefined && !isNonEmptyString(config.telemetryPath)) {
		throw new Error('MoA config: "telemetryPath" must be a non-empty string');
	}
	if (
		config.telemetryMaxBytes !== undefined &&
		(typeof config.telemetryMaxBytes !== "number" ||
			!Number.isInteger(config.telemetryMaxBytes) ||
			config.telemetryMaxBytes < 0)
	) {
		throw new Error('MoA config: "telemetryMaxBytes" must be a non-negative integer');
	}

	for (const [presetName, preset] of Object.entries(config.presets)) {
		validatePreset(presetName, preset);
	}
}

export function getPreset(config: MoAConfig, name: string): MoAPreset {
	const preset = config.presets[name];
	if (!preset) {
		throw new Error(`MoA preset "${name}" does not exist`);
	}
	if (!preset.enabled) {
		throw new Error(`MoA preset "${name}" is disabled`);
	}
	return preset;
}

export function getMaxReferences(preset: MoAPreset): number {
	return preset.maxReferences ?? DEFAULT_MAX_REFERENCES;
}

export function getReferenceConcurrency(preset: MoAPreset): number {
	return preset.referenceConcurrency ?? DEFAULT_REFERENCE_CONCURRENCY;
}

export function getMaxReferenceOutputChars(preset: MoAPreset): number {
	return preset.maxReferenceOutputChars ?? DEFAULT_MAX_REFERENCE_OUTPUT_CHARS;
}

function validatePreset(presetName: string, value: unknown): asserts value is MoAPreset {
	if (!isRecord(value)) {
		throw new Error(`MoA preset "${presetName}": expected an object`);
	}
	if (typeof value.enabled !== "boolean") {
		throw new Error(`MoA preset "${presetName}": "enabled" must be a boolean`);
	}
	if (!Array.isArray(value.referenceModels)) {
		throw new Error(`MoA preset "${presetName}": "referenceModels" must be an array`);
	}
	if (value.referenceModels.length === 0) {
		throw new Error(`MoA preset "${presetName}": "referenceModels" must contain at least one model`);
	}
	if (!isRecord(value.aggregator)) {
		throw new Error(`MoA preset "${presetName}": "aggregator" is required`);
	}

	const maxReferences =
		readOptionalPositiveInteger(value.maxReferences, presetName, "maxReferences") ?? DEFAULT_MAX_REFERENCES;
	if (value.referenceModels.length > maxReferences) {
		throw new Error(
			`MoA preset "${presetName}": "referenceModels" length ${value.referenceModels.length} exceeds "maxReferences" ${maxReferences}`,
		);
	}

	readOptionalMinimumInteger(value.maxReferenceOutputChars, presetName, "maxReferenceOutputChars", 200);
	readOptionalMinimumInteger(value.referenceMaxContextChars, presetName, "referenceMaxContextChars", 500);
	readOptionalMinimumInteger(value.referenceToolResultMaxChars, presetName, "referenceToolResultMaxChars", 200);
	// Minimum 1, not 0: truncateWithHeadTail keeps the LAST `tailChars` via
	// `text.slice(-tailChars)`, and `slice(-0)` === `slice(0)` would keep the WHOLE
	// string — so a 0 tail would defeat the truncation instead of dropping the tail.
	readOptionalMinimumInteger(value.referenceToolResultTailChars, presetName, "referenceToolResultTailChars", 1);
	readOptionalPositiveInteger(value.referenceMaxTokens, presetName, "referenceMaxTokens");
	readOptionalPositiveInteger(value.referenceTimeoutMs, presetName, "referenceTimeoutMs");
	// maxRetries of 0 (disable client-side retries entirely) is meaningful, so this
	// is a non-negative — not positive — integer.
	readOptionalMinimumInteger(value.referenceMaxRetries, presetName, "referenceMaxRetries", 0);
	readOptionalEnum(value.referenceReasoning, presetName, "referenceReasoning", THINKING_LEVELS);
	readOptionalEnum(value.aggregatorReasoning, presetName, "aggregatorReasoning", THINKING_LEVELS);
	const referenceConcurrency = readOptionalPositiveInteger(
		value.referenceConcurrency,
		presetName,
		"referenceConcurrency",
	);
	if (referenceConcurrency !== undefined && referenceConcurrency > maxReferences) {
		throw new Error(
			`MoA preset "${presetName}": "referenceConcurrency" must be less than or equal to "maxReferences"`,
		);
	}
	const referenceQuorum = readOptionalPositiveInteger(
		value.referenceQuorum,
		presetName,
		"referenceQuorum",
	);
	if (referenceQuorum !== undefined && referenceQuorum > value.referenceModels.length) {
		throw new Error(
			`MoA preset "${presetName}": "referenceQuorum" must be less than or equal to the number of "referenceModels"`,
		);
	}
	readOptionalNumber(value.referenceTemperature, presetName, "referenceTemperature");
	readOptionalNumber(value.aggregatorTemperature, presetName, "aggregatorTemperature");
	readOptionalEnum(
		value.aggregatorGuidancePlacement,
		presetName,
		"aggregatorGuidancePlacement",
		GUIDANCE_PLACEMENTS,
	);
	readOptionalEnum(
		value.aggregatorCacheRetention,
		presetName,
		"aggregatorCacheRetention",
		CACHE_RETENTIONS,
	);
	readOptionalEnum(
		value.referenceCacheRetention,
		presetName,
		"referenceCacheRetention",
		CACHE_RETENTIONS,
	);
	readOptionalEnum(
		value.referenceCadence,
		presetName,
		"referenceCadence",
		REFERENCE_CADENCES,
	);
	readOptionalOpenRouterRouting(
		value.aggregatorProviderRouting,
		presetName,
		"aggregatorProviderRouting",
	);
	readOptionalOpenRouterRouting(
		value.referenceProviderRouting,
		presetName,
		"referenceProviderRouting",
	);
	readOptionalReferenceTools(value.referenceTools, presetName);
	if (value.referenceToolRounds !== undefined && value.referenceTools === undefined) {
		throw new Error(
			`MoA preset "${presetName}": "referenceToolRounds" requires "referenceTools"`,
		);
	}
	readOptionalPositiveInteger(
		value.referenceToolRounds,
		presetName,
		"referenceToolRounds",
	);
	readOptionalBoolean(value.aggregatorPrewarm, presetName, "aggregatorPrewarm");
	readOptionalBoolean(value.streamAggregator, presetName, "streamAggregator");
	readOptionalBoolean(value.streamReferences, presetName, "streamReferences");
	readOptionalBoolean(value.failOnReferenceError, presetName, "failOnReferenceError");

	value.referenceModels.forEach((slot, index) => {
		validateModelSlot(presetName, `referenceModels[${index}]`, slot);
	});
	validateModelSlot(presetName, "aggregator", value.aggregator);
}

function validateModelSlot(presetName: string, field: string, value: unknown): asserts value is ModelSlot {
	if (!isRecord(value)) {
		throw new Error(`MoA preset "${presetName}": "${field}" must be an object`);
	}
	if (!isNonEmptyString(value.provider)) {
		throw new Error(`MoA preset "${presetName}": "${field}.provider" must be a non-empty string`);
	}
	if (!isNonEmptyString(value.model)) {
		throw new Error(`MoA preset "${presetName}": "${field}.model" must be a non-empty string`);
	}
	if (value.provider === "moa") {
		throw new Error(`MoA preset "${presetName}": "${field}.provider" cannot be "moa"`);
	}
}

function readOptionalPositiveInteger(value: unknown, presetName: string, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
		throw new Error(`MoA preset "${presetName}": "${field}" must be an integer greater than or equal to 1`);
	}
	return value;
}

function readOptionalMinimumInteger(
	value: unknown,
	presetName: string,
	field: string,
	minimum: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || typeof value !== "number" || value < minimum) {
		throw new Error(`MoA preset "${presetName}": "${field}" must be an integer greater than or equal to ${minimum}`);
	}
	return value;
}

// The reasoning-effort knobs accept the same thinking levels as
// SimpleStreamOptions.reasoning. `referenceReasoning` applies only to reference
// requests (a reasoning-heavy reference can be told to think less — its thinking
// is discarded downstream anyway); `aggregatorReasoning` applies only to the
// aggregator, letting a preset pin the acting model's reasoning effort (the
// dominant per-turn latency cost) independent of whatever the caller passed.
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

// The aggregator-guidance-placement knob selects where the private reference
// guidance is injected into the aggregator's request. "latest-user" (default)
// appends it to the latest user message; "trailing-message" adds it as a new
// trailing user turn so the prior transcript stays a cacheable prefix across turns.
const GUIDANCE_PLACEMENTS = ["latest-user", "trailing-message"] as const;

// The cache-retention knobs set how long a request's provider is asked to keep its
// prompt cache alive. They map to the provider's cache-TTL hint (Anthropic-style
// `cache_control.ttl: "1h"`, OpenAI `prompt_cache_retention`), so "long" survives
// longer gaps between turns than the provider default "short" — cutting
// time-to-first-token when a tool run or a review pause exceeds the short TTL.
// `aggregatorCacheRetention` scopes it to the aggregator; `referenceCacheRetention`
// scopes it to every reference (references also re-prefill their shared, append-only
// transcript prefix on each tool-loop turn, so they can re-hit their own cache too).
// Both are pure cache-TTL hints: the generated output is byte-identical regardless.
const CACHE_RETENTIONS = ["none", "short", "long"] as const;

// The reference-cadence knob decides how often the reference phase runs in an
// agentic tool loop. "every-turn" (default) re-runs the references on every
// model turn as before; "user-turn" runs them only when the transcript ends on
// a fresh user message and reuses that turn's guidance on the tool-loop turns
// in between — taking the whole reference phase off those turns' critical path.
const REFERENCE_CADENCES = ["every-turn", "user-turn"] as const;

const REFERENCE_TOOL_NAMES = ["read", "grep", "find", "ls"] as const satisfies readonly ReferenceToolName[];

function readOptionalReferenceTools(value: unknown, presetName: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		throw new Error(`MoA preset "${presetName}": "referenceTools" must be an array`);
	}
	if (value.length === 0) {
		throw new Error(`MoA preset "${presetName}": "referenceTools" must contain at least one tool`);
	}
	const seen = new Set<string>();
	for (const [index, toolName] of value.entries()) {
		if (
			typeof toolName !== "string" ||
			!REFERENCE_TOOL_NAMES.includes(toolName as ReferenceToolName)
		) {
			throw new Error(
				`MoA preset "${presetName}": "referenceTools[${index}]" must be one of ${REFERENCE_TOOL_NAMES.join(", ")}`,
			);
		}
		if (seen.has(toolName)) {
			throw new Error(
				`MoA preset "${presetName}": "referenceTools" must not contain duplicate tool "${toolName}"`,
			);
		}
		seen.add(toolName);
	}
}

// The provider-routing knobs steer OpenRouter's upstream provider selection (a
// speed lever: `sort: "throughput"` / `"latency"` route to a faster backend).
// `aggregatorProviderRouting` pins the aggregator's request; `referenceProviderRouting`
// pins every reference's request (references sit on the aggregator-blocking critical
// path). Both are passthroughs to pi-ai's typed `OpenRouterRouting` field, so
// validation is deliberately light — confirm it is an object and, when the
// speed-relevant `sort` is given as a string, that it is one of the OpenRouter sort
// metrics (a silent typo there would just be ignored upstream). Every other routing
// field flows through and is validated by pi-ai/OpenRouter at request time rather than
// duplicated (and kept in sync) here.
const OPENROUTER_SORTS = ["price", "throughput", "latency"] as const;

function readOptionalOpenRouterRouting(value: unknown, presetName: string, field: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		throw new Error(`MoA preset "${presetName}": "${field}" must be an object`);
	}
	const sort = value.sort;
	if (typeof sort === "string" && !OPENROUTER_SORTS.includes(sort as never)) {
		throw new Error(
			`MoA preset "${presetName}": "${field}.sort" must be one of ${OPENROUTER_SORTS.join(", ")}`,
		);
	}
}

function readOptionalNumber(value: unknown, presetName: string, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`MoA preset "${presetName}": "${field}" must be a finite number`);
	}
	return value;
}

function readOptionalBoolean(value: unknown, presetName: string, field: string): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new Error(`MoA preset "${presetName}": "${field}" must be a boolean`);
	}
}

function readOptionalEnum(
	value: unknown,
	presetName: string,
	field: string,
	allowed: readonly string[],
): void {
	if (value === undefined) return;
	if (typeof value !== "string" || !allowed.includes(value)) {
		throw new Error(`MoA preset "${presetName}": "${field}" must be one of ${allowed.join(", ")}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
