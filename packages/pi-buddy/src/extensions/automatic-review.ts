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
import {
	type BuddyTelemetryContext,
	recordWatchdogCandidate,
	recordWatchdogCommit,
	recordWatchdogInserted,
} from "./telemetry.js";
import {
	WatchdogCoordinator,
	type WatchdogSnapshot,
} from "./watchdog-coordinator.js";
import type { WatchdogVerdict } from "./watchdog-verdict.js";

const VERDICT_RING_SIZE = 10;
/** Actual revalidation workflow invocations a carried candidate may consume. */
export const CARRIED_REVALIDATION_LIMIT = 3;
const HOLD_WIDGET_KEY = "buddy-hold";
const HOLD_HEADLINE_MAX_CHARS = 80;

export type WatchdogExpiryReason =
	| "window_closed"
	| "attempts_exhausted"
	| "session_reset"
	| "shutdown"
	| "disabled";

type WatchdogResetReason = Extract<
	WatchdogExpiryReason,
	"session_reset" | "shutdown" | "disabled"
>;

/**
 * A held candidate's delivery window: tagged once at the next actual
 * `agent_start` after the hold. Retry/follow-up runs before `agent_settled`
 * cannot renew it, and nothing reopens it after that settle.
 */
export interface WatchdogDeliveryWindow {
	runId?: string;
	/** Actual revalidation workflow invocations consumed inside this window. */
	invocations: number;
}

export interface WatchdogHold {
	heldAt: string;
	window?: WatchdogDeliveryWindow;
}

export interface WatchdogCandidate {
	id: string;
	trigger: BackgroundTrigger;
	headline: string;
	advisory: string;
	evidence: string[];
	activity: string[];
	reviewedRevision: number;
	/** Lifecycle metadata captured at launch; never rewritten from a later run. */
	originRunId?: string;
	launchedAt: string;
	stagedAt: string;
	/** Present once the candidate has been held while the session was idle. */
	hold?: WatchdogHold;
}

export type { AutomaticReviewContext } from "./buddy-context.js";

interface AutomaticReviewConsultation {
	run: ConsultationWorkflow["run"];
}

export type RecordWatchdogCommit = typeof recordWatchdogCommit;
export type RecordWatchdogCandidate = typeof recordWatchdogCandidate;
export type RecordWatchdogInserted = typeof recordWatchdogInserted;

export interface AutomaticReviewOptions {
	host: Pick<ExtensionAPI, "sendMessage">;
	consultation: AutomaticReviewConsultation;
	/** Tools for the initial detached review (review-phase verdict tool). */
	tools: readonly BuddyTool[];
	/** Tools for the commit-time revalidation (revalidation-phase verdict tool). */
	revalidationTools: readonly BuddyTool[];
	getWatchdogThreshold: () => number;
	isEnabled: () => boolean;
	reviewMessageType: string;
	backgroundStatusKey: string;
	runEndReviewMinTurns: number;
	/** Current session/run correlation; snapshotted at launch and publication. */
	getTelemetryContext?: () => BuddyTelemetryContext;
	/** Widget key for the provisional held-candidate label. */
	holdWidgetKey?: string;
	id?: () => string;
	nowIso?: () => string;
	recordCommit?: RecordWatchdogCommit;
	recordCandidate?: RecordWatchdogCandidate;
	recordInserted?: RecordWatchdogInserted;
}

type InitialWatchdogVerdict = Extract<
	WatchdogVerdict,
	{ decision: "pass" | "concern" }
>;
type RevalidationWatchdogVerdict = Extract<
	WatchdogVerdict,
	{ decision: "resolved" | "confirm" | "replace" }
>;

interface PendingHandoff {
	trigger: BackgroundTrigger;
	originRunId?: string;
	deliveryRunId?: string;
	handedOffAt: string;
	context: BuddyTelemetryContext;
}

