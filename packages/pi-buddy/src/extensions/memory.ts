/**
 * Buddy memory store (phase 3): bounded, durable, inspectable notes the
 * harness injects into consultations. Two scopes — global (about the user)
 * and per-project — living OUTSIDE any repo:
 *
 *   ~/.pi/agent/buddy-memory/
 *     global.md                # about the user
 *     projects/<slug>.md       # per-project facts
 *     archive/<same layout>    # expired/evicted/retracted entries, never deleted
 *     *.bak.<ts>               # pre-mutation snapshots (3 most recent kept)
 *
 * Entry format: one markdown bullet per entry, ISO-date prefixed:
 *   - [2026-07-03] Season intentionally commits directly to main.
 * Non-conforming lines (user hand-edits) are preserved verbatim on rewrite —
 * drift tolerance is a feature, not a bug.
 *
 * All parsing/serialization/eviction logic is pure; MemoryStore is the thin
 * fs wrapper (atomic temp+rename writes, .bak snapshots, advisory mkdir lock
 * with skip-on-contention — a skipped write is a lost lesson, never a
 * corrupted file).
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Per-file character budget (hermes-style char caps, not tokens). */
export const MEMORY_FILE_BUDGET = 2000;
/** Entries older than this move to archive at curation time. */
export const EXPIRY_DAYS = 90;
/** Pre-mutation snapshots kept per file. */
export const MAX_BAKS = 3;
/** Advisory lock is considered stale after this. */
export const LOCK_STALE_MS = 5000;

export type MemoryScope = "global" | "project";

export type MemoryLine =
	| { kind: "entry"; date: string; text: string }
	| { kind: "raw"; line: string };

// --- Pure: slug derivation ---

