import type { AgentMessage } from "./message.js";
import type { Action, Decision, DecisionMap, ExclusionReason } from "./types.js";

export const PLACEHOLDER_MARKER = "[pi-compaction]";

export interface TransformResult {
	messages: AgentMessage[];
	/** Tool-call ids whose result body was replaced by a placeholder. */
	replaced: string[];
	/** Tool-call ids whose call and result were removed together. */
	dropped: string[];
	/** Requested pair drops that were applied as result replacements instead. */
	downgraded: Array<{ toolCallId: string; reason: ExclusionReason }>;
	/**
	 * Decisions left unapplied because the live list is ambiguous for their id: the id
	 * appears in more than one call or result, or the result is missing. Every message
	 * involved is passed through untouched.
	 */
	unmatched: Array<{ toolCallId: string; reason: Extract<ExclusionReason, "ambiguous" | "incomplete"> }>;
}

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;

export function placeholderText(decision: Pick<Decision, "toolName" | "resultChars" | "resultEntryId">, isError: boolean): string {
	const outcome = isError ? "error output" : "output";
	return (
		`${PLACEHOLDER_MARKER} ${decision.toolName} ${outcome} (${decision.resultChars} chars) was omitted from context to save space. ` +
		`The original is archived under id ${decision.resultEntryId}. ` +
		`Omission says nothing about success or relevance; call compaction_recall with action "read" and id "${decision.resultEntryId}" if you need it.`
	);
}

function replaceResult(message: ToolResult, decision: Decision): ToolResult {
	const text = placeholderText(decision, message.isError);
	const keptImages = message.content.filter((block) => block.type === "image");
	return {
		...message,
		content: [{ type: "text", text }, ...keptImages],
	};
}

function hasThinking(message: Assistant): boolean {
	return message.content.some((block) => block.type === "thinking");
}

function hasText(message: Assistant): boolean {
	return message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

function effectiveAction(decisions: DecisionMap, toolCallId: string, pinned: ReadonlySet<string>, blocked: ReadonlySet<string>): Action {
	if (pinned.has(toolCallId) || blocked.has(toolCallId)) return "keep";
	return decisions.get(toolCallId)?.effective ?? "keep";
}

/**
 * Re-check pairing on the live list at replay time. A decision was committed against one
 * snapshot; later edits, other context handlers or a repeated id can make it ambiguous, and
 * an ambiguous id must protect every message that carries it.
 */
function unmatchedDecisions(messages: readonly AgentMessage[], decisions: DecisionMap): TransformResult["unmatched"] {
	const callSeen = new Map<string, number>();
	const resultSeen = new Map<string, number>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && decisions.has(block.id)) callSeen.set(block.id, (callSeen.get(block.id) ?? 0) + 1);
			}
		} else if (message.role === "toolResult" && decisions.has(message.toolCallId)) {
			resultSeen.set(message.toolCallId, (resultSeen.get(message.toolCallId) ?? 0) + 1);
		}
	}
	const unmatched: TransformResult["unmatched"] = [];
	for (const [toolCallId, decision] of decisions) {
		if (decision.effective === "keep") continue;
		const calls = callSeen.get(toolCallId) ?? 0;
		const results = resultSeen.get(toolCallId) ?? 0;
		if (calls === 0 && results === 0) continue; // not in this context at all; nothing to protect
		if (calls > 1 || results > 1) unmatched.push({ toolCallId, reason: "ambiguous" });
		else if (calls !== 1 || results !== 1) unmatched.push({ toolCallId, reason: "incomplete" });
	}
	return unmatched;
}

/**
 * Apply decisions to an outgoing message list without mutating the input.
 *
 * Provider validity rules enforced here, independent of what was requested:
 * - a tool result is only ever replaced, never orphaned from its call;
 * - an assistant message carrying thinking/reasoning blocks is atomic: its calls are
 *   removed only when every call in it is dropped and no text remains, in which case the
 *   whole message goes; otherwise the pair drops become result replacements;
 * - a removal never leaves two user-role messages adjacent.
 */
