import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions, type ToolCall } from "@earendil-works/pi-ai";
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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createCompactionExtension } from "../../src/extensions/compaction.js";
import type { Scorer } from "../../src/scoring/client.js";
import type { SkeletonState } from "../../src/engine/skeleton.js";
import type { QuestionSet } from "../../src/scoring/questions.js";
import { TelemetryStore, type TelemetryInput } from "../../src/telemetry.js";

/** Telemetry store that lets tests wait for in-flight writes. */
export class TrackedTelemetry extends TelemetryStore {
	readonly writes = new Set<Promise<void>>();
	readonly inputs: TelemetryInput[] = [];
	override async record(input: TelemetryInput): Promise<void> {
		this.inputs.push(input);
		const write = super.record(input).finally(() => this.writes.delete(write));
		this.writes.add(write);
		return write;
	}
	async flush(): Promise<void> {
		while (this.writes.size > 0) await Promise.allSettled([...this.writes]);
	}
}

const PROVIDER_ID = "pi-compaction-fake";
const MODEL_ID = "compaction-lifecycle";
const API = "openai-completions" as const;
export const CONTEXT_WINDOW = 32_768;
export const RESERVE_TOKENS = 8_000;
export const BIG_TOOL = "bigread";
export const BIG_RESULT_CHARS = 8_000;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export type FakeResponse =
	| { kind: "text"; text: string; inputTokens?: number; thinking?: string; usage?: "none" }
	| { kind: "tools"; calls: ToolCall[]; inputTokens?: number; thinking?: string; usage?: "none" };

export interface Capture {
	messages: Context["messages"];
	systemPrompt: string | undefined;
	toolNames: string[];
}

export interface FakeScorer extends Scorer {
	calls: number;
	lastQuestions: QuestionSet | undefined;
	lastState: SkeletonState | undefined;
	/** Answer per question key; default drops everything (0.1). */
	answer: (key: string) => number;
	configured: boolean;
}

export function fakeScorer(answer: (key: string) => number = () => 0.1): FakeScorer {
	const scorer: FakeScorer = {
		configured: true,
		calls: 0,
		lastQuestions: undefined,
		lastState: undefined,
		answer,
		async score(state, questions) {
			scorer.calls++;
			scorer.lastQuestions = questions;
			scorer.lastState = state;
			return Object.fromEntries(Object.keys(questions).map((key) => [key, scorer.answer(key)]));
		},
	};
	return scorer;
}

export interface HarnessOptions {
	cwd: string;
	agentDir: string;
	scorer: Scorer;
	persistSession?: boolean;
	compactionEnabled?: boolean;
	/** Written to <agentDir>/pi-compaction.json before the session starts. */
	config?: Record<string, unknown>;
}

export interface Harness {
	readonly session: AgentSession;
	readonly telemetry: TrackedTelemetry;
	readonly runtime: AgentSessionRuntime;
	captures: Capture[];
	events: string[];
	/** Long command output the extension emits when no UI is present. */
	outputs: string[];
	prompt(text: string, ...responses: FakeResponse[]): Promise<void>;
	enqueue(...responses: FakeResponse[]): void;
	entries(): SessionEntry[];
	resume(sessionPath: string): Promise<void>;
	fork(entryId: string): Promise<void>;
	/** `/tree` navigation: move the leaf to an existing entry. */
	navigate(entryId: string): Promise<void>;
	dispose(): Promise<void>;
}

function model(): Model<Api> {
	return { id: MODEL_ID, name: "compaction lifecycle", api: API, provider: PROVIDER_ID, baseUrl: "https://pi-compaction.invalid/v1", reasoning: false, input: ["text"], cost: ZERO_COST, contextWindow: CONTEXT_WINDOW, maxTokens: 1_024 };
}

function assistantMessage(response: FakeResponse, sequence: number): AssistantMessage {
	const input = response.usage === "none" ? 0 : response.inputTokens ?? 500;
	const output = response.usage === "none" ? 0 : 20;
	const content: AssistantMessage["content"] = [];
	if (response.thinking) content.push({ type: "thinking", thinking: response.thinking, thinkingSignature: `sig-${sequence}` });
	if (response.kind === "text") content.push({ type: "text", text: response.text });
	else content.push(...response.calls);
	return {
		role: "assistant",
		content,
		api: API,
		provider: PROVIDER_ID,
		model: MODEL_ID,
		usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { ...ZERO_COST, total: 0 } },
		stopReason: response.kind === "tools" ? "toolUse" : "stop",
		timestamp: 1_800_000_000_000 + sequence,
	};
}

