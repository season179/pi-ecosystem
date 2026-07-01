import type {
	Api,
	CacheRetention,
	Context,
	Model,
	OpenRouterRouting,
	ThinkingBudgets,
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
	referenceMaxTokens?: number;
	referenceTimeoutMs?: number;
	referenceReasoning?: ThinkingLevel;
	referenceThinkingBudgets?: ThinkingBudgets;
	referenceProviderRouting?: OpenRouterRouting;
	referenceMaxRetries?: number;
	referenceCacheRetention?: CacheRetention;
	referenceTemperature?: number;
	aggregatorTemperature?: number;
	aggregatorReasoning?: ThinkingLevel;
	aggregatorThinkingBudgets?: ThinkingBudgets;
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
