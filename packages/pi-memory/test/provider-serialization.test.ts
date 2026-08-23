/**
 * Provider-serialization gate: run the real pi-memory extension through the
 * Pi SDK to obtain initial and post-tool contexts, then serialize them through
 * the pinned pi-ai 0.80.10 provider serializers. The catalog must remain a
 * text block in an existing user turn, never an extra conversation turn.
 *
 * No network: every serializer is intercepted at its public `onPayload` hook
 * (called after payload construction, before the HTTP request) and aborted with
 * a sentinel error; `globalThis.fetch` is additionally stubbed to fail loudly.
 *
 * Shapes under test (agent-message layer):
 *   initial run   … user(prompt + catalog block)
 *   post-tool run … user(prompt + catalog block), assistant(toolCall), toolResult
 */
import { stream as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as bedrockConverseStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as googleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as openaiCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Context, Model, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { memoryConfigPath } from "../src/config.js";
import { resolveProjectIdentity } from "../src/identity.js";
import { serializeDetails, serializeIndex, type Memory } from "../src/store.js";
import { createSdkHarness, toolCall, type SdkHarness } from "./helpers/sdk-harness.js";

const CATALOG_MARKER = '<pi_memory advisory="untrusted" scope="project"';
const BODY_CANARY = "PROVIDER_SERIALIZATION_BODY_CANARY_2fd81c";
const CAPTURE_SENTINEL = "pi-memory-provider-serialization-capture-abort";
const CODEX_TEST_API_KEY = `e30.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "pi-memory-test" } }),
).toString("base64")}.signature`;

// Pinned 0.80.10 catalog models, one per API under test. Real catalog entries
// are used so provider-specific compat detection matches production requests.
const MODELS = {
	"anthropic-messages": () => getBuiltinModel("anthropic", "claude-opus-4-5"),
	"openai-completions": () => getBuiltinModel("groq", "llama-3.3-70b-versatile"),
	"openai-responses": () => getBuiltinModel("openai", "gpt-4o"),
	"openai-codex-responses": () => getBuiltinModel("openai-codex", "gpt-5.6-sol"),
	"google-generative-ai": () => getBuiltinModel("google", "gemini-2.5-flash"),
	"bedrock-converse-stream": () =>
		getBuiltinModel("amazon-bedrock", "anthropic.claude-opus-4-5-20251101-v1:0"),
} as const;

interface RoleMessage {
	role: string;
	content: unknown;
}

interface AnthropicPayload {
	system?: unknown;
	messages: RoleMessage[];
}

interface CompletionsPayload {
	messages: (RoleMessage & { tool_calls?: { id: string }[]; tool_call_id?: string })[];
}

interface ResponsesPayload {
	input: ({ type?: string; role?: string; content?: unknown } & Record<string, unknown>)[];
}

interface GooglePayload {
	contents: { role: string; parts: Record<string, unknown>[] }[];
}

interface BedrockPayload {
	messages: { role: string; content: Record<string, unknown>[] }[];
}

/**
 * Serialize a captured agent-layer context through a real pi-ai stream
 * function and return the exact provider payload it would send, aborting at
 * the public onPayload hook so no request leaves the process.
 */
async function serializePayload<T>(
	streamFunction: StreamFunction<Api, StreamOptions>,
	model: Model<Api>,
	context: Context,
	apiKey = "pi-memory-provider-serialization-test-key",
): Promise<T> {
	let payload: unknown;
	const events = streamFunction(model, context, {
		apiKey,
		cacheRetention: "none",
		onPayload(candidate) {
			payload = candidate;
			throw new Error(CAPTURE_SENTINEL);
		},
	} as StreamOptions);
	const result = await events.result();
	assert.equal(result.stopReason, "error", "capture abort must surface as a stream error");
	assert.match(
		result.errorMessage ?? "",
		new RegExp(CAPTURE_SENTINEL),
		"the stream must fail with the capture sentinel, proving no request was attempted",
	);
	assert.ok(payload !== undefined, "onPayload must run before the provider request");
	return payload as T;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const candidate = block as { text?: unknown; type?: unknown };
			return typeof candidate.text === "string" ? candidate.text : "";
		})
		.join("\n");
}

