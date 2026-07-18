import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { BuddyTool } from "./buddy-tool.js";
import type {
	AutomaticReviewContext,
	BuddyOutcome,
} from "./buddy-context.js";
import type { ConsultResult } from "./consult.js";
import type { ConsultationWorkflow } from "./consultation-workflow.js";
import {
	ConcernHistory,
	rebuildConcernHistory,
} from "./concern-history.js";
import { formatBuddyAdvisory } from "./message-format.js";
import {
	type BackgroundTrigger,
	BuddyRunTracker,
} from "./policy.js";
import {
	formatRetriableBuddyFailure,
	isRetriableBuddyError,
} from "./retry.js";
import {
	buildVerdictDigest,
	buildWatchdogRevalidationSystemPrompt,
	buildWatchdogSystemPrompt,
} from "./stances.js";
import { recordWatchdogCommit } from "./telemetry.js";
import {
	WatchdogCoordinator,
	type WatchdogSnapshot,
} from "./watchdog-coordinator.js";
import type { WatchdogVerdict } from "./watchdog-verdict.js";

const VERDICT_RING_SIZE = 10;

export interface WatchdogCandidate {
	id: string;
	trigger: BackgroundTrigger;
	headline: string;
	advisory: string;
	evidence: string[];
	activity: string[];
	reviewedRevision: number;
}

export type { AutomaticReviewContext } from "./buddy-context.js";

interface AutomaticReviewConsultation {
	run: ConsultationWorkflow["run"];
}

export interface AutomaticReviewOptions {
	host: Pick<ExtensionAPI, "sendMessage">;
	consultation: AutomaticReviewConsultation;
	tools: readonly BuddyTool[];
	getWatchdogThreshold: () => number;
	isEnabled: () => boolean;
	reviewMessageType: string;
	backgroundStatusKey: string;
	runEndReviewMinTurns: number;
	id?: () => string;
	nowIso?: () => string;
	recordCommit?: typeof recordWatchdogCommit;
}

type InitialWatchdogVerdict = Extract<
	WatchdogVerdict,
	{ decision: "pass" | "concern" }
>;
type RevalidationWatchdogVerdict = Extract<
	WatchdogVerdict,
	{ decision: "resolved" | "confirm" | "replace" }
>;

/**
 * Owns the Automatic Review lifecycle from cadence through safe publication.
 *
 * BuddyRunTracker and WatchdogCoordinator remain internal collaborators: the
 * public Interface speaks in Pi lifecycle events and domain operations, so
 * callers cannot accidentally stage or publish half a review protocol.
 */
export class AutomaticReview {
	private readonly tracker: BuddyRunTracker;
	private readonly coordinator = new WatchdogCoordinator<WatchdogCandidate>();
	private readonly concerns = new ConcernHistory();
	private readonly verdictRing: string[] = [];
	private readonly id: () => string;
	private readonly nowIso: () => string;
	private readonly recordCommit: typeof recordWatchdogCommit;
	private backgroundAbort?: AbortController;
	private runEndReviewPending = false;

	constructor(private readonly options: AutomaticReviewOptions) {
		this.tracker = new BuddyRunTracker(
			options.getWatchdogThreshold,
			options.runEndReviewMinTurns,
		);
		this.id = options.id ?? (() => `wd-${randomUUID().slice(0, 12)}`);
		this.nowIso = options.nowIso ?? (() => new Date().toISOString());
		this.recordCommit = options.recordCommit ?? recordWatchdogCommit;
	}

	context(): AutomaticReviewContext {
		const concernDigest = this.concerns.buildDigest();
		const counts = this.concerns.counts();
		return {
			verdictDigest:
				this.verdictRing.length > 0
					? buildVerdictDigest(this.verdictRing)
					: undefined,
			concernDigest,
			openConcerns: counts.open,
			fixedConcerns: counts.fixed,
			rebuttedConcerns: counts.rebutted,
		};
	}

	restoreSession(entries: readonly SessionEntry[]): void {
		this.abort();
		this.runEndReviewPending = false;
		this.verdictRing.length = 0;
		rebuildConcernHistory(entries, this.concerns);
	}

