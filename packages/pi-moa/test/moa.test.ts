import {
	type Api,
	type Context,
	type completeSimple,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Model,
	registerFauxProvider,
	Type,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { getPreset, loadMoAConfig, validateMoAConfig } from "../src/extensions/config.js";
import setup, { buildSyntheticModels } from "../src/extensions/moa.js";
import {
	appendGuidanceToLatestUser,
	buildGuidanceBlock,
	buildReferenceContext,
	buildReferenceDisplayContent,
	injectGuidance,
	MOA_GUIDANCE_MARKER,
	MOA_REFERENCE_CUSTOM_TYPE,
	redactErrorMessage,
	stripPriorMoAGuidanceMessages,
} from "../src/extensions/messages.js";
import { streamMoA } from "../src/extensions/orchestrator.js";
import type { MoAConfig, MoAPreset, MoAReferenceDisplayDetails, ModelSlot } from "../src/extensions/types.js";

type FauxRegistration = ReturnType<typeof registerFauxProvider>;

type AuthResult = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

interface RegistryEntry {
	model: Model<Api>;
	auth?: AuthResult;
}

const registrations: FauxRegistration[] = [];

afterEach(() => {
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
	const map = new Map(entries.map((entry) => [`${entry.model.provider}:${entry.model.id}`, entry]));
	return {
		find(provider: string, modelId: string) {
			return map.get(`${provider}:${modelId}`)?.model;
		},
		async getApiKeyAndHeaders(model: Model<Api>) {
			return map.get(`${model.provider}:${model.id}`)?.auth ?? { ok: true, apiKey: "test-key" };
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

function textFromResult(result: Awaited<ReturnType<typeof completeSimple>>): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function createDisplayCapture(): {
	hooks: { onReferenceOutputs: (details: MoAReferenceDisplayDetails) => void };
	displays: MoAReferenceDisplayDetails[];
} {
	const displays: MoAReferenceDisplayDetails[] = [];
	return { hooks: { onReferenceOutputs: (details) => displays.push(details) }, displays };
}

// Flattens the structured reference details into a searchable string. Assertions
// use this rather than the custom message `content`, which is a leak-safe
// pointer that deliberately omits the advice bodies (those live in `details`).
function referenceText(displays: MoAReferenceDisplayDetails[]): string {
	return displays
		.flatMap((details) =>
			details.outputs.map(
				(output) => `${output.provider}/${output.model} ${output.success ? output.text : `FAILED ${output.errorMessage ?? ""}`}`,
			),
		)
		.join("\n");
}

function makeSyntheticMoAModel(realModel: Model<Api>, presetName = "default"): Model<Api> {
	return {
		...realModel,
		id: presetName,
		provider: "moa",
		api: "moa-api",
		baseUrl: "https://moa.invalid",
	};
}

describe("MoA config", () => {
	it("accepts a valid config and resolves enabled presets", () => {
		const config = baseConfig();
		expect(() => validateMoAConfig(config)).not.toThrow();
		expect(getPreset(config, "default").aggregator.model).toBe("main");
	});

	it("throws for missing or unknown defaultPreset", () => {
		expect(() => validateMoAConfig({ presets: {} })).toThrow(/defaultPreset/);
		expect(() => validateMoAConfig({ defaultPreset: "missing", presets: { default: basePreset() } })).toThrow(
			/defaultPreset "missing"/,
		);
	});

	it("rejects recursive moa providers", () => {
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ referenceModels: [{ provider: "moa", model: "default" }] }))),
		).toThrow(/cannot be "moa"/);
		expect(() =>
			validateMoAConfig(baseConfig(basePreset({ aggregator: { provider: "moa", model: "default" } }))),
		).toThrow(/cannot be "moa"/);
	});

	it("rejects invalid reference limits and missing required models", () => {
		expect(() => validateMoAConfig(baseConfig(basePreset({ maxReferences: 1 })))).toThrow(/exceeds/);
		expect(() => validateMoAConfig(baseConfig(basePreset({ referenceModels: [] })))).toThrow(/at least one/);
		expect(() =>
			validateMoAConfig(
				baseConfig({ ...basePreset(), aggregator: undefined as unknown as MoAPreset["aggregator"] }),
			),
		).toThrow(/aggregator/);
		expect(() => validateMoAConfig(baseConfig(basePreset({ maxReferenceOutputChars: 199 })))).toThrow(/200/);
		expect(() => validateMoAConfig(baseConfig(basePreset({ referenceConcurrency: 9 })))).toThrow(
			/referenceConcurrency/,
		);
	});

	it("does not generate synthetic models for disabled presets", () => {
		const config: MoAConfig = {
			defaultPreset: "default",
			presets: {
				default: basePreset(),
				disabled: basePreset({ enabled: false }),
			},
		};
		expect(buildSyntheticModels(config).map((model) => model.id)).toEqual(["default"]);
		expect(() => getPreset(config, "disabled")).toThrow(/disabled/);
	});
});

