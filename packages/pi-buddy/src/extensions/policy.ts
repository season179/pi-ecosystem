/**
 * Pure state machine for the buddy's automatic advisory behavior.
 *
 * Tracks turn counts within agent runs and decides when to launch background
 * reviews (watchdog after N unconsulted turns, end-of-run review), protects
 * launches with a session-generation guard, and chooses the delivery mode.
 * Current-state publication is owned by WatchdogCoordinator.
 */

export type BackgroundTrigger = "turns" | "run_end";
export type DeliveryMode = "steer" | "nextTurn";
export type CommandConsultDelivery = "immediate" | "nextTurn";

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
