import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { getMaxReferenceOutputChars } from "./config.js";
import type { MoAPreset, ReferenceOutput } from "./types.js";

export const MOA_GUIDANCE_MARKER = "[Mixture of Agents reference context]";
export const MOA_VISIBLE_REFERENCES_START = "<!-- pi-moa-reference-outputs:start -->";
export const MOA_VISIBLE_REFERENCES_END = "<!-- pi-moa-reference-outputs:end -->";

const REFERENCE_SYSTEM_PROMPT = `You are a private reference model in a Mixture of Agents pipeline.

Below is a conversation between a user and an AI assistant. Your job is to advise the aggregator model about that conversation, not to act as the assistant.

Your role:
- Analyze the conversation below.
- Provide concise, actionable advice for the aggregator model.
- Point out what the aggregator might miss.
- Suggest alternative approaches.
- Identify risks and edge cases.
- Offer concrete improvements.

Rules:
- Do NOT produce a final user-facing answer. The aggregator will do that.
- Do NOT call tools. You have none.
- Do NOT assume you are the acting model.
- Be concise; the aggregator will read multiple reference outputs.
- Format your response as a clear advisory note.`;

const TOOL_RESULT_HEAD_CHARS = 2000;
const TOOL_RESULT_TAIL_CHARS = 500;
const FAILED_REFERENCE_ERROR_CHARS = 200;

export function buildReferenceContext(context: Context, _preset: MoAPreset): Context {
	const strippedContext = stripPriorMoAGuidanceMessages(context);
	const toolNamesById = new Map<string, string>();
	const messages = strippedContext.messages.map((message) => renderMessageForReference(message, toolNamesById));
	return {
		systemPrompt: REFERENCE_SYSTEM_PROMPT,
		messages,
	};
}

export function stripPriorMoAGuidanceMessages(context: Context): Context {
	return {
		...context,
		messages: context.messages
			.filter((message) => !isPriorMoAGuidanceMessage(message))
			.map(stripVisibleReferenceBlocksFromMessage),
	};
}

export function injectGuidance(context: Context, guidanceBlock: string): Context {
	const messages = [...context.messages];
	const guidanceMessage: UserMessage = {
		role: "user",
		content: guidanceBlock,
		timestamp: Date.now(),
	};
	const latestUserIndex = findLatestUserMessageIndex(messages);
	if (latestUserIndex === -1) {
		return { ...context, messages: [guidanceMessage] };
	}
	messages.splice(latestUserIndex + 1, 0, guidanceMessage);
	return { ...context, messages };
}

export function appendGuidanceToLatestUser(context: Context, guidanceBlock: string): Context {
	const messages = [...context.messages];
	const latestUserIndex = findLatestUserMessageIndex(messages);
	if (latestUserIndex === -1) {
		return injectGuidance(context, guidanceBlock);
	}

	const latestUser = messages[latestUserIndex] as UserMessage;
	const guidanceText = `\n\n${guidanceBlock}`;
	const content =
		typeof latestUser.content === "string"
			? `${latestUser.content}${guidanceText}`
			: [...latestUser.content, { type: "text" as const, text: guidanceText }];

	messages[latestUserIndex] = { ...latestUser, content };
	return { ...context, messages };
}

export function buildReferenceDisplayBlock(args: {
	preset: MoAPreset;
	referenceOutputs: ReferenceOutput[];
}): string {
	const maxReferenceOutputChars = getMaxReferenceOutputChars(args.preset);
	const lines = [MOA_VISIBLE_REFERENCES_START, "## Reference model outputs"];

	args.referenceOutputs.forEach((output, index) => {
		lines.push("", renderReferenceDisplayHeader(index, output));
		if (output.success) {
			lines.push(truncateReferenceOutput(output.text, maxReferenceOutputChars));
		} else {
			const fallbackErrorText = output.text || "Unknown reference failure";
			const errorText = output.errorMessage ?? fallbackErrorText;
			lines.push(`Error: ${truncateReferenceOutput(redactErrorMessage(errorText), FAILED_REFERENCE_ERROR_CHARS)}`);
		}
	});

	lines.push("", MOA_VISIBLE_REFERENCES_END, "");
	return lines.join("\n");
}

export function buildGuidanceBlock(args: {
	presetName: string;
	preset: MoAPreset;
	referenceOutputs: ReferenceOutput[];
}): string {
	const maxReferenceOutputChars = getMaxReferenceOutputChars(args.preset);
	const lines = [
		MOA_GUIDANCE_MARKER,
		`Preset: ${args.presetName}`,
		`Aggregator/acting model: ${args.preset.aggregator.provider}/${args.preset.aggregator.model}`,
		`References: ${args.referenceOutputs.length} models provided private analysis below.`,
		"",
		"Use the reference responses below as private context. You are the aggregator and acting model: answer the user directly or call tools as needed.",
	];

	args.referenceOutputs.forEach((output, index) => {
		lines.push("", renderReferenceHeader(index, output));
		if (output.success) {
			lines.push(truncateReferenceOutput(output.text, maxReferenceOutputChars));
		} else {
			const fallbackErrorText = output.text || "Unknown reference failure";
			const errorText = output.errorMessage ?? fallbackErrorText;
			lines.push(`Error: ${truncateReferenceOutput(redactErrorMessage(errorText), FAILED_REFERENCE_ERROR_CHARS)}`);
		}
	});

	lines.push("", "[End reference context]");
	return lines.join("\n");
}