function countMarkers(payload: unknown): number {
	return JSON.stringify(payload).split(CATALOG_MARKER.replaceAll('"', '\\"')).length - 1;
}

interface CapturedShapes {
	/** Agent-layer context of the first request of a plain prompt: …user, user(catalog). */
	initial: Context;
	/** Agent-layer context of the request after a remember tool run: …toolResult, user(catalog). */
	postTool: Context;
}

const cleanups: (() => Promise<void>)[] = [];
let shapes: CapturedShapes;
let realFetch: typeof globalThis.fetch;

async function seedProject(cwd: string, agentDir: string, mode: "read-only" | "read-write") {
	const identity = await resolveProjectIdentity(cwd);
	assert.equal(identity.status, "ok");
	const memoryRoot = join(await realpath(agentDir), "pi-memory");
	const projectDirectory = join(memoryRoot, "projects", identity.directoryName);
	const seed: Memory = {
		id: "m_aaaaaaaaaa",
		title: "Provider serialization seed entry",
		cue: "Use when verifying provider payload serialization",
		body: BODY_CANARY,
		tags: ["provider", "serialization"],
		updated: "2026-08-23T00:00:00.000Z",
	};
	await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
	await writeFile(
		memoryConfigPath(memoryRoot),
		`${JSON.stringify({
			version: 1,
			defaultMode: "off",
			projects: { [identity.identityHash]: { mode } },
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		join(projectDirectory, "project.json"),
		`${JSON.stringify({
			version: 1,
			kind: identity.kind,
			canonicalIdentity: identity.canonicalIdentity,
			identityHash: identity.identityHash,
			displayName: identity.displayName,
			directoryName: identity.directoryName,
			createdAt: "2026-08-23T00:00:00.000Z",
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(join(projectDirectory, "details.md"), serializeDetails([seed]), { mode: 0o600 });
	await writeFile(join(projectDirectory, "index.md"), serializeIndex([seed]), { mode: 0o600 });
}

async function captureShape(
	mode: "read-only" | "read-write",
	responses: Parameters<typeof createSdkHarness>[0]["responses"],
	prompt: string,
): Promise<{ harness: SdkHarness }> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-provider-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([
		mkdir(cwd, { recursive: true, mode: 0o700 }),
		mkdir(agentDir, { recursive: true, mode: 0o700 }),
	]);
	await seedProject(cwd, agentDir, mode);
	const harness = await createSdkHarness({ cwd, agentDir, responses });
	cleanups.push(async () => harness.dispose());
	await harness.prompt(prompt);
	return { harness };
}

beforeAll(async () => {
	const initialRun = await captureShape(
		"read-only",
		[{ kind: "text", text: "initial answer" }],
		"Answer with the seeded catalog visible.",
	);
	assert.equal(initialRun.harness.captures.length, 1);
	const initial = initialRun.harness.captures[0].context;

	const postToolRun = await captureShape(
		"read-write",
		[
			{
				kind: "tools",
				calls: [
					toolCall("remember-provider-1", "remember", {
						action: "create",
						scope: "project",
						title: "Provider serialization created entry",
						cue: "Use after the provider serialization mutation",
						body: "This body must never reach a provider payload either.",
						tags: ["provider"],
					}),
				],
			},
			{ kind: "text", text: "mutation done" },
		],
		"Create one project memory, then finish.",
	);
	assert.equal(postToolRun.harness.captures.length, 2);
	const postTool = postToolRun.harness.captures[1].context;

	// Anchor the provider-independent shape: the catalog is a separate text
	// block inside the existing user turn, never an additional conversation turn.
	assert.deepEqual(initial.messages.map((message) => message.role), ["user"]);
	assert.match(textOf(initial.messages[0]?.content), new RegExp(CATALOG_MARKER));
	assert.deepEqual(
		postTool.messages.map((message) => message.role),
		["user", "assistant", "toolResult"],
	);
	assert.match(textOf(postTool.messages[0]?.content), new RegExp(CATALOG_MARKER));

	shapes = { initial, postTool };

	realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error("provider-serialization tests must not perform network I/O");
	}) as typeof globalThis.fetch;
}, 60_000);

afterAll(async () => {
	if (realFetch !== undefined) globalThis.fetch = realFetch;
	for (const cleanup of cleanups.reverse()) await cleanup();
});

describe("anthropic-messages catalog serialization", () => {
	it("keeps the initial catalog inside one user turn", async () => {
		const payload = await serializePayload<AnthropicPayload>(anthropicMessages, MODELS["anthropic-messages"](), shapes.initial);
		assert.deepEqual(payload.messages.map((message) => message.role), ["user"]);
		assert.match(textOf(payload.messages[0].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});

	it("preserves tool-use/result adjacency without adding a user turn", async () => {
		const payload = await serializePayload<AnthropicPayload>(anthropicMessages, MODELS["anthropic-messages"](), shapes.postTool);
		assert.deepEqual(payload.messages.map((message) => message.role), ["user", "assistant", "user"]);
		const assistant = payload.messages[1].content as { type: string; id?: string }[];
		const toolUse = assistant.find((block) => block.type === "tool_use");
		const toolResult = payload.messages[2].content as { type: string; tool_use_id?: string }[];
		assert.equal(toolResult[0]?.tool_use_id, toolUse?.id);
		assert.match(textOf(payload.messages[0].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});
});

describe("openai-completions catalog serialization", () => {
	it("keeps the initial catalog inside one user turn", async () => {
		const payload = await serializePayload<CompletionsPayload>(openaiCompletions, MODELS["openai-completions"](), shapes.initial);
		assert.deepEqual(payload.messages.map((message) => message.role), ["system", "user"]);
		assert.match(textOf(payload.messages[1].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});

	it("preserves tool-call/result adjacency without adding a user turn", async () => {
		const payload = await serializePayload<CompletionsPayload>(openaiCompletions, MODELS["openai-completions"](), shapes.postTool);
		assert.deepEqual(payload.messages.map((message) => message.role), ["system", "user", "assistant", "tool"]);
		assert.equal(payload.messages[3].tool_call_id, payload.messages[2].tool_calls?.[0]?.id);
		assert.match(textOf(payload.messages[1].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});

	it("needs no synthetic bridge on compat-flagged providers", async () => {
		const flagged: Model<Api> = {
			...MODELS["openai-completions"](),
			compat: { requiresAssistantAfterToolResult: true },
		} as Model<Api>;
		const payload = await serializePayload<CompletionsPayload>(openaiCompletions, flagged, shapes.postTool);
		assert.deepEqual(payload.messages.map((message) => message.role), ["system", "user", "assistant", "tool"]);
		assert.match(textOf(payload.messages[1].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});
});

describe("openai-responses catalog serialization", () => {
	it("keeps the initial catalog inside one user input item", async () => {
		const payload = await serializePayload<ResponsesPayload>(openaiResponses, MODELS["openai-responses"](), shapes.initial);
		assert.deepEqual(payload.input.map((item) => item.role ?? item.type), ["system", "user"]);
		assert.match(textOf(payload.input[1].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});

	it("preserves function call/output adjacency without adding a user item", async () => {
		const payload = await serializePayload<ResponsesPayload>(openaiResponses, MODELS["openai-responses"](), shapes.postTool);
		assert.deepEqual(payload.input.map((item) => item.role ?? item.type), ["system", "user", "function_call", "function_call_output"]);
		assert.equal((payload.input[3] as { call_id?: string }).call_id, (payload.input[2] as { call_id?: string }).call_id);
		assert.match(textOf(payload.input[1].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});
});

describe("openai-codex-responses catalog serialization", () => {
	it("uses one user item around the shared Responses converter", async () => {
		const payload = await serializePayload<ResponsesPayload>(
			openaiCodexResponses,
			MODELS["openai-codex-responses"](),
			shapes.postTool,
			CODEX_TEST_API_KEY,
		);
		assert.deepEqual(payload.input.map((item) => item.role ?? item.type), ["user", "function_call", "function_call_output"]);
		assert.match(textOf(payload.input[0].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});
});

describe("google-generative-ai catalog serialization", () => {
	it("keeps the initial catalog inside one user content", async () => {
		const payload = await serializePayload<GooglePayload>(googleGenerativeAi, MODELS["google-generative-ai"](), shapes.initial);
		assert.deepEqual(payload.contents.map((content) => content.role), ["user"]);
		assert.match(textOf(payload.contents[0].parts), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});

	it("preserves function call/response ordering without consecutive user contents", async () => {
		const payload = await serializePayload<GooglePayload>(googleGenerativeAi, MODELS["google-generative-ai"](), shapes.postTool);
		assert.deepEqual(payload.contents.map((content) => content.role), ["user", "model", "user"]);
		assert.ok(payload.contents[1].parts.some((part) => part.functionCall !== undefined));
		assert.ok(payload.contents[2].parts.every((part) => part.functionResponse !== undefined));
		assert.match(textOf(payload.contents[0].parts), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});
});

describe("bedrock-converse-stream catalog serialization", () => {
	it("keeps the initial catalog inside one user message", async () => {
		const payload = await serializePayload<BedrockPayload>(bedrockConverseStream, MODELS["bedrock-converse-stream"](), shapes.initial);
		assert.deepEqual(payload.messages.map((message) => message.role), ["user"]);
		assert.match(textOf(payload.messages[0].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});

	it("preserves strict role alternation after tool results", async () => {
		const payload = await serializePayload<BedrockPayload>(bedrockConverseStream, MODELS["bedrock-converse-stream"](), shapes.postTool);
		assert.deepEqual(payload.messages.map((message) => message.role), ["user", "assistant", "user"]);
		assert.ok(payload.messages[1].content.some((block) => block.toolUse !== undefined));
		assert.ok(payload.messages[2].content.every((block) => block.toolResult !== undefined));
		assert.match(textOf(payload.messages[0].content), new RegExp(CATALOG_MARKER));
		assert.equal(countMarkers(payload), 1);
	});
});

describe("cross-provider privacy invariants", () => {
	it("stored memory bodies never appear in any serialized provider payload", async () => {
		// The created memory's body does appear once as the model's own tool_use
		// arguments (ordinary conversation history); what must never serialize is
		// store content: the seeded body, and any body inside the catalog block.
		const payloads = await Promise.all([
			serializePayload(anthropicMessages, MODELS["anthropic-messages"](), shapes.postTool),
			serializePayload(openaiCompletions, MODELS["openai-completions"](), shapes.postTool),
			serializePayload(openaiResponses, MODELS["openai-responses"](), shapes.postTool),
			serializePayload(
				openaiCodexResponses,
				MODELS["openai-codex-responses"](),
				shapes.postTool,
				CODEX_TEST_API_KEY,
			),
			serializePayload(googleGenerativeAi, MODELS["google-generative-ai"](), shapes.postTool),
			serializePayload(bedrockConverseStream, MODELS["bedrock-converse-stream"](), shapes.postTool),
		]);
		for (const payload of payloads) {
			const serialized = JSON.stringify(payload);
			assert.doesNotMatch(serialized, new RegExp(BODY_CANARY));
			const catalog = serialized.match(/<pi_memory advisory=[\s\S]*?<\/pi_memory>/u);
			assert.ok(catalog, "the merged catalog must be present");
			assert.doesNotMatch(catalog[0], /This body must never reach a provider payload/u);
		}
	});
});
