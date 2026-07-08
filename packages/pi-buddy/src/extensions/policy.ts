import { hasAutomaticConcernMarker } from "./automatic-review.js";
import { isWatchdogPass } from "./stances.js";

/**
 * Pure state machine for the buddy's automatic advisory behavior.
 *
 * Tracks turn counts within agent runs and decides when to launch background
 * reviews (watchdog after N unconsulted turns, end-of-run review), whether a
 * verdict that lands later should still be delivered (session generation
 * guard), and how to deliver it (steer while the agent runs, nextTurn when
 * idle). Kept free of pi APIs so it is unit-testable.
 */

export type BackgroundTrigger = "turns" | "run_end";
export type DeliveryMode = "steer" | "nextTurn";
export type CommandConsultDelivery = "immediate" | "nextTurn";

/**
 * Deliver concerns reviewed up to 3 turns ago; suppress only turnsElapsed > 3.
 * This matches the initial telemetry cut (`gt3: 39/148` concerns) and is
 * intentionally conservative pending Phase 9 post-implementation measurement.
 */
export const STALE_CONCERN_MAX_TURNS = 3;

export interface AutomaticConcernDeliveryDecision {
	deliver: boolean;
	reason?: "stale_concern";
}

export function shouldDeliverAutomaticConcern(args: {
	answer: string;
	turnsElapsed: number;
}): AutomaticConcernDeliveryDecision {
	if (args.turnsElapsed <= STALE_CONCERN_MAX_TURNS) return { deliver: true };
	if (hasAutomaticConcernMarker(args.answer)) return { deliver: true };
	return { deliver: false, reason: "stale_concern" };
}

/** Verdict for an automatic (watchdog/run-end) review that is still current. */
export type AutomaticVerdict = "pass" | "concern" | "stale_suppressed";

/**
 * Classifies a current automatic review result into a deliverable verdict.
 *
 * A truncated answer can never be a clean PASS: mid-word truncation can strip
 * the concern-marker words the staleness gate relies on, and a length-capped
 * verdict is by definition incomplete. For the same reason it can never be
 * silently stale-suppressed either — the staleness gate keys off concern
 * markers that truncation may have severed, so a known-incomplete verdict is
 * always delivered as a "concern" for the agent to judge. Kept pure (no
 * session-generation guard — the caller handles "discarded") so the
 * truncated-never-PASS rule is testable.
 */
export function classifyAutomaticVerdict(args: {
	answer: string;
	truncated?: boolean;
	turnsElapsed: number;
}): AutomaticVerdict {
	if (args.truncated) return "concern";
	if (isWatchdogPass(args.answer)) return "pass";
	return shouldDeliverAutomaticConcern({
		answer: args.answer,
		turnsElapsed: args.turnsElapsed,
	}).deliver
		? "concern"
		: "stale_suppressed";
}

/**
 * User-requested `/buddy` answers should render immediately when the agent is
 * idle, but should not steer an active agent run. Automatic reviews use
 * DeliveryMode directly; the command path intentionally remaps idle `nextTurn`
 * to immediate display/persistence.
 *
 * Known limitation: if the answer lands during an active run, we still queue it
 * for `nextTurn` so it will not steer the agent. Pi does not currently expose a
 * separate "render/persist now, inject later" path for streaming sessions.
 */
export function commandConsultDelivery(
	mode: DeliveryMode,
): CommandConsultDelivery {
	return mode === "nextTurn" ? "immediate" : "nextTurn";
}

export interface BackgroundLaunch {
	generation: number;
	turnsAtLaunch: number;
	trigger: BackgroundTrigger;
	watchdogThreshold: number;
}

export class BuddyRunTracker {
	private turnsSinceConsult = 0;
	/** Monotonic across the session; used to measure verdict staleness. */
	private turnsTotal = 0;
	private turnsThisRun = 0;
	private agentRunActive = false;
	private consultedThisRun = false;
	private backgroundInFlight = false;
	private generation = 0;

	constructor(
		private readonly watchdogThreshold: number | (() => number),
		private readonly runEndMinTurns: number,
	) {}

	currentWatchdogThreshold(): number {
		return typeof this.watchdogThreshold === "function"
			? this.watchdogThreshold()
			: this.watchdogThreshold;
	}

	onAgentStart(): void {
		this.agentRunActive = true;
		this.turnsSinceConsult = 0;
		this.turnsThisRun = 0;
		this.consultedThisRun = false;
	}

	/** Returns true when a background watchdog review should be launched. */
	onTurnEnd(): boolean {
		if (!this.agentRunActive) return false;
		this.turnsTotal += 1;
		this.turnsThisRun += 1;
		if (this.backgroundInFlight) return false;
		this.turnsSinceConsult += 1;
		if (this.turnsSinceConsult < this.currentWatchdogThreshold()) return false;
		this.turnsSinceConsult = 0;
		return true;
	}

	/** The main agent (or the human) consulted the buddy explicitly. */
	onPull(): void {
		this.turnsSinceConsult = 0;
		this.consultedThisRun = true;
	}

	/** Returns true when an end-of-run review should be launched. */
	onAgentEnd(): boolean {
		this.agentRunActive = false;
		this.turnsSinceConsult = 0;
		return (
			this.turnsThisRun >= this.runEndMinTurns &&
			!this.consultedThisRun &&
			!this.backgroundInFlight
		);
	}

	launchBackground(trigger: BackgroundTrigger): BackgroundLaunch {
		this.backgroundInFlight = true;
		// A fired watchdog counts as consultation for run-end review purposes.
		this.consultedThisRun = true;
		return {
			generation: this.generation,
			turnsAtLaunch: this.turnsTotal,
			trigger,
			watchdogThreshold: this.currentWatchdogThreshold(),
		};
	}

	settleBackground(): void {
		this.backgroundInFlight = false;
	}

	/** Invalidate in-flight verdicts (session shutdown / switch / fork). */
	invalidate(): void {
		this.generation += 1;
	}

	isCurrent(launch: BackgroundLaunch): boolean {
		return launch.generation === this.generation;
	}

	/** Turns the agent completed between launch and now (verdict staleness). */
	turnsElapsedSince(launch: BackgroundLaunch): number {
		return this.turnsTotal - launch.turnsAtLaunch;
	}

	deliveryMode(): DeliveryMode {
		return this.agentRunActive ? "steer" : "nextTurn";
	}

	get isBackgroundInFlight(): boolean {
		return this.backgroundInFlight;
	}
}
