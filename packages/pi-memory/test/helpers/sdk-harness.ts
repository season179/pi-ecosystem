import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import memoryExtension from "../../src/extensions/memory.js";

const PROVIDER_ID = "pi-memory-sdk-fake";
const MODEL_ID = "lifecycle-test";
const API = "openai-completions" as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { ...ZERO_COST, total: 0 },
} as const;

export type FakeResponse =
	| { kind: "text"; text: string; inputTokens?: number }
	| { kind: "tools"; calls: ToolCall[]; inputTokens?: number }
	| { kind: "error"; message: string; inputTokens?: number };

export interface ProviderCapture {
	context: Context;
	payload: unknown;
}

export interface SdkHarnessOptions {
	cwd: string;
	agentDir: string;
	responses: FakeResponse[];
	persistSession?: boolean;
	compaction?: {
		enabled?: boolean;
		reserveTokens?: number;
		keepRecentTokens?: number;
	};
	retry?: {
		enabled?: boolean;
		maxRetries?: number;
		baseDelayMs?: number;
	};
}

export interface SdkHarness {
	readonly runtime: AgentSessionRuntime;
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly cwd: string;
	captures: ProviderCapture[];
	readonly baseSystemPrompt: string;
	prompt(text: string): Promise<void>;
	reload(): Promise<void>;
	newSession(): Promise<void>;
	resume(sessionPath: string, cwdOverride?: string): Promise<void>;
	fork(entryId: string, position?: "before" | "at"): Promise<void>;
	entries(): SessionEntry[];
	readJsonl(): Promise<string | undefined>;
	dispose(): Promise<void>;
}

function model(): Model<Api> {
	return {
		id: MODEL_ID,
		name: "Pi memory SDK lifecycle test",
		api: API,
		provider: PROVIDER_ID,
		baseUrl: "https://pi-memory-sdk.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 32_768,
		maxTokens: 1_024,
	};
}

function assistantMessage(response: FakeResponse, sequence: number): AssistantMessage {
	const input = response.inputTokens ?? 0;
	const usage = {
		...ZERO_USAGE,
		input,
		totalTokens: input,
	};
	const common = {
		api: API,
		provider: PROVIDER_ID,
		model: MODEL_ID,
		usage,
		timestamp: 1_800_000_000_000 + sequence,
	};
	if (response.kind === "tools") {
		return { ...common, role: "assistant", content: response.calls, stopReason: "toolUse" };
	}
	if (response.kind === "error") {
		return {
			...common,
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: response.message,
		};
	}
	return {
		...common,
		role: "assistant",
		content: [{ type: "text", text: response.text }],
		stopReason: "stop",
	};
}

function fakeProviderExtension(
	responses: FakeResponse[],
	captures: ProviderCapture[],
): (pi: ExtensionAPI) => void {
	let sequence = 0;
	return (pi) => {
		pi.registerProvider(PROVIDER_ID, {
			name: "Pi memory SDK fake provider",
			baseUrl: "https://pi-memory-sdk.invalid/v1",
			apiKey: "pi-memory-sdk-test-key",
			api: API,
			models: [
				{
					id: MODEL_ID,
					name: "Pi memory SDK lifecycle test",
					reasoning: false,
					input: ["text"],
					cost: ZERO_COST,
					contextWindow: 32_768,
					maxTokens: 1_024,
				},
			],
			streamSimple(streamModel, context, options?: SimpleStreamOptions) {
				const capture: ProviderCapture = {
					context: {
						systemPrompt: context.systemPrompt,
						messages: structuredClone(context.messages),
						tools: context.tools?.map((tool) => ({
							name: tool.name,
							description: tool.description,
							parameters: structuredClone(tool.parameters),
						})),
					},
					payload: undefined,
				};
				captures.push(capture);
				const stream = createAssistantMessageEventStream();
				const response = responses.shift() ?? {
					kind: "error" as const,
					message: "Fake provider response queue exhausted",
				};
				const message = assistantMessage(response, sequence++);

				void (async () => {
					try {
						if (options?.signal?.aborted) {
							throw Object.assign(new Error("aborted"), { name: "AbortError" });
						}
						const originalPayload = { provider: PROVIDER_ID, sequence: sequence - 1 };
						capture.payload = options?.onPayload
							? await options.onPayload(originalPayload, streamModel)
							: originalPayload;
						await options?.onResponse?.({ status: 200, headers: { "x-sdk-fake": "1" } }, streamModel);
						stream.push({ type: "start", partial: message });
						if (message.stopReason === "error" || message.stopReason === "aborted") {
							stream.push({ type: "error", reason: message.stopReason, error: message });
						} else {
							stream.push({ type: "done", reason: message.stopReason, message });
						}
					} catch (error) {
						const failed = assistantMessage(
							{ kind: "error", message: error instanceof Error ? error.message : String(error) },
							sequence++,
						);
						stream.push({ type: "error", reason: "error", error: failed });
					}
				})();
				return stream;
			},
		});
	};
}

