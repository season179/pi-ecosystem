export const BUDDY_FEEDBACKS = ["more", "same", "less"] as const;
export type BuddyFeedback = (typeof BUDDY_FEEDBACKS)[number];

export type AdvisoryLevel = -3 | -2 | -1 | 0 | 1;

export interface BuddyCalibrationNote {
	feedback: Exclude<BuddyFeedback, "same">;
	reason?: string;
	level: AdvisoryLevel;
	watchdogThreshold: number;
}

export interface BuddyFeedbackResult {
	feedback: BuddyFeedback;
	previousLevel: AdvisoryLevel;
	newLevel: AdvisoryLevel;
	watchdogThreshold: number;
	changed: boolean;
}

const WATCHDOG_THRESHOLDS: Record<AdvisoryLevel, number> = {
	1: 2,
	0: 3,
	[-1]: 6,
	[-2]: 12,
	[-3]: 24,
};

export function watchdogThresholdForLevel(level: AdvisoryLevel): number {
	return WATCHDOG_THRESHOLDS[level];
}

export function applyBuddyFeedback(
	current: AdvisoryLevel,
	feedback: BuddyFeedback,
): BuddyFeedbackResult {
	const newLevel = nextAdvisoryLevel(current, feedback);
	return {
		feedback,
		previousLevel: current,
		newLevel,
		watchdogThreshold: watchdogThresholdForLevel(newLevel),
		changed: newLevel !== current,
	};
}

export function nextAdvisoryLevel(
	current: AdvisoryLevel,
	feedback: BuddyFeedback,
): AdvisoryLevel {
	if (feedback === "same") return current;
	if (feedback === "more") return clampAdvisoryLevel(current + 1);
	return clampAdvisoryLevel(current - 1);
}

export function buildBuddyCalibrationBlock(
	note: BuddyCalibrationNote | undefined,
): string | undefined {
	if (!note) return undefined;
	const reason = note.reason?.trim();
	const reasonLine = reason
		? `\nAgent-provided reason (context, not proof): ${reason}`
		: "";
	if (note.feedback === "less") {
		return `# Buddy calibration for this session
The main agent requested less frequent automatic advisories. Current advisory level is ${note.level}; automatic watchdog cadence is every ${note.watchdogThreshold} turns. Be more selective: raise only concrete, material concerns. Do not comment on style or process unless it affects correctness, safety, user requirements, or expensive rework.${reasonLine}`;
	}
	return `# Buddy calibration for this session
The main agent requested more active Buddy input. Current advisory level is ${note.level}; automatic watchdog cadence is every ${note.watchdogThreshold} turns. Be willing to raise concrete concerns earlier, while still suppressing minor nitpicks.${reasonLine}`;
}

export function formatBuddyFeedbackResult(result: BuddyFeedbackResult): string {
	const direction = result.changed
		? `level ${result.previousLevel} → ${result.newLevel}`
		: `level unchanged at ${result.newLevel}`;
	return `Buddy feedback recorded: ${result.feedback}; ${direction}; watchdog threshold ${result.watchdogThreshold} turn(s).`;
}

function clampAdvisoryLevel(value: number): AdvisoryLevel {
	if (value > 1) return 1;
	if (value < -3) return -3;
	return value as AdvisoryLevel;
}
