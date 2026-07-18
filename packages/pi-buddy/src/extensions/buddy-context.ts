/** Neutral data passed between Buddy's session and application workflows. */
export type BuddySource = "tool" | "command" | "watchdog";

export type BuddyOutcome =
	| "ok"
	| "pass"
	| "concern"
	| "resolved"
	| "error"
	| "discarded";

/** Which automatic path launched an Automatic Review. */
export type BuddyTrigger = "turns" | "run_end";

export interface AutomaticReviewContext {
	verdictDigest?: string;
	concernDigest?: string;
	openConcerns: number;
	fixedConcerns: number;
	rebuttedConcerns: number;
}

/** Prompt context assembled by the session for one consultation. */
export interface ConsultationInjection {
	block?: string;
	memoryChars: number;
	openConcerns: number;
	fixedConcerns: number;
	rebuttedConcerns: number;
	concernHistoryChars: number;
}