describe("MoA message shaping", () => {
	it("strips only prior synthetic guidance messages", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: `${MOA_GUIDANCE_MARKER}\nold`, timestamp: 1 },
				{ role: "user", content: `Please discuss ${MOA_GUIDANCE_MARKER} later`, timestamp: 2 },
			],
		};
		expect(stripPriorMoAGuidanceMessages(context).messages).toEqual([context.messages[1]]);
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
		expect(context.messages[2]).toEqual({ role: "user", content: latestContent, timestamp: 2 });
		expect(injected.messages[3]).toMatchObject({ role: "user", content: `${MOA_GUIDANCE_MARKER}\nnew` });
	});

	it("appends guidance to the latest string user message without adding a new message", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "older", timestamp: 1 },
				fauxAssistantMessage("assistant"),
				{ role: "user", content: "latest", timestamp: 2 },
			],
		};
		const appended = appendGuidanceToLatestUser(context, `${MOA_GUIDANCE_MARKER}\nnew`);
		expect(appended.messages).toHaveLength(3);
		expect(appended.messages[2]).toMatchObject({
			role: "user",
			content: `latest\n\n${MOA_GUIDANCE_MARKER}\nnew`,
			timestamp: 2,
		});
		expect(context.messages[2]).toEqual({ role: "user", content: "latest", timestamp: 2 });
	});

	it("appends guidance to the latest array user message without mutating original content", () => {
		const latestContent = [{ type: "text" as const, text: "latest" }];
		const context: Context = {
			messages: [
				{ role: "user", content: "older", timestamp: 1 },
				{ role: "user", content: latestContent, timestamp: 2 },
			],
		};
		const appended = appendGuidanceToLatestUser(context, `${MOA_GUIDANCE_MARKER}\nnew`);
		expect(appended.messages).toHaveLength(2);
		expect(appended.messages[1]).toMatchObject({
			role: "user",
			content: [latestContent[0], { type: "text", text: `\n\n${MOA_GUIDANCE_MARKER}\nnew` }],
			timestamp: 2,
		});
		expect(context.messages[1]).toEqual({ role: "user", content: latestContent, timestamp: 2 });
	});

	it("builds reference context without tools and renders private-safe history", () => {
		const longToolResult = `${"a".repeat(3000)}TAIL`;
		const context: Context = {
			systemPrompt: "acting system prompt",
			tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }],
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
		expect(referenceContext.messages[0]).toMatchObject({ role: "user", content: "hello\n[image:image/png:4]" });
		// Tool results fold into the preceding assistant turn (advisor framing),
		// so the tool call and its result share one assistant message rather than
		// the result arriving as a "user" turn that reads like a task instruction.
		expect(referenceContext.messages[1].role).toBe("assistant");
		expect(JSON.stringify(referenceContext.messages[1])).not.toContain("secret thinking");
		expect(JSON.stringify(referenceContext.messages[1])).not.toContain("[assistant thinking omitted]");
		expect(JSON.stringify(referenceContext.messages[1])).toContain("[Tool call: echo(");
		expect(JSON.stringify(referenceContext.messages[1])).toContain("[Tool result: echo ->");
		expect(JSON.stringify(referenceContext.messages[1])).toContain("...[truncated 3004 chars]...");
		// No tool-role messages leak to the reference, and the view ends on a
		// synthetic user advisory turn so the reference advises rather than
		// continuing the task as if it were the acting agent.
		expect(referenceContext.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(
			true,
		);
		const lastReferenceMessage = referenceContext.messages[referenceContext.messages.length - 1];
		expect(lastReferenceMessage.role).toBe("user");
		expect(JSON.stringify(lastReferenceMessage)).toContain("private guidance to the aggregator");
	});

	it("merges the advisory turn into a trailing user message and never emits consecutive same-role turns", () => {
		const context: Context = {
			systemPrompt: "acting system prompt",
			messages: [
				{ role: "user", content: "first question", timestamp: 1 },
				fauxAssistantMessage([fauxToolCall("echo", { text: "a" }, { id: "t1" })]),
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "echo",
					content: [{ type: "text", text: "result-a" }],
					isError: false,
					timestamp: 2,
				},
				fauxAssistantMessage([fauxToolCall("echo", { text: "b" }, { id: "t2" })]),
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
		expect(JSON.stringify(lastReferenceMessage)).toContain("private guidance to the aggregator");
		// Both tool loops are visible to the advisor, folded into the one assistant turn.
		expect(JSON.stringify(referenceContext.messages[1])).toContain("result-a");
		expect(JSON.stringify(referenceContext.messages[1])).toContain("result-b");
	});

	it("produces a lone user advisory turn for an empty transcript", () => {
		const referenceContext = buildReferenceContext({ messages: [] }, basePreset());
		expect(referenceContext.tools).toBeUndefined();
		expect(referenceContext.messages).toHaveLength(1);
		expect(referenceContext.messages[0].role).toBe("user");
		expect(JSON.stringify(referenceContext.messages[0])).toContain("private guidance to the aggregator");
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
		expect(referenceContext.messages.map((message) => message.role)).toEqual(["user"]);
		const only = JSON.stringify(referenceContext.messages[0]);
		expect(only).toContain("orphan-result");
		expect(only).toContain("continue");
		expect(only).toContain("private guidance to the aggregator");
	});

	it("builds guidance with truncation and redacted failed references", () => {
		const guidance = buildGuidanceBlock({
			presetName: "default",
			preset: basePreset({ maxReferenceOutputChars: 220 }),
			referenceOutputs: [
				{ slot: { provider: "ref-a", model: "a" }, success: true, text: "x".repeat(300) },
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

	it("redacts common credential patterns", () => {
		expect(redactErrorMessage("Authorization: Bearer secret-token")).toContain("Bearer [REDACTED]");
		expect(redactErrorMessage("api_key=abc123 token: xyz789 glpat-12345678901234567890")).not.toContain("abc123");
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
			tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }],
			messages: [{ role: "user", content: "question", timestamp: 1 }],
		};
		const { hooks, displays } = createDisplayCapture();
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			undefined,
			registry,
			baseConfig(),
			hooks,
		).result();
		const resultText = textFromResult(result);
		// Reference outputs are surfaced via the display hook (a separate custom
		// message), NOT prepended onto the aggregator's visible answer.
		expect(resultText).toContain("final answer");
		expect(resultText).not.toContain("## Reference model outputs");
		expect(resultText).not.toContain("advice A");
		expect(displays).toHaveLength(1);
		expect(displays[0].outputs).toHaveLength(2);
		const references = referenceText(displays);
		expect(references).toContain("ref-a/a");
		expect(references).toContain("advice A");
		expect(references).toContain("ref-b/b");
		expect(references).toContain("advice B");
		expect(seenReferenceTools).toEqual([undefined, undefined]);
		expect(aggregatorContext?.tools).toBe(context.tools);
		expect(aggregatorContext?.messages.map((message) => message.role)).toEqual(["user"]);
		expect(aggregatorContext?.systemPrompt).toContain("advice A");
		expect(aggregatorContext?.systemPrompt).toContain("advice B");
		expect(JSON.stringify(aggregatorContext?.messages)).not.toContain(MOA_GUIDANCE_MARKER);
	});

	it("strips onPayload/onResponse hooks from references but keeps them for the aggregator", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		const referenceHooks: Array<{ onPayload: unknown; onResponse: unknown }> = [];
		let aggregatorKeptHooks = false;
		refA.setResponses([
			(_context, options) => {
				referenceHooks.push({ onPayload: options?.onPayload, onResponse: options?.onResponse });
				return fauxAssistantMessage("advice");
			},
		]);
		agg.setResponses([
			(_context, options) => {
				aggregatorKeptHooks = options?.onPayload !== undefined && options?.onResponse !== undefined;
				return fauxAssistantMessage("final answer");
			},
		]);
		const registry = createRegistry([{ model: refA.getModel("a")! }, { model: agg.getModel("main")! }]);
		const context: Context = { messages: [{ role: "user", content: "question", timestamp: 1 }] };
		await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			context,
			{ onPayload: () => undefined, onResponse: () => undefined },
			registry,
			baseConfig(basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] })),
		).result();
		// The reference never sees the payload-mutation hooks (the only path by
		// which tool schemas could still reach a supposedly tool-free reference)...
		expect(referenceHooks).toEqual([{ onPayload: undefined, onResponse: undefined }]);
		// ...while the aggregator, the acting model, keeps them.
		expect(aggregatorKeptHooks).toBe(true);
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

		const { hooks, displays } = createDisplayCapture();
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([{ model: refA.getModel("a")! }, { model: agg.getModel("main")! }]),
			baseConfig(basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] })),
			hooks,
		).result();

		const resultText = textFromResult(result);
		expect(resultText).toContain("final answer");
		expect(resultText).not.toContain(MOA_GUIDANCE_MARKER);
		expect(resultText).not.toContain("private stuff that must not leak");
		expect(referenceText(displays)).toContain("advice");
	});

	it("treats reference tool calls as reference failures", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" })]);
		let aggregatorContext: Context | undefined;
		agg.setResponses([
			(context) => {
				aggregatorContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);

		const { hooks, displays } = createDisplayCapture();
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([{ model: refA.getModel("a")! }, { model: agg.getModel("main")! }]),
			baseConfig(basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] })),
			hooks,
		).result();

		const resultText = textFromResult(result);
		expect(resultText).toContain("final answer");
		expect(displays[0].outputs[0]).toMatchObject({ provider: "ref-a", model: "a", success: false });
		expect(referenceText(displays)).toContain("Reference attempted to use a tool");
		expect(aggregatorContext?.systemPrompt).toContain("Reference attempted to use a tool");
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
					{ role: "user", content: `${MOA_GUIDANCE_MARKER}\nstale old advice`, timestamp: 2 },
				],
			},
			undefined,
			registry,
			baseConfig(),
		).result();
		expect(JSON.stringify(referenceContext?.messages)).not.toContain("stale old advice");
		expect(JSON.stringify(aggregatorContext?.messages)).not.toContain("stale old advice");
		expect(aggregatorContext?.systemPrompt).toContain("fresh advice A");
		expect(aggregatorContext?.systemPrompt).not.toContain("stale old advice");
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
		const { hooks, displays } = createDisplayCapture();
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(),
			hooks,
		).result();
		const resultText = textFromResult(result);
		expect(resultText).toContain("still ok");
		const references = referenceText(displays);
		expect(references).toContain("ref-a/a");
		expect(references).toContain("advice A");
		expect(references).toContain("ref-b/b FAILED");
		expect(references).toContain("Bearer [REDACTED]");
		expect(aggregatorContext?.systemPrompt).toContain("FAILED");
		expect(aggregatorContext?.systemPrompt).toContain("Bearer [REDACTED]");
	});

	it("fails the turn when failOnReferenceError is true", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([
			() => {
				throw new Error("boom");
			},
		]);
		const registry = createRegistry([{ model: refA.getModel("a")! }, { model: agg.getModel("main")! }]);
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			registry,
			baseConfig(basePreset({ failOnReferenceError: true, referenceModels: [{ provider: "ref-a", model: "a" }] })),
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
			baseConfig(basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] })),
		).result();
		expect(missingAggregator.stopReason).toBe("error");
		expect(missingAggregator.errorMessage).toContain("aggregator model not found");

		const authFailed = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([
				{ model: refA.getModel("a")! },
				{ model: agg.getModel("main")!, auth: { ok: false, error: "No API key found" } },
			]),
			baseConfig(basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] })),
		).result();
		expect(authFailed.stopReason).toBe("error");
		expect(authFailed.errorMessage).toContain("aggregator auth failed");
	});

	it("retries aggregator without adding visible synthetic user guidance", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		const aggregatorContexts: Context[] = [];
		agg.setResponses([
			(context) => {
				aggregatorContexts.push(context);
				throw new Error("messages must alternate between user and assistant roles; got user after user");
			},
			(context) => {
				aggregatorContexts.push(context);
				return fauxAssistantMessage("fallback answer");
			},
		]);

		const { hooks, displays } = createDisplayCapture();
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([{ model: refA.getModel("a")! }, { model: agg.getModel("main")! }]),
			baseConfig(basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] })),
			hooks,
		).result();

		const resultText = textFromResult(result);
		expect(resultText).toContain("fallback answer");
		// References are computed once, before the aggregator retry, so the display
		// hook fires exactly once even though the aggregator streamed twice.
		expect(displays).toHaveLength(1);
		expect(referenceText(displays)).toContain("advice");
		expect(agg.state.callCount).toBe(2);
		expect(aggregatorContexts[0].messages.map((message) => message.role)).toEqual(["user"]);
		expect(aggregatorContexts[1].messages.map((message) => message.role)).toEqual(["user"]);
		expect(JSON.stringify(aggregatorContexts[1].messages)).not.toContain(MOA_GUIDANCE_MARKER);
		expect(aggregatorContexts[1].systemPrompt).toContain(MOA_GUIDANCE_MARKER);
		expect(aggregatorContexts[1].systemPrompt).toContain("advice");
	});

	it("passes through aggregator tool call messages", async () => {
		const refA = registerFaux("ref-a", "a");
		const agg = registerFaux("agg", "main");
		refA.setResponses([fauxAssistantMessage("advice")]);
		agg.setResponses([fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" })]);
		const result = await streamMoA(
			makeSyntheticMoAModel(agg.getModel("main")!),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
			createRegistry([{ model: refA.getModel("a")! }, { model: agg.getModel("main")! }]),
			baseConfig(basePreset({ referenceModels: [{ provider: "ref-a", model: "a" }] })),
		).result();
		expect(result.stopReason).toBe("toolUse");
		// Reference outputs are no longer prepended onto the aggregator's answer, so
		// a tool-call-only turn passes through as a lone tool call (no leading text).
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "toolCall", name: "echo", arguments: { text: "hi" } });
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
		const renderers = new Map<string, unknown>();
		const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
		let provider: CapturedProvider | undefined;
		const pi = {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerMessageRenderer(customType: string, _renderer: unknown) {
				renderers.set(customType, _renderer);
			},
			registerProvider(_id: string, config: CapturedProvider) {
				provider = config;
			},
			sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
				sent.push({ message, options });
			},
		};
		return { pi, handlers, renderers, sent, getProvider: () => provider };
	}

	function tick(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("registers the reference renderer and filters reference messages out of every model context", () => {
		const fake = createFakePi();
		setup(fake.pi as unknown as Parameters<typeof setup>[0]);

		expect(fake.renderers.has(MOA_REFERENCE_CUSTOM_TYPE)).toBe(true);

		const contextHandler = fake.handlers.get("context");
		expect(contextHandler).toBeDefined();
		const referenceMessage = { role: "custom", customType: MOA_REFERENCE_CUSTOM_TYPE, content: "refs" };
		const otherCustom = { role: "custom", customType: "some-other-extension", content: "keep me" };
		const userMessage = { role: "user", content: "hi", timestamp: 1 };
		const filtered = contextHandler?.({ messages: [referenceMessage, otherCustom, userMessage] });
		// Only our reference custom messages are dropped; unrelated custom messages
		// and ordinary turns pass through untouched.
		expect(filtered.messages).toEqual([otherCustom, userMessage]);
	});

	// Runs one full MoA turn through the provider setup() registers, using whatever
	// MoA config is active so the wiring is exercised end to end regardless of the
	// config values (references succeed with distinctive advice; aggregator answers
	// "final answer"). Leaves the reference outputs stashed but NOT yet flushed.
	async function primeMoATurn(): Promise<{ fake: ReturnType<typeof createFakePi>; preset: MoAPreset }> {
		const config = loadMoAConfig(process.cwd());
		const preset = config.presets[config.defaultPreset];
		const slots: ModelSlot[] = [...preset.referenceModels, preset.aggregator];

		const modelsByProvider = new Map<string, Set<string>>();
		for (const slot of slots) {
			if (!modelsByProvider.has(slot.provider)) modelsByProvider.set(slot.provider, new Set());
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
			const dispatch = (_context: Context, _options: unknown, _state: unknown, model: Model<Api>) =>
				model.id === preset.aggregator.model && model.provider === preset.aggregator.provider
					? fauxAssistantMessage("final answer")
					: fauxAssistantMessage(`advice from ${model.provider}/${model.id}`);
			const callCount = slots.filter((slot) => slot.provider === provider).length;
			registration.setResponses(Array.from({ length: callCount }, () => dispatch));
			for (const id of modelIds) registryEntries.push({ model: registration.getModel(id)! });
		}
		const registry = createRegistry(registryEntries);

		const fake = createFakePi();
		setup(fake.pi as unknown as Parameters<typeof setup>[0]);
		// setup captures the registry on turn_start.
		fake.handlers.get("turn_start")?.({}, { modelRegistry: registry });

		const aggregatorModel = registry.find(preset.aggregator.provider, preset.aggregator.model);
		expect(aggregatorModel).toBeDefined();
		const stream = fake.getProvider()?.streamSimple(
			makeSyntheticMoAModel(aggregatorModel as Model<Api>, config.defaultPreset),
			{ messages: [{ role: "user", content: "question", timestamp: 1 }] },
			undefined,
		);
		const result = await stream!.result();
		const resultText = textFromResult(result);
		// The aggregator answer is clean: no reference block prepended.
		expect(resultText).toContain("final answer");
		expect(resultText).not.toContain("advisory only");
		return { fake, preset };
	}

	it("flushes reference outputs once as a display-only custom message after the agent goes idle", async () => {
		const { fake, preset } = await primeMoATurn();

		// Nothing is emitted mid-turn...
		expect(fake.sent).toHaveLength(0);
		fake.handlers.get("agent_end")?.({}, { isIdle: () => true });
		// ...the flush is deferred to a macrotask so Pi sees the agent as idle...
		expect(fake.sent).toHaveLength(0);
		await tick();

		expect(fake.sent).toHaveLength(1);
		const { message, options } = fake.sent[0];
		expect(message.customType).toBe(MOA_REFERENCE_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		const details = message.details as MoAReferenceDisplayDetails;
		expect(details.outputs).toHaveLength(preset.referenceModels.length);
		// Full advice lives ONLY in details (never converted to model text)...
		expect(details.outputs.some((output) => output.text.includes("advice from"))).toBe(true);
		// ...while content is a leak-safe pointer (compaction converts content to a
		// user turn, so it must not carry the advice bodies).
		expect(message.content).toBe(buildReferenceDisplayContent(details));
		expect(message.content).toContain("advisory only");
		expect(message.content).not.toContain("advice from");
		// ...and it must never trigger another LLM turn.
		expect(options?.triggerTurn).toBe(false);

		// A subsequent idle event with nothing pending emits nothing further.
		fake.handlers.get("agent_end")?.({}, { isIdle: () => true });
		await tick();
		expect(fake.sent).toHaveLength(1);
	});

	it("defers the flush while a follow-up turn is streaming, then flushes once idle", async () => {
		const { fake } = await primeMoATurn();

		// agent_end fires but a follow-up turn is already streaming (not idle):
		// appending now would steer the block into that turn, so it must defer.
		fake.handlers.get("agent_end")?.({}, { isIdle: () => false });
		await tick();
		expect(fake.sent).toHaveLength(0);

		// The streaming turn ends; now idle, the next agent_end retries and flushes.
		fake.handlers.get("agent_end")?.({}, { isIdle: () => true });
		await tick();
		expect(fake.sent).toHaveLength(1);
	});

	it("cancels a scheduled flush and drops pending outputs on session shutdown", async () => {
		const { fake } = await primeMoATurn();

		fake.handlers.get("agent_end")?.({}, { isIdle: () => true }); // schedules the deferred flush
		fake.handlers.get("session_shutdown")?.({}, {}); // must cancel it before it fires
		await tick();

		expect(fake.sent).toHaveLength(0);
	});
});
