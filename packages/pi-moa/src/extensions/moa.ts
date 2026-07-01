import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { loadMoAConfig } from "./config.js";
import { streamMoA } from "./orchestrator.js";
import type { MoAConfig } from "./types.js";

const MOA_API = "moa-api" as Api;
const MOA_BASE_URL = "https://moa.invalid";

export default function setup(pi: ExtensionAPI): void {
	let registry: ModelRegistry | undefined;
	const config = loadMoAConfig(process.cwd());

	pi.on("turn_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
	});

	pi.registerProvider("moa", {
		name: "Mixture of Agents",
		baseUrl: MOA_BASE_URL,
		apiKey: "moa-synthetic",
		api: MOA_API,
		models: buildSyntheticModels(config),
		streamSimple: (model, context, options) => {
			if (!registry) {
				throw new Error("MoA model registry is not available yet");
			}
			return streamMoA(model, context, options, registry, config);
		},
	});
}

export function buildSyntheticModels(config: MoAConfig): ProviderModelConfig[] {
	return Object.entries(config.presets)
		.filter(([, preset]) => preset.enabled)
		.map(([presetName]) => ({
			id: presetName,
			name: `MoA ${formatPresetName(presetName)}`,
			api: MOA_API,
			baseUrl: MOA_BASE_URL,
			reasoning: false,
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

function formatPresetName(presetName: string): string {
	return presetName
		.split(/[-_\s]+/)
		.filter((part) => part.length > 0)
		.map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
		.join(" ");
}