/** Walk up from cwd to find the enclosing git root, if any. */
export function findGitRoot(
	cwd: string,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (exists(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Slugify an absolute path: /Users/season/x -> Users-season-x */
export function slugifyPath(path: string): string {
	return resolve(path)
		.replace(/^[/\\]+/, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Project slug for a cwd: git root when inside a repo, else cwd itself. */
export function deriveSlug(
	cwd: string,
	exists: (path: string) => boolean = existsSync,
): string {
	return slugifyPath(findGitRoot(cwd, exists) ?? cwd);
}

// --- Pure: parse / serialize ---

const ENTRY_RE = /^- \[(\d{4}-\d{2}-\d{2})\] (.+)$/;

export function parseMemoryFile(content: string): MemoryLine[] {
	const lines: MemoryLine[] = [];
	for (const line of content.split("\n")) {
		const match = ENTRY_RE.exec(line);
		if (match) {
			lines.push({ kind: "entry", date: match[1], text: match[2].trim() });
		} else if (line.trim().length > 0) {
			lines.push({ kind: "raw", line });
		}
	}
	return lines;
}

export function serializeMemory(lines: readonly MemoryLine[]): string {
	if (lines.length === 0) return "";
	return (
		lines
			.map((l) => (l.kind === "entry" ? `- [${l.date}] ${l.text}` : l.line))
			.join("\n") + "\n"
	);
}

export function isoDate(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

// --- Pure: expiry, eviction, append, retract ---

/** Split entries older than EXPIRY_DAYS into `expired`; raw lines are kept. */
export function splitExpired(
	lines: readonly MemoryLine[],
	now: Date = new Date(),
): { kept: MemoryLine[]; expired: MemoryLine[] } {
	const cutoff = new Date(now.getTime() - EXPIRY_DAYS * 24 * 60 * 60 * 1000);
	const cutoffDate = isoDate(cutoff);
	const kept: MemoryLine[] = [];
	const expired: MemoryLine[] = [];
	for (const line of lines) {
		if (line.kind === "entry" && line.date < cutoffDate) expired.push(line);
		else kept.push(line);
	}
	return { kept, expired };
}

/**
 * Evict oldest entries until the serialized file fits the budget. Raw lines
 * (user hand-edits) are never evicted.
 */
export function evictForBudget(
	lines: readonly MemoryLine[],
	budget: number = MEMORY_FILE_BUDGET,
): { kept: MemoryLine[]; evicted: MemoryLine[] } {
	const kept = [...lines];
	const evicted: MemoryLine[] = [];
	while (serializeMemory(kept).length > budget) {
		// Oldest entry = first entry in file order (entries are appended).
		const idx = kept.findIndex((l) => l.kind === "entry");
		if (idx === -1) break; // Only raw lines left; nothing evictable.
		evicted.push(...kept.splice(idx, 1));
	}
	return { kept, evicted };
}

/**
 * True when a new lesson duplicates an existing entry (exact or bidirectional
 * substring match, case-insensitive). Deliberately aggressive: memory is tiny,
 * and dropping a redundant lesson is cheaper than hoarding near-duplicates.
 */
export function isDuplicateLesson(
	lines: readonly MemoryLine[],
	text: string,
): boolean {
	const needle = text.toLowerCase();
	return lines.some(
		(l) =>
			l.kind === "entry" &&
			(l.text.toLowerCase().includes(needle) ||
				needle.includes(l.text.toLowerCase())),
	);
}

/**
 * Remove the MOST RECENTLY ADDED entry containing `text` (case-insensitive).
 * LIFO: the buddy most often retracts what it learned recently.
 */
export function retractEntry(
	lines: readonly MemoryLine[],
	text: string,
): { lines: MemoryLine[]; removed?: MemoryLine } {
	const needle = text.toLowerCase();
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.kind === "entry" && line.text.toLowerCase().includes(needle)) {
			const next = [...lines];
			next.splice(i, 1);
			return { lines: next, removed: line };
		}
	}
	return { lines: [...lines] };
}

// --- Fs wrapper ---

export interface ApplyResult {
	lessons: number;
	retractions: number;
	retractMisses: number;
}

export interface ScopedLesson {
	scope: MemoryScope;
	text: string;
}

export class MemoryStore {
	constructor(
		readonly baseDir: string = join(
			homedir(),
			".pi",
			"agent",
			"buddy-memory",
		),
	) {}

	globalPath(): string {
		return join(this.baseDir, "global.md");
	}

	projectPath(slug: string): string {
		return join(this.baseDir, "projects", `${slug}.md`);
	}

	private archivePathFor(file: string): string {
		const isProject = dirname(file).endsWith("projects");
		return isProject
			? join(this.baseDir, "archive", "projects", basename(file))
			: join(this.baseDir, "archive", basename(file));
	}

	readLines(file: string): MemoryLine[] {
		try {
			return parseMemoryFile(readFileSync(file, "utf8"));
		} catch {
			return [];
		}
	}

	/**
	 * Both scope files rendered for injection; undefined when both are empty.
	 */
	readForInjection(slug: string): string | undefined {
		const globalContent = serializeMemory(this.readLines(this.globalPath()));
		const projectContent = serializeMemory(
			this.readLines(this.projectPath(slug)),
		);
		if (!globalContent && !projectContent) return undefined;
		const sections: string[] = [];
		if (globalContent) sections.push(`## About the user\n${globalContent}`);
		if (projectContent) sections.push(`## About this project\n${projectContent}`);
		return sections.join("\n");
	}

	/**
	 * Expiry pass over both scope files. Returns false when the lock was
	 * contended (pass skipped — retried at the next consultation).
	 */
	curate(slug: string, now: Date = new Date()): boolean {
		if (!this.acquireLock()) return false;
		try {
			for (const file of [this.globalPath(), this.projectPath(slug)]) {
				const lines = this.readLines(file);
				if (lines.length === 0) continue;
				const { kept, expired } = splitExpired(lines, now);
				if (expired.length === 0) continue;
				this.backup(file);
				this.appendToArchive(file, expired);
				this.atomicWrite(file, serializeMemory(kept));
			}
			return true;
		} finally {
			this.releaseLock();
		}
	}

	/**
	 * Apply harvested directives. Lock-guarded read-modify-write; on
	 * contention the whole harvest is skipped (lost lesson > corrupted file).
	 */
	applyDirectives(
		slug: string,
		lessons: readonly ScopedLesson[],
		retractions: readonly string[],
		now: Date = new Date(),
	): ApplyResult {
		const result: ApplyResult = { lessons: 0, retractions: 0, retractMisses: 0 };
		if (lessons.length === 0 && retractions.length === 0) return result;
		if (!this.acquireLock()) return result;
		try {
			const files = {
				global: this.globalPath(),
				project: this.projectPath(slug),
			};
			// Re-read inside the lock (RMW rule).
			const state: Record<MemoryScope, MemoryLine[]> = {
				global: this.readLines(files.global),
				project: this.readLines(files.project),
			};
			const dirty = new Set<MemoryScope>();
			const date = isoDate(now);

			for (const lesson of lessons) {
				if (isDuplicateLesson(state[lesson.scope], lesson.text)) continue;
				state[lesson.scope].push({ kind: "entry", date, text: lesson.text });
				dirty.add(lesson.scope);
				result.lessons += 1;
			}
			// RETRACT: project scope first, then global (LIFO within each).
			for (const text of retractions) {
				let removed = false;
				for (const scope of ["project", "global"] as const) {
					const outcome = retractEntry(state[scope], text);
					if (outcome.removed) {
						state[scope] = outcome.lines;
						this.appendToArchive(files[scope], [outcome.removed]);
						dirty.add(scope);
						result.retractions += 1;
						removed = true;
						break;
					}
				}
				if (!removed) result.retractMisses += 1;
			}

			for (const scope of dirty) {
				const { kept, evicted } = evictForBudget(state[scope]);
				if (evicted.length > 0) this.appendToArchive(files[scope], evicted);
				this.backup(files[scope]);
				this.atomicWrite(files[scope], serializeMemory(kept));
			}
			return result;
		} finally {
			this.releaseLock();
		}
	}

	/** Move a scope file to archive and start fresh. */
	clear(scope: MemoryScope, slug: string): boolean {
		const file =
			scope === "global" ? this.globalPath() : this.projectPath(slug);
		if (!this.acquireLock()) return false;
		try {
			if (!existsSync(file)) return false;
			this.backup(file);
			this.appendToArchive(file, this.readLines(file));
			rmSync(file);
			return true;
		} finally {
			this.releaseLock();
		}
	}

	// --- Internals ---

	private lockDir(): string {
		return join(this.baseDir, ".lock");
	}

	private acquireLock(): boolean {
		const lock = this.lockDir();
		mkdirSync(this.baseDir, { recursive: true });
		try {
			mkdirSync(lock);
			return true;
		} catch {
			// Contended: steal only if stale.
			try {
				const age = Date.now() - statSync(lock).mtimeMs;
				if (age > LOCK_STALE_MS) {
					rmdirSync(lock);
					mkdirSync(lock);
					return true;
				}
			} catch {
				// Raced with the holder's release/steal: skip.
			}
			return false;
		}
	}

	private releaseLock(): void {
		try {
			rmdirSync(this.lockDir());
		} catch {
			// Already released/stolen: nothing to do.
		}
	}

	private atomicWrite(file: string, content: string): void {
		mkdirSync(dirname(file), { recursive: true });
		if (content.length === 0) {
			if (existsSync(file)) rmSync(file);
			return;
		}
		const tmp = `${file}.tmp.${process.pid}`;
		writeFileSync(tmp, content);
		renameSync(tmp, file);
	}

	private backup(file: string): void {
		if (!existsSync(file)) return;
		copyFileSync(file, `${file}.bak.${Date.now()}`);
		// Keep the MAX_BAKS most recent baks for this file.
		const dir = dirname(file);
		const prefix = `${basename(file)}.bak.`;
		const baks = readdirSync(dir)
			.filter((name) => name.startsWith(prefix))
			.sort()
			.reverse();
		for (const stale of baks.slice(MAX_BAKS)) {
			try {
				rmSync(join(dir, stale));
			} catch {
				// Best-effort pruning.
			}
		}
	}

	private appendToArchive(file: string, lines: readonly MemoryLine[]): void {
		if (lines.length === 0) return;
		const archive = this.archivePathFor(file);
		const existing = existsSync(archive) ? readFileSync(archive, "utf8") : "";
		// Archive appends are still writes; honor the same temp+rename atomicity
		// invariant as live memory files. The shared lock serializes normal
		// appends; atomicWrite prevents partial/corrupt archive files even if a
		// stale-lock edge case ever overlaps writers.
		this.atomicWrite(archive, existing + serializeMemory(lines));
	}
}
