import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { loadMoAConfig } from "./config.js";
import { renderReferenceOutputs } from "./display.js";
import { buildReferenceDisplayContent, MOA_REFERENCE_CUSTOM_TYPE } from "./messages.js";
import { streamMoA } from "./orchestrator.js";
import type { MoAConfig, MoAReferenceDisplayDetails } from "./types.js";

const MOA_API = "moa-api" as Api;
const MOA_BASE_URL = "https://moa.invalid";

export default function setup(pi: ExtensionAPI): void {
	let registry: ModelRegistry | undefined;
	const config = loadMoAConfig(process.cwd());

	// Reference outputs computed during a MoA turn are stashed here, then flushed
	// as display-only custom messages once the agent goes idle.
	const pendingReferenceDisplays: MoAReferenceDisplayDetails[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	// Render the reference-outputs custom message as a distinct, collapsible block
	// instead of prepending a marker-delimited blob onto the aggregator's answer.
	pi.registerMessageRenderer<MoAReferenceDisplayDetails>(MOA_REFERENCE_CUSTOM_TYPE, renderReferenceOutputs);

	// Keep reference-output messages out of every model's context. They are
	// display-only; the aggregator already received the references as private
	// system guidance during its own turn. Filtering by structural identity
	// (role + customType) replaces the old HTML-comment marker stripping.
	pi.on("context", (event) => ({
		messages: event.messages.filter(
			(message) => !(message.role === "custom" && message.customType === MOA_REFERENCE_CUSTOM_TYPE),
		),
	}));

	pi.on("turn_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
	});

	// Cancel any scheduled flush and drop stashed outputs when the session tears
	// down (resume/reload/switch/exit) so a deferred timer never fires against a
	// stale session.
	pi.on("session_shutdown", () => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		pendingReferenceDisplays.length = 0;
	});

	// Flush stashed reference outputs after the agent loop ends. Deferred to a
	// macrotask, and only sent while the agent is idle: when idle with
	// triggerTurn:false, sendMessage takes a pure display-append path (no LLM
	// turn, no steering). If a follow-up turn has already started streaming by the
	// time the timer fires, sending would steer the block INTO that turn (reaching
	// the model), so we leave the outputs pending and let the next agent_end retry.
	// Only one flush is scheduled at a time; it splices inside the timer so nothing
	// is lost if more outputs arrive first.
	pi.on("agent_end", (_event, ctx) => {
		if (pendingReferenceDisplays.length === 0 || flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			if (pendingReferenceDisplays.length === 0 || !ctx.isIdle()) return;
			for (const details of pendingReferenceDisplays.splice(0)) {
				try {
					pi.sendMessage(
						{ customType: MOA_REFERENCE_CUSTOM_TYPE, content: buildReferenceDisplayContent(details), display: true, details },
						{ triggerTurn: false },
					);
				} catch {
					// A late flush after teardown is best-effort; never crash the turn.
				}
			}
		}, 0);
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
			return streamMoA(model, context, options, registry, config, {
				onReferenceOutputs: (details) => pendingReferenceDisplays.push(details),
			});
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
