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

/**
 * Sentinel that prefixes the display-only reference thinking block the provider
 * emits ahead of the aggregator's answer. The `context` handler strips assistant
 * thinking blocks whose text starts with this marker before any model sees them,
 * so the references stay visible to the human but never re-enter model context.
 */
export const MOA_REFERENCE_THINKING_MARKER = "⟦MoA references⟧";

// Reference advisor prompts are copied from hermes-agent's MoA implementation
// (agent/moa_loop.py) so the "proper" MoA framing is used verbatim: references
// are advisory analysts, not the acting agent, and their output is private
// guidance for the aggregator.
const REFERENCE_SYSTEM_PROMPT = `You are a reference advisor in a Mixture of Agents (MoA) process. You are NOT the acting agent and you do NOT execute anything: you cannot call tools, run commands, browse, or access files, repositories, or URLs, and you should not try to or apologize for being unable to. A separate aggregator/orchestrator model holds those capabilities and will take the actual actions.

The conversation below is the current state of a task handled by that acting agent. Your job is to give your most intelligent analysis of that state: understand the goal, reason about the problem, and advise on what to do next. Surface the best approach, concrete next steps and tool-use strategy, likely pitfalls and risks, and anything the acting agent may have missed or gotten wrong. Assume any referenced files, URLs, or systems exist and reason about them from the context given rather than asking for access.

Respond with your advice directly — no preamble, no disclaimers about tools or access. Your response is private guidance handed to the aggregator, not an answer shown to the user.`;

const REFERENCE_ADVISORY_TURN = `[The conversation above is the current state of the task. Give your most intelligent judgement: what is going on, what should happen next, what risks or mistakes you see, and how the acting agent should proceed.]`;

const TOOL_RESULT_HEAD_CHARS = 2000;
const TOOL_RESULT_TAIL_CHARS = 500;
const FAILED_REFERENCE_ERROR_CHARS = 200;

export function buildReferenceContext(
	context: Context,
	preset: MoAPreset,
): Context {
	return renderReferenceContext(stripPriorMoAGuidanceMessages(context), preset);
}

/**
 * Render an already-stripped context into the reference advisor's view. The input
 * MUST have had prior MoA guidance messages removed (see
 * `stripPriorMoAGuidanceMessages`) — this function deliberately does NOT strip,
 * so it can be called on the shared, once-stripped context the orchestrator
 * already computes for the aggregator path. That avoids a second full-transcript
 * strip pass on the synchronous reference-context critical path (the strip is
 * idempotent, so the rendered output is byte-identical either way). Callers that
 * hold a raw context should use `buildReferenceContext`, which strips first.
 */
