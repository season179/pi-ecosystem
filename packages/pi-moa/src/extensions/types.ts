import type {
	Api,
	CacheRetention,
	Context,
	Model,
	OpenRouterRouting,
	ThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";

export interface ModelSlot {
	provider: string;
	model: string;
}

export interface MoAPreset {
	enabled: boolean;
	referenceModels: ModelSlot[];
	aggregator: ModelSlot;
	referenceConcurrency?: number;
	referenceQuorum?: number;
	maxReferences?: number;
	maxReferenceOutputChars?: number;
	referenceMaxContextChars?: number;
	referenceToolResultMaxChars?: number;
	referenceToolResultTailChars?: number;
	referenceMaxTokens?: number;
	referenceTimeoutMs?: number;
	referenceReasoning?: ThinkingLevel;
	referenceProviderRouting?: OpenRouterRouting;
	referenceMaxRetries?: number;
	referenceCacheRetention?: CacheRetention;
	referenceCadence?: "every-turn" | "user-turn";
	referenceTemperature?: number;
	aggregatorTemperature?: number;
	aggregatorReasoning?: ThinkingLevel;
	aggregatorGuidancePlacement?: "latest-user" | "trailing-message";
	aggregatorCacheRetention?: CacheRetention;
	aggregatorProviderRouting?: OpenRouterRouting;
	aggregatorPrewarm?: boolean;
	streamAggregator?: boolean;
	streamReferences?: boolean;
	failOnReferenceError?: boolean;
}

export interface MoAConfig {
	defaultPreset: string;
	presets: Record<string, MoAPreset>;
	// When set, appends one JSON line of per-turn timing/usage metadata (no prompt
	// or completion text) to this file. Unset = no timers, no writes.
	telemetryPath?: string;
}

export interface ReferenceOutput {
	slot: ModelSlot;
	success: boolean;
	text: string;
	usage?: Usage;
	errorMessage?: string;
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
