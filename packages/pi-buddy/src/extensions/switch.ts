export const CONSULT_BUDDY_TOOL = "consult_buddy";
export const GIVE_BUDDY_FEEDBACK_TOOL = "give_buddy_feedback";

export type BuddyCommandParseResult =
	| { kind: "empty" }
	| { kind: "control"; action: "on" | "off" | "status" }
	| { kind: "ask"; question: string };

export function parseBuddyCommand(args: string | undefined): BuddyCommandParseResult {
	const trimmed = args?.trim() ?? "";
	if (!trimmed) return { kind: "empty" };
	const lower = trimmed.toLowerCase();
	if (lower === "on" || lower === "off" || lower === "status") {
		return { kind: "control", action: lower };
	}
	return { kind: "ask", question: trimmed };
}

export function buddyDisabledFromFlag(value: unknown): boolean {
	return value === true;
}

export function seedBuddyEnabledFromFlag(
	currentEnabled: boolean,
	flagValue: unknown,
	alreadySeeded: boolean,
): { enabled: boolean; seeded: boolean } {
	if (alreadySeeded) return { enabled: currentEnabled, seeded: true };
	return { enabled: !buddyDisabledFromFlag(flagValue), seeded: true };
}

export function activeToolsWithBuddyState(
	activeTools: readonly string[],
	enabled: boolean,
	shouldRestoreWhenEnabled: boolean,
): string[] {
	const active = [...activeTools];
	const hasConsult = active.includes(CONSULT_BUDDY_TOOL);
	const hasFeedback = active.includes(GIVE_BUDDY_FEEDBACK_TOOL);
	if (!enabled) {
		return active.filter(
			(tool) =>
				tool !== CONSULT_BUDDY_TOOL && tool !== GIVE_BUDDY_FEEDBACK_TOOL,
		);
	}
	const shouldExposeFeedback = hasConsult || shouldRestoreWhenEnabled;
	const next = [...active];
	if (shouldRestoreWhenEnabled && !hasConsult) next.push(CONSULT_BUDDY_TOOL);
	if (shouldExposeFeedback && !hasFeedback) next.push(GIVE_BUDDY_FEEDBACK_TOOL);
	return next;
}