async function withAgentDir<T>(agentDir: string, run: () => Promise<T>): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

export async function createSdkHarness(options: SdkHarnessOptions): Promise<SdkHarness> {
	await mkdir(options.agentDir, { recursive: true, mode: 0o700 });
	const captures: ProviderCapture[] = [];
	const responses = options.responses.slice();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) =>
		withAgentDir(agentDir, async () => {
			const settingsManager = SettingsManager.inMemory(
				{
					compaction: {
						enabled: options.compaction?.enabled ?? false,
						reserveTokens: options.compaction?.reserveTokens ?? 64,
						keepRecentTokens: options.compaction?.keepRecentTokens ?? 1,
					},
					retry: {
						enabled: options.retry?.enabled ?? false,
						maxRetries: options.retry?.maxRetries ?? 0,
						baseDelayMs: options.retry?.baseDelayMs ?? 1,
					},
					defaultProjectTrust: "always",
				},
				{ projectTrusted: true },
			);
			const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [memoryExtension, fakeProviderExtension(responses, captures)],
					noContextFiles: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					systemPrompt: "PI_MEMORY_SDK_BASE_SYSTEM_PROMPT",
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: model(),
					thinkingLevel: "off",
					tools: ["remember", "recall"],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		});
	const sessionManager = options.persistSession
		? SessionManager.create(options.cwd, join(options.agentDir, "sessions"))
		: SessionManager.inMemory(options.cwd);
	const runtime = await withAgentDir(options.agentDir, () =>
		createAgentSessionRuntime(createRuntime, {
			cwd: options.cwd,
			agentDir: options.agentDir,
			sessionManager,
		}),
	);
	let baseSystemPrompt = "";
	const bindSession = async (session: AgentSession): Promise<void> => {
		await withAgentDir(options.agentDir, () => session.bindExtensions({ mode: "print" }));
		baseSystemPrompt = session.systemPrompt;
	};
	runtime.setRebindSession(bindSession);
	await bindSession(runtime.session);

	return {
		runtime,
		get session() {
			return runtime.session;
		},
		get sessionManager() {
			return runtime.session.sessionManager;
		},
		get cwd() {
			return runtime.cwd;
		},
		captures,
		get baseSystemPrompt() {
			return baseSystemPrompt;
		},
		prompt: (text) => withAgentDir(options.agentDir, () => runtime.session.prompt(text)),
		reload: () => withAgentDir(options.agentDir, () => runtime.session.reload()),
		async newSession() {
			await withAgentDir(options.agentDir, () => runtime.newSession());
		},
		async resume(sessionPath, cwdOverride) {
			await withAgentDir(options.agentDir, () => runtime.switchSession(sessionPath, { cwdOverride }));
		},
		async fork(entryId, position = "at") {
			await withAgentDir(options.agentDir, () => runtime.fork(entryId, { position }));
		},
		entries: () => runtime.session.sessionManager.getEntries(),
		async readJsonl() {
			const path = runtime.session.sessionFile;
			return path === undefined ? undefined : readFile(path, "utf8");
		},
		dispose: () => withAgentDir(options.agentDir, () => runtime.dispose()),
	};
}

export function toolCall(id: string, name: string, arguments_: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: arguments_ };
}
