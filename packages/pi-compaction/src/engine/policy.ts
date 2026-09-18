import type { Action, Candidate, CandidateScores, Decision } from "./types.js";

export interface PolicyOptions {
	/** Minimum keep probability for a call or its result to stay. */
	keepThreshold: number;
	/** Tools whose completed calls may disappear entirely; others keep the call as evidence. */
	pairDroppableTools: ReadonlySet<string>;
}

/** Built-in read-only tools whose calls carry no side effects worth remembering. */
export const DEFAULT_PAIR_DROPPABLE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "glob", "bash_readonly"]);

export function requestedAction(scores: CandidateScores, threshold: number): Action {
	if (scores.keepResult >= threshold) return "keep";
	if (scores.keepCall >= threshold) return "drop_result";
	return "drop_pair";
}

/**
 * Turn Jev's two probabilities into a requested decision. Missing or invalid scores keep
 * the pair. Calls to tools with side effects never lose the call itself, only the output.
 */
export function decide(candidate: Candidate, scores: CandidateScores | undefined, options: PolicyOptions): Decision {
	const base = {
		toolCallId: candidate.toolCallId,
		resultEntryId: candidate.resultEntryId,
		toolName: candidate.toolName,
		resultChars: candidate.resultChars,
	};
	if (!scores || !validProbability(scores.keepCall) || !validProbability(scores.keepResult)) {
		return { ...base, requested: "keep", effective: "keep" };
	}
	let requested = requestedAction(scores, options.keepThreshold);
	let downgradeReason: Decision["downgradeReason"];
	if (requested === "drop_pair" && !options.pairDroppableTools.has(candidate.toolName)) {
		requested = "drop_result";
		downgradeReason = "unsupported";
	}
	return { ...base, requested, effective: requested, downgradeReason, scores };
}

export function validProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
