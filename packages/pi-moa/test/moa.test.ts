import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessageEvent,
	type Context,
	type completeSimple,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	Type,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	getPreset,
	loadMoAConfig,
	validateMoAConfig,
} from "../src/extensions/config.js";
import {
	appendGuidanceToLatestUser,
	buildGuidanceBlock,
	buildReferenceContext,
	buildReferenceThinkingText,
	injectGuidance,
	MOA_GUIDANCE_MARKER,
	MOA_REFERENCE_THINKING_MARKER,
	redactErrorMessage,
	renderReferenceContext,
	stripPriorMoAGuidanceMessages,
} from "../src/extensions/messages.js";
import setup, { buildSyntheticModels } from "../src/extensions/moa.js";
import {
	__resetReferenceGuidanceCacheForTests,
	__resetTrailingPlacementCacheForTests,
	beginProgressiveReferenceThinking,
	streamMoA,
} from "../src/extensions/orchestrator.js";
import {
	__setReferenceToolFactoryForTests,
	type ReferenceTool,
} from "../src/extensions/reference-tools.js";
import {
	createTurnTelemetry,
	TurnTelemetry,
} from "../src/extensions/telemetry.js";
import type {
	MoAConfig,
	MoAPreset,
	ModelSlot,
} from "../src/extensions/types.js";

type FauxRegistration = ReturnType<typeof registerFauxProvider>;

type AuthResult = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

interface RegistryEntry {
	model: Model<Api>;
	auth?: AuthResult;
}

const registrations: FauxRegistration[] = [];

afterEach(() => {
	__setReferenceToolFactoryForTests(undefined);
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function basePreset(overrides: Partial<MoAPreset> = {}): MoAPreset {
	return {
		enabled: true,
		referenceModels: [
			{ provider: "ref-a", model: "a" },
			{ provider: "ref-b", model: "b" },
		],
		aggregator: { provider: "agg", model: "main" },
		referenceConcurrency: 2,
		maxReferences: 4,
		maxReferenceOutputChars: 1000,
		failOnReferenceError: false,
		...overrides,
	};
}

function baseConfig(preset: MoAPreset = basePreset()): MoAConfig {
	return {
		defaultPreset: "default",
		presets: { default: preset },
	};
}

function createRegistry(entries: RegistryEntry[]): ModelRegistry {
	const map = new Map(
		entries.map((entry) => [
			`${entry.model.provider}:${entry.model.id}`,
			entry,
		]),
	);
	return {
		find(provider: string, modelId: string) {
			return map.get(`${provider}:${modelId}`)?.model;
		},
		async getApiKeyAndHeaders(model: Model<Api>) {
			return (
				map.get(`${model.provider}:${model.id}`)?.auth ?? {
					ok: true,
					apiKey: "test-key",
				}
			);
		},
	} as Pick<ModelRegistry, "find" | "getApiKeyAndHeaders"> as ModelRegistry;
}

function registerFaux(provider: string, modelId: string): FauxRegistration {
	const registration = registerFauxProvider({
		provider,
		models: [{ id: modelId, name: `${provider}/${modelId}` }],
	});
	registrations.push(registration);
	return registration;
}

// pi-ai's Model.compat is a conditional type that resolves to `never` for the faux
// provider's api, so read the routing through a structural cast — the same boundary
// cast the orchestrator uses when it writes the field.
function openRouterRoutingOf(model: Model<Api>): unknown {
	return (model as { compat?: { openRouterRouting?: unknown } }).compat
		?.openRouterRouting;
}

// The role-scoped knob tests share one scaffold: reference faux providers plus an
// aggregator, a single-user-turn context, and a streamMoA call whose responders
// capture what each role's request actually carried. `read` runs inside every
// responder with the exact (options, model) pi-moa handed to streamSimple; the
// returned values are index-aligned with the references. Throws if any responder
// never fired, so an `undefined` capture can only mean the request really carried
// no value.
async function captureRoleValues<T>(args: {
	callerOptions?: SimpleStreamOptions;
	preset?: Partial<MoAPreset>;
	referenceCount?: 1 | 2;
	read: (options: unknown, model: Model<Api>) => T;
}): Promise<{ references: T[]; aggregator: T }> {
	const slots = [
		{ provider: "ref-a", model: "a" },
		{ provider: "ref-b", model: "b" },
	].slice(0, args.referenceCount ?? 1);
	const fauxes = slots.map((slot) => registerFaux(slot.provider, slot.model));
	const agg = registerFaux("agg", "main");
	const references: T[] = [];
	const referenceFired = slots.map(() => false);
	let aggregator: T | undefined;
	let aggregatorFired = false;
	fauxes.forEach((faux, index) => {
		faux.setResponses([
			(_context, options, _state, model) => {
				references[index] = args.read(options, model);
				referenceFired[index] = true;
				return fauxAssistantMessage(`advice ${slots[index].model}`);
			},
		]);
	});
	agg.setResponses([
		(_context, options, _state, model) => {
			aggregator = args.read(options, model);
			aggregatorFired = true;
			return fauxAssistantMessage("final answer");
		},
	]);
	const registry = createRegistry([
		...fauxes.map((faux, index) => ({
			model: faux.getModel(slots[index].model)!,
		})),
		{ model: agg.getModel("main")! },
	]);
	await streamMoA(
		makeSyntheticMoAModel(agg.getModel("main")!),
		{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
		args.callerOptions,
		registry,
		baseConfig(basePreset({ referenceModels: slots, ...args.preset })),
	).result();
	if (!aggregatorFired || referenceFired.some((fired) => !fired)) {
		throw new Error("captureRoleValues: a faux responder never fired");
	}
	return { references, aggregator: aggregator as T };
}

async function collectEvents(
	stream: ReturnType<typeof streamMoA>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function textFromResult(
	result: Awaited<ReturnType<typeof completeSimple>>,
): string {
	return result.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

// The references are emitted as a leading thinking block on the aggregator's
// message. Concatenate the thinking text so assertions can search it — this is
// what the human sees above the answer, and what the `context` handler strips
// before the model is called again.
function thinkingFromResult(
	result: Awaited<ReturnType<typeof completeSimple>>,
): string {
	return result.content
		.flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
		.join("\n");
}

// Flatten a context's system prompt and message text into one searchable string,
// so a test can assert whether a given request carried the MoA guidance block.
function serializeContextText(context: Context): string {
	const chunks: string[] = [context.systemPrompt ?? ""];
	for (const message of context.messages) {
		const content = (message as { content: unknown }).content;
		if (typeof content === "string") {
			chunks.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (
					block &&
					typeof block === "object" &&
					"text" in block &&
					typeof (block as { text: unknown }).text === "string"
				) {
					chunks.push((block as { text: string }).text);
				}
			}
		}
	}
	return chunks.join("\n");
}

function makeSyntheticMoAModel(
	realModel: Model<Api>,
	presetName = "default",
): Model<Api> {
	return {
		...realModel,
		id: presetName,
		provider: "moa",
		api: "moa-api",
		baseUrl: "https://moa.invalid",
	};
}

function createTestReferenceTool(
	name: "read" | "grep" | "find" | "ls" = "read",
	execute: ReferenceTool["execute"] = async (_toolCallId, params) => ({
		content: [
			{
				type: "text",
				text: `tool result for ${name}: ${JSON.stringify(params)}`,
			},
		],
		details: undefined,
	}),
): ReferenceTool {
	return {
		name,
		description: `${name} test tool`,
		parameters: Type.Object({
			path: Type.Optional(Type.String()),
			pattern: Type.Optional(Type.String()),
		}),
		execute,
	};
}

describe("MoA compulsory config", () => {
	// moa.json is required: there is no bundled default config, so loading with
	// no file anywhere must fail loudly — pi turns the throwing setup() into a
	// fatal startup diagnostic.
	function withAgentDir<T>(agentDir: string, fn: () => T): T {
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			return fn();
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	}

	it("throws a guiding error when no moa.json exists anywhere", () => {
		const emptyCwd = mkdtempSync(join(tmpdir(), "moa-nocfg-cwd-"));
		const emptyAgentDir = mkdtempSync(join(tmpdir(), "moa-nocfg-agent-"));
		withAgentDir(emptyAgentDir, () => {
			let thrown: Error | undefined;
			try {
				loadMoAConfig(emptyCwd);
			} catch (error) {
				thrown = error as Error;
			}
			// The error names both searched locations and includes a minimal
			// example the user can copy as a starting point.
			expect(thrown).toBeDefined();
			expect(thrown?.message).toContain(join(emptyCwd, ".pi", "moa.json"));
			expect(thrown?.message).toContain(join(emptyAgentDir, "moa.json"));
			expect(thrown?.message).toContain('"defaultPreset"');
			expect(thrown?.message).toContain('"referenceModels"');
		});
	});

	it("names the offending file when a config is invalid", () => {
		const emptyCwd = mkdtempSync(join(tmpdir(), "moa-badcfg-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "moa-badcfg-agent-"));
		const configPath = join(agentDir, "moa.json");
		writeFileSync(
			configPath,
			JSON.stringify({ defaultPreset: "default", presets: {} }),
		);
		withAgentDir(agentDir, () => {
			expect(() => loadMoAConfig(emptyCwd)).toThrow(configPath);
			expect(() => loadMoAConfig(emptyCwd)).toThrow(/"presets"/);
		});
	});
});

describe("MoA config", () => {
	it("accepts a valid config and resolves enabled presets", () => {
		const config = baseConfig();
		expect(() => validateMoAConfig(config)).not.toThrow();
		expect(getPreset(config, "default").aggregator.model).toBe("main");
	});

	it("throws for missing or unknown defaultPreset", () => {
		expect(() => validateMoAConfig({ presets: {} })).toThrow(/defaultPreset/);
		expect(() =>
			validateMoAConfig({
				defaultPreset: "missing",
				presets: { default: basePreset() },
			}),
		).toThrow(/defaultPreset "missing"/);
	});

	it("rejects an invalid telemetryMaxBytes", () => {
		for (const bad of [-1, 1.5, "big"]) {
			expect(() =>
				validateMoAConfig({ ...baseConfig(), telemetryMaxBytes: bad }),
			).toThrow(/telemetryMaxBytes/);
		}
		for (const ok of [0, 1024]) {
			expect(() =>
				validateMoAConfig({ ...baseConfig(), telemetryMaxBytes: ok }),
			).not.toThrow();
		}
	});

	it("rejects recursive moa providers", () => {
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						referenceModels: [{ provider: "moa", model: "default" }],
					}),
				),
			),
		).toThrow(/cannot be "moa"/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({ aggregator: { provider: "moa", model: "default" } }),
				),
			),
		).toThrow(/cannot be "moa"/);
	});

	it("rejects invalid reference limits and missing required models", () => {
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ maxReferences: 1 }))),
		).toThrow(/exceeds/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceModels: [] }))),
		).toThrow(/at least one/);
		expect(() =>
			validateMoAConfig(
				baseConfig({
					...basePreset(),
					aggregator: undefined as unknown as MoAPreset["aggregator"],
				}),
			),
		).toThrow(/aggregator/);
		expect(() =>
			validateMoAConfig(
				baseConfig(basePreset({ maxReferenceOutputChars: 199 })),
			),
		).toThrow(/200/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceConcurrency: 9 }))),
		).toThrow(/referenceConcurrency/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceMaxTokens: 0 }))),
		).toThrow(/referenceMaxTokens/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceTimeoutMs: 0 }))),
		).toThrow(/referenceTimeoutMs/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceQuorum: 0 }))),
		).toThrow(/referenceQuorum/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceQuorum: 3 }))),
		).toThrow(/referenceQuorum/);
		expect(() =>
			validateMoAConfig(
				baseConfig(basePreset({ referenceMaxContextChars: 499 })),
			),
		).toThrow(/referenceMaxContextChars/);
		expect(() =>
			validateMoAConfig(
				baseConfig(basePreset({ referenceToolResultMaxChars: 199 })),
			),
		).toThrow(/referenceToolResultMaxChars/);
		// A 0 tail is rejected: slice(-0) would keep the whole result, defeating the
		// truncation, so the minimum is 1.
		expect(() =>
			validateMoAConfig(
				baseConfig(basePreset({ referenceToolResultTailChars: 0 })),
			),
		).toThrow(/referenceToolResultTailChars/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						referenceReasoning: "off" as unknown as MoAPreset["referenceReasoning"],
					}),
				),
			),
		).toThrow(/referenceReasoning/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						aggregatorGuidancePlacement:
							"middle" as unknown as MoAPreset["aggregatorGuidancePlacement"],
					}),
				),
			),
		).toThrow(/aggregatorGuidancePlacement/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						streamAggregator: "yes" as unknown as MoAPreset["streamAggregator"],
					}),
				),
			),
		).toThrow(/streamAggregator/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						streamReferences: "yes" as unknown as MoAPreset["streamReferences"],
					}),
				),
			),
		).toThrow(/streamReferences/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						aggregatorCacheRetention:
							"forever" as unknown as MoAPreset["aggregatorCacheRetention"],
					}),
				),
			),
		).toThrow(/aggregatorCacheRetention/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						referenceCacheRetention:
							"forever" as unknown as MoAPreset["referenceCacheRetention"],
					}),
				),
			),
		).toThrow(/referenceCacheRetention/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						aggregatorReasoning:
							"off" as unknown as MoAPreset["aggregatorReasoning"],
					}),
				),
			),
		).toThrow(/aggregatorReasoning/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						aggregatorProviderRouting:
							"throughput" as unknown as MoAPreset["aggregatorProviderRouting"],
					}),
				),
			),
		).toThrow(/aggregatorProviderRouting/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						aggregatorProviderRouting: {
							sort: "fastest",
						} as unknown as MoAPreset["aggregatorProviderRouting"],
					}),
				),
			),
		).toThrow(/aggregatorProviderRouting.*sort/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						referenceProviderRouting:
							"latency" as unknown as MoAPreset["referenceProviderRouting"],
					}),
				),
			),
		).toThrow(/referenceProviderRouting/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						referenceProviderRouting: {
							sort: "slowest",
						} as unknown as MoAPreset["referenceProviderRouting"],
					}),
				),
			),
		).toThrow(/referenceProviderRouting.*sort/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						aggregatorPrewarm:
							"yes" as unknown as MoAPreset["aggregatorPrewarm"],
					}),
				),
			),
		).toThrow(/aggregatorPrewarm/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceMaxRetries: -1 }))),
		).toThrow(/referenceMaxRetries/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceMaxRetries: 1.5 }))),
		).toThrow(/referenceMaxRetries/);
		// 0 (disable retries) is a valid, meaningful value — not rejected.
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceMaxRetries: 0 }))),
		).not.toThrow();
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceTools: [] }))),
		).toThrow(/referenceTools/);
		expect(() =>
			validateMoAConfig(
				baseConfig(basePreset({ referenceTools: ["read", "read"] })),
			),
		).toThrow(/duplicate/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({
						referenceTools: [
							"write" as unknown as NonNullable<
								MoAPreset["referenceTools"]
							>[number],
						],
					}),
				),
			),
		).toThrow(/referenceTools\[0\]/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceToolRounds: 3 }))),
		).toThrow(/referenceToolRounds.*referenceTools/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({ referenceTools: ["read"], referenceToolRounds: 0 }),
				),
			),
		).toThrow(/referenceToolRounds/);
		expect(() =>
			validateMoAConfig(
				baseConfig(
					basePreset({ referenceTools: ["read"], referenceToolRounds: 1 }),
				),
			),
		).not.toThrow();
	});

	it("does not generate synthetic models for disabled presets", () => {
		const config: MoAConfig = {
			defaultPreset: "default",
			presets: {
				default: basePreset(),
				disabled: basePreset({ enabled: false }),
			},
		};
		expect(buildSyntheticModels(config).map((model) => model.id)).toEqual([
			"default",
		]);
		expect(() => getPreset(config, "disabled")).toThrow(/disabled/);
	});
});

