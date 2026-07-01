import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MoAConfig, MoAPreset, ModelSlot } from "./types.js";

const DEFAULT_MAX_REFERENCES = 8;
const DEFAULT_REFERENCE_CONCURRENCY = 4;
const DEFAULT_MAX_REFERENCE_OUTPUT_CHARS = 2000;
const DEFAULT_REFERENCE_MAX_TOKENS = 1024;

export const DEFAULT_MOA_CONFIG: MoAConfig = {
	defaultPreset: "default",
	presets: {
		default: {
			enabled: true,
			referenceModels: [
				{ provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
				{ provider: "openrouter", model: "google/gemini-3-flash-preview" },
			],
			aggregator: {
				provider: "openrouter",
				model: "anthropic/claude-sonnet-4.5",
			},
			referenceConcurrency: DEFAULT_REFERENCE_CONCURRENCY,
			maxReferences: DEFAULT_MAX_REFERENCES,
			maxReferenceOutputChars: DEFAULT_MAX_REFERENCE_OUTPUT_CHARS,
			// References are truncated to maxReferenceOutputChars (~500 tokens) before
			// they reach the aggregator or the display, so generation beyond that is
			// discarded. Cap it well above the kept budget: English/code advisory text
			// runs ~3-4 chars/token, so 2000 chars fits in <700 tokens — the kept text
			// is unchanged while verbose references stop early instead of running long.
			referenceMaxTokens: DEFAULT_REFERENCE_MAX_TOKENS,
			// Stream the shipped default end-to-end so the out-of-box experience gets the
			// perceived-latency win the validated streaming machinery enables. Both knobs
			// are DISPLAY-ONLY: the persisted `done` message (and thus next-turn model
			// context) is byte-identical to the buffered path either way — only WHEN the
			// live deltas surface differs. MoA registers as an ordinary provider, and pi's
			// agent loop already renders incremental content events from every real
			// streaming provider, so this just makes the default behave like a normal
			// streaming provider instead of buffering its whole turn.
			//
			// - streamReferences reveals the reference thinking block as it fills in (the
			//   header immediately, then each reference's advice on settle) instead of one
			//   burst after the phase; it self-protects, falling back to the atomic burst
			//   when referenceQuorum is set or a reference model is missing.
			// - streamAggregator forwards the aggregator's answer token-by-token, dropping
			//   time-to-first-token from the whole generation to the first token. The
			//   default "latest-user" guidance placement never creates the consecutive-user
			//   sequence, so the streaming path always runs on its primary attempt.
			//
			// The TYPE-level default stays unset (undefined ⇒ buffered), so only this
			// shipped preset opts in; a custom preset that omits the knobs is unaffected.
			streamReferences: true,
			streamAggregator: true,
			failOnReferenceError: false,
		},
	},
};

export function loadMoAConfig(cwd: string): MoAConfig {
	const projectPath = join(cwd, ".pi", "moa.json");
	if (existsSync(projectPath)) {
		return readMoAConfig(projectPath);
	}

	const globalPath = join(getGlobalConfigDir(), "moa.json");
	if (existsSync(globalPath)) {
		return readMoAConfig(globalPath);
	}

	validateMoAConfig(DEFAULT_MOA_CONFIG);
	return DEFAULT_MOA_CONFIG;
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

	validateMoAConfig(parsed);
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
	readOptionalPositiveInteger(value.referenceMaxTokens, presetName, "referenceMaxTokens");
	readOptionalPositiveInteger(value.referenceTimeoutMs, presetName, "referenceTimeoutMs");
	readOptionalThinkingLevel(value.referenceReasoning, presetName, "referenceReasoning");
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
	readOptionalGuidancePlacement(
		value.aggregatorGuidancePlacement,
		presetName,
		"aggregatorGuidancePlacement",
	);
	if (value.streamAggregator !== undefined && typeof value.streamAggregator !== "boolean") {
		throw new Error(`MoA preset "${presetName}": "streamAggregator" must be a boolean`);
	}
	if (value.streamReferences !== undefined && typeof value.streamReferences !== "boolean") {
		throw new Error(`MoA preset "${presetName}": "streamReferences" must be a boolean`);
	}
	if (value.failOnReferenceError !== undefined && typeof value.failOnReferenceError !== "boolean") {
		throw new Error(`MoA preset "${presetName}": "failOnReferenceError" must be a boolean`);
	}

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

// The reference-reasoning knob accepts the same thinking levels as
// SimpleStreamOptions.reasoning. It is applied only to reference requests, so a
// reasoning-heavy reference model can be told to think less (its thinking is
// discarded downstream anyway) without touching the aggregator's reasoning.
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

function readOptionalThinkingLevel(value: unknown, presetName: string, field: string): void {
	if (value === undefined) return;
	if (typeof value !== "string" || !THINKING_LEVELS.includes(value as never)) {
		throw new Error(
			`MoA preset "${presetName}": "${field}" must be one of ${THINKING_LEVELS.join(", ")}`,
		);
	}
}

// The aggregator-guidance-placement knob selects where the private reference
// guidance is injected into the aggregator's request. "latest-user" (default)
// appends it to the latest user message; "trailing-message" adds it as a new
// trailing user turn so the prior transcript stays a cacheable prefix across turns.
const GUIDANCE_PLACEMENTS = ["latest-user", "trailing-message"] as const;

function readOptionalGuidancePlacement(value: unknown, presetName: string, field: string): void {
	if (value === undefined) return;
	if (typeof value !== "string" || !GUIDANCE_PLACEMENTS.includes(value as never)) {
		throw new Error(
			`MoA preset "${presetName}": "${field}" must be one of ${GUIDANCE_PLACEMENTS.join(", ")}`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
