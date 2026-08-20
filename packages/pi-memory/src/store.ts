import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const MEMORY_TOKEN_LIMIT = 4_000;
export const MEMORY_ID_PATTERN = /^m_[a-z2-7]{10}$/;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DETAILS_FILE = "details.md";
const INDEX_FILE = "index.md";

export interface Memory {
	id: string;
	title: string;
	updated: string;
	tags: string[];
	cue: string;
	body: string;
}

export interface IndexEntry {
	id: string;
	title: string;
	tags: string[];
	cue: string;
	updated: string;
}

export type MemoryMutation =
	| { action: "create"; title: string; cue: string; body: string; tags?: string[] }
	| { action: "update"; id: string; title?: string; cue?: string; body?: string; tags?: string[] }
	| { action: "delete"; id: string };

export interface MutationResult {
	memories: Memory[];
	memory?: Memory;
	deleted?: Memory;
	tokens: {
		details: number;
		index: number;
	};
}

function escapeInline(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function unescapeInline(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character !== "\\" || index === value.length - 1) {
			result += character;
			continue;
		}
		const escaped = value[(index += 1)];
		result += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped;
	}
	return result;
}

function splitEscaped(value: string, delimiter: string): string[] {
	const parts: string[] = [];
	let current = "";
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === "\\" && index < value.length - 1) {
			current += character + value[(index += 1)];
		} else if (character === delimiter) {
			parts.push(current);
			current = "";
		} else {
			current += character;
		}
	}
	parts.push(current);
	return parts;
}

function serializeTags(tags: readonly string[]): string {
	return tags.map((tag) => escapeInline(tag).replaceAll(",", "\\,")).join(", ");
}

function parseTags(value: string): string[] {
	if (value === "") return [];
	return splitEscaped(value, ",").map((tag, index) =>
		unescapeInline(index > 0 && tag.startsWith(" ") ? tag.slice(1) : tag),
	);
}