/**
 * Owns the Automatic Review lifecycle from cadence through safe publication.
 *
 * BuddyRunTracker and WatchdogCoordinator remain internal collaborators: the
 * public Interface speaks in Pi lifecycle events and domain operations, so
 * callers cannot accidentally stage or publish half a review protocol.
 *
 * Publication happens only inside an active run, at a stable turn boundary,
 * with `deliverAs: "steer"`. A candidate that is pending while the session is
 * idle is held in the single coordinator slot (no revalidation, no
 * `sendMessage`), shown as a provisional widget, and gets exactly one later
 * delivery window: the next actual run through its `agent_settled`.
 */
export class AutomaticReview {
	private readonly tracker: BuddyRunTracker;
	private readonly coordinator = new WatchdogCoordinator<WatchdogCandidate>();
	private readonly concerns = new ConcernHistory();
	private readonly verdictRing: string[] = [];
	/** Handoffs awaiting their `message_end`, keyed by Concern ID. */
	private readonly handoffs = new Map<string, PendingHandoff>();
	private readonly id: () => string;
	private readonly nowIso: () => string;
	private readonly recordCommit: RecordWatchdogCommit;
	private readonly recordCandidate: RecordWatchdogCandidate;
	private readonly recordInserted: RecordWatchdogInserted;
	private readonly holdWidgetKey: string;
	private backgroundAbort?: AbortController;
	private runEndReviewPending = false;
	/** Context that last set the hold widget; used to clear it best-effort. */
	private holdWidgetCtx?: ExtensionContext;

