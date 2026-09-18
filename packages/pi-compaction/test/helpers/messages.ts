import type { AgentMessage } from "../../src/engine/message.js";
import type { ContextEntry } from "../../src/engine/types.js";

type Assistant = Extract<AgentMessage, { role: "assistant" }>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type User = Extract<AgentMessage, { role: "user" }>;

let clock = 1_800_000_000_000;
const next = (): number => clock++;

export function user(text: string): User {
	return { role: "user", content: [{ type: "text", text }], timestamp: next() };
}

export interface AssistantOptions {
	text?: string;
	thinking?: string;
	inputTokens?: number;
	calls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
}

export function assistant(options: AssistantOptions = {}): Assistant {
	const content: Assistant["content"] = [];
	if (options.thinking) content.push({ type: "thinking", thinking: options.thinking, thinkingSignature: "sig" });
	if (options.text) content.push({ type: "text", text: options.text });
	for (const call of options.calls ?? []) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} });
	const input = options.inputTokens ?? 100;
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: options.calls?.length ? "toolUse" : "stop",
		timestamp: next(),
	};
}

export function toolResult(toolCallId: string, toolName: string, text: string, isError = false): ToolResult {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: next() };
}

export function imageResult(toolCallId: string, toolName: string): ToolResult {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false, timestamp: next() };
}

/** Give every message a synthetic entry id (`e0`, `e1`, ...). */
export function withIds(messages: readonly AgentMessage[]): ContextEntry[] {
	return messages.map((message, index) => ({ id: `e${index}`, message }));
}

/**
 * One user task followed by `groups` completed tool groups (read call + large result) and a
 * final assistant text. This is the ordinary long single-prompt coding run.
 */
export function singleTaskTranscript(groups: number, options: { toolName?: string; resultChars?: number } = {}): AgentMessage[] {
	const toolName = options.toolName ?? "read";
	const chars = options.resultChars ?? 2_000;
	const messages: AgentMessage[] = [user("Please refactor the payment module and fix the failing tests.")];
	for (let index = 0; index < groups; index++) {
		messages.push(assistant({ text: index === 0 ? "Starting by reading the code." : undefined, calls: [{ id: `call-${index}`, name: toolName, arguments: { path: `src/file${index}.ts` } }] }));
		messages.push(toolResult(`call-${index}`, toolName, `content of file ${index}\n`.repeat(Math.ceil(chars / 20))));
	}
	messages.push(assistant({ text: "Done reading; here is the plan." }));
	return messages;
}