describe("MoA message shaping", () => {
	it("strips only prior synthetic guidance messages", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: `${MOA_GUIDANCE_MARKER}\nold`, timestamp: 1 },
				{
					role: "user",
					content: `Please discuss ${MOA_GUIDANCE_MARKER} later`,
					timestamp: 2,
				},
			],
		};
		expect(stripPriorMoAGuidanceMessages(context).messages).toEqual([
			context.messages[1],
		]);
	});

	it("renderReferenceContext trusts an already-stripped context and does not strip again", () => {
		// The orchestrator strips prior MoA guidance once up front and shares that
		// context with both the reference and aggregator paths, so the reference
		// renderer must NOT strip a second time (a redundant O(n) transcript pass on
		// the reference-context critical path). buildReferenceContext strips; the
		// lower-level renderReferenceContext deliberately does not.
		const context: Context = {
			messages: [
				{ role: "user", content: "real question", timestamp: 1 },
				{
					role: "user",
					content: `${MOA_GUIDANCE_MARKER}\nSTALE-PRIOR-GUIDANCE`,
					timestamp: 2,
				},
			],
		};
		const preset = basePreset();
		// The public builder strips prior guidance before rendering.
		expect(
			JSON.stringify(buildReferenceContext(context, preset).messages),
		).not.toContain("STALE-PRIOR-GUIDANCE");
		// renderReferenceContext assumes its caller already stripped, so it renders
		// the guidance message verbatim. If it re-stripped (reintroducing the double
		// pass) this text would be gone — this assertion locks the single-strip win.
		expect(
			JSON.stringify(renderReferenceContext(context, preset).messages),
		).toContain("STALE-PRIOR-GUIDANCE");
	});

	it("injects guidance after the latest user message without mutating original content", () => {
		const latestContent = [{ type: "text" as const, text: "latest" }];
		const context: Context = {
			systemPrompt: "original system",
			messages: [
				{ role: "user", content: "older", timestamp: 1 },
				fauxAssistantMessage("assistant"),
				{ role: "user", content: latestContent, timestamp: 2 },
				fauxAssistantMessage("after"),
			],
		};
		const injected = injectGuidance(context, `${MOA_GUIDANCE_MARKER}\nnew`);
		expect(injected.systemPrompt).toBe("original system");
		expect(injected.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"user",
			"assistant",
		]);
		expect(context.messages[2]).toEqual({
			role: "user",
			content: latestContent,
			timestamp: 2,
		});
		expect(injected.messages[3]).toMatchObject({
			role: "user",
			content: `${MOA_GUIDANCE_MARKER}\nnew`,
		});
	});

	it("appends guidance to the latest string user message without adding a new message", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "older", timestamp: 1 },
				fauxAssistantMessage("assistant"),
				{ role: "user", content: "latest", timestamp: 2 },
			],
		};
		const appended = appendGuidanceToLatestUser(
			context,
			`${MOA_GUIDANCE_MARKER}\nnew`,
		);
		expect(appended.messages).toHaveLength(3);
		expect(appended.messages[2]).toMatchObject({
			role: "user",
			content: `latest\n\n${MOA_GUIDANCE_MARKER}\nnew`,
			timestamp: 2,
		});
		expect(context.messages[2]).toEqual({
			role: "user",
			content: "latest",
			timestamp: 2,
		});
	});

	it("appends guidance to the latest array user message without mutating original content", () => {
		const latestContent = [{ type: "text" as const, text: "latest" }];
		const context: Context = {
			messages: [
				{ role: "user", content: "older", timestamp: 1 },
				{ role: "user", content: latestContent, timestamp: 2 },
			],
		};
		const appended = appendGuidanceToLatestUser(
			context,
			`${MOA_GUIDANCE_MARKER}\nnew`,
		);
		expect(appended.messages).toHaveLength(2);
		expect(appended.messages[1]).toMatchObject({
			role: "user",
			content: [
				latestContent[0],
				{ type: "text", text: `\n\n${MOA_GUIDANCE_MARKER}\nnew` },
			],
			timestamp: 2,
		});
		expect(context.messages[1]).toEqual({
			role: "user",
			content: latestContent,
			timestamp: 2,
		});
	});

	it("builds reference context without tools and renders private-safe history", () => {
		const longToolResult = `${"a".repeat(3000)}TAIL`;
		const context: Context = {
			systemPrompt: "acting system prompt",
			tools: [
				{
					name: "echo",
					description: "Echo",
					parameters: Type.Object({ text: Type.String() }),
				},
			],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "image", mimeType: "image/png", data: "abcd" },
					],
					timestamp: 1,
				},
				fauxAssistantMessage([
					fauxThinking("secret thinking"),
					fauxToolCall("echo", { text: "hi" }, { id: "tool-1" }),
					fauxText("done"),
				]),
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "echo",
					content: [{ type: "text", text: longToolResult }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const referenceContext = buildReferenceContext(context, basePreset());
		expect(referenceContext.tools).toBeUndefined();
		expect(referenceContext.systemPrompt).toContain("reference advisor");
		expect(referenceContext.systemPrompt).not.toContain("acting system prompt");
		expect(referenceContext.messages[0]).toMatchObject({
			role: "user",
			content: "hello\n[image:image/png:4]",
		});
		// Tool results fold into the preceding assistant turn (advisor framing),
		// so the tool call and its result share one assistant message rather than
		// the result arriving as a "user" turn that reads like a task instruction.
		expect(referenceContext.messages[1].role).toBe("assistant");
		expect(JSON.stringify(referenceContext.messages[1])).not.toContain(
			"secret thinking",
		);
		expect(JSON.stringify(referenceContext.messages[1])).not.toContain(
			"[assistant thinking omitted]",
		);
		expect(JSON.stringify(referenceContext.messages[1])).toContain(
			"[Tool call: echo(",
		);
		expect(JSON.stringify(referenceContext.messages[1])).toContain(
			"[Tool result: echo ->",
		);
		expect(JSON.stringify(referenceContext.messages[1])).toContain(
			"...[truncated 3004 chars]...",
		);
		// No tool-role messages leak to the reference, and the view ends on a
		// synthetic user advisory turn so the reference advises rather than
		// continuing the task as if it were the acting agent.
		expect(
			referenceContext.messages.every(
				(message) => message.role === "user" || message.role === "assistant",
			),
		).toBe(true);
		const lastReferenceMessage =
			referenceContext.messages[referenceContext.messages.length - 1];
		expect(lastReferenceMessage.role).toBe("user");
		expect(JSON.stringify(lastReferenceMessage)).toContain(
			"most intelligent judgement",
		);
	});

	it("bounds the reference context to referenceMaxContextChars, keeping the task and recent turns", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "TASK: fix the parser", timestamp: 1 },
				fauxAssistantMessage(`old middle ${"x".repeat(4000)}`),
				{ role: "user", content: "MIDDLE follow-up", timestamp: 3 },
				fauxAssistantMessage(`more middle ${"y".repeat(4000)}`),
				{ role: "user", content: "RECENT: what next?", timestamp: 5 },
			],
		};
		const capped = buildReferenceContext(
			context,
			basePreset({ referenceMaxContextChars: 500 }),
		);
		const serialized = JSON.stringify(capped.messages);
		// The first user turn (the task) is preserved and the most recent turn is
		// kept, but the bulky middle turns are elided with a marker.
		expect(serialized).toContain("TASK: fix the parser");
		expect(serialized).toContain("RECENT: what next?");
		expect(serialized).toContain("omitted to bound reference latency");
		expect(serialized).not.toContain("old middle");
		expect(serialized).not.toContain("more middle");
		// Structure is still valid for strict providers: alternating roles only and
		// a trailing user advisory turn.
		expect(
			capped.messages.every(
				(message) => message.role === "user" || message.role === "assistant",
			),
		).toBe(true);
		expect(capped.messages[capped.messages.length - 1].role).toBe("user");

		// Unset (default) leaves the full transcript untouched.
		const uncapped = buildReferenceContext(context, basePreset());
		const uncappedSerialized = JSON.stringify(uncapped.messages);
		expect(uncappedSerialized).toContain("old middle");
		expect(uncappedSerialized).toContain("more middle");
		expect(uncappedSerialized).not.toContain("omitted to bound reference latency");
	});

	it("bounds each tool result to referenceToolResultMaxChars while keeping every turn", () => {
		const bulkyToolResult = `HEAD${"x".repeat(5000)}TAIL`;
		const context: Context = {
			messages: [
				{ role: "user", content: "run the build", timestamp: 1 },
				fauxAssistantMessage([
					fauxToolCall("bash", { cmd: "build" }, { id: "t1" }),
				]),
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					content: [{ type: "text", text: bulkyToolResult }],
					isError: false,
					timestamp: 2,
				},
				fauxAssistantMessage("build finished"),
				{ role: "user", content: "what next?", timestamp: 4 },
			],
		};

		// A small per-tool-result budget shrinks the bulky output but preserves the
		// full action sequence: the tool call, a short head+tail of its result, and
		// every surrounding turn all survive (unlike referenceMaxContextChars, which
		// would elide whole middle turns).
		const capped = buildReferenceContext(
			context,
			basePreset({ referenceToolResultMaxChars: 300 }),
		);
		const cappedSerialized = JSON.stringify(capped.messages);
		expect(cappedSerialized).toContain("[Tool call: bash(");
		expect(cappedSerialized).toContain("[Tool result: bash ->");
		expect(cappedSerialized).toContain("...[truncated 5008 chars]...");
		expect(cappedSerialized).toContain("HEAD");
		expect(cappedSerialized).toContain("TAIL");
		// The middle of the bulky result is dropped, so the rendered tool result is
		// far smaller than the raw 5008 chars.
		const cappedToolTurn = JSON.stringify(capped.messages[1]);
		expect(cappedToolTurn.length).toBeLessThan(1500);
		// Every turn is still present — the action sequence is intact.
		expect(cappedSerialized).toContain("run the build");
		expect(cappedSerialized).toContain("build finished");
		expect(cappedSerialized).toContain("what next?");

		// Unset (default) keeps the wider default head budget, so more of the result
		// survives — proving the knob is what shrank it, not some other trimming.
		const uncapped = buildReferenceContext(context, basePreset());
		const uncappedToolTurn = JSON.stringify(uncapped.messages[1]);
		expect(uncappedToolTurn).toContain("...[truncated 5008 chars]...");
		expect(uncappedToolTurn.length).toBeGreaterThan(cappedToolTurn.length + 1500);
	});

	it("shrinks the always-kept tail of each tool result to referenceToolResultTailChars", () => {
		// A distinctive-per-character tail lets us prove exactly how many trailing
		// chars survive: the default keeps 500, so the marker at position -600 is
		// dropped but the last 500 chars stay.
		const uniqueTail = Array.from(
			{ length: 800 },
			(_v, index) => `<${index}>`,
		).join("");
		const bulkyToolResult = `HEAD${"x".repeat(5000)}${uniqueTail}`;
		const context: Context = {
			messages: [
				{ role: "user", content: "run it", timestamp: 1 },
				fauxAssistantMessage([
					fauxToolCall("bash", { cmd: "go" }, { id: "t1" }),
				]),
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					content: [{ type: "text", text: bulkyToolResult }],
					isError: false,
					timestamp: 2,
				},
			],
		};

		// A tiny tail budget keeps only the final chars of the outcome, dropping the
		// rest of the tail the default (500) would retain — a reference-prefill
		// reduction the head cap alone cannot reach.
		const tailCapped = buildReferenceContext(
			context,
			basePreset({ referenceToolResultTailChars: 30 }),
		);
		const tailCappedToolTurn = JSON.stringify(tailCapped.messages[1]);
		// The head still survives, and the very end of the result is still visible.
		expect(tailCappedToolTurn).toContain("HEAD");
		expect(tailCappedToolTurn).toContain("<799>");
		// But content ~500 chars from the end (kept under the default tail) is now gone.
		expect(tailCappedToolTurn).not.toContain("<700>");

		// The default keeps the full 500-char tail, so that same content survives —
		// proving the knob is what dropped it, not some other trimming.
		const defaultTail = buildReferenceContext(context, basePreset());
		const defaultTailToolTurn = JSON.stringify(defaultTail.messages[1]);
		expect(defaultTailToolTurn).toContain("<700>");
		expect(defaultTailToolTurn.length).toBeGreaterThan(
			tailCappedToolTurn.length + 400,
		);
	});

	it("merges the advisory turn into a trailing user message and never emits consecutive same-role turns", () => {
		const context: Context = {
			systemPrompt: "acting system prompt",
			messages: [
				{ role: "user", content: "first question", timestamp: 1 },
				fauxAssistantMessage([
					fauxToolCall("echo", { text: "a" }, { id: "t1" }),
				]),
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "echo",
					content: [{ type: "text", text: "result-a" }],
					isError: false,
					timestamp: 2,
				},
				fauxAssistantMessage([
					fauxToolCall("echo", { text: "b" }, { id: "t2" }),
				]),
				{
					role: "toolResult",
					toolCallId: "t2",
					toolName: "echo",
					content: [{ type: "text", text: "result-b" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "now what", timestamp: 4 },
			],
		};
		const referenceContext = buildReferenceContext(context, basePreset());
		const roles = referenceContext.messages.map((message) => message.role);
		// Alternation is preserved: two assistant turns coalesce into one, and the
		// trailing user turn absorbs the advisory instruction instead of spawning a
		// second consecutive user message.
		expect(roles).toEqual(["user", "assistant", "user"]);
		for (let index = 1; index < roles.length; index++) {
			expect(roles[index]).not.toBe(roles[index - 1]);
		}
		const lastReferenceMessage = referenceContext.messages[2];
		expect(JSON.stringify(lastReferenceMessage)).toContain("now what");
		expect(JSON.stringify(lastReferenceMessage)).toContain(
			"most intelligent judgement",
		);
		// Both tool loops are visible to the advisor, folded into the one assistant turn.
		expect(JSON.stringify(referenceContext.messages[1])).toContain("result-a");
		expect(JSON.stringify(referenceContext.messages[1])).toContain("result-b");
	});

	it("produces a lone user advisory turn for an empty transcript", () => {
		const referenceContext = buildReferenceContext(
			{ messages: [] },
			basePreset(),
		);
		expect(referenceContext.tools).toBeUndefined();
		expect(referenceContext.messages).toHaveLength(1);
		expect(referenceContext.messages[0].role).toBe("user");
		expect(JSON.stringify(referenceContext.messages[0])).toContain(
			"most intelligent judgement",
		);
	});

	it("handles a leading tool result that has no preceding assistant turn", () => {
		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "orphan",
					toolName: "echo",
					content: [{ type: "text", text: "orphan-result" }],
					isError: false,
					timestamp: 1,
				},
				{ role: "user", content: "continue", timestamp: 2 },
			],
		};
		const referenceContext = buildReferenceContext(context, basePreset());
		// The orphan tool result becomes a user line, coalesces with the following
		// user turn, and the advisory merges in — one clean user turn, ends on user.
		expect(referenceContext.messages.map((message) => message.role)).toEqual([
			"user",
		]);
		const only = JSON.stringify(referenceContext.messages[0]);
		expect(only).toContain("orphan-result");
		expect(only).toContain("continue");
		expect(only).toContain("most intelligent judgement");
	});

	it("builds guidance with truncation and redacted failed references", () => {
		const guidance = buildGuidanceBlock({
			presetName: "default",
			preset: basePreset({ maxReferenceOutputChars: 220 }),
			referenceOutputs: [
				{
					slot: { provider: "ref-a", model: "a" },
					success: true,
					text: "x".repeat(300),
				},
				{
					slot: { provider: "ref-b", model: "b" },
					success: false,
					text: "",
					errorMessage: `Bearer abcdefghijklmnopqrstuvwxyz OPENAI_API_KEY=sk-${"z".repeat(40)} ${"e".repeat(260)}`,
				},
			],
		});
		expect(guidance).toContain("--- Reference 1 (ref-a/a) ---");
		expect(guidance).toContain("...[truncated, 300 chars total]...");
		expect(guidance).toContain("--- Reference 2 (ref-b/b) FAILED ---");
		expect(guidance).toContain("Bearer [REDACTED]");
		expect(guidance).toContain("OPENAI_API_KEY=[REDACTED]");
		expect(guidance).not.toContain("sk-zzzz");
	});

	it("renders the reference thinking block sentinel-first, with truncation and redaction", () => {
		const text = buildReferenceThinkingText(
			basePreset({ maxReferenceOutputChars: 220 }),
			[
				{
					slot: { provider: "ref-a", model: "a" },
					success: true,
					text: "x".repeat(300),
				},
				{
					slot: { provider: "ref-b", model: "b" },
					success: false,
					text: "",
					errorMessage: `Bearer abcdefghijklmnopqrstuvwxyz ${"e".repeat(260)}`,
				},
			],
		);
		// Sentinel must be the very first characters so the context handler's
		// startsWith() strip matches.
		expect(text.startsWith(MOA_REFERENCE_THINKING_MARKER)).toBe(true);
		expect(text).toContain("▍ Reference 1 — ref-a/a");
		expect(text).toContain("...[truncated, 300 chars total]...");
		expect(text).toContain("▍ Reference 2 — ref-b/b (failed)");
		expect(text).toContain("Bearer [REDACTED]");
	});

	it("redacts common credential patterns", () => {
		expect(redactErrorMessage("Authorization: Bearer secret-token")).toContain(
			"Bearer [REDACTED]",
		);
		expect(
			redactErrorMessage(
				"api_key=abc123 token: xyz789 glpat-12345678901234567890",
			),
		).not.toContain("abc123");
	});
});