export function renderReferenceContext(
	strippedContext: Context,
	preset: MoAPreset,
): Context {
	const toolNamesById = new Map<string, string>();

	// How much of each tool result the reference advisors see. Tool results
	// (file dumps, command output) are usually the bulkiest, least-advice-relevant
	// content in an agentic transcript, and they drive the reference's prefill —
	// which sits on the aggregator-blocking critical path. `referenceToolResultMaxChars`
	// bounds the leading portion (head) kept per tool result and
	// `referenceToolResultTailChars` bounds the trailing portion (tail) — a fixed
	// tail is always kept so the reference still sees each command's OUTCOME, not
	// just its start. Both unset fall back to the default head/tail budgets so the
	// rendered view is byte-identical. Together they are a finer lever than
	// referenceMaxContextChars: rather than eliding whole middle TURNS (which loses
	// the sequence of actions), they keep every turn but compress each verbose
	// result from both ends — which is exactly what an advisor needs (see WHAT was
	// done and how it ended, not every byte of output). On a long agentic transcript
	// with many tool results the always-kept tail (500 chars each by default) can
	// itself dominate reference prefill, so shrinking it is a real reduction the head
	// cap alone can't reach.
	const toolResultHeadChars =
		preset.referenceToolResultMaxChars ??
		TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS;
	const toolResultTailChars =
		preset.referenceToolResultTailChars ?? TOOL_RESULT_TAIL_CHARS;

	// Render the transcript into plain user/assistant text turns. Tool results
	// are NOT the user's words, so folding each into the preceding assistant turn
	// (rather than emitting it as a "user" message) keeps the advisor framing:
	// the reference reads the agent's action and its result together instead of
	// seeing a "user" turn that reads like an instruction to continue the task.
	const rendered: Message[] = [];
	for (const message of strippedContext.messages) {
		if (message.role === "user") {
			rendered.push({
				role: "user",
				content: renderUserContent(message.content),
				timestamp: message.timestamp,
			});
		} else if (message.role === "assistant") {
			const text = renderAssistantForReference(message, toolNamesById);
			rendered.push({
				...message,
				content: [
					{
						type: "text",
						text: text || "[assistant message contained no visible text]",
					},
				],
			});
		} else {
			foldToolResultIntoPrevious(
				rendered,
				message,
				toolNamesById,
				toolResultHeadChars,
				toolResultTailChars,
			);
		}
	}

	// Optionally bound the reference's *input* size. References are advisory only
	// — the aggregator always receives the FULL context and does the actual work —
	// so trimming a reference's view of a long transcript degrades only its hints,
	// never the final answer's context. On a large/uncached transcript this is the
	// one lever that shortens reference time-to-first-token (input length drives
	// prefill), which sits on the aggregator-blocking critical path. Opt-in and
	// unset by default, so default behavior is byte-identical.
	const budgetedRendered = capReferenceContextToBudget(
		rendered,
		preset.referenceMaxContextChars,
	);

	// Collapse any adjacent same-role turns (e.g. two assistant turns in a tool
	// loop, or a leading tool result kept as a user line) so the transcript
	// alternates cleanly for strict providers, then close with an advisory turn
	// that reframes the ask as "advise" — not "continue the task" — and
	// guarantees the view ends on a user message (required by no-prefill models).
	const messages = appendAdvisoryTurn(coalesceAdjacentSameRole(budgetedRendered));
	return {
		systemPrompt: REFERENCE_SYSTEM_PROMPT,
		messages,
	};
}

// Marker inserted where earlier transcript turns were dropped to honor
// referenceMaxContextChars, so the reference knows its view was trimmed (and
// doesn't treat the kept tail as the whole story).
const REFERENCE_CONTEXT_ELISION_NOTE =
	"[Earlier conversation turns were omitted to bound reference latency; reason from the task and the recent state below.]";

// Trim the rendered reference transcript to roughly `maxChars` of text by keeping
// the most-recent turns (what matters most for "what to do next") plus the first
// user turn (usually the task/goal), eliding the middle. The cap is approximate:
// the preserved task turn and elision note are a small, deliberate overage so the
// reference retains both the objective and the current state. Returns the input
// unchanged when the cap is unset or the transcript already fits.
function capReferenceContextToBudget(
	rendered: Message[],
	maxChars: number | undefined,
): Message[] {
	if (maxChars === undefined || rendered.length <= 1) {
		return rendered;
	}
	const sizes = rendered.map(renderedMessageChars);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total <= maxChars) {
		return rendered;
	}

	// Walk newest -> oldest, keeping turns until the next one would blow the
	// budget. Always keep at least the most recent turn even if it alone exceeds
	// the budget (a single huge turn is better than an empty view).
	let tailStart = rendered.length;
	let used = 0;
	for (let index = rendered.length - 1; index >= 0; index--) {
		if (tailStart < rendered.length && used + sizes[index] > maxChars) {
			break;
		}
		tailStart = index;
		used += sizes[index];
	}

	if (tailStart === 0) {
		return rendered;
	}

	const firstUserIndex = rendered.findIndex(
		(message) => message.role === "user",
	);
	const preserved: Message[] = [];
	if (firstUserIndex !== -1 && firstUserIndex < tailStart) {
		preserved.push(rendered[firstUserIndex]);
	}
	preserved.push({
		role: "user",
		content: REFERENCE_CONTEXT_ELISION_NOTE,
		timestamp: rendered[tailStart].timestamp,
	});
	preserved.push(...rendered.slice(tailStart));
	return preserved;
}

function renderedMessageChars(message: Message): number {
	return extractPlainText(message).length;
}

export function stripPriorMoAGuidanceMessages(context: Context): Context {
	return {
		...context,
		messages: context.messages.filter(
			(message) => !isPriorMoAGuidanceMessage(message),
		),
	};
}

