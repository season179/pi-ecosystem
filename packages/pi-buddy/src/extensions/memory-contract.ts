export type MemoryScope = "global" | "project";

export type MemoryLine =
	| { kind: "entry"; date: string; text: string }
	| { kind: "raw"; line: string };

export interface ApplyResult {
	lessons: number;
	retractions: number;
	retractMisses: number;
}

export interface ScopedLesson {
	scope: MemoryScope;
	text: string;
}

/** Persistence port used by Buddy's session and Consultation workflow. */
export interface BuddyMemory {
	globalPath(): string;
	projectPath(slug: string): string;
	readLines(file: string): MemoryLine[];
	readForInjection(slug: string): string | undefined;
	curate(slug: string, now?: Date): boolean;
	applyDirectives(
		slug: string,
		lessons: readonly ScopedLesson[],
		retractions: readonly string[],
		now?: Date,
	): ApplyResult;
	clear(scope: MemoryScope, slug: string): boolean;
}