export function renderToolResult(content: unknown, maxChars: number): string {
	const rendered = renderUnknownContent(content);
	return truncateWithHeadTail(rendered, maxChars, TOOL_RESULT_TAIL_CHARS);
}

export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => {
			if (block.type === "text") return [block.text];
			if (block.type === "thinking") return ["[assistant thinking omitted]"];
			return [`[Tool call: ${block.name}(${safeJsonStringify(block.arguments)})]`];
		})
		.join("\n")
		.trim();
}

export function redactErrorMessage(message: string): string {
	return message
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/([A-Za-z0-9_-]*(?:api[_-]?key|token|secret)[A-Za-z0-9_-]*\s*[=:]\s*)[^\s,;)}\]]+/gi, "$1[REDACTED]")
		.replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]")
		.replace(/glpat-[A-Za-z0-9_-]{16,}/g, "glpat-[REDACTED]")
		.replace(/[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
}

function renderMessageForReference(message: Message, toolNamesById: Map<string, string>): Message {
	if (message.role === "user") {
		return {
			role: "user",
			content: renderUserContent(message.content),
			timestamp: message.timestamp,
		};
	}
	if (message.role === "assistant") {
		const text = renderAssistantForReference(message, toolNamesById);
		return {
			...message,
			content: [{ type: "text", text: text || "[assistant message contained no visible text]" }],
		};
	}
	return renderToolResultMessageForReference(message, toolNamesById);
}

function renderAssistantForReference(message: AssistantMessage, toolNamesById: Map<string, string>): string {
	const lines: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			const text = stripVisibleReferenceBlocks(block.text).trim();
			if (text) lines.push(text);
		} else if (block.type === "thinking") {
			lines.push("[assistant thinking omitted]");
		} else {
			toolNamesById.set(block.id, block.name);
			lines.push(renderToolCall(block));
		}
	}
	return lines.join("\n").trim();
}

function renderToolResultMessageForReference(
	message: ToolResultMessage,
	toolNamesById: Map<string, string>,
): UserMessage {
	const toolName = toolNamesById.get(message.toolCallId) ?? message.toolName ?? message.toolCallId;
	const renderedContent = renderToolResult(message.content, TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS);
	return {
		role: "user",
		content: `[Tool result: ${toolName} -> ${renderedContent}]`,
		timestamp: message.timestamp,
	};
}

function renderToolCall(block: ToolCall): string {
	return `[Tool call: ${block.name}(${safeJsonStringify(block.arguments)})]`;
}

function renderUserContent(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.map(renderInputBlock).join("\n");
}

function renderInputBlock(block: TextContent | ImageContent): string {
	if (block.type === "text") return block.text;
	return `[image:${block.mimeType}:${block.data.length}]`;
}

function isPriorMoAGuidanceMessage(message: Message): boolean {
	if (message.role !== "user") return false;
	return getLeadingUserText(message).startsWith(MOA_GUIDANCE_MARKER);
}

function getLeadingUserText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	const firstBlock = message.content[0];
	if (firstBlock?.type !== "text") return "";
	return firstBlock.text;
}

function findLatestUserMessageIndex(messages: Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") return index;
	}
	return -1;
}

function renderReferenceHeader(index: number, output: ReferenceOutput): string {
	const label = `--- Reference ${index + 1} (${output.slot.provider}/${output.slot.model})`;
	return output.success ? `${label} ---` : `${label} FAILED ---`;
}

function renderReferenceDisplayHeader(index: number, output: ReferenceOutput): string {
	const label = `### Reference ${index + 1} (${output.slot.provider}/${output.slot.model})`;
	return output.success ? label : `${label} — failed`;
}

function stripVisibleReferenceBlocksFromMessage(message: Message): Message {
	if (message.role !== "assistant") return message;
	let changed = false;
	const content = message.content
		.map((block) => {
			if (block.type !== "text") return block;
			const text = stripVisibleReferenceBlocks(block.text);
			if (text !== block.text) changed = true;
			return { ...block, text };
		})
		.filter((block) => block.type !== "text" || block.text.length > 0);
	return changed ? { ...message, content } : message;
}

function stripVisibleReferenceBlocks(text: string): string {
	let stripped = text;
	while (true) {
		const start = stripped.indexOf(MOA_VISIBLE_REFERENCES_START);
		if (start === -1) return stripped;
		const end = stripped.indexOf(MOA_VISIBLE_REFERENCES_END, start);
		if (end === -1) return stripped.slice(0, start);
		stripped = `${stripped.slice(0, start)}${stripped.slice(end + MOA_VISIBLE_REFERENCES_END.length)}`;
	}
}

function truncateReferenceOutput(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = `...[truncated, ${text.length} chars total]...`;
	return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function truncateWithHeadTail(text: string, headChars: number, tailChars: number): string {
	if (text.length <= headChars + tailChars) return text;
	return `${text.slice(0, headChars)}...[truncated ${text.length} chars]...${text.slice(-tailChars)}`;
}

function renderUnknownContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (isTextContent(item)) return item.text;
				if (isImageContent(item)) return `[image:${item.mimeType}:${item.data.length}]`;
				return safeJsonStringify(item);
			})
			.join("\n");
	}
	return safeJsonStringify(content);
}

function isTextContent(value: unknown): value is TextContent {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): value is ImageContent {
	return (
		isRecord(value) && value.type === "image" && typeof value.mimeType === "string" && typeof value.data === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
