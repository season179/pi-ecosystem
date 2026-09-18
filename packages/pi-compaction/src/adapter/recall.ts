import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DecisionMap } from "../engine/types.js";
import type { PinRecord } from "./state.js";

/** One archived tool result on the current branch. */
export interface ArchiveItem {
	/** Archive id: the session entry id of the tool result. */
	id: string;
	toolCallId: string;
	toolName: string;
	/** Bounded, single-line rendering of the call arguments. */
	arguments: string;
	chars: number;
	isError: boolean;
	/** Whether the result is currently omitted or shortened in the outgoing context. */
	omitted: "none" | "result" | "pair";
	pinned: boolean;
	/** Zero-based user turn the call belongs to. */
	turn: number;
}

interface Archived extends ArchiveItem {
	text: string;
}

export const READ_PAGE_DEFAULT = 8_000;
export const READ_PAGE_MAX = 16_000;
const ARGUMENT_CHARS = 160;

function renderArguments(args: Record<string, unknown> | undefined): string {
	let text: string;
	try {
		text = JSON.stringify(args ?? {});
	} catch {
		text = "[unserializable]";
	}
	text = text.replace(/\s+/g, " ");
	return text.length > ARGUMENT_CHARS ? `${text.slice(0, ARGUMENT_CHARS)}…` : text;
}

/** Walk the branch (root first) and index every completed tool result with its call. */
export function indexArchive(branch: readonly SessionEntry[], decisions: DecisionMap, pins: ReadonlyMap<string, PinRecord>): Archived[] {
	const calls = new Map<string, { name: string; arguments: Record<string, unknown> | undefined; turn: number }>();
	const items: Archived[] = [];
	let turn = -1;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			turn++;
			continue;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.set(block.id, { name: block.name, arguments: block.arguments, turn: Math.max(turn, 0) });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		let text = "";
		for (const block of message.content) if (block.type === "text") text += block.text;
		const decision = decisions.get(message.toolCallId);
		const pinned = pins.has(message.toolCallId);
		items.push({
			id: entry.id,
			toolCallId: message.toolCallId,
			toolName: call?.name ?? message.toolName,
			arguments: renderArguments(call?.arguments),
			chars: text.length,
			isError: message.isError,
			omitted: pinned || !decision ? "none" : decision.effective === "drop_pair" ? "pair" : decision.effective === "drop_result" ? "result" : "none",
			pinned,
			turn: call?.turn ?? Math.max(turn, 0),
			text,
		});
	}
	return items;
}

export interface ListOptions {
	omittedOnly: boolean;
	offset: number;
	limit: number;
}

export function listArchive(items: readonly Archived[], options: ListOptions): { items: ArchiveItem[]; total: number } {
	const filtered = options.omittedOnly ? items.filter((item) => item.omitted !== "none") : items;
	const page = filtered.slice(options.offset, options.offset + options.limit).map(stripText);
	return { items: page, total: filtered.length };
}

export interface SearchMatch extends ArchiveItem {
	/** Bounded excerpt around the first match. */
	snippet: string;
	matches: number;
}

export function searchArchive(items: readonly Archived[], query: string, limit: number): SearchMatch[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const results: SearchMatch[] = [];
	for (const item of items) {
		const haystack = item.text.toLowerCase();
		let index = haystack.indexOf(needle);
		if (index < 0) {
			if (!item.arguments.toLowerCase().includes(needle)) continue;
			results.push({ ...stripText(item), snippet: item.arguments, matches: 0 });
		} else {
			let matches = 0;
			let cursor = index;
			while (cursor >= 0 && matches < 1000) {
				matches++;
				cursor = haystack.indexOf(needle, cursor + needle.length);
			}
			const start = Math.max(0, index - 120);
			const end = Math.min(item.text.length, index + needle.length + 200);
			results.push({ ...stripText(item), snippet: `${start > 0 ? "…" : ""}${item.text.slice(start, end)}${end < item.text.length ? "…" : ""}`, matches });
		}
		if (results.length >= limit) break;
	}
	return results;
}

export interface ReadResult {
	item: ArchiveItem;
	text: string;
	offset: number;
	total: number;
	/** Offset to continue from, or undefined when the page reached the end. */
	nextOffset?: number;
}

export function readArchive(items: readonly Archived[], id: string, offset: number, limit: number): ReadResult | undefined {
	const item = items.find((candidate) => candidate.id === id || candidate.toolCallId === id);
	if (!item) return undefined;
	const start = Math.max(0, Math.min(offset, item.text.length));
	const size = Math.max(1, Math.min(limit, READ_PAGE_MAX));
	const end = Math.min(item.text.length, start + size);
	return {
		item: stripText(item),
		text: item.text.slice(start, end),
		offset: start,
		total: item.text.length,
		nextOffset: end < item.text.length ? end : undefined,
	};
}

function stripText(item: Archived): ArchiveItem {
	const { text: _text, ...rest } = item;
	return rest;
}
