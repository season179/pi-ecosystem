export const CONSULT_BUDDY_TOOL = "consult_buddy";

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
	const hasBuddy = active.includes(CONSULT_BUDDY_TOOL);
	if (!enabled) {
		return active.filter((tool) => tool !== CONSULT_BUDDY_TOOL);
	}
	if (shouldRestoreWhenEnabled && !hasBuddy) {
		return [...active, CONSULT_BUDDY_TOOL];
	}
	return active;
}