describe("MoA orchestration", () => {
	it("runs references without tools and streams the aggregator with original tools", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		const seenReferenceTools: Array<unknown> = [];
		let aggregatorContext: Context | undefined;
		refA.setResponses([
			(context) => {
				seenReferenceTools.push(context.tools);
				return fauxAssistantMessage("advice A");
			},
		]);
		refB.setResponses([
			(context) => {
				seenReferenceTools.push(context.tools);
				return fauxAssistantMessage("advice B");
			},
		]);
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);

		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);
		const context: Context = {
			tools: [
				{
					name: "echo",
					description: "Echo",
					parameters: Type.Object({ text: Type.String() }),
				},
			],
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			undefined,
			registry,
			baseConfig(),
		).result();
		const resultText = textFromResult(result);
		// The visible answer TEXT is only the aggregator's; the references live in a
		// separate leading thinking block, not in the answer text.
		expect(resultText).toContain("final answer");
		expect(resultText).not.toContain("advice A");
		expect(result.content[0]).toMatchObject({ type: "thinking" });
		const references = thinkingFromResult(result);
		expect(references).toContain(MOA_REFERENCE_THINKING_MARKER);
		expect(references).toContain("ref-a/a");
		expect(references).toContain("advice A");
		expect(references).toContain("ref-b/b");
		expect(references).toContain("advice B");
		expect(seenReferenceTools).toEqual([undefined, undefined]);
		expect(aggregatorContext?.tools).toBe(context.tools);
		// Guidance now rides on the latest user message (not the system prompt), so
		// the aggregator reads the references there while its system prompt stays clean.
		expect(aggregatorContext?.messages.map((message) => message.role)).toEqual([
			"user",
		]);
		expect(JSON.stringify(aggregatorContext?.messages)).toContain(
			MOA_GUIDANCE_MARKER,
		);
		expect(JSON.stringify(aggregatorContext?.messages)).toContain("advice A");
		expect(JSON.stringify(aggregatorContext?.messages)).toContain("advice B");
		expect(aggregatorContext?.systemPrompt ?? "").not.toContain("advice A");
	});

	it("strips onPayload/onResponse hooks from references but keeps them for the aggregator", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		const referenceHooks: Array<{ onPayload: unknown; onResponse: unknown }> =
			[];
		let aggregatorKeptHooks = false;
		refA.setResponses([
			(_context, options) => {
				referenceHooks.push({
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
				});
				return fauxAssistantMessage("advice");
			},
		]);
		agg.setResponses([
			(_context, options) => {
				aggregatorKeptHooks =
					options?.onPayload !== undefined && options?.onResponse !== undefined;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const context: Context = {
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			{ onPayload: () => undefined, onResponse: () => undefined },
			registry,
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();
		// The reference never sees the payload-mutation hooks (the only path by
		// which tool schemas could still reach a supposedly tool-free reference)...
		expect(referenceHooks).toEqual([
			{ onPayload: undefined, onResponse: undefined },
		]);
		// ...while the aggregator, the acting model, keeps them.
		expect(aggregatorKeptHooks).toBe(true);
	});

	it("caps reference generation to referenceMaxTokens without bounding the aggregator", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		const referenceMaxTokens: Array<number | undefined> = [];
		let aggregatorMaxTokens: number | undefined;
		refA.setResponses([
			(_context, options) => {
				referenceMaxTokens.push(options?.maxTokens);
				return fauxAssistantMessage("advice");
			},
		]);
		agg.setResponses([
			(_context, options) => {
				aggregatorMaxTokens = options?.maxTokens;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const context: Context = {
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			{ maxTokens: 8192 },
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceMaxTokens: 512,
				}),
			),
		).result();
		// The reference is bound to the preset cap; the aggregator keeps the caller's
		// larger budget since it produces the actual answer.
		expect(referenceMaxTokens).toEqual([512]);
		expect(aggregatorMaxTokens).toBe(8192);
	});

	it("never raises a caller maxTokens below referenceMaxTokens", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let referenceMaxTokens: number | undefined;
		refA.setResponses([
			(_context, options) => {
				referenceMaxTokens = options?.maxTokens;
				return fauxAssistantMessage("advice");
			},
		]);
		agg.setResponses([fauxAssistantMessage("final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const context: Context = {
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			{ maxTokens: 128 },
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceMaxTokens: 512,
				}),
			),
		).result();
		// The cap only ever lowers generation — a smaller caller limit wins.
		expect(referenceMaxTokens).toBe(128);
	});

	it("skips the referenceMaxTokens cap when a reasoning effort is in play for the reference", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let referenceMaxTokens: number | undefined = -1;
		refA.setResponses([
			(_context, options) => {
				referenceMaxTokens = options?.maxTokens;
				return fauxAssistantMessage("advice");
			},
		]);
		agg.setResponses([fauxAssistantMessage("final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const context: Context = {
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			// The caller runs with thinking enabled; the reference inherits it.
			{ reasoning: "high" },
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceMaxTokens: 512,
				}),
			),
		).result();
		// On completions-style APIs thinking tokens share the max_tokens budget
		// (OpenRouter derives the Anthropic thinking budget as a fraction of
		// max_tokens, with a 1024-token provider-side minimum), so applying a small
		// cap to a thinking reference could get the request rejected or let thinking
		// starve the kept advice text. The cap must stand down when a reasoning
		// effort is in play — the stream-level abort still bounds the kept text.
		expect(referenceMaxTokens).toBeUndefined();
	});

	it("pre-resolves every reference's auth up front so a late concurrency slot never blocks on a fresh auth fetch", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		const authRequested: string[] = [];
		let authSeenWhileRefARan: string[] = [];
		// With referenceConcurrency 1 the single worker runs ref-a to completion
		// before it even picks ref-b, so if ref-b's auth were fetched lazily when
		// its concurrency slot opens it would NOT yet be requested while ref-a is
		// still streaming. Capturing the requested-auth set inside ref-a's responder
		// therefore distinguishes the up-front pre-resolution (ref-b already
		// requested) from a lazy per-worker fetch (ref-b not yet requested).
		refA.setResponses([
			() => {
				authSeenWhileRefARan = [...authRequested];
				return fauxAssistantMessage("advice A");
			},
		]);
		refB.setResponses([fauxAssistantMessage("advice B")]);
		agg.setResponses([fauxAssistantMessage("final answer")]);
		const baseRegistry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);
		const registry = {
			find: (provider: string, modelId: string) =>
				baseRegistry.find(provider, modelId),
			async getApiKeyAndHeaders(model: Model<Api>) {
				authRequested.push(`${model.provider}:${model.id}`);
				return baseRegistry.getApiKeyAndHeaders(model);
			},
		} as ModelRegistry;
		const context: Context = {
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			undefined,
			registry,
			baseConfig(basePreset({ referenceConcurrency: 1 })),
		).result();
		// ref-b's auth is already in flight while the serial worker is still on
		// ref-a; reverting the up-front pre-resolution leaves ref-b unrequested here.
		expect(authSeenWhileRefARan).toContain("ref-b:b");
		// And every model's auth is still resolved exactly once (no double-fetch).
		expect(authRequested.filter((key) => key === "ref-b:b")).toHaveLength(1);
	});

	it("caps reference reasoning effort without changing the aggregator's", async () => {
		const { references, aggregator } = await captureRoleValues({
			// The caller asks for heavy reasoning (for the aggregator's benefit)...
			callerOptions: { reasoning: "high" },
			preset: { referenceReasoning: "minimal" },
			read: (options) => (options as { reasoning?: unknown })?.reasoning,
		});
		// ...but the reference is capped to minimal so its (discarded) thinking
		// stops holding up the aggregator, while the aggregator keeps the caller's
		// requested reasoning for the actual answer.
		expect(references).toEqual(["minimal"]);
		expect(aggregator).toBe("high");
	});

	it("leaves reference reasoning inheriting the caller's when unset", async () => {
		const { references } = await captureRoleValues({
			callerOptions: { reasoning: "high" },
			read: (options) => (options as { reasoning?: unknown })?.reasoning,
		});
		// With no referenceReasoning override, the reference inherits the caller's
		// reasoning exactly as before — zero behavioral change by default.
		expect(references).toEqual(["high"]);
	});

	it("caps client-side retries for references only, leaving the aggregator's untouched", async () => {
		const { references, aggregator } = await captureRoleValues({
			// The caller passes no retry preference...
			referenceCount: 2,
			preset: { referenceMaxRetries: 0 },
			read: (options) => (options as { maxRetries?: number })?.maxRetries,
		});
		// ...so every reference's request is pinned to zero client-side retries (fail
		// fast on a transient error instead of blocking the critical path on backoff),
		// while the aggregator — which produces the final answer — keeps the SDK/caller
		// default (undefined here), so its resilience is never traded away.
		expect(references).toEqual([0, 0]);
		expect(aggregator).toBeUndefined();
	});

	it("leaves reference retries inheriting the caller's when referenceMaxRetries is unset", async () => {
		const { references } = await captureRoleValues({
			// The caller supplies its own retry budget across the board...
			callerOptions: { maxRetries: 5 },
			read: (options) => (options as { maxRetries?: number })?.maxRetries,
		});
		// ...and with no preset override the reference inherits it exactly as before —
		// zero behavioral change by default.
		expect(references).toEqual([5]);
	});

	it("caps aggregator reasoning effort without changing the references'", async () => {
		const { references, aggregator } = await captureRoleValues({
			// The caller asks for heavy reasoning across the board...
			callerOptions: { reasoning: "high" },
			preset: { aggregatorReasoning: "minimal" },
			read: (options) => (options as { reasoning?: unknown })?.reasoning,
		});
		// ...but the preset pins the aggregator (the dominant per-turn latency cost)
		// to minimal so its answer generation is faster, while the reference keeps the
		// caller's reasoning — the aggregator knob never touches references.
		expect(aggregator).toBe("minimal");
		expect(references).toEqual(["high"]);
	});

	it("leaves the aggregator inheriting the caller's reasoning when aggregatorReasoning is unset", async () => {
		const { aggregator } = await captureRoleValues({
			callerOptions: { reasoning: "high" },
			read: (options) => (options as { reasoning?: unknown })?.reasoning,
		});
		// With no preset override the aggregator inherits the caller's reasoning
		// exactly as before — zero behavioral change by default.
		expect(aggregator).toBe("high");
	});

	it("applies aggregatorCacheRetention to the aggregator only, overriding the caller and leaving references untouched", async () => {
		const { references, aggregator } = await captureRoleValues({
			// The caller asks for short retention across the board...
			callerOptions: { cacheRetention: "short" },
			preset: { aggregatorCacheRetention: "long" },
			read: (options) =>
				(options as { cacheRetention?: unknown })?.cacheRetention,
		});
		// ...but the preset upgrades the aggregator (the expensive, cross-turn
		// re-prefiller) to long retention so its cache survives review/tool gaps,
		// while the single-turn reference keeps the caller's short retention — the
		// preset knob never touches references, so it doesn't pay their long-cache
		// write cost.
		expect(aggregator).toBe("long");
		expect(references).toEqual(["short"]);
	});

	it("leaves the aggregator inheriting the caller's cache retention when aggregatorCacheRetention is unset", async () => {
		const { aggregator } = await captureRoleValues({
			callerOptions: { cacheRetention: "long" },
			read: (options) =>
				(options as { cacheRetention?: unknown })?.cacheRetention,
		});
		// With no preset override the aggregator inherits the caller's retention
		// exactly as before — zero behavioral change by default.
		expect(aggregator).toBe("long");
	});

	it("applies referenceCacheRetention to the references only, overriding the caller and leaving the aggregator untouched", async () => {
		const { references, aggregator } = await captureRoleValues({
			// The caller asks for short retention across the board...
			callerOptions: { cacheRetention: "short" },
			preset: { referenceCacheRetention: "long" },
			read: (options) =>
				(options as { cacheRetention?: unknown })?.cacheRetention,
		});
		// ...but the preset upgrades the references (which also re-prefill their
		// shared, append-only transcript prefix on every tool-loop turn) to long
		// retention, while the aggregator keeps the caller's short retention — the
		// reference knob is reference-scoped and never touches the aggregator.
		expect(references).toEqual(["long"]);
		expect(aggregator).toBe("short");
	});

	it("leaves references inheriting the caller's cache retention when referenceCacheRetention is unset", async () => {
		const { references } = await captureRoleValues({
			callerOptions: { cacheRetention: "long" },
			read: (options) =>
				(options as { cacheRetention?: unknown })?.cacheRetention,
		});
		// With no preset override the reference inherits the caller's retention
		// exactly as before — zero behavioral change by default.
		expect(references).toEqual(["long"]);
	});

	it("applies aggregatorProviderRouting to the aggregator model only, leaving references unrouted", async () => {
		// The faux responder's model arg is the exact model object pi-moa handed to
		// streamSimple, so `model.compat.openRouterRouting` reflects the routing that
		// would reach OpenRouter's `provider` payload field.
		const { references, aggregator } = await captureRoleValues({
			preset: { aggregatorProviderRouting: { sort: "throughput" } },
			read: (_options, model) => openRouterRoutingOf(model),
		});
		// The aggregator (the dominant, unbounded per-turn cost) is pinned to the
		// fastest-throughput OpenRouter backend, while the reference stays unrouted —
		// the knob is aggregator-scoped and never touches reference requests.
		expect(aggregator).toEqual({ sort: "throughput" });
		expect(references).toEqual([undefined]);
	});

	it("leaves the aggregator model unrouted when aggregatorProviderRouting is unset", async () => {
		const { aggregator } = await captureRoleValues({
			read: (_options, model) => model.compat,
		});
		// With no preset override the aggregator model is passed through untouched —
		// no synthetic compat is injected (which also means no routing), so the
		// request is byte-identical to before.
		expect(aggregator).toBeUndefined();
	});

	it("applies referenceProviderRouting to reference models only, leaving the aggregator unrouted", async () => {
		const { references, aggregator } = await captureRoleValues({
			referenceCount: 2,
			preset: { referenceProviderRouting: { sort: "latency" } },
			read: (_options, model) => openRouterRoutingOf(model),
		});
		// Every reference is pinned to the lowest-latency OpenRouter backend (they sit
		// on the aggregator-blocking critical path), while the aggregator stays unrouted
		// — the knob is reference-scoped and never touches the aggregator request.
		expect(references).toEqual([{ sort: "latency" }, { sort: "latency" }]);
		expect(aggregator).toBeUndefined();
	});

	it("leaves reference models unrouted when referenceProviderRouting is unset", async () => {
		const { references } = await captureRoleValues({
			read: (_options, model) => model.compat,
		});
		// With no preset override the reference model is passed through untouched — no
		// synthetic compat is injected (so no routing either), and the reference
		// request is byte-identical.
		expect(references).toEqual([undefined]);
	});

	it("pre-warms the aggregator's prompt cache over the guidance-free prefix during the reference phase", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let warmContextText: string | undefined;
		let warmReasoning: unknown;
		let warmCacheRetention: unknown;
		let realContextText: string | undefined;
		let warmRanWhileReferencePending = false;
		let resolveWarm!: () => void;
		const warmRan = new Promise<void>((resolve) => {
			resolveWarm = resolve;
		});
		// Under pre-warm the aggregator is called twice: first the throwaway warm-up
		// (guidance-free prefix, minimal reasoning), then the real request (guidance
		// appended, caller's reasoning kept).
		agg.setResponses([
			(context, options) => {
				warmContextText = serializeContextText(context);
				warmReasoning = (options as { reasoning?: unknown })?.reasoning;
				warmCacheRetention = (
					options as { cacheRetention?: unknown }
				)?.cacheRetention;
				resolveWarm();
				return fauxAssistantMessage("warm");
			},
			(context) => {
				realContextText = serializeContextText(context);
				return fauxAssistantMessage("final answer");
			},
		]);
		// The single serial reference cannot settle until the warm-up has run, proving
		// the warm request fires DURING the reference phase (its prefill overlaps the
		// references rather than stacking after them). Reverting the pre-warm leaves
		// `warmRan` unresolved, so the reference falls through the 500ms guard with the
		// flag still false and the assertion below fails (fast on success, bounded on
		// failure — no hang).
		refA.setResponses([
			async () => {
				await Promise.race([
					warmRan.then(() => {
						warmRanWhileReferencePending = true;
					}),
					new Promise((resolve) => setTimeout(resolve, 500)),
				]);
				return fauxAssistantMessage("advice");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const context: Context = {
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			{ reasoning: "high" },
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceConcurrency: 1,
					aggregatorPrewarm: true,
					aggregatorCacheRetention: "long",
				}),
			),
		).result();
		// The warm-up ran while the reference was still pending — overlap achieved.
		expect(warmRanWhileReferencePending).toBe(true);
		// It carries the guidance-free prefix (no MoA reference block), so it shares the
		// byte-stable prefix the real request will read back from the warm cache...
		expect(warmContextText).toBeDefined();
		expect(warmContextText).not.toContain(MOA_GUIDANCE_MARKER);
		// ...pinned to minimal reasoning so a reasoning aggregator does not burn a full
		// thinking budget on the throwaway ping (the caller asked for "high")...
		expect(warmReasoning).toBe("minimal");
		// ...asking for the same cache TTL the real request will, so the warm write's
		// retention matches what the real read expects...
		expect(warmCacheRetention).toBe("long");
		// ...while the real request keeps the guidance for the aggregator to act on.
		expect(realContextText).toContain(MOA_GUIDANCE_MARKER);
	});

	it("fires no aggregator pre-warm request when aggregatorPrewarm is unset", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let aggregatorCallCount = 0;
		refA.setResponses([fauxAssistantMessage("advice")]);
		agg.setResponses([
			() => {
				aggregatorCallCount += 1;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const context: Context = {
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			undefined,
			registry,
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();
		// Exactly one aggregator request (the real one) — no warm-up fires, so the turn
		// is byte-identical to before the pre-warm knob existed.
		expect(aggregatorCallCount).toBe(1);
	});

	it("bounds reference input to referenceMaxContextChars while the aggregator keeps the full context", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let referenceContext: Context | undefined;
		let aggregatorContext: Context | undefined;
		refA.setResponses([
			(context) => {
				referenceContext = context;
				return fauxAssistantMessage("advice");
			},
		]);
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const context: Context = {
			messages: [
				{ role: "user", content: "TASK: ship the feature", timestamp: 1 },
				fauxAssistantMessage(`bulky middle ${"z".repeat(4000)}`),
				{ role: "user", content: "RECENT: how do I proceed?", timestamp: 3 },
			],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			undefined,
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceMaxContextChars: 500,
				}),
			),
		).result();

		// The reference's view is trimmed: task + recent state kept, bulky middle
		// dropped with a marker.
		const referenceSerialized = JSON.stringify(referenceContext?.messages);
		expect(referenceSerialized).toContain("TASK: ship the feature");
		expect(referenceSerialized).toContain("RECENT: how do I proceed?");
		expect(referenceSerialized).toContain("omitted to bound reference latency");
		expect(referenceSerialized).not.toContain("bulky middle");

		// The aggregator — the acting model — always receives the full, untrimmed
		// transcript, so bounding the reference input never starves the answer.
		const aggregatorSerialized = JSON.stringify(aggregatorContext?.messages);
		expect(aggregatorSerialized).toContain("bulky middle");
		expect(aggregatorSerialized).not.toContain("omitted to bound reference latency");
	});

	it("bounds each reference tool result to referenceToolResultMaxChars while the aggregator keeps the full result", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let referenceContext: Context | undefined;
		let aggregatorContext: Context | undefined;
		refA.setResponses([
			(context) => {
				referenceContext = context;
				return fauxAssistantMessage("advice");
			},
		]);
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const bulkyToolResult = `HEAD-MARKER${"q".repeat(6000)}TAIL-MARKER`;
		const context: Context = {
			messages: [
				{ role: "user", content: "inspect the logs", timestamp: 1 },
				fauxAssistantMessage([
					fauxToolCall("cat", { file: "log" }, { id: "t1" }),
				]),
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "cat",
					content: [{ type: "text", text: bulkyToolResult }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			undefined,
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceToolResultMaxChars: 300,
				}),
			),
		).result();

		// The reference's view of the tool result is shrunk to the head budget: the
		// action (tool call) and outcome (head+tail markers) survive, but the bulky
		// middle is elided — smaller prefill on the aggregator-blocking critical path.
		const referenceSerialized = JSON.stringify(referenceContext?.messages);
		expect(referenceSerialized).toContain("[Tool result: cat ->");
		expect(referenceSerialized).toContain("HEAD-MARKER");
		expect(referenceSerialized).toContain("TAIL-MARKER");
		expect(referenceSerialized).toContain("...[truncated 6022 chars]...");
		expect(referenceSerialized).not.toContain("q".repeat(1000));

		// The aggregator — the acting model — always receives the raw, untrimmed tool
		// result, so shrinking the reference's view never hides output from the answer.
		const aggregatorContent = JSON.stringify(
			aggregatorContext?.messages.find(
				(message) => message.role === "toolResult",
			),
		);
		expect(aggregatorContent).toContain("q".repeat(6000));
		expect(aggregatorContent).not.toContain("...[truncated");
	});

	it("aborts a reference once its output reaches the kept budget", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let referenceSignal: AbortSignal | undefined;
		// Only the first maxReferenceOutputChars of a reference ever reach the
		// aggregator/display, so a reference far longer than that budget should be
		// aborted mid-stream rather than generating the discarded tail.
		const longAdvice = `${"advice ".repeat(400)}TAIL-SENTINEL`;
		refA.setResponses([
			(_context, options) => {
				referenceSignal = options?.signal;
				return fauxAssistantMessage(longAdvice);
			},
		]);
		let aggregatorContext: Context | undefined;
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					maxReferenceOutputChars: 200,
				}),
			),
		).result();

		// The reference stream was aborted once the kept-output budget was met.
		expect(referenceSignal?.aborted).toBe(true);
		// It is still a success: the aggregator ran, and the kept head of the
		// reference reached it as guidance without the discarded tail sentinel.
		expect(textFromResult(result)).toContain("final answer");
		const references = thinkingFromResult(result);
		expect(references).toContain("ref-a/a");
		expect(references).not.toContain("(failed)");
		expect(references).toContain("advice");
		expect(references).not.toContain("TAIL-SENTINEL");
		expect(JSON.stringify(aggregatorContext?.messages)).toContain("advice");
		expect(JSON.stringify(aggregatorContext?.messages)).not.toContain(
			"TAIL-SENTINEL",
		);
	});

	it("bounds a stalled reference by referenceTimeoutMs so the aggregator still runs", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		// refA answers promptly; refB hangs forever (its responder never resolves,
		// so it never even begins streaming). Without a deadline the aggregator —
		// which waits for the slowest reference — would hang on refB indefinitely.
		refA.setResponses([fauxAssistantMessage("advice A")]);
		refB.setResponses([() => new Promise<never>(() => {})]);
		let aggregatorContext: Context | undefined;
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(basePreset({ referenceTimeoutMs: 50 })),
		).result();

		// The turn completed (did not hang on the stalled reference): the aggregator
		// ran with the fast reference's advice, and the stalled one failed gracefully
		// with a deadline error rather than blocking the turn.
		expect(textFromResult(result)).toContain("final answer");
		const references = thinkingFromResult(result);
		expect(references).toContain("ref-a/a");
		expect(references).toContain("advice A");
		expect(references).toContain("ref-b/b (failed)");
		expect(references).toContain("referenceTimeoutMs");
		const aggMessages = JSON.stringify(aggregatorContext?.messages);
		expect(aggMessages).toContain("advice A");
		expect(aggMessages).toContain("referenceTimeoutMs");
	});

	it("proceeds as soon as referenceQuorum references succeed, dropping the slower ones", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		// refA answers promptly; refB hangs forever (its responder never resolves,
		// so it never begins streaming — an abort cannot unblock it). With quorum 1,
		// the fast reference alone must satisfy the phase so the aggregator runs
		// immediately, WITHOUT any wall-clock deadline. If quorum did not short the
		// phase, this test would hang on refB.
		refA.setResponses([fauxAssistantMessage("advice A")]);
		refB.setResponses([() => new Promise<never>(() => {})]);
		let aggregatorContext: Context | undefined;
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(basePreset({ referenceQuorum: 1 })),
		).result();

		// The turn completed on the fast reference alone.
		expect(textFromResult(result)).toContain("final answer");
		const references = thinkingFromResult(result);
		expect(references).toContain("ref-a/a");
		expect(references).toContain("advice A");
		// The superseded slow reference is dropped entirely — NOT surfaced as a
		// failure (which is what distinguishes quorum from a timeout).
		expect(references).not.toContain("ref-b/b");
		expect(references).not.toContain("(failed)");
		const aggMessages = JSON.stringify(aggregatorContext?.messages);
		expect(aggMessages).toContain("advice A");
		expect(aggMessages).not.toContain("ref-b/b");
	});

	it("streams the aggregator answer incrementally when streamAggregator is enabled", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice A")]);
		agg.setResponses([
			fauxAssistantMessage("the final answer streams in many small chunks"),
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const stream = streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					streamAggregator: true,
				}),
			),
		);
		const events = await collectEvents(stream);

		// The aggregator's answer arrives as incremental text_delta events (live
		// streaming / time-to-first-token) — not just the final `done` burst.
		const textDeltas = events.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
				event.type === "text_delta",
		);
		expect(textDeltas.length).toBeGreaterThan(1);
		// Reassembled deltas reconstruct exactly the aggregator's answer.
		expect(textDeltas.map((event) => event.delta).join("")).toBe(
			"the final answer streams in many small chunks",
		);
		// Content is shifted to index 1+ (index 0 is reserved for the reference
		// thinking prelude), and every streamed partial carries that prelude at 0 so
		// the live message shape matches the final `done` message.
		expect(textDeltas.every((event) => event.contentIndex >= 1)).toBe(true);
		expect(
			textDeltas.every((event) => {
				const first = event.partial.content[0];
				return (
					first?.type === "thinking" &&
					first.thinking.startsWith(MOA_REFERENCE_THINKING_MARKER)
				);
			}),
		).toBe(true);
		// A single `done` still closes the stream, and its final message equals the
		// buffered behavior (reference thinking at 0, aggregator answer following).
		const done = events.filter((event) => event.type === "done");
		expect(done).toHaveLength(1);
		const finalMessage = (
			done[0] as Extract<AssistantMessageEvent, { type: "done" }>
		).message;
		expect(finalMessage.content[0]?.type).toBe("thinking");
		expect(textFromResult(finalMessage)).toContain(
			"the final answer streams in many small chunks",
		);
	});

	it("does not stream aggregator content incrementally by default", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice A")]);
		agg.setResponses([fauxAssistantMessage("the final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const stream = streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		);
		const events = await collectEvents(stream);

		// With the knob unset the aggregator's answer is NOT streamed — no text_delta
		// events reach the outer stream; the answer arrives only in the final `done`.
		expect(events.some((event) => event.type === "text_delta")).toBe(false);
		const done = events.filter((event) => event.type === "done");
		expect(done).toHaveLength(1);
		expect(
			textFromResult(
				(done[0] as Extract<AssistantMessageEvent, { type: "done" }>).message,
			),
		).toContain("the final answer");
	});

	it("reveals reference sections in slot order even when a later slot settles first", async () => {
		// Unit-test the progressive reveal directly (no timing dependency): drive the
		// reveal callback out of slot order and assert the emitted deltas still fill
		// the block in slot order — slot 1 finishing before slot 0 must be buffered
		// until slot 0 reveals, so the streamed order matches the atomic block.
		const preset = basePreset();
		const model = makeSyntheticMoAModel(
			registerFaux("agg", "main").getModel("main")!,
		);
		const stream = createAssistantMessageEventStream();
		const progressive = beginProgressiveReferenceThinking(stream, model, preset, 2);

		const outputA = {
			slot: { provider: "ref-a", model: "a" },
			success: true,
			text: "advice from A",
		};
		const outputB = {
			slot: { provider: "ref-b", model: "b" },
			success: true,
			text: "advice from B",
		};
		// Slot 1 (B) settles first — it must NOT be emitted before slot 0.
		progressive.reveal(1, outputB);
		progressive.reveal(0, outputA);
		const fullText = buildReferenceThinkingText(preset, [outputA, outputB]);
		progressive.finish(fullText);
		stream.end();

		const deltas: string[] = [];
		let lastPartialThinking = "";
		for await (const event of stream) {
			if (event.type === "thinking_delta") {
				deltas.push(event.delta);
				const block = event.partial.content[0];
				if (block?.type === "thinking") lastPartialThinking = block.thinking;
			}
		}
		// First delta is the header alone (immediate feedback before any reference).
		expect(deltas[0].startsWith(MOA_REFERENCE_THINKING_MARKER)).toBe(true);
		expect(deltas[0]).not.toContain("advice from");
		// Reference 1 (slot 0, A) is revealed before Reference 2 (slot 1, B), despite
		// B settling first — the buffer preserves slot order.
		const aIndex = deltas.findIndex((delta) => delta.includes("advice from A"));
		const bIndex = deltas.findIndex((delta) => delta.includes("advice from B"));
		expect(aIndex).toBeGreaterThan(0);
		expect(bIndex).toBeGreaterThan(aIndex);
		// The accumulated deltas reconstruct exactly the atomic block byte-for-byte.
		expect(deltas.join("")).toBe(fullText);
		expect(lastPartialThinking).toBe(fullText);
	});

	it("streams the reference thinking block progressively when streamReferences is enabled", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice A")]);
		refB.setResponses([fauxAssistantMessage("advice B")]);
		agg.setResponses([fauxAssistantMessage("the final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);
		const stream = streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(basePreset({ streamReferences: true })),
		);
		const events = await collectEvents(stream);

		const thinkingDeltas = events.filter(
			(
				event,
			): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
				event.type === "thinking_delta" && event.contentIndex === 0,
		);
		// Progressive: the header plus one section per reference — more than the single
		// full-text delta the atomic prelude emits.
		expect(thinkingDeltas.length).toBe(3);
		// The first delta is the header alone, emitted before any reference finished.
		expect(thinkingDeltas[0].delta.startsWith(MOA_REFERENCE_THINKING_MARKER)).toBe(
			true,
		);
		expect(thinkingDeltas[0].delta).not.toContain("advice");
		// The later deltas carry the reference advice, in slot order.
		expect(thinkingDeltas[1].delta).toContain("Reference 1 — ref-a/a");
		expect(thinkingDeltas[2].delta).toContain("Reference 2 — ref-b/b");

		// The final `done` message is byte-identical to the buffered path: reference
		// thinking at content index 0, aggregator answer following — and it equals the
		// reassembled stream, so nothing about the persisted message changed.
		const done = events.find(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> =>
				event.type === "done",
		);
		expect(done).toBeDefined();
		const finalThinking = thinkingFromResult(done!.message);
		expect(thinkingDeltas.map((event) => event.delta).join("")).toBe(
			finalThinking,
		);
		expect(finalThinking).toContain("advice A");
		expect(finalThinking).toContain("advice B");
		expect(textFromResult(done!.message)).toContain("the final answer");
	});

	it("composes progressive references with aggregator streaming (one start, disjoint indices)", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice A")]);
		refB.setResponses([fauxAssistantMessage("advice B")]);
		agg.setResponses([fauxAssistantMessage("the streamed final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);
		const stream = streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(
				basePreset({ streamReferences: true, streamAggregator: true }),
			),
		);
		const events = await collectEvents(stream);

		// Exactly one `start` — the progressive prelude's; the aggregator's own start
		// is skipped so no duplicate assistant message is pushed to the consumer.
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		// Reference thinking streams at content index 0; the aggregator answer streams
		// at index 1+. The two never collide.
		const thinkingDeltas = events.filter(
			(event) => event.type === "thinking_delta",
		);
		const textDeltas = events.filter(
			(
				event,
			): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
				event.type === "text_delta",
		);
		expect(thinkingDeltas.every((event) => event.contentIndex === 0)).toBe(true);
		expect(textDeltas.length).toBeGreaterThan(0);
		expect(textDeltas.every((event) => event.contentIndex >= 1)).toBe(true);
		expect(textDeltas.map((event) => event.delta).join("")).toBe(
			"the streamed final answer",
		);
		const done = events.find(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> =>
				event.type === "done",
		);
		expect(done!.message.content[0]?.type).toBe("thinking");
		expect(textFromResult(done!.message)).toContain("the streamed final answer");
	});

	it("emits the reference thinking as one atomic delta when streamReferences is unset", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice A")]);
		refB.setResponses([fauxAssistantMessage("advice B")]);
		agg.setResponses([fauxAssistantMessage("the final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);
		const stream = streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(basePreset()),
		);
		const events = await collectEvents(stream);

		// The default prelude emits the whole reference block in a single thinking
		// delta after the phase completes — the byte-identical baseline the progressive
		// path reconciles to.
		const thinkingDeltas = events.filter(
			(event) => event.type === "thinking_delta" && event.contentIndex === 0,
		);
		expect(thinkingDeltas).toHaveLength(1);
		const done = events.find(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> =>
				event.type === "done",
		);
		expect(thinkingFromResult(done!.message)).toContain("advice A");
		expect(thinkingFromResult(done!.message)).toContain("advice B");
	});

	it("places guidance as a trailing turn (cache-friendly) without mutating the task message in a tool loop", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice A")]);
		let trailingAggContext: Context | undefined;
		let latestUserAggContext: Context | undefined;
		agg.setResponses([
			(context) => {
				trailingAggContext = context;
				return fauxAssistantMessage("final answer");
			},
			(context) => {
				latestUserAggContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		// A tool-loop transcript: the only user turn is the original task at index 0;
		// the transcript ends on a tool result (role "toolResult", not "user").
		const toolLoopContext = (): Context => ({
			messages: [
				{ role: "user", content: "TASK: fix the bug", timestamp: 1 },
				fauxAssistantMessage([
					fauxToolCall("echo", { text: "run" }, { id: "t1" }),
				]),
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "echo",
					content: [{ type: "text", text: "tool output" }],
					isError: false,
					timestamp: 2,
				},
			],
		});

		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			toolLoopContext(),
			undefined,
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					aggregatorGuidancePlacement: "trailing-message",
				}),
			),
		).result();

		// The guidance is a NEW trailing user turn; the whole prior transcript is
		// preserved byte-for-byte so the aggregator's provider can reuse it from its
		// prompt cache across turns.
		expect(trailingAggContext?.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		const taskMessage = trailingAggContext?.messages[0];
		expect(JSON.stringify(taskMessage)).toBe(
			JSON.stringify({
				role: "user",
				content: "TASK: fix the bug",
				timestamp: 1,
			}),
		);
		const trailing =
			trailingAggContext?.messages[trailingAggContext.messages.length - 1];
		expect(JSON.stringify(trailing)).toContain(MOA_GUIDANCE_MARKER);
		expect(JSON.stringify(trailing)).toContain("advice A");

		// Contrast: the default "latest-user" placement mutates the early task
		// message (index 0), which is what busts the cross-turn prompt cache.
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			toolLoopContext(),
			undefined,
			registry,
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();
		expect(latestUserAggContext?.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
		expect(JSON.stringify(latestUserAggContext?.messages[0])).toContain(
			MOA_GUIDANCE_MARKER,
		);
	});

	it("removes accidentally echoed private guidance from the visible aggregator answer", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		agg.setResponses([
			fauxAssistantMessage(
				`${MOA_GUIDANCE_MARKER}\nprivate stuff that must not leak\n[End reference context]\n\nfinal answer`,
			),
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();

		const resultText = textFromResult(result);
		expect(resultText).toContain("final answer");
		expect(resultText).not.toContain(MOA_GUIDANCE_MARKER);
		expect(resultText).not.toContain("private stuff that must not leak");
		expect(thinkingFromResult(result)).toContain("advice");
	});

	it("removes echoed private guidance from the aggregator's own thinking block", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		// A reasoning aggregator can restate the private guidance inside its own
		// thinking, not just its text answer. That thinking is persisted and shown,
		// so it must be sanitized too.
		agg.setResponses([
			fauxAssistantMessage([
				fauxThinking(
					`${MOA_GUIDANCE_MARKER}\nprivate stuff that must not leak\n[End reference context]\nNow I will synthesize.`,
				),
				fauxText("final answer"),
			]),
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();

		const thinking = thinkingFromResult(result);
		// The reference block and the aggregator's legitimate reasoning both survive,
		// but the echoed private guidance is stripped from the visible thinking.
		expect(thinking).toContain("advice");
		expect(thinking).toContain("Now I will synthesize.");
		expect(thinking).not.toContain(MOA_GUIDANCE_MARKER);
		expect(thinking).not.toContain("private stuff that must not leak");
		expect(textFromResult(result)).toContain("final answer");
	});

	it("treats reference tool calls as reference failures", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), {
				stopReason: "toolUse",
			}),
		]);
		let aggregatorContext: Context | undefined;
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();

		const resultText = textFromResult(result);
		expect(resultText).toContain("final answer");
		const references = thinkingFromResult(result);
		expect(references).toContain("ref-a/a (failed)");
		expect(references).toContain("Reference attempted to use a tool");
		// The failure is also handed to the aggregator as guidance on the user turn.
		expect(JSON.stringify(aggregatorContext?.messages)).toContain(
			"Reference attempted to use a tool",
		);
	});

	it("runs an agentic reference through tool rounds and keeps only final advice", async () => {
		__setReferenceToolFactoryForTests((names) =>
			names.map((name) => createTestReferenceTool(name)),
		);
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([
			fauxAssistantMessage(
				[
					fauxText("TOOL-ROUND-COMMENTARY-ONE"),
					fauxToolCall("read", { path: "one.ts" }, { id: "read-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxText("TOOL-ROUND-COMMENTARY-TWO"),
					fauxToolCall("read", { path: "two.ts" }, { id: "read-2" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("FINAL_ADVICE_ONLY"),
		]);
		let aggregatorContext: Context | undefined;
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceTools: ["read"],
					referenceToolRounds: 3,
				}),
			),
		).result();

		const references = thinkingFromResult(result);
		expect(references).toContain("FINAL_ADVICE_ONLY");
		expect(references).not.toContain("TOOL-ROUND-COMMENTARY");
		const guidance = JSON.stringify(aggregatorContext?.messages);
		expect(guidance).toContain("FINAL_ADVICE_ONLY");
		expect(guidance).not.toContain("TOOL-ROUND-COMMENTARY");
		expect(refA.state.callCount).toBe(3);
	});

	it("forces one no-tools final reference request when the tool-round cap is reached", async () => {
		__setReferenceToolFactoryForTests((names) =>
			names.map((name) => createTestReferenceTool(name)),
		);
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let finalRoundTools: unknown;
		refA.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "one.ts" }, { id: "t1" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				finalRoundTools = context.tools;
				return fauxAssistantMessage("forced final advice");
			},
		]);
		agg.setResponses([fauxAssistantMessage("final answer")]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceTools: ["read"],
					referenceToolRounds: 1,
				}),
			),
		).result();

		expect(finalRoundTools).toBeUndefined();
		expect(thinkingFromResult(result)).toContain("forced final advice");
		expect(refA.state.callCount).toBe(2);
	});

	it("applies the reference character budget only to final agentic advice", async () => {
		__setReferenceToolFactoryForTests((names) =>
			names.map((name) => createTestReferenceTool(name)),
		);
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([
			fauxAssistantMessage(
				[
					fauxText(`TOOL-COMMENTARY-${"x".repeat(500)}-TOOL-TAIL`),
					fauxToolCall("read", { path: "one.ts" }, { id: "t1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(`FINAL-${"y".repeat(500)}-FINAL-TAIL`),
		]);
		agg.setResponses([fauxAssistantMessage("final answer")]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceTools: ["read"],
					referenceToolRounds: 3,
					maxReferenceOutputChars: 120,
				}),
			),
		).result();

		const references = thinkingFromResult(result);
		expect(refA.state.callCount).toBe(2);
		expect(references).toContain("FINAL-");
		expect(references).not.toContain("FINAL-TAIL");
		expect(references).not.toContain("TOOL-COMMENTARY");
	});

	it("fails an agentic reference gracefully when referenceTimeoutMs fires mid-model round", async () => {
		__setReferenceToolFactoryForTests((names) =>
			names.map((name) => createTestReferenceTool(name)),
		);
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([() => new Promise<never>(() => {})]);
		agg.setResponses([fauxAssistantMessage("final answer")]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceTools: ["read"],
					referenceTimeoutMs: 30,
				}),
			),
		).result();

		const references = thinkingFromResult(result);
		expect(textFromResult(result)).toContain("final answer");
		expect(references).toContain("ref-a/a (failed)");
		expect(references).toContain("referenceTimeoutMs");
	});

	it("fails an agentic reference gracefully when referenceTimeoutMs aborts tool execution", async () => {
		__setReferenceToolFactoryForTests((names) =>
			names.map((name) =>
				createTestReferenceTool(name, async (_toolCallId, _params, signal) => {
					await new Promise<never>((_resolve, reject) => {
						if (signal?.aborted) {
							reject(new Error("slow tool aborted"));
							return;
						}
						signal?.addEventListener(
							"abort",
							() => setTimeout(() => reject(new Error("slow tool aborted")), 0),
							{ once: true },
						);
					});
					return { content: [] };
				}),
			),
		);
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "slow.ts" }, { id: "t1" }), {
				stopReason: "toolUse",
			}),
		]);
		agg.setResponses([fauxAssistantMessage("final answer")]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceTools: ["read"],
					referenceTimeoutMs: 50,
				}),
			),
		).result();

		const references = thinkingFromResult(result);
		expect(textFromResult(result)).toContain("final answer");
		expect(references).toContain("ref-a/a (failed)");
		expect(references).toContain("referenceTimeoutMs");
	});

	it("drops an in-flight agentic reference when referenceQuorum aborts the loop", async () => {
		let slowToolStarted!: () => void;
		const slowToolStart = new Promise<void>((resolve) => {
			slowToolStarted = resolve;
		});
		let slowToolAborted = false;
		__setReferenceToolFactoryForTests((names) =>
			names.map((name) =>
				createTestReferenceTool(name, async (_toolCallId, _params, signal) => {
					slowToolStarted();
					await new Promise<never>((_resolve, reject) => {
						if (signal?.aborted) {
							slowToolAborted = true;
							reject(new Error("slow tool aborted"));
							return;
						}
						signal?.addEventListener(
							"abort",
							() => {
								slowToolAborted = true;
								reject(new Error("slow tool aborted"));
							},
							{ once: true },
						);
					});
					return { content: [] };
				}),
			),
		);
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		refA.setResponses([
			async () => {
				await slowToolStart;
				return fauxAssistantMessage("advice A");
			},
		]);
		refB.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "slow.ts" }, { id: "t1" }), {
				stopReason: "toolUse",
			}),
		]);
		agg.setResponses([fauxAssistantMessage("final answer")]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: refB.getModel("b")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({
					referenceQuorum: 1,
					referenceTools: ["read"],
				}),
			),
		).result();

		expect(textFromResult(result)).toContain("final answer");
		const references = thinkingFromResult(result);
		expect(references).toContain("ref-a/a");
		expect(references).toContain("advice A");
		expect(references).not.toContain("ref-b/b");
		expect(references).not.toContain("(failed)");
		expect(slowToolAborted).toBe(true);
	});

	it("strips stale guidance before reference and aggregator contexts are built", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		let referenceContext: Context | undefined;
		let aggregatorContext: Context | undefined;
		refA.setResponses([
			(context) => {
				referenceContext = context;
				return fauxAssistantMessage("fresh advice A");
			},
		]);
		refB.setResponses([fauxAssistantMessage("fresh advice B")]);
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("ok");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{
				messages: [
					{ role: "user", content: "question", timestamp: 1 },
					{
						role: "user",
						content: `${MOA_GUIDANCE_MARKER}\nstale old advice`,
						timestamp: 2,
					},
				],
			},
			undefined,
			registry,
			baseConfig(),
		).result();
		expect(JSON.stringify(referenceContext?.messages)).not.toContain(
			"stale old advice",
		);
		expect(JSON.stringify(aggregatorContext?.messages)).not.toContain(
			"stale old advice",
		);
		// Fresh references are handed to the aggregator as guidance on the user turn.
		expect(JSON.stringify(aggregatorContext?.messages)).toContain(
			"fresh advice A",
		);
		expect(JSON.stringify(aggregatorContext?.messages)).not.toContain(
			"stale old advice",
		);
	});

	it("keeps running when one reference fails by default", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice A")]);
		refB.setResponses([
			() => {
				throw new Error("reference exploded Bearer secret-token");
			},
		]);
		let aggregatorContext: Context | undefined;
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("still ok");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(),
		).result();
		const resultText = textFromResult(result);
		expect(resultText).toContain("still ok");
		const references = thinkingFromResult(result);
		expect(references).toContain("ref-a/a");
		expect(references).toContain("advice A");
		expect(references).toContain("ref-b/b (failed)");
		expect(references).toContain("Bearer [REDACTED]");
		// The failure + redaction also reach the aggregator via the user-turn guidance.
		const aggMessages = JSON.stringify(aggregatorContext?.messages);
		expect(aggMessages).toContain("FAILED");
		expect(aggMessages).toContain("Bearer [REDACTED]");
	});

	it("fails the turn when failOnReferenceError is true", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([
			() => {
				throw new Error("boom");
			},
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(
				basePreset({
					failOnReferenceError: true,
					referenceModels: [{ provider: "ref-a", model: "a" }],
				}),
			),
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("boom");
	});

	it("surfaces missing aggregator and auth failures as fatal errors", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		const missingAggregator = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([{ model: refA.getModel("a")! }]),
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();
		expect(missingAggregator.stopReason).toBe("error");
		expect(missingAggregator.errorMessage).toContain(
			"aggregator model not found",
		);

		const authFailed = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{
					model: agg.getModel("main")!,
					auth: { ok: false, error: "No API key found" },
				},
			]),
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();
		expect(authFailed.stopReason).toBe("error");
		expect(authFailed.errorMessage).toContain("aggregator auth failed");
	});

	it("keeps aggregator error responses bare — references are not prepended on error", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		// A plain error response from the aggregator (not a thrown exception) drives
		// the inner error-event path through prepareAggregatorMessage.
		agg.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "rate limited",
			}),
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("rate limited");
		// The reference thinking block only rides on the success path; an error
		// message stays bare so references are never mistaken for an answer.
		expect(result.content.every((block) => block.type !== "thinking")).toBe(
			true,
		);
		expect(JSON.stringify(result.content)).not.toContain(
			MOA_REFERENCE_THINKING_MARKER,
		);
	});

	it("aborts before references and during the reference phase without running the aggregator", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		agg.setResponses([fauxAssistantMessage("should never run")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const preset = basePreset({
			referenceModels: [{ provider: "ref-a", model: "a" }],
		});

		// Pre-start: an already-aborted signal short-circuits before any model runs.
		refA.setResponses([fauxAssistantMessage("advice")]);
		const preStart = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			{ signal: AbortSignal.abort() },
			registry,
			baseConfig(preset),
		).result();
		expect(preStart.stopReason).toBe("aborted");
		expect(preStart.errorMessage).toContain("before references started");
		expect(agg.state.callCount).toBe(0);

		// Post-reference: aborting while a reference runs stops the turn before the
		// (expensive) aggregator is ever invoked.
		const controller = new AbortController();
		refA.setResponses([
			() => {
				controller.abort();
				return fauxAssistantMessage("advice");
			},
		]);
		const postReference = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			{ signal: controller.signal },
			registry,
			baseConfig(preset),
		).result();
		expect(postReference.stopReason).toBe("aborted");
		expect(postReference.errorMessage).toContain("during reference phase");
		expect(agg.state.callCount).toBe(0);
	});

	it("falls back to system-prompt guidance when tail-user guidance is rejected as consecutive-user", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		const aggregatorContexts: Context[] = [];
		agg.setResponses([
			(context) => {
				aggregatorContexts.push(context);
				throw new Error(
					"messages must alternate between user and assistant roles; got user after user",
				);
			},
			(context) => {
				aggregatorContexts.push(context);
				return fauxAssistantMessage("fallback answer");
			},
		]);

		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();

		const resultText = textFromResult(result);
		expect(resultText).toContain("fallback answer");
		// References are computed once, before the aggregator retry, so the result
		// carries exactly one reference thinking block even though the aggregator ran twice.
		expect(
			result.content.filter((block) => block.type === "thinking"),
		).toHaveLength(1);
		expect(thinkingFromResult(result)).toContain("advice");
		expect(agg.state.callCount).toBe(2);
		expect(
			aggregatorContexts[0].messages.map((message) => message.role),
		).toEqual(["user"]);
		expect(
			aggregatorContexts[1].messages.map((message) => message.role),
		).toEqual(["user"]);
		// First attempt: guidance appended to the tail of the user turn.
		expect(JSON.stringify(aggregatorContexts[0].messages)).toContain(
			MOA_GUIDANCE_MARKER,
		);
		// Rejected there, it falls back to system-prompt injection: guidance leaves the
		// user turn and moves to the system prompt.
		expect(JSON.stringify(aggregatorContexts[1].messages)).not.toContain(
			MOA_GUIDANCE_MARKER,
		);
		expect(aggregatorContexts[1].systemPrompt).toContain(MOA_GUIDANCE_MARKER);
		expect(aggregatorContexts[1].systemPrompt).toContain("advice");
	});

	it("remembers a provider that rejects the trailing turn and skips it on later turns", async () => {
		__resetTrailingPlacementCacheForTests();
		const refA = registerFaux("ref-a", "a");
		// A distinct provider so the process-wide rejection cache this test populates
		// cannot leak into other tests (which use provider "agg").
		const strictAgg = registerFaux("strict-agg", "main");
		refA.setResponses([
			fauxAssistantMessage("advice"),
			fauxAssistantMessage("advice"),
		]);
		const aggContexts: Context[] = [];
		// One responder reused for every aggregator call: it rejects (as a strict
		// role-alternation error) exactly when the guidance arrives as a *trailing*
		// user turn, and succeeds when it arrives folded into the system prompt.
		const dispatch = (context: Context) => {
			aggContexts.push(context);
			const last = context.messages[context.messages.length - 1];
			const guidanceIsTrailingUserTurn =
				last?.role === "user" &&
				JSON.stringify(last.content).includes(MOA_GUIDANCE_MARKER);
			if (guidanceIsTrailingUserTurn) {
				throw new Error(
					"messages must alternate between user and assistant roles; got user after user",
				);
			}
			return fauxAssistantMessage("final answer");
		};
		// Turn 1 makes two aggregator calls (rejected trailing, then system);
		// turn 2 should make only one (system, trailing skipped). Three total.
		strictAgg.setResponses([dispatch, dispatch, dispatch]);

		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: strictAgg.getModel("main")! },
		]);
		// A tool-loop transcript: ends on a tool result, so trailing-message appends a
		// NEW trailing user turn (the sequence a strict provider rejects).
		const toolLoopContext = (): Context => ({
			messages: [
				{ role: "user", content: "TASK: fix the bug", timestamp: 1 },
				fauxAssistantMessage([
					fauxToolCall("echo", { text: "run" }, { id: "t1" }),
				]),
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "echo",
					content: [{ type: "text", text: "tool output" }],
					isError: false,
					timestamp: 2,
				},
			],
		});
		const runTurn = () =>
			streamMoA(
				makeSyntheticMoAModel(strictAgg.getModel("main")!),
				toolLoopContext(),
				undefined,
				registry,
				baseConfig(
					basePreset({
						referenceModels: [{ provider: "ref-a", model: "a" }],
						aggregator: { provider: "strict-agg", model: "main" },
						aggregatorGuidancePlacement: "trailing-message",
					}),
				),
			).result();

		// Turn 1: trailing attempted, rejected, then the system fallback succeeds.
		const first = await runTurn();
		expect(textFromResult(first)).toContain("final answer");
		expect(strictAgg.state.callCount).toBe(2);
		// The first call carried a trailing guidance user turn; the fallback moved the
		// guidance into the system prompt.
		expect(aggContexts[0].messages[aggContexts[0].messages.length - 1]?.role).toBe(
			"user",
		);
		expect(JSON.stringify(aggContexts[0].messages)).toContain(MOA_GUIDANCE_MARKER);
		expect(aggContexts[1].systemPrompt).toContain(MOA_GUIDANCE_MARKER);
		expect(JSON.stringify(aggContexts[1].messages)).not.toContain(
			MOA_GUIDANCE_MARKER,
		);

		// Turn 2: the provider is now known to reject the trailing turn, so the
		// doomed attempt is skipped entirely — a single aggregator call that goes
		// straight to the system-prompt placement (no wasted trailing request).
		const second = await runTurn();
		expect(textFromResult(second)).toContain("final answer");
		expect(strictAgg.state.callCount).toBe(3);
		const turn2Context = aggContexts[2];
		expect(turn2Context.systemPrompt).toContain(MOA_GUIDANCE_MARKER);
		expect(JSON.stringify(turn2Context.messages)).not.toContain(
			MOA_GUIDANCE_MARKER,
		);
		__resetTrailingPlacementCacheForTests();
	});

	it("passes through aggregator tool call messages", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		agg.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), {
				stopReason: "toolUse",
			}),
		]);
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")! },
			]),
			baseConfig(
				basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
			),
		).result();
		expect(result.stopReason).toBe("toolUse");
		// The references thinking block leads; the aggregator's tool call follows it.
		expect(result.content[0]).toMatchObject({ type: "thinking" });
		const toolCalls = result.content.filter(
			(block) => block.type === "toolCall",
		);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({
			type: "toolCall",
			name: "echo",
			arguments: { text: "hi" },
		});
	});
});