function fakeProvider(responses: FakeResponse[], captures: Capture[]): (pi: ExtensionAPI) => void {
	let sequence = 0;
	return (pi) => {
		pi.registerProvider(PROVIDER_ID, {
			name: "compaction fake provider",
			baseUrl: "https://pi-compaction.invalid/v1",
			apiKey: "fake",
			api: API,
			models: [{ id: MODEL_ID, name: "compaction lifecycle", reasoning: false, input: ["text"], cost: ZERO_COST, contextWindow: CONTEXT_WINDOW, maxTokens: 1_024 }],
			streamSimple(_model, context, options?: SimpleStreamOptions) {
				captures.push({ messages: structuredClone(context.messages), systemPrompt: context.systemPrompt, toolNames: context.tools?.map((tool) => tool.name) ?? [] });
				const stream = createAssistantMessageEventStream();
				const response = responses.shift();
				const message = response ? assistantMessage(response, sequence++) : { ...assistantMessage({ kind: "text", text: "" }, sequence++), stopReason: "error" as const, errorMessage: "fake response queue exhausted" };
				void (async () => {
					await options?.onPayload?.({ fake: true }, _model);
					stream.push({ type: "start", partial: message });
					if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: message.stopReason, message });
				})();
				return stream;
			},
		});
	};
}

function bigTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: BIG_TOOL,
		label: "Big read",
		description: "Returns a large text body for the given path.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, params) {
			const line = `content of ${params.path}\n`;
			return { content: [{ type: "text", text: line.repeat(Math.ceil(BIG_RESULT_CHARS / line.length)) }], details: {} };
		},
	});
}

function eventRecorder(events: string[]): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("session_before_compact", (event) => {
			events.push(`before_compact:${event.reason}`);
		});
		pi.on("session_compact", (event) => {
			events.push(`compact:${event.reason}`);
		});
		pi.on("session_compact_failed", (event) => {
			events.push(`compact_failed:${event.reason}:${event.aborted ? "aborted" : "error"}`);
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

export async function createHarness(options: HarnessOptions): Promise<Harness> {
	await mkdir(options.agentDir, { recursive: true, mode: 0o700 });
	await mkdir(options.cwd, { recursive: true });
	if (options.config) await writeFile(join(options.agentDir, "pi-compaction.json"), JSON.stringify(options.config));
	const captures: Capture[] = [];
	const events: string[] = [];
	const outputs: string[] = [];
	const responses: FakeResponse[] = [];
	const telemetry = new TrackedTelemetry(join(options.agentDir, "pi-compaction", "telemetry"));
	const compaction = createCompactionExtension({ scorer: options.scorer, agentDir: options.agentDir, env: {}, telemetry, output: (text) => outputs.push(text) });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) =>
		withAgentDir(agentDir, async () => {
			const settingsManager = SettingsManager.inMemory(
				{
					compaction: { enabled: options.compactionEnabled ?? true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 4_000 },
					retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
					defaultProjectTrust: "always",
				},
				{ projectTrusted: true },
			);
			const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [eventRecorder(events), compaction, bigTool, fakeProvider(responses, captures)],
					noContextFiles: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					systemPrompt: "COMPACTION_TEST_SYSTEM_PROMPT",
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: model(), thinkingLevel: "off", tools: [BIG_TOOL, "compaction_recall"] })),
				services,
				diagnostics: services.diagnostics,
			};
		});
	const sessionManager = options.persistSession ? SessionManager.create(options.cwd, join(options.agentDir, "sessions")) : SessionManager.inMemory(options.cwd);
	const runtime = await withAgentDir(options.agentDir, () => createAgentSessionRuntime(createRuntime, { cwd: options.cwd, agentDir: options.agentDir, sessionManager }));
	const bind = async (session: AgentSession): Promise<void> => {
		await withAgentDir(options.agentDir, () => session.bindExtensions({ mode: "print" }));
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return {
		get session() {
			return runtime.session;
		},
		runtime,
		telemetry,
		captures,
		events,
		outputs,
		enqueue: (...queued) => {
			responses.push(...queued);
		},
		async prompt(text, ...queued) {
			responses.push(...queued);
			await withAgentDir(options.agentDir, () => runtime.session.prompt(text));
			await telemetry.flush();
		},
		entries: () => runtime.session.sessionManager.getEntries(),
		resume: (path) => withAgentDir(options.agentDir, () => runtime.switchSession(path)),
		fork: (entryId) => withAgentDir(options.agentDir, () => runtime.fork(entryId, { position: "at" })),
		navigate: async (entryId) => {
			await withAgentDir(options.agentDir, () => runtime.session.navigateTree(entryId));
			await telemetry.flush();
		},
		dispose: () => withAgentDir(options.agentDir, () => runtime.dispose()),
	};
}

export function call(id: string, path: string): ToolCall {
	return { type: "toolCall", id, name: BIG_TOOL, arguments: { path } };
}

/** A single user task: `groups` big reads, the last one carrying the pressure usage, then a final text. */
export function longTask(groups: number, pressureTokens: number): FakeResponse[] {
	const responses: FakeResponse[] = [];
	for (let index = 0; index < groups; index++) {
		responses.push({ kind: "tools", calls: [call(`c${index}`, `src/file${index}.ts`)], inputTokens: index === groups - 1 ? pressureTokens : 500 });
	}
	responses.push({ kind: "text", text: "All done." });
	return responses;
}

export function toolResultTexts(capture: Capture): Array<{ id: string; text: string }> {
	const out: Array<{ id: string; text: string }> = [];
	for (const message of capture.messages) {
		if (message.role !== "toolResult") continue;
		out.push({ id: message.toolCallId, text: message.content.map((block) => (block.type === "text" ? block.text : "")).join("") });
	}
	return out;
}
