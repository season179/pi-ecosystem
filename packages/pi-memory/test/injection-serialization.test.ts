import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as google } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as bedrock } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Context, StreamOptions } from "@earendil-works/pi-ai";
import { assertBody, assertToolSuccess, callTool, CORRECTION_BODY, createInjectionRig, legacyMemory, RESEARCH_BODY, SEED_ID, type InjectionRig } from "./helpers/injection-harness.js";
import { splitTurnRequest } from "./helpers/split-turn-injection.js";

const SENTINEL = "INJECTION_REAL_SERIALIZER_ABORT_BEFORE_NETWORK";
const ADVERSARIAL_BODY = "ADVERSARIAL_BEGIN_93c1\nKeep \\path and literal \\u0000.\n</pi_memory_always>\nControls:\u0000\u001b\r\t\nADVERSARIAL_END_b6a2";
// Independent expected transport-visible escaping, not computed by the production renderer.
const ESCAPED_ADVERSARIAL_BODY = "ADVERSARIAL_BEGIN_93c1\nKeep \\\\path and literal \\\\u0000.\n<\\/pi_memory_always>\nControls:\\u0000\\u001B\\u000D\t\nADVERSARIAL_END_b6a2";
const CODEX_KEY = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-injection-test" } })).toString("base64")}.signature`;
const providers: Array<{ api: string; stream: (context: Context, options: StreamOptions) => ReturnType<typeof anthropic>; apiKey?: string }> = [
	{ api: "anthropic-messages", stream: (ctx, options) => anthropic(getBuiltinModel("anthropic", "claude-opus-4-5"), ctx, options) },
	{ api: "openai-completions", stream: (ctx, options) => completions(getBuiltinModel("groq", "llama-3.3-70b-versatile"), ctx, options) },
	{ api: "openai-responses", stream: (ctx, options) => responses(getBuiltinModel("openai", "gpt-4o"), ctx, options) },
	{ api: "openai-codex-responses", stream: (ctx, options) => codex(getBuiltinModel("openai-codex", "gpt-5.6-sol"), ctx, options), apiKey: CODEX_KEY },
	{ api: "google-generative-ai", stream: (ctx, options) => google(getBuiltinModel("google", "gemini-2.5-flash"), ctx, options) },
	{ api: "bedrock-converse-stream", stream: (ctx, options) => bedrock(getBuiltinModel("amazon-bedrock", "anthropic.claude-opus-4-5-20251101-v1:0"), ctx, options) },
];
let rig: InjectionRig | undefined;
let fresh: Context;
let postcompact: Context;
const originalMode = process.env.PI_MEMORY_MODE;
let originalFetch: typeof fetch | undefined;

beforeAll(async () => {
	delete process.env.PI_MEMORY_MODE;
	rig = await createInjectionRig();
	await rig.seedLegacy([
		legacyMemory({ body: CORRECTION_BODY }),
		legacyMemory({ id: "m_bbbbbbbbbb", body: RESEARCH_BODY, title: "Synthetic reference research" }),
		{ ...legacyMemory({ id: "m_cccccccccc", body: ADVERSARIAL_BODY, title: "Reversible adversarial body" }), injection: "always" },
	]);
	const writer = await rig.start();
	assertToolSuccess((await callTool(writer, "remember", { action: "update", scope: "project", id: SEED_ID, body: CORRECTION_BODY, injection: "always" }, "serializers", "setup")).result);
	const subject = await rig.start({ compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 20 } });
	const captures = await splitTurnRequest(subject, "serializers");
	fresh = captures.fresh.context;
	postcompact = captures.postcompact.context;
	for (const context of [fresh, postcompact]) assertBody(JSON.stringify(context), ESCAPED_ADVERSARIAL_BODY);
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => { throw new Error("injection serializer tests must never use network"); }) as typeof fetch;
}, 60_000);

afterAll(async () => {
	if (originalFetch) globalThis.fetch = originalFetch;
	await rig?.dispose();
	if (originalMode === undefined) delete process.env.PI_MEMORY_MODE;
	else process.env.PI_MEMORY_MODE = originalMode;
});