	restoreTree(entries: readonly SessionEntry[]): void {
		this.restoreSession(entries);
	}

	shutdown(): void {
		this.abort();
		this.runEndReviewPending = false;
		this.verdictRing.length = 0;
		this.concerns.clear();
	}

	abort(): void {
		this.tracker.invalidate();
		this.coordinator.invalidate();
		this.backgroundAbort?.abort();
		this.backgroundAbort = undefined;
	}

	onConsultationRequested(): void {
		this.tracker.onPull();
	}

	deliveryMode(): "steer" | "nextTurn" {
		return this.tracker.deliveryMode();
	}

	markConcern(args: Parameters<ConcernHistory["mark"]>[0]) {
		return this.concerns.mark(args);
	}

	noteActivity(): void {
		this.coordinator.noteActivity();
	}

	toolStarted(toolCallId: string): void {
		this.coordinator.toolStarted(toolCallId);
	}

	toolEnded(toolCallId: string): void {
		this.coordinator.toolEnded(toolCallId);
	}

	agentStarted(): void {
		this.runEndReviewPending = false;
		this.tracker.onAgentStart();
	}

	async turnEnded(ctx: ExtensionContext): Promise<void> {
		if (!this.options.isEnabled()) return;
		await this.commitPending(ctx);
		if (this.tracker.onTurnEnd() && !this.coordinator.hasPending) {
			this.launch("turns", ctx);
		}
	}

	agentEnded(): void {
		this.runEndReviewPending = this.tracker.onAgentEnd();
	}

	async agentSettled(ctx: ExtensionContext): Promise<void> {
		await this.commitPending(ctx);
		const shouldReview = this.runEndReviewPending;
		this.runEndReviewPending = false;
		if (!this.options.isEnabled()) return;
		// Print/JSON mode exits immediately after the run; do not launch work that
		// session shutdown would discard before completion.
		if (shouldReview && ctx.hasUI && !this.coordinator.hasPending) {
			this.launch("run_end", ctx);
		}
	}

	private recordVerdict(trigger: BackgroundTrigger, verdict: string): void {
		const time = this.nowIso().slice(11, 16);
		this.verdictRing.push(`[${time}] ${trigger}: ${verdict}`);
		if (this.verdictRing.length > VERDICT_RING_SIZE) this.verdictRing.shift();
	}

