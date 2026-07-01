import type { Api } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ModelRegistry,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { loadMoAConfig } from "./config.js";
import { MOA_REFERENCE_THINKING_MARKER } from "./messages.js";
import { streamMoA } from "./orchestrator.js";
import type { MoAConfig } from "./types.js";

const MOA_API = "moa-api" as Api;
const MOA_BASE_URL = "https://moa.invalid";

export default function setup(pi: ExtensionAPI): void {
	let registry: ModelRegistry | undefined;
	const config = loadMoAConfig(process.cwd());

	// The MoA provider emits its reference outputs as a leading, sentinel-tagged
	// thinking block so they render above the aggregator's answer. That block is
	// display-only: strip it from every model's context before the call so it never
	// re-enters the conversation the model sees. The aggregator already received
	// the references as private guidance on its own turn, so nothing is lost.
	// Filtering by the sentinel leaves the aggregator's own thinking — and every
	// other message — untouched.
	//
	// Note: compaction and branch-summarization call convertToLlm directly and
	// bypass this handler; a residual "[Assistant thinking]" placeholder can appear
	// in those summaries. That is accepted — the references are advisory, non-secret,
	// and this is a single-user tool.
	pi.on("context", (event) => ({
		messages: event.messages.map((message) => {
			if (message.role !== "assistant") return message;
			const content = message.content.filter(
				(block) =>
					!(
						block.type === "thinking" &&
						block.thinking.startsWith(MOA_REFERENCE_THINKING_MARKER)
					),
			);
			return content.length === message.content.length
				? message
				: { ...message, content };
		}),
	}));

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