export function applyDecisions(
	messages: readonly AgentMessage[],
	decisions: DecisionMap,
	pinned: ReadonlySet<string> = new Set(),
): TransformResult {
	const replaced: string[] = [];
	const dropped: string[] = [];
	const downgraded: TransformResult["downgraded"] = [];
	const unmatched = unmatchedDecisions(messages, decisions);
	const blocked = new Set(unmatched.map((item) => item.toolCallId));
	// Which result messages exist, so we never remove a call whose result is missing.
	const resultIndexByCall = new Map<string, number>();
	messages.forEach((message, index) => {
		if (message.role === "toolResult" && !blocked.has(message.toolCallId)) resultIndexByCall.set(message.toolCallId, index);
	});

	const removeMessage = new Set<number>();
	const removeCall = new Map<number, Set<string>>();
	const replaceCall = new Set<string>();

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const calls = message.content.filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall");
		if (calls.length === 0) continue;
		const pairDrops = calls.filter(
			(call) => effectiveAction(decisions, call.id, pinned, blocked) === "drop_pair" && resultIndexByCall.has(call.id),
		);
		const resultDrops = calls.filter((call) => effectiveAction(decisions, call.id, pinned, blocked) === "drop_result");
		for (const call of resultDrops) replaceCall.add(call.id);
		if (pairDrops.length === 0) continue;

		const atomic = hasThinking(message);
		const wholeMessage = pairDrops.length === calls.length && !hasText(message);
		if (atomic && !wholeMessage) {
			for (const call of pairDrops) {
				replaceCall.add(call.id);
				downgraded.push({ toolCallId: call.id, reason: "provider_atomic" });
			}
			continue;
		}
		if (wholeMessage) {
			// Removing the message and all its results must not make two user messages adjacent.
			const resultIndices = pairDrops.map((call) => resultIndexByCall.get(call.id)!);
			const lastRemoved = Math.max(index, ...resultIndices);
			const previous = previousKept(messages, index - 1, removeMessage);
			const next = lastRemoved + 1 < messages.length ? messages[lastRemoved + 1] : undefined;
			if (previous?.role === "user" && next?.role === "user") {
				for (const call of pairDrops) {
					replaceCall.add(call.id);
					downgraded.push({ toolCallId: call.id, reason: "provider_atomic" });
				}
				continue;
			}
			removeMessage.add(index);
			for (const resultIndex of resultIndices) removeMessage.add(resultIndex);
			for (const call of pairDrops) dropped.push(call.id);
			continue;
		}
		// Partial removal from a plain assistant message: drop the call blocks and their results.
		const ids = new Set(pairDrops.map((call) => call.id));
		removeCall.set(index, ids);
		for (const call of pairDrops) {
			removeMessage.add(resultIndexByCall.get(call.id)!);
			dropped.push(call.id);
		}
	}

	const output: AgentMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (removeMessage.has(index)) continue;
		const message = messages[index];
		if (message.role === "assistant" && removeCall.has(index)) {
			const ids = removeCall.get(index)!;
			output.push({ ...message, content: message.content.filter((block) => block.type !== "toolCall" || !ids.has(block.id)) });
			continue;
		}
		if (message.role === "toolResult" && replaceCall.has(message.toolCallId)) {
			const decision = decisions.get(message.toolCallId);
			if (decision) {
				const next = replaceResult(message, decision);
				if (JSON.stringify(next.content).length < JSON.stringify(message.content).length) {
					output.push(next);
					replaced.push(message.toolCallId);
					continue;
				}
			}
		}
		output.push(message);
	}
	return { messages: output, replaced, dropped, downgraded, unmatched };
}

function previousKept(messages: readonly AgentMessage[], from: number, removed: ReadonlySet<number>): AgentMessage | undefined {
	for (let index = from; index >= 0; index--) {
		if (!removed.has(index)) return messages[index];
	}
	return undefined;
}

/**
 * Validate requested decisions against the live message list and return what can be
 * applied. Used before persisting a pass so replay is deterministic.
 */
export function reconcileDecisions(messages: readonly AgentMessage[], requested: readonly Decision[], pinned: ReadonlySet<string>): Decision[] {
	const map = new Map<string, Decision>();
	for (const decision of requested) {
		if (decision.requested === "keep") continue;
		map.set(decision.toolCallId, { ...decision, effective: decision.requested });
	}
	const result = applyDecisions(messages, map, pinned);
	const downgradedIds = new Map(result.downgraded.map((item) => [item.toolCallId, item.reason] as const));
	const unmatchedIds = new Map(result.unmatched.map((item) => [item.toolCallId, item.reason] as const));
	const appliedIds = new Set([...result.replaced, ...result.dropped]);
	const reconciled: Decision[] = [];
	for (const decision of requested) {
		if (decision.requested === "keep") {
			reconciled.push({ ...decision, effective: "keep" });
			continue;
		}
		const downgrade = downgradedIds.get(decision.toolCallId);
		if (downgrade !== undefined) {
			reconciled.push({ ...decision, effective: "drop_result", downgradeReason: downgrade });
			continue;
		}
		if (!appliedIds.has(decision.toolCallId)) {
			reconciled.push({ ...decision, effective: "keep", downgradeReason: unmatchedIds.get(decision.toolCallId) ?? "unsupported" });
			continue;
		}
		reconciled.push({ ...decision, effective: decision.requested });
	}
	return reconciled;
}
