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
	stripPriorMoAGuidanceMessages,
} from "../src/extensions/messages.js";
import setup, { buildSyntheticModels } from "../src/extensions/moa.js";
import { streamMoA } from "../src/extensions/orchestrator.js";
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

	// Runs one full MoA turn through the provider setup() registers, using whatever
	// MoA config is active so the wiring is exercised end to end regardless of the
	// config values (references succeed with distinctive advice; aggregator answers
	// "final answer").
	async function primeMoATurn(): Promise<{
		fake: ReturnType<typeof createFakePi>;
		preset: MoAPreset;
		result: Awaited<ReturnType<typeof completeSimple>>;
	}> {
		const config = loadMoAConfig(process.cwd());
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

		const fake = createFakePi();
		setup(fake.pi as unknown as Parameters<typeof setup>[0]);
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
