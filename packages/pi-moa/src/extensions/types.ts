import type { Api, Context, Model, Usage } from "@earendil-works/pi-ai";

export interface ModelSlot {
	provider: string;
	model: string;
}

export interface MoAPreset {
	enabled: boolean;
	referenceModels: ModelSlot[];
	aggregator: ModelSlot;
	referenceConcurrency?: number;
	maxReferences?: number;
	maxReferenceOutputChars?: number;
	referenceTemperature?: number;
	aggregatorTemperature?: number;
	failOnReferenceError?: boolean;
}

export interface MoAConfig {
	defaultPreset: string;
	presets: Record<string, MoAPreset>;
}

export interface ReferenceOutput {
	slot: ModelSlot;
	success: boolean;
	text: string;
	usage?: Usage;
	errorMessage?: string;
}

/** One reference model's result, shaped for display (truncated/redacted). */
export interface MoAReferenceDisplayOutput {
	provider: string;
	model: string;
	success: boolean;
	/** Advisory text when successful; empty when the reference failed. */
	text: string;
	/** Redacted, truncated error when the reference failed. */
	errorMessage?: string;
}

/**
 * Payload surfaced to the UI as a custom message (`MOA_REFERENCE_CUSTOM_TYPE`).
 * Carried in the custom message's `details`, which is never sent to any model.
 */
export interface MoAReferenceDisplayDetails {
	presetName: string;
	/** "provider/model" of the acting aggregator. */
	aggregator: string;
	outputs: MoAReferenceDisplayOutput[];
}

/** Optional side-channel callbacks threaded through the MoA stream. */
export interface MoAStreamHooks {
	/**
	 * Invoked once per aggregator step, after the reference outputs for that step
	 * are known and before the aggregator streams. The extension collects these
	 * and renders them as a display-only custom message once the turn is idle.
	 */
	onReferenceOutputs?: (details: MoAReferenceDisplayDetails) => void;
}

export interface ResolvedMoAPreset {
	name: string;
	preset: MoAPreset;
	referenceModels: Model<Api>[];
	aggregatorModel: Model<Api>;
}

export interface OrchestrationResult {
	referenceOutputs: ReferenceOutput[];
	guidanceBlock: string;
	aggregatorContext: Context;
}
