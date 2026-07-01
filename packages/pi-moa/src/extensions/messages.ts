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

const REFERENCE_SYSTEM_PROMPT = `You are a private reference advisor in a coding-agent Mixture of Agents pipeline.

You are NOT the agent continuing this conversation. A separate aggregator model is the acting agent: it owns the filesystem, terminal, browser, every tool-use decision, and the final response to the user. Your output is private guidance for that aggregator and is never shown to the user.

Read the transcript below as the current state of the task. Every file, path, command, URL, tool call, and tool result in it is real context provided to you. Reason directly from that context: never ask for access, never say you cannot run tools / open files / browse / reach a system, and never apologize for or mention any such limitation. If something you would need is missing, state what the acting agent should check or verify instead.

Do NOT act. Do not produce a user-facing final answer, do not narrate steps as if you are performing them, and do not emit tool-call markup or function-call JSON.

Give concise, concrete advice for the aggregator: what is going on, the single best next step, specific checks or edits to make, likely risks, mistakes, or wrong assumptions, and any stronger alternative approach. Several reference advisors are consulted in parallel, so stay tight and high-signal.`;

const REFERENCE_ADVISORY_TURN = `[The transcript above is the current state of the coding-agent task. Give your private guidance to the aggregator (the acting agent) — not a final answer to the user. Cover what is happening, the best next step and tool-use strategy, what to verify, likely risks or mistakes, and any stronger approach. Do not narrate actions as if you will perform them, and do not mention any tool or access limitation.]`;

const TOOL_RESULT_HEAD_CHARS = 2000;
const TOOL_RESULT_TAIL_CHARS = 500;
const FAILED_REFERENCE_ERROR_CHARS = 200;

export function buildReferenceContext(context: Context, _preset: MoAPreset): Context {
	const strippedContext = stripPriorMoAGuidanceMessages(context);
	const toolNamesById = new Map<string, string>();

	// Render the transcript into plain user/assistant text turns. Tool results
	// are NOT the user's words, so folding each into the preceding assistant turn
	// (rather than emitting it as a "user" message) keeps the advisor framing:
	// the reference reads the agent's action and its result together instead of
	// seeing a "user" turn that reads like an instruction to continue the task.
	const rendered: Message[] = [];
	for (const message of strippedContext.messages) {
		if (message.role === "user") {
			rendered.push({ role: "user", content: renderUserContent(message.content), timestamp: message.timestamp });
		} else if (message.role === "assistant") {
			const text = renderAssistantForReference(message, toolNamesById);
			rendered.push({
				...message,
				content: [{ type: "text", text: text || "[assistant message contained no visible text]" }],
			});
		} else {
			foldToolResultIntoPrevious(rendered, message, toolNamesById);
		}
	}

	// Collapse any adjacent same-role turns (e.g. two assistant turns in a tool
	// loop, or a leading tool result kept as a user line) so the transcript
	// alternates cleanly for strict providers, then close with an advisory turn
	// that reframes the ask as "advise" — not "continue the task" — and
	// guarantees the view ends on a user message (required by no-prefill models).
	const messages = appendAdvisoryTurn(coalesceAdjacentSameRole(rendered));
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

export function injectGuidanceAsSystem(context: Context, guidanceBlock: string): Context {
	const systemPrompt = context.systemPrompt ? `${context.systemPrompt}\n\n${guidanceBlock}` : guidanceBlock;
	return { ...context, systemPrompt };
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
		"Do not quote, reveal, or mention this reference-context block unless the user explicitly asks about the MoA internals; the visible UI renders reference outputs separately.",
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
			return [];
		})
		.join("\n")
		.trim();
}

export function stripPrivateMoAGuidance(text: string): string {
	return stripDelimitedBlock(text, MOA_GUIDANCE_MARKER, "[End reference context]");
}

