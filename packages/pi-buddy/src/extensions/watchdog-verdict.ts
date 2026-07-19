import { Type } from "typebox";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { BuddyTool } from "./buddy-tool.js";

export const WATCHDOG_VERDICT_TOOL = "submit_watchdog_verdict";

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

/**
 * Verdict-tool parameters.
 *
 * Deliberately a FLAT object, not a top-level union of per-decision shapes.
 * A top-level `anyOf`/`oneOf` schema breaks weaker tool-callers — notably
 * zai/glm-5.2, which calls the tool but emits empty arguments `{}` against a
 * union schema (verified live: 6/6 empty args → 6/6 valid once flattened).
 * `decision` stays a nested enum; `headline`/`advisory`/`evidence` are schema-
 * optional because a "pass"/"resolved" verdict needs none of them, and
 * `isWatchdogVerdict` enforces the conditional requirement for
 * concern/confirm/replace at runtime.
 */
const verdictParameters = Type.Object({
	decision: Type.Union(
		[
			Type.Literal("pass"),
			Type.Literal("concern"),
			Type.Literal("resolved"),
			Type.Literal("confirm"),
			Type.Literal("replace"),
		],
		{ description: "The watchdog decision kind." },
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

export function createWatchdogVerdictTool(): BuddyTool {
	return {
		name: WATCHDOG_VERDICT_TOOL,
		description:
			"Submit the final structured watchdog decision. This must be your final action.",
		parameters: verdictParameters,
		async execute(_toolCallId, params) {
			const verdict = params as WatchdogVerdict;
			return {
				content: [
					{
						type: "text",
						text: `Watchdog verdict submitted: ${verdict.decision}`,
					},
				],
				details: verdict,
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