function escapeBody(body: string): string {
	return body
		.split("\n")
		.map((line) => (/^\\*## m_[a-z2-7]{10} — /.test(line) ? `\\${line}` : line))
		.join("\n");
}

function unescapeBody(body: string): string {
	return body
		.split("\n")
		.map((line) => (/^\\+## m_[a-z2-7]{10} — /.test(line) ? line.slice(1) : line))
		.join("\n");
}

function assertTimestamp(value: string, id: string): void {
	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`Invalid Updated timestamp for memory ${id}: ${value}`);
	}
}

function assertMemory(memory: Memory): void {
	if (!MEMORY_ID_PATTERN.test(memory.id)) throw new Error(`Invalid memory id: ${memory.id}`);
	assertTimestamp(memory.updated, memory.id);
}

function serializeSection(memory: Memory): string {
	assertMemory(memory);
	return [
		`## ${memory.id} — ${escapeInline(memory.title)}`,
		`Updated: ${memory.updated}`,
		`Tags: ${serializeTags(memory.tags)}`,
		`Cue: ${escapeInline(memory.cue)}`,
		"",
		escapeBody(memory.body),
	].join("\n");
}

export function serializeDetails(memories: readonly Memory[]): string {
	if (memories.length === 0) return "";
	return `${memories.map(serializeSection).join("\n\n")}\n`;
}

export function parseDetails(markdown: string): Memory[] {
	if (markdown.trim() === "") return [];

	const headings = [...markdown.matchAll(/^## (m_[a-z2-7]{10}) — (.*)$/gm)];
	if (headings.length === 0 || markdown.slice(0, headings[0].index).trim() !== "") {
		throw new Error("details.md is unparseable: expected a memory section heading");
	}

	return headings.map((heading, index) => {
		const id = heading[1];
		const nextHeading = headings[index + 1];
		let section = markdown.slice((heading.index ?? 0) + heading[0].length, nextHeading?.index ?? markdown.length);
		if (section.startsWith("\n")) section = section.slice(1);
		if (nextHeading && section.endsWith("\n\n")) section = section.slice(0, -2);
		else if (!nextHeading && section.endsWith("\n")) section = section.slice(0, -1);

		const lines = section.split("\n");
		if (
			!lines[0]?.startsWith("Updated: ") ||
			!lines[1]?.startsWith("Tags: ") ||
			!lines[2]?.startsWith("Cue: ") ||
			lines[3] !== ""
		) {
			throw new Error(`details.md is unparseable: invalid metadata for memory ${id}`);
		}

		const memory: Memory = {
			id,
			title: unescapeInline(heading[2]),
			updated: lines[0].slice("Updated: ".length),
			tags: parseTags(lines[1].slice("Tags: ".length)),
			cue: unescapeInline(lines[2].slice("Cue: ".length)),
			body: unescapeBody(lines.slice(4).join("\n")),
		};
		assertMemory(memory);
		return memory;
	});
}

function escapeIndexField(value: string): string {
	return escapeInline(value).replaceAll("|", "\\|");
}

export function serializeIndex(memories: readonly Memory[]): string {
	if (memories.length === 0) return "";
	return `${memories
		.map((memory) => {
			assertMemory(memory);
			return `\`${memory.id}\` | ${escapeIndexField(memory.title)} | ${serializeTags(memory.tags).replaceAll("|", "\\|")} | ${escapeIndexField(memory.cue)} | ${memory.updated}`;
		})
		.join("\n")}\n`;
}

export function parseIndex(markdown: string): IndexEntry[] {
	if (markdown === "") return [];
	const lines = markdown.endsWith("\n") ? markdown.slice(0, -1).split("\n") : markdown.split("\n");
	return lines.map((line, lineIndex) => {
		const rawFields = splitEscaped(line, "|");
		if (
			rawFields.length !== 5 ||
			!rawFields[0].endsWith(" ") ||
			!rawFields[1].startsWith(" ") ||
			!rawFields[1].endsWith(" ") ||
			!rawFields[2].startsWith(" ") ||
			!rawFields[2].endsWith(" ") ||
			!rawFields[3].startsWith(" ") ||
			!rawFields[3].endsWith(" ") ||
			!rawFields[4].startsWith(" ")
		) {
			throw new Error(`index.md is unparseable at line ${lineIndex + 1}`);
		}
		const fields = [
			rawFields[0].slice(0, -1),
			rawFields[1].slice(1, -1),
			rawFields[2].slice(1, -1),
			rawFields[3].slice(1, -1),
			rawFields[4].slice(1),
		];
		const idMatch = /^`(m_[a-z2-7]{10})`$/.exec(fields[0]);
		if (!idMatch) throw new Error(`index.md is unparseable at line ${lineIndex + 1}`);
		const entry: IndexEntry = {
			id: idMatch[1],
			title: unescapeInline(fields[1]),
			tags: parseTags(fields[2]),
			cue: unescapeInline(fields[3]),
			updated: fields[4],
		};
		assertTimestamp(entry.updated, entry.id);
		return entry;
	});
}

export function estimateTokens(chars: number | string): number {
	return Math.ceil((typeof chars === "string" ? chars.length : chars) / 4);
}

function words(value: string): Set<string> {
	return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

export function searchMemories(memories: readonly Memory[], query: string, limit = 5): Memory[] {
	const boundedLimit = Math.max(1, Math.min(10, Math.trunc(limit) || 5));
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (normalizedQuery === "") {
		return [...memories]
			.sort((left, right) => Date.parse(right.updated) - Date.parse(left.updated) || left.id.localeCompare(right.id))
			.slice(0, boundedLimit);
	}

	const queryWords = words(normalizedQuery);
	return memories
		.map((memory) => {
			const exact = memory.id.toLocaleLowerCase() === normalizedQuery || memory.title.toLocaleLowerCase() === normalizedQuery;
			const searchableWords = words(`${memory.title} ${memory.tags.join(" ")} ${memory.cue}`);
			const overlap = [...queryWords].filter((word) => searchableWords.has(word)).length;
			return { memory, exact, overlap };
		})
		.filter((candidate) => candidate.exact || candidate.overlap > 0)
		.sort(
			(left, right) =>
				Number(right.exact) - Number(left.exact) ||
				right.overlap - left.overlap ||
				Date.parse(right.memory.updated) - Date.parse(left.memory.updated) ||
				left.memory.id.localeCompare(right.memory.id),
		)
		.slice(0, boundedLimit)
		.map((candidate) => candidate.memory);
}

export function generateMemoryId(): string {
	const bytes = randomBytes(10);
	let suffix = "";
	for (const byte of bytes) suffix += BASE32_ALPHABET[byte & 31];
	return `m_${suffix}`;
}

export function applyMemoryMutation(
	memories: readonly Memory[],
	mutation: MemoryMutation,
	now = new Date().toISOString(),
	idFactory: () => string = generateMemoryId,
): Omit<MutationResult, "tokens"> {
	assertTimestamp(now, "mutation");
	const next = memories.map((memory) => ({ ...memory, tags: [...memory.tags] }));

	if (mutation.action === "create") {
		const memory: Memory = {
			id: idFactory(),
			title: mutation.title,
			updated: now,
			tags: [...(mutation.tags ?? [])],
			cue: mutation.cue,
			body: mutation.body,
		};
		assertMemory(memory);
		next.push(memory);
		return { memories: next, memory };
	}

	if (!MEMORY_ID_PATTERN.test(mutation.id)) throw new Error(`Invalid memory id: ${mutation.id}`);
	const memoryIndex = next.findIndex((memory) => memory.id === mutation.id);
	if (memoryIndex === -1) throw new Error(`Memory not found: ${mutation.id}`);

	if (mutation.action === "delete") {
		const [deleted] = next.splice(memoryIndex, 1);
		return { memories: next, deleted };
	}

	if (mutation.title === undefined && mutation.cue === undefined && mutation.body === undefined && mutation.tags === undefined) {
		throw new Error("Update requires at least one of title, cue, body, or tags");
	}
	const current = next[memoryIndex];
	const memory: Memory = {
		...current,
		title: mutation.title ?? current.title,
		cue: mutation.cue ?? current.cue,
		body: mutation.body ?? current.body,
		tags: mutation.tags === undefined ? current.tags : [...mutation.tags],
		updated: now,
	};
	next[memoryIndex] = memory;
	return { memories: next, memory };
}

export function assertWithinTokenCaps(current: readonly Memory[], projected: readonly Memory[]): void {
	const currentDetails = estimateTokens(serializeDetails(current));
	const currentIndex = estimateTokens(serializeIndex(current));
	const projectedDetails = estimateTokens(serializeDetails(projected));
	const projectedIndex = estimateTokens(serializeIndex(projected));
	if (projectedDetails <= MEMORY_TOKEN_LIMIT && projectedIndex <= MEMORY_TOKEN_LIMIT) return;

	const oldest = [...projected]
		.sort((left, right) => Date.parse(left.updated) - Date.parse(right.updated) || left.id.localeCompare(right.id))
		.slice(0, 3)
		.map((memory) => memory.id);
	const largest = [...projected]
		.sort(
			(left, right) =>
				serializeSection(right).length - serializeSection(left).length || left.id.localeCompare(right.id),
		)
		.slice(0, 3)
		.map((memory) => memory.id);

	throw new Error(
		`Memory token cap exceeded (limit ${MEMORY_TOKEN_LIMIT} each): details.md current ${currentDetails}, projected ${projectedDetails}; index.md current ${currentIndex}, projected ${projectedIndex}. Consolidation candidates — oldest: ${oldest.join(", ") || "none"}; largest: ${largest.join(", ") || "none"}.`,
	);
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const suffix = randomBytes(6).toString("hex");
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${suffix}.tmp`);
	try {
		await writeFile(temporaryPath, content, "utf8");
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function readAuthoritativeDetails(directory: string): Promise<Memory[]> {
	const markdown = (await readOptional(join(directory, DETAILS_FILE))) ?? "";
	return parseDetails(markdown);
}

export async function loadMemoryStore(directory: string): Promise<Memory[]> {
	const memories = await readAuthoritativeDetails(directory);
	const expectedIndex = serializeIndex(memories);
	const indexPath = join(directory, INDEX_FILE);
	const currentIndex = await readOptional(indexPath);
	let rebuild = currentIndex === undefined || currentIndex !== expectedIndex;
	if (!rebuild && currentIndex !== undefined) {
		try {
			parseIndex(currentIndex);
		} catch {
			rebuild = true;
		}
	}
	if (rebuild) await atomicWrite(indexPath, expectedIndex);
	return memories;
}

export async function mutateMemoryStore(
	directory: string,
	mutation: MemoryMutation,
	options: { now?: string; idFactory?: () => string } = {},
): Promise<MutationResult> {
	const current = await readAuthoritativeDetails(directory);
	const result = applyMemoryMutation(current, mutation, options.now, options.idFactory);
	assertWithinTokenCaps(current, result.memories);

	const details = serializeDetails(result.memories);
	const index = serializeIndex(result.memories);
	await atomicWrite(join(directory, DETAILS_FILE), details);
	await atomicWrite(join(directory, INDEX_FILE), index);
	return {
		...result,
		tokens: { details: estimateTokens(details), index: estimateTokens(index) },
	};
}

export async function recallMemoryStore(directory: string, query: string, limit = 5): Promise<Memory[]> {
	return searchMemories(await loadMemoryStore(directory), query, limit);
}
