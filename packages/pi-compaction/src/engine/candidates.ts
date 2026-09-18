import type { AgentMessage } from "./message.js";
import type { Candidate, CandidateCollection, ContextEntry, Exclusion } from "./types.js";

export interface CollectOptions {
	/**
	 * Newest tool groups (assistant messages that issued tool calls, with their results)
	 * that are never candidates, regardless of which user turn they belong to.
	 */
	protectRecentGroups: number;
	/** Tool-call ids the user or recall pinned; never candidates. */
	pinned: ReadonlySet<string>;
	/** Tool-call ids that already carry an applied decision; not re-scored. */
	decided: ReadonlySet<string>;
	/** Tools whose results are never candidates (e.g. the recall tool itself). */
	protectedTools: ReadonlySet<string>;
}

interface CallSite {
	entryId: string | undefined;
	index: number;
	turnIndex: number;
	groupIndex: number;
	name: string;
	arguments: Record<string, unknown>;
	seen: number;
}

/** Text characters in a tool result; images count as multimodal separately. */
export function resultTextChars(message: Extract<AgentMessage, { role: "toolResult" }>): number {
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
	}
	return chars;
}

function hasImage(message: Extract<AgentMessage, { role: "toolResult" }>): boolean {
	return message.content.some((block) => block.type === "image");
}

/** File names whose contents are standing instructions or plans rather than evidence. */
const INSTRUCTION_BASENAME = /^(AGENTS|CLAUDE|GEMINI|README|CONTRIBUTING|SKILL|PLAN|PLANS?|TODO|ROADMAP|\.cursorrules|\.clinerules)(\.[A-Za-z0-9]+)?$/i;
const INSTRUCTION_PATH = /(^|[\\/])(\.pi|\.claude|\.cursor|\.github)[\\/]|(^|[\\/_.-])plan(s|ning)?\.(md|txt)$|(^|[\\/])docs[\\/][^\\/]*PLAN[^\\/]*$/i;

/** True when any string argument points at instruction or plan material. */
export function isInstructionCall(args: Record<string, unknown>): boolean {
	for (const value of Object.values(args)) {
		if (typeof value !== "string" || value.length > 1024) continue;
		// A path argument is one token; a shell command may name several files.
		for (const token of value.trim().split(/\s+/)) {
			if (!token) continue;
			if (INSTRUCTION_PATH.test(token)) return true;
			const base = token.split(/[\\/]/).pop() ?? token;
			if (INSTRUCTION_BASENAME.test(base)) return true;
		}
	}
	return false;
}

/**
 * Pair every tool call with its result and select the pairs Jev may judge.
 * Protection is per tool group, not per user turn: the newest `protectRecentGroups`
 * assistant tool-call groups are excluded as `recent`, so a single long user task still
 * yields candidates once its older groups age out. Reads of instruction or plan files are
 * excluded as `instruction`. User messages are never candidates and are never touched.
 * Duplicate or unmatched tool-call ids are excluded so ambiguity always protects the pair.
 */
export function collectCandidates(entries: readonly ContextEntry[], options: CollectOptions): CandidateCollection {
	const calls = new Map<string, CallSite>();
	const results = new Map<string, { entryId: string | undefined; index: number; seen: number }>();
	let turnIndex = -1;
	let groups = 0;
	for (let index = 0; index < entries.length; index++) {
		const { id, message } = entries[index];
		if (message.role === "user") {
			turnIndex++;
			continue;
		}
		if (message.role === "assistant") {
			let grouped = false;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (!grouped) {
					grouped = true;
					groups++;
				}
				const previous = calls.get(block.id);
				calls.set(block.id, {
					entryId: id,
					index,
					turnIndex: Math.max(turnIndex, 0),
					groupIndex: groups - 1,
					name: block.name,
					arguments: block.arguments ?? {},
					seen: (previous?.seen ?? 0) + 1,
				});
			}
			continue;
		}
		if (message.role === "toolResult") {
			const previous = results.get(message.toolCallId);
			results.set(message.toolCallId, { entryId: id, index, seen: (previous?.seen ?? 0) + 1 });
		}
	}
	const turns = turnIndex + 1;
	const recentFrom = Math.max(0, groups - Math.max(0, options.protectRecentGroups));
	const candidates: Candidate[] = [];
	const excluded: Exclusion[] = [];
	let ordinal = 0;
	for (const [toolCallId, call] of calls) {
		const result = results.get(toolCallId);
		if (!result) {
			excluded.push({ toolCallId, reason: "incomplete" });
			continue;
		}
		if (call.seen > 1 || result.seen > 1) {
			excluded.push({ toolCallId, reason: "ambiguous" });
			continue;
		}
		if (result.index <= call.index) {
			excluded.push({ toolCallId, reason: "incomplete" });
			continue;
		}
		const resultMessage = entries[result.index].message;
		if (resultMessage.role !== "toolResult") {
			excluded.push({ toolCallId, reason: "incomplete" });
			continue;
		}
		if (options.pinned.has(toolCallId) || options.protectedTools.has(call.name)) {
			excluded.push({ toolCallId, reason: "pinned" });
			continue;
		}
		if (options.decided.has(toolCallId)) continue; // already applied, nothing to ask
		if (call.entryId === undefined || result.entryId === undefined) {
			excluded.push({ toolCallId, reason: "unmapped" });
			continue;
		}
		if (hasImage(resultMessage)) {
			excluded.push({ toolCallId, reason: "multimodal" });
			continue;
		}
		if (isInstructionCall(call.arguments)) {
			excluded.push({ toolCallId, reason: "instruction" });
			continue;
		}
		if (call.groupIndex >= recentFrom) {
			excluded.push({ toolCallId, reason: "recent" });
			continue;
		}
		ordinal++;
		candidates.push({
			toolCallId,
			resultEntryId: result.entryId,
			callEntryId: call.entryId,
			shortId: `t${ordinal}`,
			toolName: call.name,
			arguments: call.arguments,
			resultChars: resultTextChars(resultMessage),
			isError: resultMessage.isError,
			callIndex: call.index,
			resultIndex: result.index,
			turnIndex: call.turnIndex,
		});
	}
	candidates.sort((a, b) => a.callIndex - b.callIndex);
	return { candidates, excluded, turns };
}
