import { Type } from "typebox";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { BuddyTool } from "./buddy-tools.js";

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

const concernShape = (decision: "concern" | "confirm" | "replace") =>
	Type.Object({
		decision: Type.Literal(decision),
		headline: Type.String({ description: "One-line actionable headline" }),
		advisory: Type.String({
			description: "Concise current-state recommendation and evidence",
		}),
		evidence: Type.Array(Type.String(), {
			description: "Concrete current transcript or repository evidence",
		}),
	});

export function createWatchdogVerdictTool(): BuddyTool {
	return {
		name: WATCHDOG_VERDICT_TOOL,
		description:
			"Submit the final structured watchdog decision. This must be your final action.",
		parameters: Type.Union([
			Type.Object({ decision: Type.Literal("pass") }),
			concernShape("concern"),
			Type.Object({ decision: Type.Literal("resolved") }),
			concernShape("confirm"),
			concernShape("replace"),
		]),
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