export function injectGuidanceAsSystem(
	context: Context,
	guidanceBlock: string,
): Context {
	const systemPrompt = context.systemPrompt
		? `${context.systemPrompt}\n\n${guidanceBlock}`
		: guidanceBlock;
	return { ...context, systemPrompt };
}

export function injectGuidance(
	context: Context,
	guidanceBlock: string,
): Context {
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

export function appendGuidanceToLatestUser(
	context: Context,
	guidanceBlock: string,
): Context {
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

/**
 * Place the aggregator guidance so the entire prior transcript stays a byte-stable
 * prefix that the aggregator's provider can reuse from its prompt cache across
 * turns.
 *
 * The default `appendGuidanceToLatestUser` mutates the *latest user message*.
 * In an agentic tool loop the only user message is usually the original task at
 * index 0 (subsequent turns are `assistant`/`toolResult` roles), so injecting the
 * fresh-every-turn guidance there changes an early message and busts the aggregator's
 * cross-turn prompt cache for the whole transcript — forcing a full re-prefill on
 * every tool-loop iteration. Providers cache the longest matching *prefix*, so the
 * guidance must sit at the end for the growing transcript before it to keep matching.
 *
 * When the transcript already ends on a user turn, appending in place is both
 * cache-optimal and alternation-safe, so this defers to `appendGuidanceToLatestUser`.
 * Otherwise it adds the guidance as a new trailing user message. On providers that
 * reject the resulting role sequence (a user turn after tool results on strict
 * Anthropic-style alternation), the caller's existing consecutive-user fallback folds
 * the guidance into the system prompt instead, so correctness is preserved.
 */
export function appendGuidanceAsTrailingTurn(
	context: Context,
	guidanceBlock: string,
): Context {
	const messages = [...context.messages];
	const last = messages[messages.length - 1];
	if (last?.role === "user") {
		return appendGuidanceToLatestUser(context, guidanceBlock);
	}
	messages.push({
		role: "user",
		content: guidanceBlock,
		timestamp: last?.timestamp ?? Date.now(),
	});
	return { ...context, messages };
}

/**
 * Render reference outputs as the text of the display-only thinking block the
 * provider emits ahead of the aggregator's answer. Successful advice is
 * truncated to the preset's budget; failures are redacted and truncated. The
 * first line is the `MOA_REFERENCE_THINKING_MARKER` sentinel so the `context`
 * handler can identify and strip this block before any model sees it.
 */
export function buildReferenceThinkingText(
	preset: MoAPreset,
	referenceOutputs: ReferenceOutput[],
): string {
	// Composed from the same header/section builders the progressive streaming path
	// uses, so a header followed by `\n\n`-joined sections reproduces this text
	// byte-for-byte (the atomic burst and the streamed reveal are interchangeable).
	const header = buildReferenceThinkingHeader(preset, referenceOutputs.length);
	const sections = referenceOutputs.map((output, index) =>
		buildReferenceThinkingSection(preset, index, output),
	);
	return [header, ...sections].join("\n\n");
}

/**
 * The first line of the reference thinking block: the sentinel marker, the model
 * count, and the aggregator. Known before any reference finishes, so the
 * progressive streaming path emits it immediately as the reference phase's first
 * visible feedback.
 */
export function buildReferenceThinkingHeader(
	preset: MoAPreset,
	count: number,
): string {
	const aggregator = `${preset.aggregator.provider}/${preset.aggregator.model}`;
	return `${MOA_REFERENCE_THINKING_MARKER} · ${count} model${count === 1 ? "" : "s"} · aggregator ${aggregator}`;
}

/**
 * One reference's section of the thinking block (its `▍ Reference N — provider/model`
 * label line followed by its truncated advice or redacted error). The progressive
 * streaming path emits these one at a time as each reference settles; joining the
 * header and every section with `\n\n` yields exactly `buildReferenceThinkingText`.
 */
export function buildReferenceThinkingSection(
	preset: MoAPreset,
	index: number,
	output: ReferenceOutput,
): string {
	const name = `${output.slot.provider}/${output.slot.model}`;
	if (output.success) {
		return `▍ Reference ${index + 1} — ${name}\n${truncateReferenceOutput(
			output.text,
			getMaxReferenceOutputChars(preset),
		)}`;
	}
	const fallbackErrorText =
		output.errorMessage ?? output.text ?? "Unknown reference failure";
	return `▍ Reference ${index + 1} — ${name} (failed)\n${truncateReferenceOutput(
		redactErrorMessage(fallbackErrorText),
		FAILED_REFERENCE_ERROR_CHARS,
	)}`;
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
		`References: ${args.referenceOutputs.map((output) => `${output.slot.provider}/${output.slot.model}`).join(", ")}`,
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
			lines.push(
				`Error: ${truncateReferenceOutput(redactErrorMessage(errorText), FAILED_REFERENCE_ERROR_CHARS)}`,
			);
		}
	});

	lines.push("", "[End reference context]");
	return lines.join("\n");
}

