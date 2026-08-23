import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MemoryError, type MemoryOperation } from "./errors.js";
import { storeLockPath, withDirLock, type DirLockHandle, type DirLockOptions } from "./lock.js";
import {
	assertCanonicalContainmentRoot,
	assertContainedRegularPath,
	type StoreContainment,
} from "./paths.js";

export const MEMORY_TOKEN_LIMIT = 4_000;
export const MEMORY_ID_PATTERN = /^m_[a-z2-7]{10}$/;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DETAILS_FILE = "details.md";
const INDEX_FILE = "index.md";
const ID_GENERATION_ATTEMPTS = 32;
const TRANSIENT_RENAME_MS = 1_000;

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

export type MemoryGeneration = `sha256:${string}`;

export interface MutationWarning {
	code: "INDEX_REPAIR_NEEDED" | "OVER_CAP_REMAINS" | "LOCK_UNSAFE";
	message: string;
}

/**
 * 26.8.0-compatible mutation result shape. Kept exactly as released so
 * downstream object literals and mocks written against 26.8.0 still compile;
 * hardened mutations return the extending HardenedMutationResult.
 */
export interface MutationResult {
	memories: Memory[];
	memory?: Memory;
	deleted?: Memory;
	tokens: {
		details: number;
		index: number;
	};
}

/** Result of a hardened mutation; extends the 26.8.0 MutationResult shape. */
export interface HardenedMutationResult extends MutationResult {
	generation: MemoryGeneration;
	warnings: MutationWarning[];
}

export type IndexState = "current" | "missing" | "stale" | "malformed";

export interface MemorySnapshot {
	memories: Memory[];
	/**
	 * Exact authoritative content of details.md ("" when absent), decoded with
	 * fatal UTF-8 validation: invalid bytes are STORE_CORRUPT, never replaced,
	 * so this string re-encodes byte-for-byte to the on-disk file.
	 */
	detailsMarkdown: string;
	/** Index bytes derived in memory from the parsed details, never from disk. */
	indexMarkdown: string;
	/** sha256 of the raw on-disk details.md bytes (of "" when absent). */
	generation: MemoryGeneration;
	indexState: IndexState;
	tokens: {
		details: number;
		index: number;
	};
}

/** Named seams for deterministic fault-injection tests; unused in production. */
export type MutationCheckpoint =
	| "before-details-temp-open"
	| "after-temps-synced"
	| "before-details-rename"
	| "after-details-rename"
	| "before-index-rename";

export interface MutationHooks {
	checkpoint?: (name: MutationCheckpoint) => void | Promise<void>;
	/** Overrides the two commit renames (details, then index). */
	renameFile?: (from: string, to: string) => Promise<void>;
}

/**
 * Runs inside the store lock, after acquisition and before the authoritative
 * snapshot read and any temp/commit work. Project wiring uses it to verify or
 * initialize project.json under the same lock as the first details.md commit,
 * without lock reentry. A thrown error fails the operation before any commit.
 */
export interface StoreGuardContext {
	/** Canonical store directory whose lock is held. */
	directory: string;
	/** The held lock handle; use isOwned/assertOwned, never release it. */
	lock: DirLockHandle;
	operation: MemoryOperation;
	signal?: AbortSignal;
}

export type StoreGuard = (context: StoreGuardContext) => void | Promise<void>;

export interface MutateMemoryStoreOptions {
	now?: string;
	idFactory?: () => string;
	signal?: AbortSignal;
	/**
	 * lock.onReleaseFailure is owned by the mutation itself: a release failure
	 * after the details commit is reported as a LOCK_UNSAFE warning on the
	 * successful result, never as a failed mutation.
	 */
	lock?: DirLockOptions;
	hooks?: MutationHooks;
	/** Canonical containment contract; see StoreContainment in paths.ts. */
	containment?: StoreContainment;
	guard?: StoreGuard;
}

export interface RepairMemoryIndexOptions {
	signal?: AbortSignal;
	lock?: DirLockOptions;
	containment?: StoreContainment;
	guard?: StoreGuard;
}

export interface ReadMemorySnapshotOptions {
	containment?: StoreContainment;
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

// ---------------------------------------------------------------------------
// Hardened storage layer: in-process queue + cross-process lock + details-first
// commit. details.md is the sole authority; index.md is derived and repairable.
// ---------------------------------------------------------------------------

function errnoCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return String((error as NodeJS.ErrnoException).code);
}