describe("MoA extension wiring", () => {
	interface CapturedProvider {
		streamSimple: (
			model: Model<Api>,
			context: Context,
			options?: unknown,
		) => { result(): Promise<Awaited<ReturnType<typeof completeSimple>>> };
	}

	// biome-ignore lint/suspicious/noExplicitAny: a minimal ExtensionAPI test double
	type Handler = (event: any, ctx?: any) => any;

	function createFakePi() {
		const handlers = new Map<string, Handler>();
		let provider: CapturedProvider | undefined;
		const pi = {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerProvider(_id: string, config: CapturedProvider) {
				provider = config;
			},
		};
		return { pi, handlers, getProvider: () => provider };
	}

	it("strips the sentinel reference thinking block from assistant context and leaves everything else", () => {
		const fake = createFakePi();
		setup(fake.pi as unknown as Parameters<typeof setup>[0]);

		const contextHandler = fake.handlers.get("context");
		expect(contextHandler).toBeDefined();

		const referenceThinking = {
			type: "thinking",
			thinking: `${MOA_REFERENCE_THINKING_MARKER}\nref advice`,
		};
		const ownThinking = {
			type: "thinking",
			thinking: "the aggregator's own reasoning",
		};
		const answer = { type: "text", text: "the answer" };
		const assistant = {
			role: "assistant",
			content: [referenceThinking, ownThinking, answer],
		};
		const user = { role: "user", content: "hi", timestamp: 1 };

		const filtered = contextHandler?.({ messages: [assistant, user] });
		// The MoA reference thinking block is removed; the aggregator's own thinking,
		// the answer text, and unrelated messages pass through untouched.
		expect(filtered.messages[0].content).toEqual([ownThinking, answer]);
		expect(filtered.messages[1]).toBe(user);
	});

	// Runs one full MoA turn through the provider setup() registers, against a
	// fixture config staged where setup()'s own loadMoAConfig will find it —
	// moa.json is compulsory, so the wiring test brings its own instead of
	// depending on (or telemetry-polluting) the user's real one. References
	// succeed with distinctive advice; the aggregator answers "final answer".
	async function primeMoATurn(): Promise<{
		fake: ReturnType<typeof createFakePi>;
		preset: MoAPreset;
		result: Awaited<ReturnType<typeof completeSimple>>;
	}> {
		const config = baseConfig();
		const preset = config.presets[config.defaultPreset];
		const slots: ModelSlot[] = [...preset.referenceModels, preset.aggregator];

		const modelsByProvider = new Map<string, Set<string>>();
		for (const slot of slots) {
			if (!modelsByProvider.has(slot.provider))
				modelsByProvider.set(slot.provider, new Set());
			modelsByProvider.get(slot.provider)?.add(slot.model);
		}

		const registryEntries: RegistryEntry[] = [];
		for (const [provider, modelIds] of modelsByProvider) {
			const registration = registerFauxProvider({
				provider,
				models: [...modelIds].map((id) => ({ id, name: `${provider}/${id}` })),
			});
			registrations.push(registration);
			// The response queue is shared per provider and consumed FIFO, but
			// references run concurrently — so dispatch by model id rather than
			// relying on call order. One entry per call this provider will serve.
			const dispatch = (
				_context: Context,
				_options: unknown,
				_state: unknown,
				model: Model<Api>,
			) =>
				model.id === preset.aggregator.model &&
				model.provider === preset.aggregator.provider
					? fauxAssistantMessage("final answer")
					: fauxAssistantMessage(`advice from ${model.provider}/${model.id}`);
			const callCount = slots.filter(
				(slot) => slot.provider === provider,
			).length;
			registration.setResponses(
				Array.from({ length: callCount }, () => dispatch),
			);
			for (const id of modelIds)
				registryEntries.push({ model: registration.getModel(id)! });
		}
		const registry = createRegistry(registryEntries);

		// setup() loads the config itself, so stage the fixture where its
		// loadMoAConfig will find it.
		const agentDir = mkdtempSync(join(tmpdir(), "moa-wiring-"));
		writeFileSync(join(agentDir, "moa.json"), JSON.stringify(config));
		const fake = createFakePi();
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			setup(fake.pi as unknown as Parameters<typeof setup>[0]);
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
		// setup captures the registry on turn_start.
		fake.handlers.get("turn_start")?.({}, { modelRegistry: registry });

		const aggregatorModel = registry.find(
			preset.aggregator.provider,
			preset.aggregator.model,
		);
		expect(aggregatorModel).toBeDefined();
		const stream = fake
			.getProvider()
			?.streamSimple(
				makeSyntheticMoAModel(
					aggregatorModel as Model<Api>,
					config.defaultPreset,
				),
				{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
				undefined,
			);
		const result = await stream!.result();
		expect(textFromResult(result)).toContain("final answer");
		return { fake, preset, result };
	}

	it("emits references as a leading thinking block on the aggregator's message", async () => {
		const { result } = await primeMoATurn();
		const thinking = result.content.filter(
			(block) => block.type === "thinking",
		);
		expect(thinking).toHaveLength(1);
		const thinkingText = (thinking[0] as { thinking: string }).thinking;
		expect(thinkingText.startsWith(MOA_REFERENCE_THINKING_MARKER)).toBe(true);
		expect(thinkingText).toContain("advice from");
		// The thinking block leads; the answer text follows it.
		expect(result.content[0]).toMatchObject({ type: "thinking" });
		expect(textFromResult(result)).toContain("final answer");
	});

	it("keeps the reference thinking block out of the model context via the context handler", async () => {
		const { fake, result } = await primeMoATurn();
		const contextHandler = fake.handlers.get("context");
		// Round-trip the produced assistant message through the context handler, as
		// Pi does before the next model call: the reference thinking block is stripped
		// while the aggregator's answer text survives.
		const filtered = contextHandler?.({ messages: [result] });
		const content = filtered.messages[0].content as Array<{
			type: string;
			text?: string;
		}>;
		expect(content.some((block) => block.type === "thinking")).toBe(false);
		expect(
			content.some(
				(block) =>
					block.type === "text" && block.text?.includes("final answer"),
			),
		).toBe(true);
	});

});

describe("MoA fully-streamed preset", () => {
	it("streams a both-knobs preset end-to-end (references progressively, aggregator live)", async () => {
		// A preset with both streaming knobs on gives live feedback for the whole
		// turn. Iterate the real event stream — not just result() — to prove the
		// deltas actually surface, while confirming the persisted `done` message is
		// still the buffered shape: the safety property that makes streaming a
		// zero-regression, display-only speedup.
		const config = baseConfig(
			basePreset({
				// One shared provider so a single faux registration serves all slots.
				referenceModels: [
					{ provider: "faux", model: "ref-one" },
					{ provider: "faux", model: "ref-two" },
				],
				aggregator: { provider: "faux", model: "agg-main" },
				streamReferences: true,
				streamAggregator: true,
			}),
		);
		const preset = config.presets[config.defaultPreset];

		const slots = [...preset.referenceModels, preset.aggregator];
		const modelIds = [...new Set(slots.map((slot) => slot.model))];
		const registration = registerFauxProvider({
			provider: preset.aggregator.provider,
			models: modelIds.map((id) => ({ id, name: id })),
		});
		registrations.push(registration);
		registration.setResponses(
			slots.map(
				() =>
					(
						_context: Context,
						_options: unknown,
						_state: unknown,
						model: Model<Api>,
					) =>
						model.id === preset.aggregator.model
							? fauxAssistantMessage("the final answer streams in")
							: fauxAssistantMessage(`advice from ${model.id}`),
			),
		);
		const registry = createRegistry(
			modelIds.map((id) => ({ model: registration.getModel(id)! })),
		);

		const stream = streamMoA(
			makeSyntheticMoAModel(
				registration.getModel(preset.aggregator.model)!,
				config.defaultPreset,
			),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			config,
		);

		const events = await collectEvents(stream);

		// streamReferences: the reference thinking block fills in progressively at
		// content index 0 — more than the single atomic delta the buffered path emits.
		const thinkingDeltas = events.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
				event.type === "thinking_delta" && event.contentIndex === 0,
		);
		expect(thinkingDeltas.length).toBeGreaterThan(1);
		expect(thinkingDeltas[0]?.delta).toContain(MOA_REFERENCE_THINKING_MARKER);

		// streamAggregator: the answer arrives as incremental text_delta events shifted
		// to index 1+ (index 0 is the reference thinking prelude), not one final burst.
		const textDeltas = events.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
				event.type === "text_delta",
		);
		expect(textDeltas.length).toBeGreaterThan(0);
		expect(textDeltas.every((event) => event.contentIndex >= 1)).toBe(true);
		expect(textDeltas.map((event) => event.delta).join("")).toContain(
			"the final answer streams in",
		);

		// The persisted `done` message is unchanged by streaming: reference thinking at
		// index 0, the aggregator's answer following — identical to the buffered path.
		const done = events.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> =>
				event.type === "done",
		);
		expect(done).toHaveLength(1);
		const finalMessage = done[0].message;
		expect(finalMessage.content[0]?.type).toBe("thinking");
		expect(textFromResult(finalMessage)).toContain("the final answer streams in");
	});
});