export function renderToolResult(
	content: unknown,
	headChars: number,
	tailChars: number = TOOL_RESULT_TAIL_CHARS,
): string {
	const rendered = renderUnknownContent(content);
	return truncateWithHeadTail(rendered, headChars, tailChars);
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
	return stripDelimitedBlock(
		text,
		MOA_GUIDANCE_MARKER,
		"[End reference context]",
	);
}

export function redactErrorMessage(message: string): string {
	return message
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(
			/([A-Za-z0-9_-]*(?:api[_-]?key|token|secret)[A-Za-z0-9_-]*\s*[=:]\s*)[^\s,;)}\]]+/gi,
			"$1[REDACTED]",
		)
		.replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]")
		.replace(/glpat-[A-Za-z0-9_-]{16,}/g, "glpat-[REDACTED]")
		.replace(
			/[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
			"[REDACTED]",
		);
}

function renderAssistantForReference(
	message: AssistantMessage,
	toolNamesById: Map<string, string>,
): string {
	const lines: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			const text = block.text.trim();
			if (text) lines.push(text);
		} else if (block.type === "thinking") {
		} else {
			toolNamesById.set(block.id, block.name);
			lines.push(renderToolCall(block));
		}
	}
	return lines.join("\n").trim();
}

function renderToolResultBlock(
	message: ToolResultMessage,
	toolNamesById: Map<string, string>,
	headChars: number,
	tailChars: number,
): string {
	const toolName =
		toolNamesById.get(message.toolCallId) ??
		message.toolName ??
		message.toolCallId;
	const renderedContent = renderToolResult(message.content, headChars, tailChars);
	return `[Tool result: ${toolName} -> ${renderedContent}]`;
}

function foldToolResultIntoPrevious(
	rendered: Message[],
	message: ToolResultMessage,
	toolNamesById: Map<string, string>,
	headChars: number,
	tailChars: number,
): void {
	const block = renderToolResultBlock(
		message,
		toolNamesById,
		headChars,
		tailChars,
	);
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
		if (
			previous &&
			previous.role === message.role &&
			(message.role === "user" || message.role === "assistant")
		) {
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
			content: existing
				? `${existing}\n\n${REFERENCE_ADVISORY_TURN}`
				: REFERENCE_ADVISORY_TURN,
			timestamp: last.timestamp,
		};
		return result;
	}
	result.push({
		role: "user",
		content: REFERENCE_ADVISORY_TURN,
		timestamp: last?.timestamp ?? Date.now(),
	});
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
		return message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n");
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

function stripDelimitedBlock(
	text: string,
	startMarker: string,
	endMarker: string,
): string {
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

function truncateWithHeadTail(
	text: string,
	headChars: number,
	tailChars: number,
): string {
	if (text.length <= headChars + tailChars) return text;
	return `${text.slice(0, headChars)}...[truncated ${text.length} chars]...${text.slice(-tailChars)}`;
}

function renderUnknownContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (isTextContent(item)) return item.text;
				if (isImageContent(item))
					return `[image:${item.mimeType}:${item.data.length}]`;
				return safeJsonStringify(item);
			})
			.join("\n");
	}
	return safeJsonStringify(content);
}

function isTextContent(value: unknown): value is TextContent {
	return (
		isRecord(value) && value.type === "text" && typeof value.text === "string"
	);
}

function isImageContent(value: unknown): value is ImageContent {
	return (
		isRecord(value) &&
		value.type === "image" &&
		typeof value.mimeType === "string" &&
		typeof value.data === "string"
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