function isTransientErrno(error: unknown): boolean {
	const code = errnoCode(error);
	return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function sha256GenerationOfBytes(content: Uint8Array): MemoryGeneration {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function sha256Generation(content: string): MemoryGeneration {
	return sha256GenerationOfBytes(Buffer.from(content, "utf8"));
}

const EMPTY_BYTES = Buffer.alloc(0);

// Fatal decoder: invalid byte sequences throw instead of becoming U+FFFD, and
// a BOM is preserved (and then rejected by the parser) rather than stripped,
// so a decoded string always re-encodes to the exact authoritative bytes.
const authoritativeUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// In-process FIFO queue keyed on the canonical details.md path. This serializes
// every mutating/repairing call inside one process before the interprocess lock
// is attempted; callers never wrap store calls in their own queue.
const fileMutationQueues = new Map<string, Promise<unknown>>();

async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = resolve(filePath);
	const previous = fileMutationQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const tail = previous.then(() => gate);
	fileMutationQueues.set(key, tail);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (fileMutationQueues.get(key) === tail) fileMutationQueues.delete(key);
	}
}

/** Raw authoritative bytes; only a confirmed ENOENT reads as absent. */
async function readOptionalBytes(path: string): Promise<Buffer | undefined> {
	try {
		return await readFile(path);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * realpath the store directory; undefined when it does not exist. Creates
 * nothing. With a containment contract, the directory is instead resolved
 * lexically and the whole root→store chain is proven symlink-free, so a
 * symlinked store or intermediate is rejected rather than silently followed.
 * Without one, the legacy string API only canonicalizes the caller's path —
 * it makes no claim that the path lives under any particular agent root.
 */
async function resolveExistingDirectory(
	directory: string,
	operation: MemoryOperation,
	containment?: StoreContainment,
): Promise<string | undefined> {
	if (containment !== undefined) {
		await assertCanonicalContainmentRoot(containment.root, operation);
		const target = resolve(directory);
		// Reject existing symlinks anywhere on the chain before trusting lstat
		// of the store itself (a dangling symlinked component must fail closed,
		// not read as an absent store).
		await assertContainedRegularPath(containment.root, target, "directory", operation);
		try {
			await lstat(target);
		} catch (error) {
			const code = errnoCode(error);
			if (code === "ENOENT") return undefined;
			if (code === "ENOTDIR") {
				throw new MemoryError("PATH_UNSAFE", `store path is not a directory: ${directory}`, {
					operation,
					path: directory,
				});
			}
			throw new MemoryError("IO", `cannot resolve store directory: ${directory}`, {
				operation,
				path: directory,
				cause: error,
			});
		}
		return target;
	}

	let canonical: string;
	try {
		canonical = await realpath(directory);
	} catch (error) {
		const code = errnoCode(error);
		if (code === "ENOENT") return undefined;
		if (code === "ENOTDIR") {
			throw new MemoryError("PATH_UNSAFE", `store path is not a directory: ${directory}`, {
				operation,
				path: directory,
			});
		}
		throw new MemoryError("IO", `cannot resolve store directory: ${directory}`, {
			operation,
			path: directory,
			cause: error,
		});
	}
	const stats = await lstat(canonical).catch(() => undefined);
	if (stats === undefined || !stats.isDirectory()) {
		throw new MemoryError("PATH_UNSAFE", `store path is not a directory: ${directory}`, {
			operation,
			path: directory,
		});
	}
	return canonical;
}

/** Create-if-absent variant for mutations; an empty store directory is benign. */
async function ensureStoreDirectory(directory: string, containment?: StoreContainment): Promise<string> {
	if (containment !== undefined) {
		await assertCanonicalContainmentRoot(containment.root, "mutate");
		const target = resolve(directory);
		// Before creation: reject a symlinked root/store/intermediate instead of
		// recursively creating through (or realpath-following) it.
		await assertContainedRegularPath(containment.root, target, "directory", "mutate");
		try {
			await mkdir(target, { recursive: true, mode: 0o700 });
		} catch (error) {
			const code = errnoCode(error);
			if (code === "EEXIST" || code === "ENOTDIR") {
				throw new MemoryError("PATH_UNSAFE", `store path is not a directory: ${directory}`, {
					operation: "mutate",
					path: directory,
				});
			}
			throw new MemoryError("IO", `cannot create store directory: ${directory}`, {
				operation: "mutate",
				path: directory,
				cause: error,
			});
		}
		// After creation every component exists; prove the chain is still real
		// directories all the way down before any lock or temp is created.
		await assertContainedRegularPath(containment.root, target, "directory", "mutate");
		return target;
	}

	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
	} catch (error) {
		const code = errnoCode(error);
		if (code === "EEXIST" || code === "ENOTDIR") {
			throw new MemoryError("PATH_UNSAFE", `store path is not a directory: ${directory}`, {
				operation: "mutate",
				path: directory,
			});
		}
		throw new MemoryError("IO", `cannot create store directory: ${directory}`, {
			operation: "mutate",
			path: directory,
			cause: error,
		});
	}
	const canonical = await resolveExistingDirectory(directory, "mutate");
	if (canonical === undefined) {
		throw new MemoryError("IO", `store directory disappeared: ${directory}`, {
			operation: "mutate",
			path: directory,
		});
	}
	return canonical;
}

function findDuplicateId(memories: readonly Memory[]): string | undefined {
	const seen = new Set<string>();
	for (const memory of memories) {
		if (seen.has(memory.id)) return memory.id;
		seen.add(memory.id);
	}
	return undefined;
}

function classifyIndexState(diskIndexBytes: Buffer | undefined, derivedIndex: string): IndexState {
	if (diskIndexBytes === undefined) return derivedIndex === "" ? "current" : "missing";
	let diskIndex: string;
	try {
		// The index is derived, never authoritative: invalid UTF-8 here is
		// malformed-and-repairable, not store corruption.
		diskIndex = authoritativeUtf8.decode(diskIndexBytes);
	} catch {
		return "malformed";
	}
	if (diskIndex === derivedIndex) return "current";
	try {
		parseIndex(diskIndex);
		return "stale";
	} catch {
		return "malformed";
	}
}

function emptySnapshot(): MemorySnapshot {
	return {
		memories: [],
		detailsMarkdown: "",
		indexMarkdown: "",
		generation: sha256Generation(""),
		indexState: "current",
		tokens: { details: 0, index: 0 },
	};
}

/** Package-internal unlocked read shared by snapshot, repair, and mutation. */
async function readSnapshotUnlocked(
	canonicalDirectory: string,
	operation: MemoryOperation,
	containmentRoot?: string,
): Promise<MemorySnapshot> {
	const assertRoot = containmentRoot ?? canonicalDirectory;
	const detailsPath = join(canonicalDirectory, DETAILS_FILE);
	const indexPath = join(canonicalDirectory, INDEX_FILE);
	await assertContainedRegularPath(assertRoot, detailsPath, "file", operation);
	await assertContainedRegularPath(assertRoot, indexPath, "file", operation);

	const rawDetailsBytes = await readOptionalBytes(detailsPath);
	const rawIndexBytes = await readOptionalBytes(indexPath);
	if (rawDetailsBytes === undefined && rawIndexBytes !== undefined && rawIndexBytes.length > 0) {
		throw new MemoryError("STORE_CORRUPT", `index.md exists without details.md in ${canonicalDirectory}`, {
			operation,
			path: indexPath,
		});
	}

	// details.md is authoritative: decode fatally so invalid bytes fail closed
	// instead of being replaced with U+FFFD and destroyed by the next commit.
	let detailsMarkdown: string;
	try {
		detailsMarkdown = rawDetailsBytes === undefined ? "" : authoritativeUtf8.decode(rawDetailsBytes);
	} catch (error) {
		throw new MemoryError("STORE_CORRUPT", `details.md contains invalid UTF-8: ${detailsPath}`, {
			operation,
			path: detailsPath,
			cause: error,
		});
	}
	let memories: Memory[];
	try {
		memories = parseDetails(detailsMarkdown);
	} catch (error) {
		throw new MemoryError("STORE_CORRUPT", error instanceof Error ? error.message : String(error), {
			operation,
			path: detailsPath,
			cause: error,
		});
	}
	const duplicate = findDuplicateId(memories);
	if (duplicate !== undefined) {
		throw new MemoryError("DUPLICATE_ID", `details.md contains duplicate memory id ${duplicate}`, {
			operation,
			path: detailsPath,
		});
	}

	const indexMarkdown = serializeIndex(memories);
	return {
		memories,
		detailsMarkdown,
		indexMarkdown,
		// The generation identifies the actual on-disk bytes, not a re-encoding.
		generation: sha256GenerationOfBytes(rawDetailsBytes ?? EMPTY_BYTES),
		indexState: classifyIndexState(rawIndexBytes, indexMarkdown),
		tokens: { details: estimateTokens(detailsMarkdown), index: estimateTokens(indexMarkdown) },
	};
}

/**
 * Strictly read-only snapshot of a store. Never creates directories or files,
 * never takes the lock, and works in a read-only directory. An absent store
 * reads as empty; an index without details fails closed as STORE_CORRUPT, as
 * does invalid UTF-8 in details.md.
 */
export async function readMemorySnapshot(
	directory: string,
	options: ReadMemorySnapshotOptions = {},
): Promise<MemorySnapshot> {
	const canonical = await resolveExistingDirectory(directory, "read", options.containment);
	if (canonical === undefined) return emptySnapshot();
	return readSnapshotUnlocked(canonical, "read", options.containment?.root);
}

async function writeExclusiveSynced(path: string, content: string, operation: MemoryOperation): Promise<void> {
	try {
		const handle = await open(path, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof MemoryError) throw error;
		throw new MemoryError("IO", `cannot prepare transaction temp file: ${path}`, {
			operation,
			path,
			cause: error,
		});
	}
}

async function renameWithTransientRetry(
	renameFile: (from: string, to: string) => Promise<void>,
	from: string,
	to: string,
	timing: { now: () => number; sleep: (ms: number) => Promise<void> },
	signal?: AbortSignal,
): Promise<void> {
	const deadline = timing.now() + TRANSIENT_RENAME_MS;
	for (;;) {
		try {
			await renameFile(from, to);
			return;
		} catch (error) {
			// Once a rename has been attempted, an abort stops the retries but
			// rethrows the filesystem error so the caller classifies the actual
			// on-disk state instead of blindly reporting an abort.
			if (!isTransientErrno(error) || timing.now() >= deadline || signal?.aborted) throw error;
			await timing.sleep(25);
			if (signal?.aborted) throw error;
		}
	}
}

function transactionTiming(lock: DirLockOptions | undefined): {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
} {
	const now = lock?.monotonicNow ?? (() => performance.now());
	const sleep =
		lock?.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
	return { now, sleep: (ms) => sleep(ms) };
}

function throwIfAborted(signal: AbortSignal | undefined, operation: MemoryOperation, path: string): void {
	if (signal?.aborted) {
		throw new MemoryError("BUSY", `${operation} aborted before commit`, {
			operation,
			path,
			retryable: true,
		});
	}
}

function selectCreateId(existing: ReadonlySet<string>, idFactory: () => string): string {
	for (let attempt = 0; attempt < ID_GENERATION_ATTEMPTS; attempt += 1) {
		const candidate = idFactory();
		if (MEMORY_ID_PATTERN.test(candidate) && !existing.has(candidate)) return candidate;
	}
	throw new MemoryError(
		"ID_EXHAUSTED",
		`${ID_GENERATION_ATTEMPTS} generated memory id candidates collided or were invalid`,
		{ operation: "mutate" },
	);
}

function validateMutationTarget(mutation: MemoryMutation, memories: readonly Memory[], detailsPath: string): void {
	if (mutation.action === "create") return;
	if (!MEMORY_ID_PATTERN.test(mutation.id)) {
		throw new MemoryError("INVALID_ARGUMENT", `Invalid memory id: ${mutation.id}`, {
			operation: "mutate",
			path: detailsPath,
		});
	}
	if (!memories.some((memory) => memory.id === mutation.id)) {
		throw new MemoryError("NOT_FOUND", `Memory not found: ${mutation.id}`, {
			operation: "mutate",
			path: detailsPath,
		});
	}
	if (
		mutation.action === "update" &&
		mutation.title === undefined &&
		mutation.cue === undefined &&
		mutation.body === undefined &&
		mutation.tags === undefined
	) {
		throw new MemoryError("INVALID_ARGUMENT", "Update requires at least one of title, cue, body, or tags", {
			operation: "mutate",
			path: detailsPath,
		});
	}
}

function enforceCaps(
	mutation: MemoryMutation,
	current: readonly Memory[],
	currentDetails: string,
	currentIndex: string,
	projected: readonly Memory[],
	projectedDetails: string,
	projectedIndex: string,
	detailsPath: string,
): MutationWarning[] {
	if (
		estimateTokens(projectedDetails) <= MEMORY_TOKEN_LIMIT &&
		estimateTokens(projectedIndex) <= MEMORY_TOKEN_LIMIT
	) {
		return [];
	}

	// Over-cap recovery: a delete is always allowed; an update is allowed only
	// when neither rendered file grows and at least one shrinks.
	const detailsDelta = Buffer.byteLength(projectedDetails, "utf8") - Buffer.byteLength(currentDetails, "utf8");
	const indexDelta = Buffer.byteLength(projectedIndex, "utf8") - Buffer.byteLength(currentIndex, "utf8");
	const monotonicShrink = detailsDelta <= 0 && indexDelta <= 0 && (detailsDelta < 0 || indexDelta < 0);
	const allowed = mutation.action === "delete" || (mutation.action === "update" && monotonicShrink);
	if (!allowed) {
		try {
			assertWithinTokenCaps(current, projected);
		} catch (error) {
			throw new MemoryError("CAP_EXCEEDED", error instanceof Error ? error.message : String(error), {
				operation: "mutate",
				path: detailsPath,
				cause: error,
			});
		}
	}
	return [
		{
			code: "OVER_CAP_REMAINS",
			message: `store remains over the ${MEMORY_TOKEN_LIMIT}-token cap after this recovery mutation; keep deleting or consolidating`,
		},
	];
}

async function performMutation(
	canonicalDirectory: string,
	mutation: MemoryMutation,
	options: MutateMemoryStoreOptions,
	lock: DirLockHandle,
): Promise<HardenedMutationResult> {
	const assertRoot = options.containment?.root ?? canonicalDirectory;
	const detailsPath = join(canonicalDirectory, DETAILS_FILE);
	const indexPath = join(canonicalDirectory, INDEX_FILE);
	const timing = transactionTiming(options.lock);
	const checkpoint = async (name: MutationCheckpoint): Promise<void> => {
		await options.hooks?.checkpoint?.(name);
	};
	const renameFile = options.hooks?.renameFile ?? ((from: string, to: string) => rename(from, to));

	throwIfAborted(options.signal, "mutate", detailsPath);

	// Under-lock guard: project wiring verifies/initializes project.json here,
	// before the snapshot read and any temp or commit work, with no reentry.
	if (options.guard !== undefined) {
		await options.guard({
			directory: canonicalDirectory,
			lock,
			operation: "mutate",
			...(options.signal !== undefined ? { signal: options.signal } : {}),
		});
		throwIfAborted(options.signal, "mutate", detailsPath);
	}

	// Re-read the authoritative file under the lock (lost-update fix).
	const before = await readSnapshotUnlocked(canonicalDirectory, "mutate", options.containment?.root);
	validateMutationTarget(mutation, before.memories, detailsPath);

	const now = options.now ?? new Date().toISOString();
	if (!Number.isFinite(Date.parse(now))) {
		throw new MemoryError("INVALID_ARGUMENT", `Invalid Updated timestamp for memory mutation: ${now}`, {
			operation: "mutate",
			path: detailsPath,
		});
	}

	let applied: Omit<MutationResult, "tokens">;
	if (mutation.action === "create") {
		const existingIds = new Set(before.memories.map((memory) => memory.id));
		const chosenId = selectCreateId(existingIds, options.idFactory ?? generateMemoryId);
		applied = applyMemoryMutation(before.memories, mutation, now, () => chosenId);
	} else {
		applied = applyMemoryMutation(before.memories, mutation, now);
	}

	const nextDetails = serializeDetails(applied.memories);
	const nextIndex = serializeIndex(applied.memories);
	const warnings = enforceCaps(
		mutation,
		before.memories,
		serializeDetails(before.memories),
		serializeIndex(before.memories),
		applied.memories,
		nextDetails,
		nextIndex,
		detailsPath,
	);
	const oldGeneration = before.generation;
	const newGeneration = sha256Generation(nextDetails);

	const transactionToken = randomBytes(16).toString("hex");
	const detailsTemp = join(canonicalDirectory, `.${DETAILS_FILE}.${process.pid}.${transactionToken}.tmp`);
	const indexTemp = join(canonicalDirectory, `.${INDEX_FILE}.${process.pid}.${transactionToken}.tmp`);

	try {
		await checkpoint("before-details-temp-open");
		await writeExclusiveSynced(detailsTemp, nextDetails, "mutate");
		await writeExclusiveSynced(indexTemp, nextIndex, "mutate");
		await checkpoint("after-temps-synced");

		// Revalidate the whole containment chain plus rename source and
		// destination, and ownership, immediately before the commit point.
		await assertContainedRegularPath(assertRoot, detailsPath, "file", "mutate");
		await assertContainedRegularPath(assertRoot, detailsTemp, "file", "mutate");
		throwIfAborted(options.signal, "mutate", detailsPath);
		await lock.assertOwned();
		await checkpoint("before-details-rename");

		try {
			// SOLE COMMIT POINT: a resolved details rename commits the mutation.
			await renameWithTransientRetry(renameFile, detailsTemp, detailsPath, timing, options.signal);
		} catch (renameError) {
			// Evidence-based classification: only raw bytes proven present (or a
			// confirmed ENOENT) may claim the old or new state. Any other
			// verification-read failure is an unknown commit state, never a
			// false "still old" or false "committed".
			let observedBytes: Buffer | undefined;
			try {
				observedBytes = await readOptionalBytes(detailsPath);
			} catch (verificationError) {
				throw new MemoryError(
					"COMMIT_STATE_UNKNOWN",
					`details.md rename failed and the on-disk state could not be verified: ${detailsPath}`,
					{ operation: "mutate", path: detailsPath, retryable: false, committed: "unknown", cause: verificationError },
				);
			}
			const observed = sha256GenerationOfBytes(observedBytes ?? EMPTY_BYTES);
			if (observed !== newGeneration) {
				if (observed === oldGeneration) {
					throw new MemoryError("IO", `details.md commit rename failed: ${detailsPath}`, {
						operation: "mutate",
						path: detailsPath,
						retryable: true,
						committed: false,
						cause: renameError,
					});
				}
				throw new MemoryError(
					"COMMIT_STATE_UNKNOWN",
					`details.md rename failed and the on-disk generation matches neither old nor new state: ${detailsPath}`,
					{ operation: "mutate", path: detailsPath, retryable: false, committed: "unknown", cause: renameError },
				);
			}
			// The rename reported failure but the new generation is on disk: committed.
		}

		// details.md is committed; nothing past this point may fail the mutation.
		try {
			await checkpoint("after-details-rename");
			if (await lock.isOwned()) {
				await assertContainedRegularPath(assertRoot, indexPath, "file", "mutate");
				await assertContainedRegularPath(assertRoot, indexTemp, "file", "mutate");
				await checkpoint("before-index-rename");
				await renameWithTransientRetry(renameFile, indexTemp, indexPath, timing, options.signal);
			} else {
				warnings.push({
					code: "LOCK_UNSAFE",
					message: `lock ownership was lost after the details commit; the foreign lock was left untouched`,
				});
				warnings.push({
					code: "INDEX_REPAIR_NEEDED",
					message: `index.md was not updated; readers derive it from details.md until a locked repair converges it`,
				});
			}
		} catch (indexError) {
			warnings.push({
				code: "INDEX_REPAIR_NEEDED",
				message: `index.md update failed after the details commit (${
					indexError instanceof Error ? indexError.message : String(indexError)
				}); readers derive it from details.md until a locked repair converges it`,
			});
		}

		return {
			memories: applied.memories,
			...(applied.memory !== undefined ? { memory: applied.memory } : {}),
			...(applied.deleted !== undefined ? { deleted: applied.deleted } : {}),
			tokens: { details: estimateTokens(nextDetails), index: estimateTokens(nextIndex) },
			generation: newGeneration,
			warnings,
		};
	} finally {
		// Clean only this transaction's temps; renamed temps are gone already.
		await rm(detailsTemp, { force: true }).catch(() => undefined);
		await rm(indexTemp, { force: true }).catch(() => undefined);
	}
}

function mergedLockOptions(options: { signal?: AbortSignal; lock?: DirLockOptions }): DirLockOptions {
	return { ...options.lock, signal: options.lock?.signal ?? options.signal };
}

/**
 * Apply one mutation transactionally. Serialized internally through the
 * in-process queue and the cross-process store lock — callers never wrap this
 * in their own queue or lock. The store directory is created when absent.
 *
 * A lock-release failure after the details commit never fails the mutation
 * (the caller must not retry a committed create); it is reported as a
 * LOCK_UNSAFE warning on the successful result instead.
 */
export async function mutateMemoryStore(
	directory: string,
	mutation: MemoryMutation,
	options: MutateMemoryStoreOptions = {},
): Promise<HardenedMutationResult> {
	const canonical = await ensureStoreDirectory(directory, options.containment);
	if (options.containment !== undefined) {
		// Reject a symlinked lock path before withDirLock creates it.
		await assertContainedRegularPath(options.containment.root, storeLockPath(canonical), "directory", "mutate");
	}
	const detailsPath = join(canonical, DETAILS_FILE);
	return withFileMutationQueue(detailsPath, async () => {
		let releaseFailure: MemoryError | undefined;
		const result = await withDirLock(
			storeLockPath(canonical),
			(lock) => performMutation(canonical, mutation, options, lock),
			{
				...mergedLockOptions(options),
				onReleaseFailure: (failure) => {
					releaseFailure = failure;
				},
			},
		);
		if (releaseFailure !== undefined && !result.warnings.some((warning) => warning.code === "LOCK_UNSAFE")) {
			result.warnings.push({
				code: "LOCK_UNSAFE",
				message: `store lock release failed after the committed mutation (${releaseFailure.message}); later operations on this store may time out BUSY until the lock is recovered`,
			});
		}
		return result;
	});
}

/**
 * Rewrite index.md from the authoritative details.md, under the queue and the
 * store lock. An absent store stays absent; an orphan index fails closed. A
 * lock-release failure surfaces as LOCK_UNSAFE (repair is idempotent).
 */
export async function repairMemoryIndex(
	directory: string,
	options: RepairMemoryIndexOptions = {},
): Promise<MemorySnapshot> {
	const canonical = await resolveExistingDirectory(directory, "repair", options.containment);
	if (canonical === undefined) return emptySnapshot();
	const assertRoot = options.containment?.root ?? canonical;
	if (options.containment !== undefined) {
		await assertContainedRegularPath(options.containment.root, storeLockPath(canonical), "directory", "repair");
	}
	const detailsPath = join(canonical, DETAILS_FILE);
	return withFileMutationQueue(detailsPath, () =>
		withDirLock(
			storeLockPath(canonical),
			async (lock) => {
				if (options.guard !== undefined) {
					await options.guard({
						directory: canonical,
						lock,
						operation: "repair",
						...(options.signal !== undefined ? { signal: options.signal } : {}),
					});
				}
				const snapshot = await readSnapshotUnlocked(canonical, "repair", options.containment?.root);
				if (snapshot.indexState === "current") return snapshot;
				const indexPath = join(canonical, INDEX_FILE);
				const indexTemp = join(canonical, `.${INDEX_FILE}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
				try {
					await writeExclusiveSynced(indexTemp, snapshot.indexMarkdown, "repair");
					await assertContainedRegularPath(assertRoot, indexPath, "file", "repair");
					await assertContainedRegularPath(assertRoot, indexTemp, "file", "repair");
					await lock.assertOwned();
					try {
						await rename(indexTemp, indexPath);
					} catch (error) {
						throw new MemoryError("IO", `cannot repair index.md: ${indexPath}`, {
							operation: "repair",
							path: indexPath,
							cause: error,
						});
					}
				} finally {
					await rm(indexTemp, { force: true }).catch(() => undefined);
				}
				return { ...snapshot, indexState: "current" as const };
			},
			mergedLockOptions(options),
		),
	);
}

/**
 * Compatibility loader: reads the store and, when the on-disk index is not
 * current, performs an explicit locked repair. New read paths (recall, catalog)
 * use readMemorySnapshot instead and never write.
 */
export async function loadMemoryStore(directory: string): Promise<Memory[]> {
	const snapshot = await readMemorySnapshot(directory);
	if (snapshot.indexState === "current") return snapshot.memories;
	return (await repairMemoryIndex(directory)).memories;
}

export async function recallMemoryStore(directory: string, query: string, limit = 5): Promise<Memory[]> {
	const snapshot = await readMemorySnapshot(directory);
	return searchMemories(snapshot.memories, query, limit);
}