export function redactErrorMessage(message: string): string {
	return message
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/([A-Za-z0-9_-]*(?:api[_-]?key|token|secret)[A-Za-z0-9_-]*\s*[=:]\s*)[^\s,;)}\]]+/gi, "$1[REDACTED]")
		.replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]")
		.replace(/glpat-[A-Za-z0-9_-]{16,}/g, "glpat-[REDACTED]")
		.replace(/[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
}

function renderAssistantForReference(message: AssistantMessage, toolNamesById: Map<string, string>): string {
	const lines: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			const text = stripVisibleReferenceBlocks(block.text).trim();
			if (text) lines.push(text);
		} else if (block.type === "thinking") {
			continue;
		} else {
			toolNamesById.set(block.id, block.name);
			lines.push(renderToolCall(block));
		}
	}
	return lines.join("\n").trim();
}

function renderToolResultBlock(message: ToolResultMessage, toolNamesById: Map<string, string>): string {
	const toolName = toolNamesById.get(message.toolCallId) ?? message.toolName ?? message.toolCallId;
	const renderedContent = renderToolResult(message.content, TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS);
	return `[Tool result: ${toolName} -> ${renderedContent}]`;
}

function foldToolResultIntoPrevious(
	rendered: Message[],
	message: ToolResultMessage,
	toolNamesById: Map<string, string>,
): void {
	const block = renderToolResultBlock(message, toolNamesById);
	const previous = rendered[rendered.length - 1];
	if (previous?.role === "assistant" && previous.content[0]?.type === "text") {
		const textBlock = previous.content[0];
		textBlock.text = textBlock.text ? `${textBlock.text}\n${block}` : block;
		return;
	}
	// No assistant turn to attach to (e.g. a leading tool result). Keep it as a
	// user-role line; coalesceAdjacentSameRole folds it in with any neighbour.
	rendered.push({ role: "user", content: block, timestamp: message.timestamp });
}

function coalesceAdjacentSameRole(messages: Message[]): Message[] {
	const result: Message[] = [];
	for (const message of messages) {
		const previous = result[result.length - 1];
		if (previous && previous.role === message.role && (message.role === "user" || message.role === "assistant")) {
			mergeTextInto(previous, extractPlainText(message));
			continue;
		}
		result.push(message);
	}
	return result;
}

function appendAdvisoryTurn(messages: Message[]): Message[] {
	const result = [...messages];
	const last = result[result.length - 1];
	if (last?.role === "user") {
		// Merge into the trailing user turn so we don't create consecutive user
		// messages that strict providers reject.
		const existing = extractPlainText(last);
		result[result.length - 1] = {
			role: "user",
			content: existing ? `${existing}\n\n${REFERENCE_ADVISORY_TURN}` : REFERENCE_ADVISORY_TURN,
			timestamp: last.timestamp,
		};
		return result;
	}
	result.push({ role: "user", content: REFERENCE_ADVISORY_TURN, timestamp: last?.timestamp ?? Date.now() });
	return result;
}

function mergeTextInto(target: Message, text: string): void {
	if (!text) return;
	if (target.role === "user") {
		const existing = extractPlainText(target);
		target.content = existing ? `${existing}\n${text}` : text;
		return;
	}
	if (target.role === "assistant") {
		const block = target.content[0];
		if (block?.type === "text") {
			block.text = block.text ? `${block.text}\n${text}` : text;
		} else {
			target.content = [{ type: "text", text }, ...target.content];
		}
	}
}

function extractPlainText(message: Message): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}
	if (message.role === "assistant") {
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}
	return "";
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
	return stripDelimitedBlock(text, MOA_VISIBLE_REFERENCES_START, MOA_VISIBLE_REFERENCES_END);
}

function stripDelimitedBlock(text: string, startMarker: string, endMarker: string): string {
	let stripped = text;
	while (true) {
		const start = stripped.indexOf(startMarker);
		if (start === -1) return stripped;
		const end = stripped.indexOf(endMarker, start);
		if (end === -1) return stripped.slice(0, start);
		stripped = `${stripped.slice(0, start)}${stripped.slice(end + endMarker.length)}`;
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