	constructor(private readonly options: AutomaticReviewOptions) {
		this.tracker = new BuddyRunTracker(
			options.getWatchdogThreshold,
			options.runEndReviewMinTurns,
		);
		this.id = options.id ?? (() => `wd-${randomUUID().slice(0, 12)}`);
		this.nowIso = options.nowIso ?? (() => new Date().toISOString());
		this.recordCommit = options.recordCommit ?? recordWatchdogCommit;
		this.recordCandidate = options.recordCandidate ?? recordWatchdogCandidate;
		this.recordInserted = options.recordInserted ?? recordWatchdogInserted;
		this.holdWidgetKey = options.holdWidgetKey ?? HOLD_WIDGET_KEY;
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

	/** Detached snapshot of the held candidate, for tests and status surfaces. */
	heldCandidate(): WatchdogCandidate | undefined {
		const pending = this.coordinator.peekPending();
		if (!pending?.hold) return undefined;
		return {
			...pending,
			evidence: [...pending.evidence],
			activity: [...pending.activity],
			hold: {
				...pending.hold,
				window: pending.hold.window ? { ...pending.hold.window } : undefined,
			},
		};
	}

	restoreSession(entries: readonly SessionEntry[], ctx?: ExtensionContext): void {
		this.abort("session_reset", ctx);
		this.runEndReviewPending = false;
		this.verdictRing.length = 0;
		rebuildConcernHistory(entries, this.concerns);
	}

	restoreTree(entries: readonly SessionEntry[], ctx?: ExtensionContext): void {
		this.restoreSession(entries, ctx);
	}

	shutdown(ctx?: ExtensionContext): void {
		this.abort("shutdown", ctx);
		this.runEndReviewPending = false;
		this.verdictRing.length = 0;
		this.concerns.clear();
	}

	/**
	 * Lifecycle reset. Releases tracker/coordinator ownership synchronously
	 * before any telemetry or UI work, so a hung provider call cannot keep the
	 * protocol occupied; its continuation observes the generation change.
	 */
	abort(reason: WatchdogResetReason = "session_reset", ctx?: ExtensionContext): void {
		const pending = this.coordinator.peekPending();
		this.tracker.invalidate();
		this.coordinator.invalidate();
		this.backgroundAbort?.abort();
		this.backgroundAbort = undefined;
		this.handoffs.clear();
		this.clearHoldWidget(ctx);
		if (pending?.hold) this.recordExpiry(pending, reason);
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

	/**
	 * Observe a newly finalized message. Records `inserted` for a Concern this
	 * instance handed off and has not yet seen; historical messages are ignored
	 * because handoffs are registered only at publication.
	 */
	messageEnded(message: unknown): void {
		if (this.handoffs.size === 0 || !isRecord(message)) return;
		if (
			message.role !== "custom" ||
			message.customType !== this.options.reviewMessageType
		) {
			return;
		}
		const details = isRecord(message.details) ? message.details : undefined;
		const concernId = details?.concernId;
		if (typeof concernId !== "string") return;
		const handoff = this.handoffs.get(concernId);
		if (!handoff) return;
		this.handoffs.delete(concernId);
		void this.bestEffort(() =>
			this.recordInserted({
				...handoff.context,
				trigger: handoff.trigger,
				concernId,
				originRunId: handoff.originRunId,
				deliveryRunId: handoff.deliveryRunId,
				handedOffAt: handoff.handedOffAt,
			}),
		);
	}

	/** No model work here: only tag a held candidate's single delivery window. */
	agentStarted(_ctx?: ExtensionContext): void {
		this.runEndReviewPending = false;
		// Lifecycle transitions invalidate any revalidation snapshot in flight.
		this.coordinator.noteActivity();
		this.tracker.onAgentStart();
		this.openWindowIfHeld();
	}

	async turnEnded(ctx: ExtensionContext): Promise<void> {
		if (!this.options.isEnabled()) return;
		const lifecycle = this.tracker.lifecycleToken();
		await this.commitPending(ctx);
		// A reset (off/on, tree, session) or a run boundary while an uncooperative
		// revalidation was awaited: this continuation belongs to the old lifecycle
		// and must neither count a turn nor launch into the new one.
		if (!this.tracker.isLifecycleCurrent(lifecycle)) return;
		if (this.tracker.onTurnEnd() && !this.coordinator.hasPending) {
			this.launch("turns", ctx);
		}
	}

	agentEnded(_ctx?: ExtensionContext): void {
		// A run ending during a revalidation must invalidate its snapshot so the
		// result can never steer an idle session.
		this.coordinator.noteActivity();
		this.runEndReviewPending = this.tracker.onAgentEnd();
	}

	/**
	 * The run is idle here: never revalidate or publish. Close a carried
	 * candidate's window (expire) or hold an ordinary pending one, then apply
	 * the run-end eligibility gate against the released slot.
	 */
	async agentSettled(ctx: ExtensionContext): Promise<void> {
		const pending = this.coordinator.peekPending();
		if (pending?.hold?.window) {
			this.expire(pending, "window_closed", ctx);
		} else if (pending && !pending.hold) {
			this.hold(pending, ctx);
		}
		const shouldReview = this.runEndReviewPending;
		this.runEndReviewPending = false;
		if (!this.options.isEnabled()) return;
		// Print/JSON mode exits immediately after the run; do not launch work that
		// session shutdown would discard before completion.
		if (shouldReview && ctx.hasUI && !this.coordinator.hasPending) {
			this.launch("run_end", ctx);
		}
	}

	/** Frozen snapshot: a mutable injected object cannot rewrite origin later. */
	private telemetryContext(): BuddyTelemetryContext {
		try {
			return { ...(this.options.getTelemetryContext?.() ?? {}) };
		} catch {
			return {};
		}
	}

	/** Tag the delivery window exactly once; later runs never renew it. */
	private openWindowIfHeld(): void {
		const pending = this.coordinator.peekPending();
		if (pending?.hold && !pending.hold.window) {
			pending.hold.window = {
				runId: this.telemetryContext().runId,
				invocations: 0,
			};
		}
	}

	private recordVerdict(trigger: BackgroundTrigger, verdict: string): void {
		const time = this.nowIso().slice(11, 16);
		this.verdictRing.push(`[${time}] ${trigger}: ${verdict}`);
		if (this.verdictRing.length > VERDICT_RING_SIZE) this.verdictRing.shift();
	}

	private ageMs(candidate: WatchdogCandidate): number {
		const age = Date.parse(this.nowIso()) - Date.parse(candidate.stagedAt);
		return Number.isFinite(age) && age >= 0 ? age : 0;
	}

	/** Record one `held` transition and show the provisional widget. */
	private hold(candidate: WatchdogCandidate, ctx: ExtensionContext): void {
		if (candidate.hold) return;
		candidate.hold = { heldAt: this.nowIso() };
		this.recordVerdict(candidate.trigger, `candidate held: #${candidate.id}`);
		this.showHoldWidget(candidate, ctx);
		void this.bestEffort(() =>
			this.recordCandidate({
				...this.telemetryContext(),
				event: "held",
				trigger: candidate.trigger,
				concernId: candidate.id,
				ageMs: this.ageMs(candidate),
				originRunId: candidate.originRunId,
			}),
		);
	}

	/** Release the slot for a held candidate and record one `expired` event. */
	private expire(
		candidate: WatchdogCandidate,
		reason: WatchdogExpiryReason,
		ctx: ExtensionContext,
	): void {
		if (this.coordinator.peekPending() === candidate) {
			this.coordinator.discardPending();
		}
		this.clearHoldWidget(ctx);
		this.recordVerdict(
			candidate.trigger,
			`candidate expired (${reason}): #${candidate.id}`,
		);
		this.recordExpiry(candidate, reason);
	}

	private recordExpiry(
		candidate: WatchdogCandidate,
		reason: WatchdogExpiryReason,
	): void {
		void this.bestEffort(() =>
			this.recordCandidate({
				...this.telemetryContext(),
				event: "expired",
				reason,
				trigger: candidate.trigger,
				concernId: candidate.id,
				ageMs: this.ageMs(candidate),
				originRunId: candidate.originRunId,
				windowRunId: candidate.hold?.window?.runId,
			}),
		);
	}

	private showHoldWidget(candidate: WatchdogCandidate, ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget(this.holdWidgetKey, [
				`Buddy: unvalidated candidate pending — ${boundedHeadline(candidate.headline)}`,
			]);
			this.holdWidgetCtx = ctx;
		} catch {
			// Best-effort provisional label only.
		}
	}

	private clearHoldWidget(ctx?: ExtensionContext): void {
		const target = this.holdWidgetCtx ?? ctx;
		this.holdWidgetCtx = undefined;
		if (!target?.hasUI) return;
		try {
			target.ui.setWidget(this.holdWidgetKey, undefined);
		} catch {
			// Best-effort.
		}
	}

	private async bestEffort(work: () => Promise<void>): Promise<void> {
		try {
			await work();
		} catch {
			// Telemetry must never alter review behavior.
		}
	}

	private async commitPending(ctx: ExtensionContext): Promise<void> {
		if (!this.options.isEnabled() || !this.tracker.isRunActive) return;
		const pending = this.coordinator.peekPending();
		if (!pending) return;
		// A hold created between agent_end and agent_settled is tagged by the
		// follow-up run's agent_start; this covers any caller ordering that skips it.
		this.openWindowIfHeld();
		const window = pending.hold?.window;
		if (window && window.invocations >= CARRIED_REVALIDATION_LIMIT) {
			this.expire(pending, "attempts_exhausted", ctx);
			return;
		}

		const controller = new AbortController();
		this.backgroundAbort = controller;
		const lifecycle = this.tracker.lifecycleToken();
		const deliveryContext = this.telemetryContext();
		let attemptedTrigger: BackgroundTrigger | undefined;
		let attemptedCandidate: WatchdogCandidate | undefined;
		let attemptedSnapshot: WatchdogSnapshot | undefined;
		let attemptedRevalidationCount = 0;
		const correlation = (candidate: WatchdogCandidate) => ({
			...deliveryContext,
			originRunId: candidate.originRunId,
			deliveryRunId: deliveryContext.runId,
			windowRunId: candidate.hold?.window?.runId,
		});
		const recordCommit = (record: Parameters<RecordWatchdogCommit>[0]) =>
			this.bestEffort(() => this.recordCommit(record));
		const publish = (
			candidate: WatchdogCandidate,
			snapshot: WatchdogSnapshot,
			revalidationCount: number,
		): void => {
			const deliveredAt = this.nowIso();
			this.handoffs.set(candidate.id, {
				trigger: candidate.trigger,
				originRunId: candidate.originRunId,
				deliveryRunId: deliveryContext.runId,
				handedOffAt: deliveredAt,
				context: deliveryContext,
			});
			try {
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
							...correlation(candidate),
							heldAt: candidate.hold?.heldAt,
						},
					},
					// Publication only ever happens inside an active run.
					{ deliverAs: "steer" },
				);
			} catch (error) {
				this.handoffs.delete(candidate.id);
				throw error;
			}
			this.clearHoldWidget(ctx);
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
					// An actual invocation: carried candidates consume window budget and
					// count as this run's automatic consultation, even if this fails.
					if (candidate.hold?.window) {
						candidate.hold.window.invocations += 1;
						this.tracker.onAutomaticConsultation();
					}
					const revalidation = await this.options.consultation.run({
						ctx,
						systemPrompt: buildWatchdogRevalidationSystemPrompt(),
						requestText: buildRevalidationRequest(
							candidate,
							snapshot,
							deliveryContext.runId,
							this.nowIso(),
						),
						source: "watchdog",
						stance: "watchdog-revalidation",
						signal: controller.signal,
						statusKey: this.options.backgroundStatusKey,
						trigger: candidate.trigger,
						entries: snapshot.entries,
						extraTools: this.options.revalidationTools,
						telemetryContext: deliveryContext,
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
							...correlation(candidate),
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
				// Final eligibility: the run must still be active in the same
				// synchronous continuation as the revision check. Never steer idle.
				() => this.tracker.isRunActive,
			);

			// A reset or run boundary interleaved before this continuation resumed:
			// the coordinator already rejected the result; do not touch the new
			// lifecycle's widget, verdict ring or slot.
			if (!this.tracker.isLifecycleCurrent(lifecycle)) return;
			// All lifecycle/state updates happen synchronously here, before any
			// telemetry await, so a reset during telemetry cannot be overwritten.
			if (result.status === "suppressed") {
				this.clearHoldWidget(ctx);
				this.recordVerdict(attemptedTrigger ?? "turns", "resolved before delivery");
				if (attemptedCandidate) {
					await recordCommit({
						trigger: attemptedCandidate.trigger,
						concernId: attemptedCandidate.id,
						outcome: "resolved",
						reviewRevision: attemptedCandidate.reviewedRevision,
						commitRevision: result.snapshot.revision,
						revalidationCount: result.revalidationCount,
						...correlation(attemptedCandidate),
					});
				}
				return;
			}
			if (result.status !== "deliver") {
				this.expireIfExhausted(attemptedCandidate, ctx);
				if (
					result.status === "deferred" &&
					result.reason === "activity" &&
					attemptedCandidate &&
					attemptedSnapshot
				) {
					await recordCommit({
						trigger: attemptedCandidate.trigger,
						concernId: attemptedCandidate.id,
						outcome: "deferred",
						reason: "activity",
						reviewRevision: attemptedCandidate.reviewedRevision,
						commitRevision: attemptedSnapshot.revision,
						revalidationCount: attemptedRevalidationCount,
						...correlation(attemptedCandidate),
					});
				}
				return;
			}
			const candidate = result.candidate;
			await recordCommit({
				trigger: candidate.trigger,
				concernId: candidate.id,
				outcome: "delivered",
				reviewRevision: candidate.reviewedRevision,
				commitRevision: result.snapshot.revision,
				revalidationCount: result.revalidationCount,
				...correlation(candidate),
			});
		} catch (error) {
			if (!this.tracker.isLifecycleCurrent(lifecycle)) return;
			this.expireIfExhausted(attemptedCandidate, ctx);
			if (attemptedCandidate && attemptedSnapshot) {
				await recordCommit({
					trigger: attemptedCandidate.trigger,
					concernId: attemptedCandidate.id,
					outcome: "deferred",
					reason: "error",
					reviewRevision: attemptedCandidate.reviewedRevision,
					commitRevision: attemptedSnapshot.revision,
					revalidationCount: attemptedRevalidationCount,
					...correlation(attemptedCandidate),
				});
			}
			if (
				this.tracker.isLifecycleCurrent(lifecycle) &&
				!controller.signal.aborted && ctx.hasUI
			) {
				ctx.ui.notify(
					`Buddy watchdog revalidation deferred: ${errorToString(error)}`,
					"warning",
				);
			}
		} finally {
			if (this.backgroundAbort === controller) this.backgroundAbort = undefined;
		}
	}

	/**
	 * After an unresolved carried invocation (activity/error), a third failed
	 * invocation exhausts the window budget; there is no fourth invocation.
	 */
	private expireIfExhausted(
		candidate: WatchdogCandidate | undefined,
		ctx: ExtensionContext,
	): void {
		if (!candidate?.hold?.window) return;
		if (this.coordinator.peekPending() !== candidate) return;
		if (candidate.hold.window.invocations >= CARRIED_REVALIDATION_LIMIT) {
			this.expire(candidate, "attempts_exhausted", ctx);
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
		// Origin attribution is fixed here; detached completion must not adopt
		// whichever run happens to be current later.
		const launchContext = this.telemetryContext();
		const launchedAt = this.nowIso();
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
					telemetryContext: launchContext,
					outcomeOf: (result) => recordAutomaticOutcome(result),
					extraTelemetry: () => ({
						turnsElapsed: this.tracker.turnsElapsedSince(launch),
						reviewPhase: "review",
						reviewRevision: reviewSnapshot.revision,
						concernId: recordedOutcome === "concern" ? reviewId : undefined,
						originRunId: launchContext.runId,
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
				const candidate: WatchdogCandidate = {
					id: reviewId,
					trigger,
					headline: verdict.headline,
					advisory: verdict.advisory,
					evidence: verdict.evidence,
					activity: result.activity,
					reviewedRevision: reviewSnapshot.revision,
					originRunId: launchContext.runId,
					launchedAt,
					stagedAt: this.nowIso(),
				};
				if (!this.coordinator.stage(reviewSnapshot, candidate)) return;
				this.recordVerdict(trigger, `candidate staged: #${reviewId}`);
				// Staged during an active run: ordinary current-state revalidation at
				// the next stable turn boundary. Staged while idle: hold; never
				// revalidate or publish from here.
				if (!this.tracker.isRunActive) this.hold(candidate, ctx);
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
				this.tracker.settleBackground(launch);
				if (this.backgroundAbort === controller) this.backgroundAbort = undefined;
			}
		})();
	}
}

