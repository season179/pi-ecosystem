import type { BackgroundTrigger } from "./policy.js";

export type BuddyReviewDetails = {
	source?: string;
	trigger?: BackgroundTrigger;
	concernId?: string;
	headline?: string;
};

export function formatBuddyAdvisory(
	trigger: BackgroundTrigger,
	concernId: string,
	answer: string,
): string {
	const origin = trigger === "run_end" ? "run-end" : "watchdog";
	const freshness =
		trigger === "run_end"
			? "Revalidated against the settled run."
			: "Revalidated against the current work.";

	return [
		`## BUDDY ADVISORY (auto, ${origin})`,
		"",
		freshness,
		"Otherwise: fix, rebut with evidence, or consult_buddy.",
		"",
		`Concern #${concernId}:`,
		answer,
	].join("\n");
}

export function formatBuddyConsult(answer: string): string {
	return [`## BUDDY CONSULT (user-requested)`, "", answer].join("\n");
}

export function buddyRendererLabel(details: BuddyReviewDetails | undefined): string {
	if (details?.source === "memory") return "● buddy · memory";
	if (details?.source === "command") return "● buddy · consult · user-requested";
	if (details?.source === "watchdog") {
		const origin = details.trigger === "run_end" ? "run-end" : "watchdog";
		return `● buddy · advisory · auto · ${origin}`;
	}
	return "● buddy";
}