	private async commitPending(ctx: ExtensionContext): Promise<void> {
		if (!this.options.isEnabled() || !this.coordinator.hasPending) return;
		const controller = new AbortController();
		this.backgroundAbort = controller;
		let attemptedTrigger: BackgroundTrigger | undefined;
		let attemptedCandidate: WatchdogCandidate | undefined;
		let attemptedSnapshot: WatchdogSnapshot | undefined;
		let attemptedRevalidationCount = 0;
		const publish = (
			candidate: WatchdogCandidate,
			snapshot: WatchdogSnapshot,
			revalidationCount: number,
		): void => {
			const deliveredAt = this.nowIso();
			this.options.host.sendMessage(
				{
					customType: this.options.reviewMessageType,
					content: formatBuddyAdvisory(
						candidate.trigger,
						candidate.id,
						watchdogCandidateText(candidate),
					),
					display: true,
					details: {
						activity: candidate.activity,
						source: "watchdog",
						trigger: candidate.trigger,
						concernId: candidate.id,
						headline: candidate.headline,
						deliveredAt,
						reviewedRevision: candidate.reviewedRevision,
						validatedRevision: snapshot.revision,
						revalidationCount,
					},
				},
				{ deliverAs: this.tracker.deliveryMode() },
			);
			this.recordVerdict(candidate.trigger, `concern delivered: #${candidate.id}`);
			this.concerns.record({
				id: candidate.id,
				trigger: candidate.trigger,
				headline: candidate.headline,
				deliveredAt,
			});
		};
		try {
			const result = await this.coordinator.commit(
				ctx.sessionManager.getBranch(),
				async (candidate, snapshot, revalidationCount) => {
					attemptedTrigger = candidate.trigger;
					attemptedCandidate = candidate;
					attemptedSnapshot = snapshot;
					attemptedRevalidationCount = revalidationCount;
					const revalidation = await this.options.consultation.run({
						ctx,
						systemPrompt: buildWatchdogRevalidationSystemPrompt(),
						requestText: [
							"Revalidate this private watchdog candidate against the CURRENT transcript:",
							`Candidate #${candidate.id} (${candidate.trigger})`,
							`Originally reviewed at activity revision ${candidate.reviewedRevision}.`,
							`Current commit snapshot revision: ${snapshot.revision}.`,
							"",
							watchdogCandidateText(candidate),
						].join("\n"),
						source: "watchdog",
						stance: "watchdog-revalidation",
						signal: controller.signal,
						statusKey: this.options.backgroundStatusKey,
						trigger: candidate.trigger,
						entries: snapshot.entries,
						extraTools: this.options.tools,
						outcomeOf: (review) =>
							requireRevalidationVerdict(review).decision === "resolved"
								? "resolved"
								: "concern",
						extraTelemetry: () => ({
							concernId: candidate.id,
							reviewPhase: "revalidation",
							reviewRevision: candidate.reviewedRevision,
							revalidationRevision: snapshot.revision,
							revalidationCount,
						}),
					});
					const verdict = requireRevalidationVerdict(revalidation);
					if (verdict.decision === "resolved") return { decision: "resolved" };
					return {
						decision: verdict.decision,
						candidate: {
							...candidate,
							headline: verdict.headline,
							advisory: verdict.advisory,
							evidence: verdict.evidence,
							activity: [...candidate.activity, ...revalidation.activity],
						},
					};
				},
				publish,
			);

			if (result.status === "suppressed") {
				if (attemptedCandidate) {
					await this.recordCommit({
						trigger: attemptedCandidate.trigger,
						concernId: attemptedCandidate.id,
						outcome: "resolved",
						reviewRevision: attemptedCandidate.reviewedRevision,
						commitRevision: result.snapshot.revision,
						revalidationCount: result.revalidationCount,
					});
				}
				this.recordVerdict(attemptedTrigger ?? "turns", "resolved before delivery");
				return;
			}
			if (result.status !== "deliver") {
				if (
					result.status === "deferred" &&
					result.reason === "activity" &&
					attemptedCandidate &&
					attemptedSnapshot
				) {
					await this.recordCommit({
						trigger: attemptedCandidate.trigger,
						concernId: attemptedCandidate.id,
						outcome: "deferred",
						reason: "activity",
						reviewRevision: attemptedCandidate.reviewedRevision,
						commitRevision: attemptedSnapshot.revision,
						revalidationCount: attemptedRevalidationCount,
					});
				}
				return;
			}
			const candidate = result.candidate;
			await this.recordCommit({
				trigger: candidate.trigger,
				concernId: candidate.id,
				outcome: "delivered",
				reviewRevision: candidate.reviewedRevision,
				commitRevision: result.snapshot.revision,
				revalidationCount: result.revalidationCount,
			});
		} catch (error) {
			if (attemptedCandidate && attemptedSnapshot) {
				await this.recordCommit({
					trigger: attemptedCandidate.trigger,
					concernId: attemptedCandidate.id,
					outcome: "deferred",
					reason: "error",
					reviewRevision: attemptedCandidate.reviewedRevision,
					commitRevision: attemptedSnapshot.revision,
					revalidationCount: attemptedRevalidationCount,
				});
			}
			if (!controller.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(
					`Buddy watchdog revalidation deferred: ${errorToString(error)}`,
					"warning",
				);
			}
		} finally {
			if (this.backgroundAbort === controller) this.backgroundAbort = undefined;
		}
	}