function buildRevalidationRequest(
	candidate: WatchdogCandidate,
	snapshot: WatchdogSnapshot,
	currentRunId: string | undefined,
	nowIso: string,
): string {
	const lines = [
		"Revalidate this private watchdog candidate against the CURRENT transcript:",
		`Candidate #${candidate.id} (${candidate.trigger})`,
		`Originally reviewed at activity revision ${candidate.reviewedRevision}.`,
		`Current commit snapshot revision: ${snapshot.revision}.`,
	];
	if (candidate.hold) {
		const heldMs = Date.parse(nowIso) - Date.parse(candidate.hold.heldAt);
		const heldFor =
			Number.isFinite(heldMs) && heldMs >= 0
				? ` (about ${Math.round(heldMs / 1000)}s ago)`
				: "";
		lines.push(
			"",
			"Carried candidate: it was produced from an EARLIER run and held while " +
				"the session was idle. The transcript may now contain a newer user " +
				"prompt, or a low-level retry/follow-up of the previous run without " +
				"one, plus the current run's first results.",
			`Held since ${candidate.hold.heldAt}${heldFor}.`,
			`Origin run: ${candidate.originRunId ?? "unknown"}. Current run: ${currentRunId ?? "unknown"}.`,
			`Revalidation invocation ${candidate.hold.window?.invocations ?? 1} of ` +
				`${CARRIED_REVALIDATION_LIMIT} in its single delivery window.`,
			"Judge it against the CURRENT request. Old evidence about a finished " +
				"task is not current intent; unrelated unfinished chores do not " +
				"justify interrupting a new question.",
		);
	}
	lines.push("", watchdogCandidateText(candidate));
	return lines.join("\n");
}

/** Single line, C0/DEL/C1 controls removed, bounded for the widget. */
function boundedHeadline(headline: string): string {
	const single = headline
		.split("")
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 0x20 && (code < 0x7f || code > 0x9f);
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	if (single.length <= HOLD_HEADLINE_MAX_CHARS) return single;
	return `${single.slice(0, HOLD_HEADLINE_MAX_CHARS - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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
