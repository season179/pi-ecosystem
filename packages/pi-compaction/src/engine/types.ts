import type { AgentMessage } from "./message.js";

/** What happens to one completed tool call/result pair in the outgoing context. */
export type Action = "keep" | "drop_result" | "drop_pair";

/**
 * Why a pair was excluded from scoring, or why a requested action was downgraded.
 * Values mirror the telemetry reason vocabulary so they can be counted without mapping.
 */
export type ExclusionReason =
	| "recent"
	| "pinned"
	| "instruction"
	| "incomplete"
	| "ambiguous"
	| "multimodal"
	| "provider_atomic"
	| "unmapped"
	| "unsupported"
	| "secret"
	| "budget";

/** A message in the active context together with the session entry that holds it. */
export interface ContextEntry {
	/** Session entry id; undefined for messages without a persisted entry. */
	id?: string;
	message: AgentMessage;
}

/** A completed call/result pair eligible for scoring. */
export interface Candidate {
	/** Pairing key: the provider tool-call id shared by the call block and the result message. */
	toolCallId: string;
	/** Session entry id of the tool result message (archive identity). */
	resultEntryId: string;
	/** Session entry id of the assistant message holding the call. */
	callEntryId: string;
	/** Short id used in Jev state and question names (`t1`, `t2`, ...). */
	shortId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	/** Characters of text in the original result. */
	resultChars: number;
	isError: boolean;
	/** Index of the assistant message in the context message list. */
	callIndex: number;
	/** Index of the tool result message in the context message list. */
	resultIndex: number;
	/** Zero-based index of the user turn the call belongs to. */
	turnIndex: number;
}

export interface Exclusion {
	toolCallId: string;
	reason: ExclusionReason;
}

export interface CandidateCollection {
	candidates: Candidate[];
	excluded: Exclusion[];
	/** Number of user turns seen in the context. */
	turns: number;
}

/** Jev's two answers about one candidate. */
export interface CandidateScores {
	keepCall: number;
	keepResult: number;
}

/** A decision as requested by policy, and as it can actually be applied. */
export interface Decision {
	toolCallId: string;
	resultEntryId: string;
	toolName: string;
	resultChars: number;
	requested: Action;
	effective: Action;
	downgradeReason?: ExclusionReason;
	scores?: CandidateScores;
}

/** Applied decisions keyed by tool-call id; `keep` entries are omitted. */
export type DecisionMap = ReadonlyMap<string, Decision>;