	private launch(trigger: BackgroundTrigger, ctx: ExtensionContext): void {
		if (!this.options.isEnabled()) return;
		const launch = this.tracker.launchBackground(trigger);
		const reviewSnapshot = this.coordinator.capture(
			ctx.sessionManager.getBranch(),
		);
		const reviewId = this.id();
		const controller = new AbortController();
		this.backgroundAbort = controller;
		const requestText =
			trigger === "turns"
				? `Automatic watchdog check-in: the agent has completed ` +
					`${launch.watchdogThreshold} turns without consulting you. Review ` +
					`the supplied snapshot and submit a structured verdict.`
				: `Automatic end-of-run review: the agent has finished its run ` +
					`without consulting you. Review this run and submit a structured verdict.`;

		let recordedOutcome: BuddyOutcome | undefined;
		const automaticOutcome = (result: ConsultResult): BuddyOutcome => {
			if (!this.tracker.isCurrent(launch)) return "discarded";
			return requireInitialVerdict(result).decision === "pass" ? "pass" : "concern";
		};
		const recordAutomaticOutcome = (result: ConsultResult): BuddyOutcome => {
			recordedOutcome = automaticOutcome(result);
			return recordedOutcome;
		};

		void (async () => {
			try {
				const result = await this.options.consultation.run({
					ctx,
					systemPrompt: buildWatchdogSystemPrompt(),
					requestText,
					source: "watchdog",
					stance: "watchdog",
					signal: controller.signal,
					statusKey: this.options.backgroundStatusKey,
					trigger,
					entries: reviewSnapshot.entries,
					extraTools: this.options.tools,
					outcomeOf: (result) => recordAutomaticOutcome(result),
					extraTelemetry: () => ({
						turnsElapsed: this.tracker.turnsElapsedSince(launch),
						reviewPhase: "review",
						reviewRevision: reviewSnapshot.revision,
						concernId: recordedOutcome === "concern" ? reviewId : undefined,
					}),
				});
				if (!this.tracker.isCurrent(launch)) return;
				const outcome = recordedOutcome ?? automaticOutcome(result);
				if (outcome === "pass") {
					this.recordVerdict(trigger, "PASS");
					return;
				}
				const verdict = requireInitialVerdict(result);
				if (verdict.decision !== "concern") return;
				const staged = this.coordinator.stage(reviewSnapshot, {
					id: reviewId,
					trigger,
					headline: verdict.headline,
					advisory: verdict.advisory,
					evidence: verdict.evidence,
					activity: result.activity,
					reviewedRevision: reviewSnapshot.revision,
				});
				if (!staged) return;
				this.recordVerdict(trigger, `candidate staged: #${reviewId}`);
				if (ctx.isIdle()) await this.commitPending(ctx);
			} catch (error) {
				if (this.tracker.isCurrent(launch) && !controller.signal.aborted) {
					ctx.ui.notify(
						isRetriableBuddyError(error)
							? formatRetriableBuddyFailure()
							: `Buddy background review failed: ${errorToString(error)}`,
						"warning",
					);
				}
			} finally {
				this.tracker.settleBackground();
				if (this.backgroundAbort === controller) this.backgroundAbort = undefined;
			}
		})();
	}
}

function watchdogCandidateText(candidate: WatchdogCandidate): string {
	if (candidate.evidence.length === 0) return candidate.advisory;
	return [
		candidate.advisory,
		"",
		"Current evidence:",
		...candidate.evidence.map((entry) => `- ${entry}`),
	].join("\n");
}

function requireInitialVerdict(result: ConsultResult): InitialWatchdogVerdict {
	const verdict = result.watchdogVerdict;
	if (!verdict || (verdict.decision !== "pass" && verdict.decision !== "concern")) {
		throw new Error("Buddy watchdog did not submit a valid structured review verdict");
	}
	return verdict as InitialWatchdogVerdict;
}

function requireRevalidationVerdict(
	result: ConsultResult,
): RevalidationWatchdogVerdict {
	const verdict = result.watchdogVerdict;
	if (
		!verdict ||
		(verdict.decision !== "resolved" &&
			verdict.decision !== "confirm" &&
			verdict.decision !== "replace")
	) {
		throw new Error(
			"Buddy watchdog did not submit a valid structured revalidation verdict",
		);
	}
	return verdict as RevalidationWatchdogVerdict;
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
