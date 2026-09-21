import type { Candidate } from "../engine/types.js";

/** Shape of a TypeSafe `noul` (yes/no probability) question. */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
}

export type QuestionSet = Record<string, NoulQuestion>;

export function callQuestionKey(candidate: Pick<Candidate, "shortId">): string {
	return `call_${candidate.shortId}`;
}

export function resultQuestionKey(candidate: Pick<Candidate, "shortId">): string {
	return `result_${candidate.shortId}`;
}

/** The two keep-questions asked about one candidate. */
export function questionsFor(candidate: Candidate): QuestionSet {
	return {
		[callQuestionKey(candidate)]: {
			type: "noul",
			instructions:
				`Tool call ${candidate.shortId} (${candidate.toolName}) should stay in the history: knowing this call was made, ` +
				`with its input, still matters for what the assistant does next. When in doubt, answer yes.`,
		},
		[resultQuestionKey(candidate)]: {
			type: "noul",
			instructions:
				`The full output of tool call ${candidate.shortId} (${candidate.toolName}, ${candidate.resultChars} chars` +
				`${candidate.isError ? ", error" : ""}) should stay in the history verbatim: keeping it is likely to help the ` +
				`assistant's next steps. Consider whether its details remain necessary or are already captured elsewhere. ` +
				`Being able to retrieve it again is not, by itself, a reason to remove it. When in doubt, answer yes.`,
		},
	};
}

export function estimateQuestionTokens(questions: QuestionSet): number {
	return Math.ceil(JSON.stringify(questions).length / 4);
}

const REQUEST_OVERHEAD_TOKENS = 24;

export interface Batch {
	candidates: Candidate[];
	questions: QuestionSet;
}

export interface BatchPlan {
	batches: Batch[];
	/** Candidates that cannot fit any request even alone. */
	unbatched: Candidate[];
}

/** Split candidates into batches whose questions plus the (always complete) state fit one request. */
export function planBatches(candidates: readonly Candidate[], stateTokens: number, maxRequestTokens: number, maxPerBatch: number): BatchPlan {
	const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
	const batches: Batch[] = [];
	const unbatched: Candidate[] = [];
	let current: Batch = { candidates: [], questions: {} };
	let currentTokens = 0;
	for (const candidate of candidates) {
		const questions = questionsFor(candidate);
		const tokens = estimateQuestionTokens(questions);
		if (tokens > budget) {
			unbatched.push(candidate);
			continue;
		}
		if (current.candidates.length > 0 && (currentTokens + tokens > budget || current.candidates.length >= maxPerBatch)) {
			batches.push(current);
			current = { candidates: [], questions: {} };
			currentTokens = 0;
		}
		current.candidates.push(candidate);
		Object.assign(current.questions, questions);
		currentTokens += tokens;
	}
	if (current.candidates.length > 0) batches.push(current);
	return { batches, unbatched };
}