describe("MoA pre-warm wait policy", () => {
	it("proceeds cold after a bounded grace instead of waiting for a stalled pre-warm", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		let warmAborted = false;
		agg.setResponses([
			// The warm-up request stalls forever (a provider that accepts the request
			// but never streams). Before the bounded grace, this held the whole turn
			// hostage; now the real request proceeds cold after the grace elapses.
			(_context, options) =>
				new Promise((_resolve, reject) => {
					(options as { signal?: AbortSignal }).signal?.addEventListener(
						"abort",
						() => {
							warmAborted = true;
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
			fauxAssistantMessage("final answer"),
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					aggregatorPrewarm: true,
				}),
			),
		).result();
		expect(textFromResult(result)).toContain("final answer");
		// The straggling warm-up is cancelled when the turn proceeds cold, so it
		// stops consuming in the background.
		expect(warmAborted).toBe(true);
	});
});

describe("MoA reference cadence", () => {
	const toolLoopMessages = (): Context["messages"] => [
		{ role: "user", content: "question", timestamp: 1 },
		fauxAssistantMessage([fauxToolCall("echo", { text: "hi" }, { id: "tool-1" })]),
		{
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "echo",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: 3,
		},
	];

	it("reuses the user turn's guidance on tool-loop turns and recomputes on a new user message", async () => {
		__resetReferenceGuidanceCacheForTests();
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let referenceRuns = 0;
		const advise = () => {
			referenceRuns += 1;
			return fauxAssistantMessage("cached advice");
		};
		refA.setResponses([advise, advise, advise]);
		const aggregatorContexts: string[] = [];
		const answer = (context: Context) => {
			aggregatorContexts.push(serializeContextText(context));
			return fauxAssistantMessage("final answer");
		};
		agg.setResponses([answer, answer, answer]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const config = baseConfig(
			basePreset({
				referenceModels: [{ provider: "ref-a", model: "a" }],
				referenceCadence: "user-turn",
			}),
		);
		const moaModel = makeSyntheticMoAModel(agg.getModel("main")!);

		// Turn 1: fresh user input → references run.
		await streamMoA(
			moaModel,
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			config,
		).result();
		expect(referenceRuns).toBe(1);

		// Turn 2: the tool loop continues the SAME user turn (transcript ends on a
		// tool result) → the cached guidance is reused, no reference request fires...
		await streamMoA(
			moaModel,
			{ messages: toolLoopMessages() },
			undefined,
			registry,
			config,
		).result();
		expect(referenceRuns).toBe(1);
		// ...but the aggregator still receives the cached advice as guidance.
		expect(aggregatorContexts[1]).toContain("cached advice");

		// Turn 3: a NEW user message arrives → the cache misses and references re-run.
		await streamMoA(
			moaModel,
			{
				messages: [
					...toolLoopMessages(),
					fauxAssistantMessage("done"),
					{ role: "user", content: "follow-up", timestamp: 5 },
				],
			},
			undefined,
			registry,
			config,
		).result();
		expect(referenceRuns).toBe(2);
	});

	it("runs references every turn when the cadence knob is unset", async () => {
		__resetReferenceGuidanceCacheForTests();
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		let referenceRuns = 0;
		const advise = () => {
			referenceRuns += 1;
			return fauxAssistantMessage("advice");
		};
		refA.setResponses([advise, advise]);
		agg.setResponses([
			fauxAssistantMessage("final answer"),
			fauxAssistantMessage("final answer"),
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const config = baseConfig(
			basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] }),
		);
		const moaModel = makeSyntheticMoAModel(agg.getModel("main")!);
		await streamMoA(
			moaModel,
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			config,
		).result();
		await streamMoA(
			moaModel,
			{ messages: toolLoopMessages() },
			undefined,
			registry,
			config,
		).result();
		// Default cadence: the tool-loop turn re-runs the references exactly as before.
		expect(referenceRuns).toBe(2);
	});
});

describe("MoA telemetry", () => {
	async function waitForLines(path: string, count: number): Promise<string[]> {
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				const lines = (await readFile(path, "utf-8"))
					.trimEnd()
					.split("\n")
					.filter((line) => line.length > 0);
				if (lines.length >= count) {
					return lines;
				}
			} catch {
				// Not written yet — the emit is fire-and-forget after the stream ends.
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Expected ${count} telemetry line(s) at ${path}`);
	}

	async function waitForLine(path: string): Promise<string> {
		return (await waitForLines(path, 1))[0];
	}

	it("appends one JSONL timing record per turn when telemetryPath is set", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		agg.setResponses([fauxAssistantMessage("final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const telemetryPath = join(
			mkdtempSync(join(tmpdir(), "moa-telemetry-")),
			"timings.jsonl",
		);
		const preset = basePreset({
			referenceModels: [{ provider: "ref-a", model: "a" }],
		});
		const config: MoAConfig = {
			...baseConfig(preset),
			telemetryPath,
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			config,
		).result();

		const record = JSON.parse(await waitForLine(telemetryPath));
		expect(record.preset).toBe("default");
		expect(record.outcome).toBe("ok");
		expect(record.placement).toBe("latest-user");
		expect(record.guidanceReused).toBe(false);
		expect(record.references).toHaveLength(1);
		expect(record.references[0]).toMatchObject({
			provider: "ref-a",
			model: "a",
			stop: "stop",
		});
		expect(typeof record.references[0].firstTokenMs).toBe("number");
		expect(typeof record.references[0].settleMs).toBe("number");
		expect(typeof record.referencePhaseMs).toBe("number");
		expect(typeof record.aggregator.doneMs).toBe("number");
		expect(record.aggregator.usage).toBeDefined();
		const expectedGuidance = buildGuidanceBlock({
			presetName: "default",
			preset,
			referenceOutputs: [
				{ slot: preset.referenceModels[0], success: true, text: "advice" },
			],
		});
		expect(record.aggregator.guidanceChars).toBeGreaterThan(0);
		expect(record.aggregator.guidanceChars).toBe(expectedGuidance.length);
		expect(typeof record.totalMs).toBe("number");
	});

	it("records guidanceChars when reference cadence reuses cached guidance", async () => {
		__resetReferenceGuidanceCacheForTests();
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("cached advice")]);
		agg.setResponses([
			fauxAssistantMessage("final answer"),
			fauxAssistantMessage("final answer"),
		]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const telemetryPath = join(
			mkdtempSync(join(tmpdir(), "moa-telemetry-")),
			"timings.jsonl",
		);
		const preset = basePreset({
			referenceModels: [{ provider: "ref-a", model: "a" }],
			referenceCadence: "user-turn",
		});
		const config: MoAConfig = {
			...baseConfig(preset),
			telemetryPath,
		};
		const moaModel = makeSyntheticMoAModel(agg.getModel("main")!);

		await streamMoA(
			moaModel,
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			config,
		).result();
		await waitForLines(telemetryPath, 1);

		await streamMoA(
			moaModel,
			{
				messages: [
					{ role: "user", content: "question", timestamp: 1 },
					fauxAssistantMessage([
						fauxToolCall("echo", { text: "hi" }, { id: "tool-1" }),
					]),
					{
						role: "toolResult",
						toolCallId: "tool-1",
						toolName: "echo",
						content: [{ type: "text", text: "tool output" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			undefined,
			registry,
			config,
		).result();

		const lines = await waitForLines(telemetryPath, 2);
		const reusedRecord = JSON.parse(lines[1]);
		const expectedGuidance = buildGuidanceBlock({
			presetName: "default",
			preset,
			referenceOutputs: [
				{
					slot: preset.referenceModels[0],
					success: true,
					text: "cached advice",
				},
			],
		});
		expect(reusedRecord.guidanceReused).toBe(true);
		expect(reusedRecord.aggregator.guidanceChars).toBeGreaterThan(0);
		expect(reusedRecord.aggregator.guidanceChars).toBe(
			expectedGuidance.length,
		);
	});

	it("records agentic reference rounds, tool-call metadata, and round usage without text", async () => {
		__setReferenceToolFactoryForTests((names) =>
			names.map((name) => createTestReferenceTool(name)),
		);
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "secret.ts" }, { id: "t1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("FINAL_AGENTIC_ADVICE"),
		]);
		agg.setResponses([fauxAssistantMessage("final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: agg.getModel("main")! },
		]);
		const telemetryPath = join(
			mkdtempSync(join(tmpdir(), "moa-telemetry-")),
			"timings.jsonl",
		);
		const config: MoAConfig = {
			...baseConfig(
				basePreset({
					referenceModels: [{ provider: "ref-a", model: "a" }],
					referenceTools: ["read"],
				}),
			),
			telemetryPath,
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			config,
		).result();

		const recordText = await waitForLine(telemetryPath);
		const record = JSON.parse(recordText);
		expect(record.references[0].rounds).toBe(2);
		expect(record.references[0].toolCalls).toEqual([
			{ round: 1, name: "read", isError: false },
		]);
		expect(record.references[0].roundUsage).toHaveLength(2);
		expect(record.references[0].roundUsage[0]).toMatchObject({
			round: 1,
			input: expect.any(Number),
			output: expect.any(Number),
			cacheRead: expect.any(Number),
			cacheWrite: expect.any(Number),
			costUsd: expect.any(Number),
		});
		expect(recordText).not.toContain("FINAL_AGENTIC_ADVICE");
		expect(recordText).not.toContain("secret.ts");
	});

	it("records a quorum-cancelled reference as aborted, not error", async () => {
		const refA = registerFaux("ref-a", "a");
		const refB = registerFaux("ref-b", "b");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice A")]);
		// refB is mid-flight when the quorum is reached and honors the phase abort
		// by rejecting — the shape of a real provider stream being cancelled.
		refB.setResponses([
			(_context, options) =>
				new Promise((_resolve, reject) => {
					(options as { signal?: AbortSignal }).signal?.addEventListener(
						"abort",
						() => reject(new Error("cancelled by quorum")),
						{ once: true },
					);
				}),
		]);
		agg.setResponses([fauxAssistantMessage("final answer")]);
		const registry = createRegistry([
			{ model: refA.getModel("a")! },
			{ model: refB.getModel("b")! },
			{ model: agg.getModel("main")! },
		]);
		const telemetryPath = join(
			mkdtempSync(join(tmpdir(), "moa-telemetry-")),
			"timings.jsonl",
		);
		const config: MoAConfig = {
			...baseConfig(basePreset({ referenceQuorum: 1 })),
			telemetryPath,
		};
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			config,
		).result();

		const record = JSON.parse(await waitForLine(telemetryPath));
		expect(record.outcome).toBe("ok");
		const stops = Object.fromEntries(
			(record.references as Array<{ model: string; stop?: string }>).map(
				(ref) => [ref.model, ref.stop],
			),
		);
		expect(stops.a).toBe("stop");
		expect(stops.b).toBe("aborted");
	});

	// emit() is fire-and-forget, so each step polls until the record lands before
	// emitting the next — otherwise the trim's stat could race the prior append.
	async function emitAndWait(
		path: string,
		preset: string,
		maxBytes: number,
	): Promise<void> {
		new TurnTelemetry(path, preset, maxBytes).emit();
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				if ((await readFile(path, "utf-8")).includes(`"${preset}"`)) {
					return;
				}
			} catch {
				// Not written yet.
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Telemetry record for "${preset}" never appeared`);
	}

	it("trims the oldest lines in place once the file reaches telemetryMaxBytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "moa-telemetry-"));
		const path = join(dir, "timings.jsonl");
		// Each bare record is ~150 bytes; a 400-byte cap forces a trim within a few
		// turns while half the cap still fits at least one whole record.
		const cap = 400;
		for (let turn = 1; turn <= 6; turn++) {
			await emitAndWait(path, `turn-${turn}`, cap);
		}

		const content = await readFile(path, "utf-8");
		const lines = content.split("\n").filter((line) => line !== "");
		// Oldest records were dropped, newest survived, and the file stayed capped.
		expect(lines.length).toBeLessThan(6);
		expect(content).not.toContain('"turn-1"');
		expect(content).toContain('"turn-6"');
		expect(content.length).toBeLessThanOrEqual(cap + 200);
		// Every surviving line is a complete record — the cut landed on a boundary.
		for (const line of lines) {
			expect(JSON.parse(line).v).toBe(1);
		}
		// The atomic-rewrite scratch file was renamed away, not left behind.
		await expect(readFile(`${path}.tmp`, "utf-8")).rejects.toThrow();
	});

	it("never trims when telemetryMaxBytes is 0", async () => {
		const dir = mkdtempSync(join(tmpdir(), "moa-telemetry-"));
		const path = join(dir, "timings.jsonl");
		for (let turn = 1; turn <= 6; turn++) {
			await emitAndWait(path, `turn-${turn}`, 0);
		}
		const lines = (await readFile(path, "utf-8"))
			.split("\n")
			.filter((line) => line !== "");
		expect(lines.length).toBe(6);
	});

	it("applies the default cap when telemetryMaxBytes is unset", () => {
		const telemetry = createTurnTelemetry("/tmp/unused.jsonl", "default");
		expect(telemetry).toBeInstanceOf(TurnTelemetry);
		expect(
			(telemetry as unknown as { maxBytes: number }).maxBytes,
		).toBe(16 * 1024 * 1024);
	});
});
