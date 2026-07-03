/**
 * Directive harvesting (phase 3): the buddy gets NO write tool. Instead the
 * harness parses structured directives out of the buddy's final answer:
 *
 *   LESSON[global]: Season prefers concise answers.
 *   LESSON[project]: vitest runs against src/ directly; no build for tests.
 *   RETRACT: verbose reviews got cut short
 *
 * Stripping is universal (every buddy answer, every source — defense against
 * the model emitting directives where it shouldn't); harvesting (actually
 * applying the directives) is gated to requested consultations and /buddy.
 *
 * Pure functions — no fs, no state.
 */

import type { MemoryScope, ScopedLesson } from "./memory.js";

/** Max lessons applied per consultation. */
export const MAX_LESSONS_PER_CONSULT = 3;
/** Max retractions applied per consultation. */
export const MAX_RETRACTS_PER_CONSULT = 2;

const LESSON_RE = /^\s*LESSON\[(global|project)\]:\s*(.+)\s*$/;
const RETRACT_RE = /^\s*RETRACT:\s*(.+)\s*$/;

export interface HarvestedDirectives {
	/** Answer with all directive lines removed. */
	stripped: string;
	/** Lessons in emission order, capped and deduped. */
	lessons: ScopedLesson[];
	/** Retraction needles in emission order, capped. */
	retractions: string[];
}

/**
 * Extract LESSON/RETRACT directives from a buddy answer and strip them.
 * Directive lines are matched anywhere in the answer. Caps: 3 lessons,
 * 2 retractions; excess directives are stripped but NOT applied.
 * Exact-duplicate lessons within one answer collapse to the first.
 */
export function harvestDirectives(answer: string): HarvestedDirectives {
	const keptLines: string[] = [];
	const lessons: ScopedLesson[] = [];
	const retractions: string[] = [];

	for (const line of answer.split("\n")) {
		const lessonMatch = LESSON_RE.exec(line);
		if (lessonMatch) {
			const scope = lessonMatch[1] as MemoryScope;
			const text = normalizeDirectiveText(lessonMatch[2]);
			if (
				text.length > 0 &&
				lessons.length < MAX_LESSONS_PER_CONSULT &&
				!lessons.some(
					(l) => l.scope === scope && l.text.toLowerCase() === text.toLowerCase(),
				)
			) {
				lessons.push({ scope, text });
			}
			continue;
		}
		const retractMatch = RETRACT_RE.exec(line);
		if (retractMatch) {
			const text = normalizeDirectiveText(retractMatch[1]);
			if (text.length > 0 && retractions.length < MAX_RETRACTS_PER_CONSULT) {
				retractions.push(text);
			}
			continue;
		}
		keptLines.push(line);
	}

	return {
		stripped: collapseBlankRuns(keptLines).join("\n").trim(),
		lessons,
		retractions,
	};
}

/** One-line UI notice for applied directives; undefined when nothing landed. */
export function harvestNotice(result: {
	lessons: number;
	retractions: number;
}): string | undefined {
	const parts: string[] = [];
	if (result.lessons > 0) parts.push(`remembered ${result.lessons} lesson(s)`);
	if (result.retractions > 0) parts.push(`retracted ${result.retractions}`);
	if (parts.length === 0) return undefined;
	return `buddy: ${parts.join(", ")}`;
}

/** Entries are single-line by format; flatten any sneaky whitespace. */
function normalizeDirectiveText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Stripping directives can leave double blank lines; collapse runs. */
function collapseBlankRuns(lines: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		if (line.trim() === "" && out.at(-1)?.trim() === "") continue;
		out.push(line);
	}
	return out;
}
