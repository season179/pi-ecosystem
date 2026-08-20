import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import {
	mutateMemoryStore,
	recallMemoryStore,
	type Memory,
	type MemoryMutation,
} from "../store.js";

const RememberParams = Type.Object({
	action: StringEnum(["create", "update", "delete"] as const, {
		description: "Create, update, or delete a persistent memory",
	}),
	id: Type.Optional(Type.String({ description: "Immutable memory id required for update and delete" })),
	title: Type.Optional(Type.String({ description: "Short memory title" })),
	cue: Type.Optional(Type.String({ description: "When this memory is useful" })),
	body: Type.Optional(Type.String({ description: "Full memory details" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Searchable tags" })),
});

const RecallParams = Type.Object({
	query: Type.String({
		description: "Words, exact title, or exact memory id to search; use an empty string for the most recent memories",
	}),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
	includeDetails: Type.Optional(Type.Boolean({ default: true, description: "Include memory bodies in the result" })),
});

function requireId(id: string | undefined, action: "update" | "delete"): string {
	if (id === undefined) throw new Error(`${action} requires id`);
	return id;
}

function toMutation(params: {
	action: "create" | "update" | "delete";
	id?: string;
	title?: string;
	cue?: string;
	body?: string;
	tags?: string[];
}): MemoryMutation {
	if (params.action === "create") {
		if (params.title === undefined || params.cue === undefined || params.body === undefined) {
			throw new Error("create requires title, cue, and body");
		}
		return { action: "create", title: params.title, cue: params.cue, body: params.body, tags: params.tags };
	}
	if (params.action === "delete") return { action: "delete", id: requireId(params.id, "delete") };
	return {
		action: "update",
		id: requireId(params.id, "update"),
		title: params.title,
		cue: params.cue,
		body: params.body,
		tags: params.tags,
	};
}

function inline(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function renderMemory(memory: Memory, includeDetails: boolean): string {
	const metadata = [
		`## ${memory.id} — ${inline(memory.title)}`,
		`Updated: ${memory.updated}`,
		`Tags: ${memory.tags.length > 0 ? memory.tags.map(inline).join(", ") : "(none)"}`,
		`Cue: ${inline(memory.cue)}`,
	];
	if (includeDetails) metadata.push("", memory.body);
	return metadata.join("\n");
}

function structuredMemory(memory: Memory, includeDetails: boolean): Omit<Memory, "body"> & { body?: string } {
	const summary = {
		id: memory.id,
		title: memory.title,
		updated: memory.updated,
		tags: [...memory.tags],
		cue: memory.cue,
	};
	return includeDetails ? { ...summary, body: memory.body } : summary;
}

export default function setup(pi: ExtensionAPI): void {
	const storageDirectory = join(getAgentDir(), "pi-memory");

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Create, update, or delete a durable memory shared across Pi sessions. Use recall first when an existing memory id is needed. IDs are generated on create and never change. Storage is capped at an estimated 4,000 tokens per rendered file.",
		promptSnippet: "Create, update, or delete durable memories across Pi sessions",
		promptGuidelines: [
			"Use remember only for durable facts, preferences, decisions, or reusable context that should survive across Pi sessions.",
			"Use recall before remember update or delete to obtain the immutable memory id.",
		],
		parameters: RememberParams,
		async execute(_toolCallId, params) {
			const result = await mutateMemoryStore(storageDirectory, toMutation(params));
			const subject = result.memory ?? result.deleted;
			const verb = params.action === "create" ? "Created" : params.action === "update" ? "Updated" : "Deleted";
			return {
				content: [{ type: "text", text: `${verb} memory ${subject?.id}.` }],
				details: {
					action: params.action,
					memory: subject,
					tokens: result.tokens,
				},
			};
		},
	});

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search durable memories by exact id/title or case-insensitive word overlap across title, tags, and cue. Exact matches rank first, then overlap and recency. An empty query returns the most recently updated memories.",
		promptSnippet: "Search durable memories from prior Pi sessions",
		promptGuidelines: ["Use recall when prior-session facts, preferences, decisions, or reusable context may help."],
		parameters: RecallParams,
		async execute(_toolCallId, params) {
			const includeDetails = params.includeDetails ?? true;
			const matches = await recallMemoryStore(storageDirectory, params.query, params.limit ?? 5);
			return {
				content: [
					{
						type: "text",
						text:
							matches.length === 0
								? "No memories found."
								: matches.map((memory) => renderMemory(memory, includeDetails)).join("\n\n"),
					},
				],
				details: { matches: matches.map((memory) => structuredMemory(memory, includeDetails)) },
			};
		},
	});
}
