import { Type } from "typebox";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { BuddyTool } from "./buddy-tool.js";

export const WATCHDOG_VERDICT_TOOL = "submit_watchdog_verdict";

/**
 * Which half of the watchdog protocol a verdict tool serves. The initial
 * detached review may only pass or raise a concern; the commit-time
 * revalidation may only resolve, confirm, or replace a staged candidate.
 */
export type WatchdogPhase = "review" | "revalidation";

interface WatchdogConcernFields {
	headline: string;
	advisory: string;
	evidence: string[];
}

export type WatchdogVerdict =
	| { decision: "pass" }
	| ({ decision: "concern" } & WatchdogConcernFields)
	| { decision: "resolved" }
	| ({ decision: "confirm" } & WatchdogConcernFields)
	| ({ decision: "replace" } & WatchdogConcernFields);

const PHASE_DECISIONS: Record<WatchdogPhase, readonly string[]> = {
	review: ["pass", "concern"],
	revalidation: ["resolved", "confirm", "replace"],
};

/**
 * Decisions that must carry headline/advisory/evidence. Mirrors the
 * WatchdogConcernFields members of the WatchdogVerdict union — keep the two
 * in sync when adding a decision kind.
 */
const CONCERN_FIELD_DECISIONS: readonly string[] = [
	"concern",
	"confirm",
	"replace",
];

const PHASE_GUIDANCE: Record<WatchdogPhase, string> = {
	review:
		'Use "pass" when there is no real unresolved problem, or "concern" ' +
		"with headline, advisory, and evidence when there is.",
	revalidation:
		'Use "resolved" when the candidate no longer applies, or ' +
		'"confirm"/"replace" with headline, advisory, and evidence when it ' +
		"still does.",
};

/**
 * Verdict-tool parameters.
 *
 * Deliberately a FLAT object, not a top-level union of per-decision shapes.
 * A top-level `anyOf`/`oneOf` schema breaks weaker tool-callers — notably
 * zai/glm-5.2, which calls the tool but emits empty arguments `{}` against a
 * union schema (verified live: 6/6 empty args → 6/6 valid once flattened).
 * `decision` stays a nested enum; `headline`/`advisory`/`evidence` are schema-
 * optional because a "pass"/"resolved" verdict needs none of them, and the
 * execute-time validation below enforces the conditional requirement for
 * concern/confirm/replace.
 *
 * The decision enum is scoped to the watchdog phase: when all five decisions
 * shared one enum, glm-5.2 submitted structurally valid but out-of-phase
 * verdicts (e.g. "confirm" during the initial review, 2026-07-19), which the
 * host had to reject outright. Scoping the enum lets schema validation reject
 * out-of-phase decisions as ordinary tool errors the model can correct
 * in-loop.
 */
function verdictParametersFor(phase: WatchdogPhase) {
	return Type.Object({
		decision: Type.Union(
			PHASE_DECISIONS[phase].map((decision) => Type.Literal(decision)),
			{
				description: `The watchdog decision kind. ${PHASE_GUIDANCE[phase]}`,
			},
		),
		headline: Type.Optional(
			Type.String({
				description:
					"Required for concern/confirm/replace. One-line actionable headline.",
			}),
		),
		advisory: Type.Optional(
			Type.String({
				description:
					"Required for concern/confirm/replace. Concise current-state recommendation and evidence.",
			}),
		),
		evidence: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Required for concern/confirm/replace. Concrete current transcript or repository evidence.",
			}),
		),
	});
}

export function createWatchdogVerdictTool(phase: WatchdogPhase): BuddyTool {
	return {
		name: WATCHDOG_VERDICT_TOOL,
		description:
			`Submit the final structured watchdog decision: ${PHASE_DECISIONS[phase]
				.map((decision) => `"${decision}"`)
				.join(", ")}. This must be your final action.`,
		parameters: verdictParametersFor(phase),
		async execute(_toolCallId, params) {
			const verdict = params as {
				decision?: unknown;
				headline?: unknown;
				advisory?: unknown;
				evidence?: unknown;
			};
			const decision = verdict.decision;
			// Schema validation normally rejects out-of-phase decisions first;
			// this guard keeps the contract for callers that skip validation.
			if (
				typeof decision !== "string" ||
				!PHASE_DECISIONS[phase].includes(decision)
			) {
				throw new Error(
					`Invalid decision ${JSON.stringify(decision)} for the ${phase} phase. ` +
						`This verdict accepts only: ${PHASE_DECISIONS[phase]
							.map((entry) => `"${entry}"`)
							.join(", ")}. ` +
						`${PHASE_GUIDANCE[phase]} Submit again with a valid decision.`,
				);
			}
			if (CONCERN_FIELD_DECISIONS.includes(decision)) {
				const missing: string[] = [];
				if (typeof verdict.headline !== "string") missing.push("headline");
				if (typeof verdict.advisory !== "string") missing.push("advisory");
				if (
					!Array.isArray(verdict.evidence) ||
					!verdict.evidence.every((entry) => typeof entry === "string")
				) {
					missing.push("evidence");
				}
				if (missing.length > 0) {
					throw new Error(
						`Incomplete "${decision}" verdict: missing or invalid required ` +
							`field(s): ${missing.join(", ")}. A "${decision}" verdict ` +
							"requires headline (one-line actionable headline), advisory " +
							"(concise recommendation), and evidence (array of concrete " +
							"evidence strings). Submit again with all fields populated.",
					);
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `Watchdog verdict submitted: ${decision}`,
					},
				],
				details: verdict as unknown as WatchdogVerdict,
			};
		},
	};
}

export function isWatchdogVerdict(value: unknown): value is WatchdogVerdict {
	if (typeof value !== "object" || value === null) return false;
	const verdict = value as Partial<WatchdogVerdict>;
	if (verdict.decision === "pass" || verdict.decision === "resolved") return true;
	return (
		(verdict.decision === "concern" ||
			verdict.decision === "confirm" ||
			verdict.decision === "replace") &&
		typeof verdict.headline === "string" &&
		typeof verdict.advisory === "string" &&
		Array.isArray(verdict.evidence) &&
		verdict.evidence.every((entry) => typeof entry === "string")
	);
}

export function extractWatchdogVerdict(
	results: readonly ToolResultMessage[],
): WatchdogVerdict | undefined {
	for (const result of results) {
		if (
			result.toolName === WATCHDOG_VERDICT_TOOL &&
			!result.isError &&
			isWatchdogVerdict(result.details)
		) {
			return result.details;
		}
	}
	return undefined;
}
