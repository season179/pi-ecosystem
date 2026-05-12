/**
 * Linguistic span extraction for pi-readbeam.
 *
 * Accepts prose segments (already filtered by the segmenter) and returns
 * typed spans for action verbs and meaningful noun phrases. Optimized for
 * calm summary scanning rather than perfect grammar.
 *
 * The adapter is isolated behind the `LinguisticAnalyzer` interface so the
 * underlying NLP library can be swapped without touching callers.
 *
 * Dependency rationale: compromise v14
 *   - Zero runtime dependencies, ~100 KB
 *   - TypeScript-first with bundled .d.ts
 *   - Provides POS tagging, noun-phrase chunking, and verb conjugation
 *   - No native bindings, works in any Node ≥18 environment
 *   - If a lighter or more accurate library appears, swap this file;
 *     the `LinguisticAnalyzer` interface stays unchanged.
 */

import nlp from "compromise";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SpanKind = "action-verb" | "noun-phrase";

export interface LinguisticSpan {
	kind: SpanKind;
	/** The matched text, trimmed of determiners and trailing punctuation. */
	text: string;
	/** Character offset (inclusive) in the original prose string. */
	start: number;
	/** Character offset (exclusive) in the original prose string. */
	end: number;
}

export interface LinguisticAnalyzer {
	/**
	 * Extract action-verb and noun-phrase spans from a prose segment.
	 * The input should contain no protected segments (code, URLs, etc.) —
	 * those are the segmenter's responsibility.
	 */
	extractSpans(prose: string): LinguisticSpan[];
}

// ---------------------------------------------------------------------------
// Stop-lists
// ---------------------------------------------------------------------------

/**
 * Verb infinitives that are too vague, hedging, or light to carry
 * highlighting weight in an agent summary. Auxiliaries, modals, and
 * copulas are already filtered by compromise's POS tags.
 */
const WEAK_VERBS = new Set([
	"be",
	"have",
	"do",
	"get",
	"make",
	"take",
	"go",
	"come",
	"seem",
	"appear",
	"give",
	"put",
	"keep",
	"let",
]);

/**
 * Single-word nouns that are too generic to be useful scanning landmarks.
 * Only applied to standalone single-word NPs — multi-word phrases that
 * happen to contain these words are kept (e.g. "error thing" is unlikely
 * but "thing" alone is noise).
 */
const WEAK_NOUNS = new Set([
	"thing",
	"things",
	"stuff",
	"way",
	"ways",
	"time",
	"times",
	"lot",
	"lots",
	"bit",
	"bits",
	"kind",
	"sort",
	"sorts",
	"part",
	"parts",
	"point",
	"points",
	"case",
	"cases",
	"place",
	"places",
	"example",
	"examples",
	"fact",
	"issue",
	"issues",
]);

// ---------------------------------------------------------------------------
// Internal types for compromise output
// ---------------------------------------------------------------------------

interface OffsetInfo {
	index: number;
	start: number;
	length: number;
}

interface VerbJsonEntry {
	text: string;
	offset: OffsetInfo;
	verb?: {
		infinitive?: string;
		grammar?: {
			copula?: boolean;
		};
	};
	terms?: {
		text: string;
		tags?: string[];
		offset?: OffsetInfo;
	}[];
}

interface NounJsonEntry {
	text: string;
	offset: OffsetInfo;
	noun?: {
		root?: string;
		determiner?: string;
		adjectives?: string[];
		isSubordinate?: boolean;
	};
	terms?: {
		text: string;
		tags?: string[];
		offset?: OffsetInfo;
	}[];
}

// ---------------------------------------------------------------------------
// Compromise-based implementation
// ---------------------------------------------------------------------------

export class CompromiseAnalyzer implements LinguisticAnalyzer {
	extractSpans(prose: string): LinguisticSpan[] {
		if (!prose.trim()) return [];

		const doc = nlp(prose);
		const spans: LinguisticSpan[] = [];

		// 1. Action verbs
		spans.push(...this.extractVerbs(doc));

		// 2. Noun phrases (excluding positions already taken by verbs)
		spans.push(...this.extractNouns(doc, spans));

		spans.sort((a, b) => a.start - b.start);

		return spans;
	}

