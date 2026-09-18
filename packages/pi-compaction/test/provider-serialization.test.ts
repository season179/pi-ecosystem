/**
 * Provider-validity gate: pruned overlays must serialize through pi-ai's real provider
 * converters without orphaned tool results, dangling tool calls or unpaired reasoning items.
 * Every serializer is stopped at its public `onPayload` hook, so no request leaves the process.
 */
import { stream as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as googleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as openaiCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Context, Model, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/engine/message.js";
import { PLACEHOLDER_MARKER, applyDecisions } from "../src/engine/transform.js";
import type { Decision } from "../src/engine/types.js";

const SENTINEL = "pi-compaction-serialization-capture";
const CODEX_KEY = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "pi-compaction-test" } })).toString("base64")}.sig`;

const TARGETS = {
	"anthropic-messages": { model: () => getBuiltinModel("anthropic", "claude-haiku-4-5"), stream: anthropicMessages, apiKey: "test" },
	"openai-completions": { model: () => getBuiltinModel("groq", "llama-3.3-70b-versatile"), stream: openaiCompletions, apiKey: "test" },
	"openai-responses": { model: () => getBuiltinModel("openai", "gpt-5.4"), stream: openaiResponses, apiKey: "test" },
	"openai-codex-responses": { model: () => getBuiltinModel("openai-codex", "gpt-5.4"), stream: openaiCodexResponses, apiKey: CODEX_KEY },
	"google-generative-ai": { model: () => getBuiltinModel("google", "gemini-2.5-flash"), stream: googleGenerativeAi, apiKey: "test" },
} as const;

let realFetch: typeof globalThis.fetch;
beforeAll(() => {
	realFetch = globalThis.fetch;
	globalThis.fetch = (() => {
		throw new Error("network must not be used");
	}) as typeof globalThis.fetch;
});
afterAll(() => {
	globalThis.fetch = realFetch;
});

function signature(api: string, index: number): string {
	if (api === "openai-responses" || api === "openai-codex-responses") return JSON.stringify({ type: "reasoning", id: `rs_${index}`, summary: [], encrypted_content: `enc_${index}` });
	return `sig_${index}`;
}

function callId(api: string, index: number): string {
	return api === "openai-responses" || api === "openai-codex-responses" ? `call_${index}|fc_${index}` : `call_${index}`;
}

/** user → thinking+2 reads → thinking+bash → plain read → text. Shaped as if produced by `model`. */
function transcript(model: Model<Api>): { messages: AgentMessage[]; ids: { a: string; b: string; bash: string; c: string } } {
	const ids = { a: callId(model.api, 1), b: callId(model.api, 2), bash: callId(model.api, 3), c: callId(model.api, 4) };
	const base = { api: model.api, provider: model.provider, model: model.id, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as const;
	let ts = 1_800_000_000_000;
	const big = (label: string) => `${label} line\n`.repeat(200);
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "Refactor the payment module." }], timestamp: ts++ },
		{
			...base,
			role: "assistant",
			stopReason: "toolUse",
			timestamp: ts++,
			content: [
				{ type: "thinking", thinking: "I should read both files.", thinkingSignature: signature(model.api, 1) },
				{ type: "toolCall", id: ids.a, name: "read", arguments: { path: "src/a.ts" } },
				{ type: "toolCall", id: ids.b, name: "read", arguments: { path: "src/b.ts" } },
			],
		},
		{ role: "toolResult", toolCallId: ids.a, toolName: "read", content: [{ type: "text", text: big("A") }], isError: false, timestamp: ts++ },
		{ role: "toolResult", toolCallId: ids.b, toolName: "read", content: [{ type: "text", text: big("B") }], isError: false, timestamp: ts++ },
		{
			...base,
			role: "assistant",
			stopReason: "toolUse",
			timestamp: ts++,
			content: [
				{ type: "thinking", thinking: "Run the tests.", thinkingSignature: signature(model.api, 2) },
				{ type: "toolCall", id: ids.bash, name: "bash", arguments: { command: "npm test" } },
			],
		},
		{ role: "toolResult", toolCallId: ids.bash, toolName: "bash", content: [{ type: "text", text: big("TEST") }], isError: false, timestamp: ts++ },
		{ ...base, role: "assistant", stopReason: "toolUse", timestamp: ts++, content: [{ type: "toolCall", id: ids.c, name: "read", arguments: { path: "src/c.ts" } }] },
		{ role: "toolResult", toolCallId: ids.c, toolName: "read", content: [{ type: "text", text: big("C") }], isError: false, timestamp: ts++ },
		{ ...base, role: "assistant", stopReason: "stop", timestamp: ts++, content: [{ type: "text", text: "Here is my plan." }] },
	];
	return { messages, ids };
}

function decision(toolCallId: string, requested: Decision["requested"], toolName: string): Decision {
	return { toolCallId, resultEntryId: `entry-${toolCallId.split("|")[0]}`, toolName, resultChars: 1_400, requested, effective: requested };
}

async function serialize<T>(stream: StreamFunction<Api, StreamOptions>, model: Model<Api>, context: Context, apiKey: string): Promise<T> {
	let payload: unknown;
	const events = stream(model, context, {
		apiKey,
		cacheRetention: "none",
		onPayload(candidate) {
			payload = candidate;
			throw new Error(SENTINEL);
		},
	} as StreamOptions);
	const result = await events.result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage ?? "").toContain(SENTINEL);
	expect(payload).toBeDefined();
	return payload as T;
}

const tools: Context["tools"] = [
	{ name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) },
	{ name: "bash", description: "run a command", parameters: Type.Object({ command: Type.String() }) },
];

function pruned(model: Model<Api>) {
	const { messages, ids } = transcript(model);
	const decisions = new Map<string, Decision>([
		[ids.a, decision(ids.a, "drop_pair", "read")], // partial drop inside a thinking group → downgraded to result replacement
		[ids.bash, decision(ids.bash, "drop_result", "bash")],
		[ids.c, decision(ids.c, "drop_pair", "read")], // plain group → removed entirely
	]);
	const result = applyDecisions(messages, decisions);
	expect(result.dropped).toEqual([ids.c]);
	expect(result.replaced.sort()).toEqual([ids.a, ids.bash].sort());
	expect(result.downgraded).toEqual([{ toolCallId: ids.a, reason: "provider_atomic" }]);
	return { context: { systemPrompt: "You are a coding agent.", messages: result.messages, tools } satisfies Context, ids };
}

describe("pruned overlays serialize validly for every provider family", () => {
	it("openai-codex-responses keeps every reasoning item paired with its function calls", async () => {
		const target = TARGETS["openai-codex-responses"];
		const model = target.model()!;
		const { context, ids } = pruned(model);
		const payload = await serialize<{ input: Array<Record<string, unknown>> }>(target.stream, model, context, target.apiKey);
		const items = payload.input;
		const reasoning = items.filter((item) => item.type === "reasoning");
		expect(reasoning.map((item) => item.id)).toEqual(["rs_1", "rs_2"]);
		const calls = items.filter((item) => item.type === "function_call").map((item) => item.call_id);
		const outputs = items.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
		expect(calls.sort()).toEqual(["call_1", "call_2", "call_3"]);
		expect(outputs.sort()).toEqual(["call_1", "call_2", "call_3"]);
		expect(JSON.stringify(items)).not.toContain("src/c.ts");
		// Each reasoning item is immediately followed by a function call or message from the same turn.
		for (let index = 0; index < items.length; index++) {
			if (items[index].type !== "reasoning") continue;
			expect(["function_call", "message"]).toContain(items[index + 1]?.type);
		}
		const replaced = items.find((item) => item.type === "function_call_output" && item.call_id === "call_1");
		expect(String(replaced?.output)).toContain(PLACEHOLDER_MARKER);
		expect(String(replaced?.output)).toContain(`entry-${ids.a.split("|")[0]}`);
	});

	it("openai-responses pairs function calls and outputs", async () => {
		const target = TARGETS["openai-responses"];
		const model = target.model()!;
		const { context } = pruned(model);
		const payload = await serialize<{ input: Array<Record<string, unknown>> }>(target.stream, model, context, target.apiKey);
		const calls = payload.input.filter((item) => item.type === "function_call").map((item) => item.call_id).sort();
		const outputs = payload.input.filter((item) => item.type === "function_call_output").map((item) => item.call_id).sort();
		expect(calls).toEqual(outputs);
		expect(calls).toEqual(["call_1", "call_2", "call_3"]);
	});

	it("openai-completions pairs tool_calls with tool messages", async () => {
		const target = TARGETS["openai-completions"];
		const model = target.model()!;
		const { context } = pruned(model);
		const payload = await serialize<{ messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string; content?: unknown }> }>(target.stream, model, context, target.apiKey);
		const calls = payload.messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []).sort();
		const results = payload.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id).sort();
		expect(calls).toEqual(["call_1", "call_2", "call_3"]);
		expect(results).toEqual(calls);
		expect(payload.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
	});

	it("anthropic-messages keeps tool_use/tool_result pairs and role alternation", async () => {
		const target = TARGETS["anthropic-messages"];
		const model = target.model()!;
		const { context } = pruned(model);
		const payload = await serialize<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }>(target.stream, model, context, target.apiKey);
		const uses = payload.messages.flatMap((message) => message.content.filter((block) => block.type === "tool_use").map((block) => block.id)).sort();
		const results = payload.messages.flatMap((message) => message.content.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id)).sort();
		expect(uses).toEqual(["call_1", "call_2", "call_3"]);
		expect(results).toEqual(uses);
		for (let index = 1; index < payload.messages.length; index++) expect(payload.messages[index].role).not.toBe(payload.messages[index - 1].role);
		const thinking = payload.messages.flatMap((message) => message.content.filter((block) => block.type === "thinking"));
		expect(thinking).toHaveLength(2);
	});

	it("google-generative-ai pairs functionCall and functionResponse parts", async () => {
		const target = TARGETS["google-generative-ai"];
		const model = target.model()!;
		const { context } = pruned(model);
		const payload = await serialize<{ contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }>(target.stream, model, context, target.apiKey);
		const calls = payload.contents.flatMap((content) => content.parts.filter((part) => part.functionCall).map((part) => (part.functionCall as { name: string }).name));
		const responses = payload.contents.flatMap((content) => content.parts.filter((part) => part.functionResponse).map((part) => (part.functionResponse as { name: string }).name));
		expect(calls).toEqual(["read", "read", "bash"]);
		expect(responses).toEqual(calls);
	});
});