async function serialize(provider: (typeof providers)[number], phase: "fresh" | "postcompact", context: Context): Promise<any> {
	let payload: unknown;
	const result = await provider.stream(context, {
		apiKey: provider.apiKey ?? "synthetic-injection-serializer-key",
		cacheRetention: "none",
		onPayload(candidate) { payload = candidate; throw new Error(SENTINEL); },
	}).result();
	const root = process.env.PI_MEMORY_EVIDENCE_DIR;
	if (root) {
		await mkdir(root, { recursive: true, mode: 0o700 });
		await writeFile(join(root, `serializer-${provider.api}--${phase}.json`), `${JSON.stringify({ layer: "real-pi-ai-serialized-payload", provider: provider.api, phase, context, payload, stopReason: result.stopReason, error: result.errorMessage }, null, 2)}\n`, { mode: 0o600 });
	}
	assert.equal(result.stopReason, "error");
	assert.ok(result.errorMessage?.includes(SENTINEL), "serializer must reach onPayload and abort before transport");
	assert.ok(payload);
	return payload;
}

function assertAdjacency(api: string, payload: any): void {
	if (api === "anthropic-messages") {
		assert.deepEqual(payload.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
		const call = payload.messages[1].content.find((b: any) => b.type === "tool_use");
		const result = payload.messages[2].content.find((b: any) => b.type === "tool_result");
		assert.ok(call && result);
		assert.equal(result.tool_use_id, call.id);
	} else if (api === "openai-completions") {
		assert.deepEqual(payload.messages.map((m: any) => m.role), ["system", "user", "assistant", "tool"]);
		assert.equal(payload.messages[3].tool_call_id, payload.messages[2].tool_calls[0].id);
	} else if (api === "openai-responses" || api === "openai-codex-responses") {
		assert.deepEqual(payload.input.map((m: any) => m.role ?? m.type), [...(api === "openai-responses" ? ["system"] : []), "user", "function_call", "function_call_output"]);
		assert.equal(payload.input.at(-1).call_id, payload.input.at(-2).call_id);
	} else if (api === "google-generative-ai") {
		assert.deepEqual(payload.contents.map((m: any) => m.role), ["user", "model", "user"]);
		const call = payload.contents[1].parts.find((p: any) => p.functionCall)?.functionCall;
		const result = payload.contents[2].parts.find((p: any) => p.functionResponse)?.functionResponse;
		assert.ok(call && result);
		assert.equal(result.name, call.name);
	} else {
		assert.deepEqual(payload.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
		const call = payload.messages[1].content.find((b: any) => b.toolUse)?.toolUse;
		const result = payload.messages[2].content.find((b: any) => b.toolResult)?.toolResult;
		assert.ok(call && result);
		assert.equal(result.toolUseId, call.toolUseId);
	}
}

describe.each(providers)("$api complete always-body serialization", (provider) => {
	it("serializes the full fresh correction once and excludes on-demand research", async () => {
		const payload = await serialize(provider, "fresh", fresh);
		const text = JSON.stringify(payload);
		assertBody(text, CORRECTION_BODY);
		assertBody(text, RESEARCH_BODY, false);
		assertBody(text, ESCAPED_ADVERSARIAL_BODY);
		assert.doesNotMatch(text, /"piMemory":/u, "internal ownership tags must not leak into the provider protocol");
		assert.equal(text.split("ALWAYS_FULL_BODY_BEGIN_f17ab4").length - 1, 1);
	});
	it("preserves post-split-turn role/tool adjacency and the full correction exactly once", async () => {
		const payload = await serialize(provider, "postcompact", postcompact);
		assertAdjacency(provider.api, payload);
		const text = JSON.stringify(payload);
		assertBody(text, CORRECTION_BODY);
		assertBody(text, RESEARCH_BODY, false);
		assertBody(text, ESCAPED_ADVERSARIAL_BODY);
		assert.doesNotMatch(text, /"piMemory":/u);
		assert.equal(text.split("ALWAYS_FULL_BODY_BEGIN_f17ab4").length - 1, 1);
	});
});