	// ---- Verb extraction ---------------------------------------------------

	private extractVerbs(doc: ReturnType<typeof nlp>): LinguisticSpan[] {
		const data = doc.verbs().out("offset") as VerbJsonEntry[];
		const spans: LinguisticSpan[] = [];

		for (const entry of data) {
			if (this.isWeakVerb(entry)) continue;

			const start = entry.offset.start;
			spans.push({
				kind: "action-verb",
				text: entry.text,
				start,
				end: start + entry.offset.length,
			});
		}

		return spans;
	}

	private isWeakVerb(entry: VerbJsonEntry): boolean {
		// Copula ("be" forms)
		if (entry.verb?.grammar?.copula) return true;

		// When compromise returns a multi-word verb phrase (e.g. "was
		// refactored", "will install"), the auxiliary/modal is always the
		// first term.  Checking only the first term correctly suppresses
		// passive-voice and modal constructions as a single unit.  This is
		// acceptable for agent summaries, which are almost always active
		// voice past-tense ("Fixed", "Updated", "Deployed").
		const tags = entry.terms?.[0]?.tags ?? [];
		if (tags.includes("Auxiliary") || tags.includes("Modal")) return true;

		const inf = entry.verb?.infinitive?.toLowerCase();
		if (inf && WEAK_VERBS.has(inf)) return true;

		return false;
	}

	// ---- Noun-phrase extraction --------------------------------------------

	private extractNouns(
		doc: ReturnType<typeof nlp>,
		existingSpans: LinguisticSpan[],
	): LinguisticSpan[] {
		const data = doc.nouns().out("offset") as NounJsonEntry[];
		const candidates: LinguisticSpan[] = [];

		for (const entry of data) {
			const root = entry.noun?.root?.trim();
			if (!root) continue;

			if (this.isWeakNoun(root)) continue;

			// Skip spans that are pure punctuation (compromise occasionally
			// tags "..." or "!!!" as nouns).
			if (!/[\p{L}\p{N}]/u.test(root)) continue;

			// Locate the root within the full NP text to get its exact offset.
			const relativeStart = entry.text.indexOf(root);
			if (relativeStart === -1) continue;

			const start = entry.offset.start + relativeStart;
			const end = start + root.length;

			candidates.push({ kind: "noun-phrase", text: root, start, end });
		}

		// Merge with any existing verb spans so we don't overlap.
		return this.deduplicateNouns(candidates, existingSpans);
	}

	private isWeakNoun(root: string): boolean {
		const lower = root.toLowerCase();

		if (!lower.includes(" ") && WEAK_NOUNS.has(lower)) return true;

		if (lower.length < 2) return true;

		return false;
	}

	/**
	 * Keep longer noun phrases when spans overlap. A multi-word NP always
	 * beats a single-word noun at the same position. Ties are broken by
	 * earlier start position.
	 */
	private deduplicateNouns(
		candidates: LinguisticSpan[],
		existingSpans: LinguisticSpan[],
	): LinguisticSpan[] {
		const sorted = [...candidates].sort((a, b) => {
			const aLen = a.text.split(/\s+/).length;
			const bLen = b.text.split(/\s+/).length;
			if (aLen !== bLen) return bLen - aLen;
			return a.start - b.start;
		});

		const occupied: LinguisticSpan[] = [...existingSpans];
		const newSpans: LinguisticSpan[] = [];

		for (const span of sorted) {
			const overlaps = occupied.some(
				(s) => span.start < s.end && s.start < span.end,
			);
			if (!overlaps) {
				occupied.push(span);
				newSpans.push(span);
			}
		}

		return newSpans;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the default linguistic analyzer. Swap this function's body to
 *  switch NLP libraries without touching callers. */
export function createAnalyzer(): LinguisticAnalyzer {
	return new CompromiseAnalyzer();
}
