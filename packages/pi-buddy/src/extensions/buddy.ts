/**
 * pi-buddy: a sparring partner for pi.
 *
 * - `consult_buddy` tool: the main agent requests a Buddy consultation for
 *   discussion, debate, fact-checking, or review. The buddy sees the full
 *   session transcript, has read-only repo tools (read/grep/find/ls), and read-only
 *   web tools (lookup_docs via deepwiki, read_webpage via agent-browser) to
 *   verify claims beyond both models' knowledge cutoffs.
 * - `/buddy <question>` command: the human summons the buddy directly.
 * - Detached watchdog: if 3 turns elapse in a run without a consultation, the
 *   buddy investigates IN THE BACKGROUND while the agent keeps working — like
 *   a colleague who checks his suspicion before interrupting. Structured pass
 *   verdicts are suppressed; concerns remain private until revalidated against
 *   a stable current snapshot, then are steered in (or queued for the next
 *   turn if the run already ended — never auto-waking the agent).
 * - End-of-run review: runs of >= 2 turns that never consulted the buddy get
 *   a quiet background review once the agent is fully settled, using the same
 *   revalidation gate.
 *
 * Buddy model defaults to zai/glm-5.2 (override with --buddy-model).
 * Model calls are stateless. A small branch-aware concern history prevents the
 * watchdog from re-raising concerns the agent explicitly fixed or rebutted.
 */

import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import type { BuddyTool } from "./buddy-tools.js";
import {
	applyBuddyFeedback,
	buildBuddyCalibrationBlock,
	BUDDY_FEEDBACKS,
	formatBuddyFeedbackResult,
	watchdogThresholdForLevel,
	type AdvisoryLevel,
	type BuddyCalibrationNote,
	type BuddyFeedback,
} from "./calibration.js";
import {
	loadBuddyConfig,
	splitModelSpec,
	type BuddyModelCandidate,
} from "./buddy-config.js";
import {
	automaticTranscriptBudget,
	consultBuddy,
	type ConsultResult,
} from "./consult.js";
import {
	ConcernHistory,
	rebuildConcernHistory,
	type ConcernDisposition,
} from "./concern-history.js";
import { harvestDirectives, harvestNotice } from "./harvest.js";
import {
	buddyRendererLabel,
	formatBuddyAdvisory,
	formatBuddyConsult,
	type BuddyReviewDetails,
} from "./message-format.js";
import { deriveSlug, MemoryStore } from "./memory.js";
import {
	type BackgroundTrigger,
	BuddyRunTracker,
	commandConsultDelivery,
} from "./policy.js";
import {
	buddyOutputControl,
	type OutputMaxTokensConfig,
} from "./output-control.js";
import {
	buddyRetryAttemptsForSource,
	classifyBuddyError,
	delayWithAbort,
	formatRetriableBuddyFailure,
	isRetriableBuddyError,
	retryDelayMs,
} from "./retry.js";
import {
	buildMemoryBlock,
	buildStanceSystemPrompt,
	buildVerdictDigest,
	buildWatchdogRevalidationSystemPrompt,
	buildWatchdogSystemPrompt,
	type Stance,
	STANCES,
} from "./stances.js";
import { appendSkillsToBuddyPrompt } from "./skill-prompt.js";
import {
	activeToolsWithBuddyState,
	CONSULT_BUDDY_TOOL,
	GIVE_BUDDY_FEEDBACK_TOOL,
	parseBuddyCommand,
	seedBuddyEnabledFromFlag,
} from "./switch.js";
import {
	type BuddyOutcome,
	type BuddySource,
	type BuddyTrigger,
	recordConsultation,
	recordFeedback,
	recordWatchdogCommit,
} from "./telemetry.js";
import { closeBuddyBrowser, createWebTools, type ExecFn } from "./web-tools.js";
import {
	WatchdogCoordinator,
	type WatchdogSnapshot,
} from "./watchdog-coordinator.js";
import {
	createWatchdogVerdictTool,
	type WatchdogVerdict,
} from "./watchdog-verdict.js";

const DEFAULT_BUDDY_MODEL = "zai/glm-5.2";
const DISABLED_MESSAGE = "Buddy is disabled. Run `/buddy on` to re-enable.";
const DEFAULT_ADVISORY_LEVEL: AdvisoryLevel = 0;
const RUN_END_REVIEW_MIN_TURNS = 2;
const BUDDY_REVIEW_TYPE = "buddy-review";
const STATUS_KEY = "buddy";
const BG_STATUS_KEY = "buddy-bg";
const MODEL_STATUS_KEY = "buddy-model";
const VERDICT_RING_SIZE = 10;

export default function setup(pi: ExtensionAPI): void {
	let advisoryLevel: AdvisoryLevel = DEFAULT_ADVISORY_LEVEL;
	let calibrationNote: BuddyCalibrationNote | undefined;
	const tracker = new BuddyRunTracker(
		() => watchdogThresholdForLevel(advisoryLevel),
		RUN_END_REVIEW_MIN_TURNS,
	);
	let backgroundAbort: AbortController | undefined;
	let browserUsed = false;
	let buddyEnabled = true;
	let buddySwitchSeeded = false;
	let consultToolWasActiveWhenDisabled: boolean | undefined;
	const memoryStore = new MemoryStore();
	let memoryCuratedThisSession = false;
	let currentSkills: Skill[] = [];
	const verdictRing: string[] = [];
	const concernHistory = new ConcernHistory();
	const watchdogCoordinator = new WatchdogCoordinator<WatchdogCandidate>();
	const configWarningsShown = new Set<string>();
	let runEndReviewPending = false;

	function recordVerdict(trigger: BackgroundTrigger, verdict: string): void {
		const time = new Date().toISOString().slice(11, 16);
		verdictRing.push(`[${time}] ${trigger}: ${verdict}`);
		if (verdictRing.length > VERDICT_RING_SIZE) verdictRing.shift();
	}

	function buildInjectionBlock(
		cwd: string,
		options: { includeMemory: boolean },
	): {
		block?: string;
		memoryChars: number;
		openConcerns: number;
		fixedConcerns: number;
		rebuttedConcerns: number;
		concernHistoryChars: number;
	} {
		const slug = deriveSlug(cwd);
		const sections: string[] = [];
		let memoryChars = 0;
		if (options.includeMemory) {
			if (!memoryCuratedThisSession && memoryStore.curate(slug)) {
				memoryCuratedThisSession = true;
			}
			const memory = memoryStore.readForInjection(slug);
			if (memory) {
				const memorySection = buildMemoryBlock(memory);
				memoryChars = memorySection.length;
				sections.push(memorySection);
			}
		}
		const calibration = buildBuddyCalibrationBlock(calibrationNote);
		if (calibration) sections.push(calibration);
		if (verdictRing.length > 0) {
			sections.push(buildVerdictDigest(verdictRing));
		}
		const concernDigest = concernHistory.buildDigest();
		if (concernDigest) sections.push(concernDigest);
		const concernCounts = concernHistory.counts();
		return {
			block: sections.length > 0 ? sections.join("\n\n") : undefined,
			memoryChars,
			openConcerns: concernCounts.open,
			fixedConcerns: concernCounts.fixed,
			rebuttedConcerns: concernCounts.rebutted,
			concernHistoryChars: concernDigest?.length ?? 0,
		};
	}

	const execFn: ExecFn = async (command, args, options) => {
		browserUsed = true;
		return pi.exec(command, args, options);
	};
	const webTools: BuddyTool[] = createWebTools(execFn);
	const watchdogTools: BuddyTool[] = [
		...webTools,
		createWatchdogVerdictTool(),
	];

	pi.registerFlag("buddy-disabled", {
		description:
			"Disable pi-buddy for this session. Re-enable with /buddy on.",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("buddy-model", {
		description: `Buddy model as provider/id (default: ${DEFAULT_BUDDY_MODEL})`,
		type: "string",
		default: DEFAULT_BUDDY_MODEL,
	});

	function applyBuddyToolState(enabled: boolean): void {
		try {
			const activeTools = pi.getActiveTools();
			if (!enabled && consultToolWasActiveWhenDisabled === undefined) {
				consultToolWasActiveWhenDisabled = activeTools.includes(CONSULT_BUDDY_TOOL);
			}
			const nextTools = activeToolsWithBuddyState(
				activeTools,
				enabled,
				consultToolWasActiveWhenDisabled ?? false,
			);
			const changed =
				nextTools.length !== activeTools.length ||
				nextTools.some((tool, i) => tool !== activeTools[i]);
			if (changed) pi.setActiveTools(nextTools);
		} catch {
			// Best-effort UX only; the consult_buddy execute guard is load-bearing.
		}
		if (enabled) consultToolWasActiveWhenDisabled = undefined;
	}

	function abortBackgroundReview(): void {
		tracker.invalidate();
		watchdogCoordinator.invalidate();
		backgroundAbort?.abort();
		backgroundAbort = undefined;
	}

	async function initializeBuddySwitch(ctx?: ExtensionContext): Promise<void> {
		const shouldRestoreTool = consultToolWasActiveWhenDisabled ?? false;
		const seeded = seedBuddyEnabledFromFlag(
			buddyEnabled,
			buddySwitchSeeded ? undefined : pi.getFlag("buddy-disabled"),
			buddySwitchSeeded,
		);
		buddyEnabled = seeded.enabled;
		buddySwitchSeeded = seeded.seeded;
		if (buddyEnabled) {
			applyBuddyToolState(true);
			await refreshBuddyModelStatus(ctx);
			return;
		}
		consultToolWasActiveWhenDisabled = shouldRestoreTool ? true : undefined;
		abortBackgroundReview();
		applyBuddyToolState(false);
		setBuddyModelStatus(ctx, undefined);
	}

	function notify(ctx: ExtensionContext | undefined, message: string): void {
		if (ctx?.hasUI) ctx.ui.notify(message, "info");
	}

	function setBuddyModelStatus(
		ctx: ExtensionContext | undefined,
		modelSpec: string | undefined,
		options: { failover?: boolean } = {},
	): void {
		if (!ctx?.hasUI) return;
		if (!buddyEnabled) {
			ctx.ui.setStatus(MODEL_STATUS_KEY, "buddy: off");
			return;
		}
		if (!modelSpec) {
			ctx.ui.setStatus(MODEL_STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(
			MODEL_STATUS_KEY,
			`buddy: ${modelSpec}${options.failover ? " (fallback)" : ""}`,
		);
	}

	async function refreshBuddyModelStatus(ctx: ExtensionContext | undefined): Promise<void> {
		if (!ctx?.hasUI) return;
		if (!buddyEnabled) {
			setBuddyModelStatus(ctx, undefined);
			return;
		}
		try {
			const plan = await resolveBuddyModelPlan(ctx, "tool");
			setBuddyModelStatus(ctx, plan.candidates[0]?.spec);
		} catch {
			ctx.ui.setStatus(MODEL_STATUS_KEY, "buddy: unavailable");
		}
	}

	function setBuddyEnabled(enabled: boolean, ctx?: ExtensionContext): void {
		if (enabled === buddyEnabled) {
			notify(ctx, `Buddy is already ${enabled ? "on" : "off"}.`);
			return;
		}
		buddyEnabled = enabled;
		if (!enabled) abortBackgroundReview();
		applyBuddyToolState(enabled);
		if (enabled) {
			void refreshBuddyModelStatus(ctx);
		} else {
			setBuddyModelStatus(ctx, undefined);
		}
		notify(ctx, `Buddy is now ${enabled ? "on" : "off"}.`);
	}

	function skillsFromCommandContext(ctx: ExtensionContext): Skill[] {
		const commandCtx = ctx as ExtensionContext & {
			getSystemPromptOptions?: () => BuildSystemPromptOptions;
		};
		return commandCtx.getSystemPromptOptions?.().skills ?? currentSkills;
	}

	interface ResolvedBuddyModelCandidate {
		spec: string;
		label?: string;
		model: Model<Api>;
	}

	interface BuddyModelPlan {
		candidates: ResolvedBuddyModelCandidate[];
		maxAttemptsPerModel: number;
		/** Per-source-class output caps from buddy.json (undefined => defaults). */
		outputMaxTokens?: OutputMaxTokensConfig;
	}

	type RunConsultationResult = ConsultResult & {
		model: string;
		modelsAttempted: string[];
		failoverUsed: boolean;
	};

	interface WatchdogCandidate {
		id: string;
		trigger: BackgroundTrigger;
		headline: string;
		advisory: string;
		evidence: string[];
		activity: string[];
		reviewedRevision: number;
	}

	function formatFailoverLine(result: RunConsultationResult): string | undefined {
		if (!result.failoverUsed) return undefined;
		return (
			`Buddy fallback used: ${result.modelsAttempted.join(" → ")}; ` +
			`answered by ${result.model}.`
		);
	}

	function formatFailoverNotice(result: RunConsultationResult): string {
		const line = formatFailoverLine(result);
		return line ? `${line}\n\n${result.answer}` : result.answer;
	}

	function notifyConfigWarnings(ctx: ExtensionContext, warnings: readonly string[]): void {
		if (!ctx.hasUI) return;
		for (const warning of warnings) {
			if (configWarningsShown.has(warning)) continue;
			configWarningsShown.add(warning);
			ctx.ui.notify(`Buddy config: ${warning}`, "warning");
		}
	}

	function resolveModelSpec(ctx: ExtensionContext, spec: string): Model<Api> {
		const { provider, id } = splitModelSpec(spec);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) {
			throw new Error(`Buddy model ${spec} not found in the model registry`);
		}
		return model as Model<Api>;
	}

	function defaultModelSpec(): string {
		return String(pi.getFlag("buddy-model") ?? DEFAULT_BUDDY_MODEL);
	}

	async function resolveBuddyModelPlan(
		ctx: ExtensionContext,
		source: BuddySource,
	): Promise<BuddyModelPlan> {
		// Read per consultation so edits to ~/.pi/agent/buddy.json take effect
		// immediately; no /reload or restart is required for model-chain changes.
		const config = await loadBuddyConfig();
		const warnings = [...config.warnings];
		const configured = config.models.length > 0;
		const candidateConfigs = configured
			? config.models
			: [{ id: defaultModelSpec(), priority: 1 } satisfies BuddyModelCandidate];
		const candidates: ResolvedBuddyModelCandidate[] = [];
		for (const candidate of candidateConfigs) {
			try {
				candidates.push({
					spec: candidate.id,
					label: candidate.label,
					model: resolveModelSpec(ctx, candidate.id),
				});
			} catch (error) {
				warnings.push(`${candidate.id}: ${errorToString(error)}`);
			}
		}
		if (configured && candidates.length === 0) {
			warnings.push(
				"No usable models in buddy.json; falling back to --buddy-model/default.",
			);
			candidates.push({
				spec: defaultModelSpec(),
				model: resolveModelSpec(ctx, defaultModelSpec()),
			});
		}
		notifyConfigWarnings(ctx, warnings);
		if (candidates.length === 0) {
			throw new Error("No usable Buddy model candidates configured");
		}
		return {
			candidates,
			maxAttemptsPerModel:
				config.perModelRetries === undefined
					? buddyRetryAttemptsForSource(source)
					: config.perModelRetries + 1,
			outputMaxTokens: config.outputMaxTokens,
		};
	}

	async function runConsultation(args: {
		ctx: ExtensionContext;
		systemPrompt: string;
		requestText: string;
		source: BuddySource;
		stance: string;
		/** Foreground consultations use ctx.signal; detached ones pass their own. */
		signal?: AbortSignal;
		/** Exact branch snapshot to review; defaults to the live branch for pulls. */
		entries?: readonly SessionEntry[];
		/** Extra tools for source-specific protocols such as watchdog verdicts. */
		extraTools?: readonly BuddyTool[];
		statusKey?: string;
		trigger?: BuddyTrigger;
		/** Maps a successful answer to a telemetry outcome (watchdog: pass/concern). */
		outcomeOf?: (result: ConsultResult) => BuddyOutcome;
		/** Extra telemetry computed at record time (e.g. commit revisions). */
		extraTelemetry?: () => {
			turnsElapsed?: number;
			concernId?: string;
			reviewPhase?: "review" | "revalidation";
			reviewRevision?: number;
			revalidationRevision?: number;
			revalidationCount?: number;
		};
		/** Apply harvested directives to memory (requested consults only). */
		harvest?: boolean;
		onActivity?: (line: string) => void;
	}): Promise<RunConsultationResult> {
		const statusKey = args.statusKey ?? STATUS_KEY;
		const startedAt = Date.now();
		args.ctx.ui.setStatus(statusKey, "buddy: consulting...");
		const signal = args.signal ?? args.ctx.signal;
		let attempts = 0;
		const modelsAttempted: string[] = [];
		const modelFailures: Array<{
			model: string;
			label?: string;
			errorKind: string;
			retried?: boolean;
			attempts?: number;
			error?: string;
		}> = [];
		let lastError: unknown;
		let successfulCandidate: ResolvedBuddyModelCandidate | undefined;
		let primaryModel = defaultModelSpec();
		try {
			const plan = await resolveBuddyModelPlan(args.ctx, args.source);
			primaryModel = plan.candidates[0]?.spec ?? primaryModel;
			setBuddyModelStatus(args.ctx, primaryModel);
			const injection = buildInjectionBlock(args.ctx.cwd, {
				includeMemory: args.source !== "watchdog",
			});
			const outputControl = buddyOutputControl({
				source: args.source,
				stance: args.stance,
				config: plan.outputMaxTokens,
			});
			let raw: ConsultResult | undefined;
			modelLoop: for (const candidate of plan.candidates) {
				let attemptsForModel = 0;
				if (!modelsAttempted.includes(candidate.spec)) {
					modelsAttempted.push(candidate.spec);
				}
				setBuddyModelStatus(args.ctx, candidate.spec, {
					failover: candidate.spec !== primaryModel,
				});
				for (;;) {
					attempts += 1;
					attemptsForModel += 1;
					try {
						args.ctx.ui.setStatus(
							statusKey,
							`buddy: consulting ${candidate.spec}...`,
						);
						raw = await consultBuddy({
							requestText: args.requestText,
							systemPrompt: args.systemPrompt,
							memoryBlock: injection.block,
							entries: args.entries ?? args.ctx.sessionManager.getBranch(),
							cwd: args.ctx.cwd,
							model: candidate.model,
							registry: args.ctx.modelRegistry,
							signal,
							transcriptBudget:
								args.source === "watchdog"
									? automaticTranscriptBudget(candidate.model.contextWindow)
									: undefined,
							outputControl,
							extraTools: args.extraTools ?? webTools,
							onActivity: (line) => {
								args.ctx.ui.setStatus(statusKey, `buddy: ${line}`);
								args.onActivity?.(line);
							},
						});
						successfulCandidate = candidate;
						break modelLoop;
					} catch (error) {
						lastError = error;
						const retriable = isRetriableBuddyError(error);
						if (
							!signal?.aborted &&
							retriable &&
							attemptsForModel < plan.maxAttemptsPerModel
						) {
							const delayMs = retryDelayMs();
							args.ctx.ui.setStatus(
								statusKey,
								`buddy: ${candidate.spec} busy; retrying in ${(delayMs / 1000).toFixed(1)}s...`,
							);
							await delayWithAbort(delayMs, signal);
							continue;
						}
						modelFailures.push({
							model: candidate.spec,
							label: candidate.label,
							errorKind: classifyBuddyError(error),
							retried: attemptsForModel > 1,
							attempts: attemptsForModel,
							error: errorToString(error).slice(0, 500),
						});
						if (signal?.aborted) throw error;
						break;
					}
				}
			}
			if (!raw || !successfulCandidate) {
				throw lastError ?? new Error("All Buddy model candidates failed");
			}
			const harvested = harvestDirectives(raw.answer);
			const result: RunConsultationResult = {
				...raw,
				answer: harvested.stripped,
				model: successfulCandidate.spec,
				modelsAttempted,
				failoverUsed: successfulCandidate.spec !== primaryModel,
			};
			setBuddyModelStatus(args.ctx, result.model, {
				failover: result.failoverUsed,
			});
			let applied = { lessons: 0, retractions: 0, retractMisses: 0 };
			// Never persist directives harvested from a truncated answer: a
			// LESSON/RETRACT line cut mid-token would write a corrupted lesson or
			// (via RETRACT's substring match) delete the wrong one. We still strip
			// the partial lines above so the agent never sees them.
			if (
				args.harvest &&
				!raw.truncated &&
				(harvested.lessons.length > 0 || harvested.retractions.length > 0)
			) {
				applied = memoryStore.applyDirectives(
					deriveSlug(args.ctx.cwd),
					harvested.lessons,
					harvested.retractions,
				);
				const notice = harvestNotice(applied);
				if (notice && args.ctx.hasUI) args.ctx.ui.notify(notice, "info");
			}
			await recordConsultation({
				source: args.source,
				stance: args.stance,
				outcome: args.outcomeOf?.(result) ?? "ok",
				model: result.model,
				totalMs: Date.now() - startedAt,
				trigger: args.trigger,
				...args.extraTelemetry?.(),
				rounds: result.rounds,
				toolCalls: result.activity.length,
				transcriptTokens: result.transcriptTokens,
				...result.usage,
				answerChars: result.answer.length,
				truncated: result.truncated,
				lessons: applied.lessons,
				retractions: applied.retractions,
				retractMisses: applied.retractMisses,
				memoryChars: injection.memoryChars,
				openConcerns: injection.openConcerns,
				fixedConcerns: injection.fixedConcerns,
				rebuttedConcerns: injection.rebuttedConcerns,
				concernHistoryChars: injection.concernHistoryChars,
				attempts,
				// More total attempts than distinct models means at least one model had
				// a same-model retry before success/failover.
				retried: attempts > modelsAttempted.length,
				modelsAttempted,
				failoverUsed: result.failoverUsed,
				modelFailures: modelFailures.length > 0 ? modelFailures : undefined,
			});
			return result;
		} catch (error) {
			await recordConsultation({
				source: args.source,
				stance: args.stance,
				// Aborted background reviews (session shutdown/switch) are not failures.
				outcome:
					args.source === "watchdog" && signal?.aborted ? "discarded" : "error",
				model: modelsAttempted.at(-1) ?? primaryModel,
				totalMs: Date.now() - startedAt,
				trigger: args.trigger,
				attempts,
				// More total attempts than distinct models means at least one model had
				// a same-model retry before all candidates failed.
				retried: attempts > modelsAttempted.length,
				modelsAttempted,
				failoverUsed: modelsAttempted.length > 1,
				modelFailures: modelFailures.length > 0 ? modelFailures : undefined,
				error: errorToString(error),
			});
			throw error;
		} finally {
			args.ctx.ui.setStatus(statusKey, undefined);
		}
	}

	// --- Detached background review (watchdog + end-of-run) ---

	function watchdogCandidateText(candidate: WatchdogCandidate): string {
		if (candidate.evidence.length === 0) return candidate.advisory;
		return [
			candidate.advisory,
			"",
			"Current evidence:",
			...candidate.evidence.map((entry) => `- ${entry}`),
		].join("\n");
	}

	type InitialWatchdogVerdict = Extract<
		WatchdogVerdict,
		{ decision: "pass" | "concern" }
	>;
	type RevalidationWatchdogVerdict = Extract<
		WatchdogVerdict,
		{ decision: "resolved" | "confirm" | "replace" }
	>;

	function requireInitialVerdict(result: ConsultResult): InitialWatchdogVerdict {
		const verdict = result.watchdogVerdict;
		if (!verdict || (verdict.decision !== "pass" && verdict.decision !== "concern")) {
			throw new Error(
				"Buddy watchdog did not submit a valid structured review verdict",
			);
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

	async function commitPendingReview(ctx: ExtensionContext): Promise<void> {
		if (!buddyEnabled || !watchdogCoordinator.hasPending) return;
		const controller = new AbortController();
		backgroundAbort = controller;
		let attemptedTrigger: BackgroundTrigger | undefined;
		let attemptedCandidate: WatchdogCandidate | undefined;
		let attemptedSnapshot: WatchdogSnapshot | undefined;
		let attemptedRevalidationCount = 0;
		const publish = (
			candidate: WatchdogCandidate,
			snapshot: WatchdogSnapshot,
			revalidationCount: number,
		): void => {
			const deliveredAt = new Date().toISOString();
			pi.sendMessage(
				{
					customType: BUDDY_REVIEW_TYPE,
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
				{ deliverAs: tracker.deliveryMode() },
			);
			recordVerdict(candidate.trigger, `concern delivered: #${candidate.id}`);
			concernHistory.record({
				id: candidate.id,
				trigger: candidate.trigger,
				headline: candidate.headline,
				deliveredAt,
			});
		};
		try {
			const result = await watchdogCoordinator.commit(
				ctx.sessionManager.getBranch(),
				async (candidate, snapshot, revalidationCount) => {
					attemptedTrigger = candidate.trigger;
					attemptedCandidate = candidate;
					attemptedSnapshot = snapshot;
					attemptedRevalidationCount = revalidationCount;
					const revalidation = await runConsultation({
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
						statusKey: BG_STATUS_KEY,
						trigger: candidate.trigger,
						entries: snapshot.entries,
						extraTools: watchdogTools,
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
					if (verdict.decision === "resolved") {
						return { decision: "resolved" };
					}
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
					await recordWatchdogCommit({
						trigger: attemptedCandidate.trigger,
						concernId: attemptedCandidate.id,
						outcome: "resolved",
						reviewRevision: attemptedCandidate.reviewedRevision,
						commitRevision: result.snapshot.revision,
						revalidationCount: result.revalidationCount,
					});
				}
				recordVerdict(
					attemptedTrigger ?? "turns",
					"resolved before delivery",
				);
				return;
			}
			if (result.status !== "deliver") {
				if (
					result.status === "deferred" &&
					result.reason === "activity" &&
					attemptedCandidate &&
					attemptedSnapshot
				) {
					await recordWatchdogCommit({
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
			await recordWatchdogCommit({
				trigger: candidate.trigger,
				concernId: candidate.id,
				outcome: "delivered",
				reviewRevision: candidate.reviewedRevision,
				commitRevision: result.snapshot.revision,
				revalidationCount: result.revalidationCount,
			});
		} catch (error) {
			if (attemptedCandidate && attemptedSnapshot) {
				await recordWatchdogCommit({
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
			if (backgroundAbort === controller) backgroundAbort = undefined;
		}
	}

	function launchBackgroundReview(
		trigger: BackgroundTrigger,
		ctx: ExtensionContext,
	): void {
		if (!buddyEnabled) return;
		const launch = tracker.launchBackground(trigger);
		const reviewSnapshot = watchdogCoordinator.capture(
			ctx.sessionManager.getBranch(),
		);
		const reviewId = `wd-${randomUUID().slice(0, 12)}`;
		const controller = new AbortController();
		backgroundAbort = controller;

		const requestText =
			trigger === "turns"
				? `Automatic watchdog check-in: the agent has completed ` +
					`${launch.watchdogThreshold} turns without consulting you. Review ` +
					`the supplied snapshot and submit a structured verdict.`
				: `Automatic end-of-run review: the agent has finished its run ` +
					`without consulting you. Review this run and submit a structured verdict.`;

		// Set once by runConsultation's telemetry outcome hook; re-derived below if absent.
		let recordedOutcome: BuddyOutcome | undefined;
		const automaticOutcome = (result: ConsultResult): BuddyOutcome => {
			if (!tracker.isCurrent(launch)) return "discarded";
			return requireInitialVerdict(result).decision === "pass"
				? "pass"
				: "concern";
		};
		const recordAutomaticOutcome = (result: ConsultResult): BuddyOutcome => {
			recordedOutcome = automaticOutcome(result);
			return recordedOutcome;
		};

		// Fire-and-forget: the agent keeps working while the buddy investigates.
		void (async () => {
			try {
				const result = await runConsultation({
					ctx,
					systemPrompt: buildWatchdogSystemPrompt(),
					requestText,
					source: "watchdog",
					stance: "watchdog",
					signal: controller.signal,
					statusKey: BG_STATUS_KEY,
					trigger,
					entries: reviewSnapshot.entries,
					extraTools: watchdogTools,
					outcomeOf: (r) => recordAutomaticOutcome(r),
					extraTelemetry: () => ({
						turnsElapsed: tracker.turnsElapsedSince(launch),
						reviewPhase: "review",
						reviewRevision: reviewSnapshot.revision,
						concernId:
							recordedOutcome === "concern" ? reviewId : undefined,
					}),
				});
				// Session was replaced/forked while we investigated: drop the verdict.
				if (!tracker.isCurrent(launch)) return;
				const outcome = recordedOutcome ?? automaticOutcome(result);
				if (outcome === "pass") {
					recordVerdict(trigger, "PASS");
					return;
				}
				const verdict = requireInitialVerdict(result);
				if (verdict.decision !== "concern") return;
				const staged = watchdogCoordinator.stage(reviewSnapshot, {
					id: reviewId,
					trigger,
					headline: verdict.headline,
					advisory: verdict.advisory,
					evidence: verdict.evidence,
					activity: result.activity,
					reviewedRevision: reviewSnapshot.revision,
				});
				if (!staged) return;
				recordVerdict(trigger, `candidate staged: #${reviewId}`);
				if (ctx.isIdle()) await commitPendingReview(ctx);
			} catch (error) {
				// Background review is best-effort: never surface as a failure,
				// telemetry already recorded it. Notify only if the session is live.
				if (tracker.isCurrent(launch) && !controller.signal.aborted) {
					ctx.ui.notify(
						isRetriableBuddyError(error)
							? formatRetriableBuddyFailure()
							: `Buddy background review failed: ${errorToString(error)}`,
						"warning",
					);
				}
			} finally {
				tracker.settleBackground();
				if (backgroundAbort === controller) backgroundAbort = undefined;
			}
		})();
	}

	// --- The consult_buddy tool (agent-requested consult) ---

	pi.registerTool({
		name: CONSULT_BUDDY_TOOL,
		label: "Consult Buddy",
		description:
			"Consult your sparring partner (a separate model with read-only access " +
			"to this repository, the web, and the full conversation transcript). " +
			"Stances: 'discuss' explores tradeoffs and alternatives; 'debate' " +
			"steelmans the case AGAINST your proposal; 'fact_check' verifies claims " +
			"against actual files, library docs, and the web (useful past your " +
			"knowledge cutoff); 'review' checks recent work for correctness and " +
			"missed requirements. The buddy is candid and will push back — treat " +
			"its concerns seriously, but you remain responsible for the final " +
			"decision.",
		promptSnippet:
			"Consult a candid sparring partner to discuss, debate, fact-check, or review",
		promptGuidelines: [
			"Use consult_buddy (stance 'debate' or 'discuss') after initial orientation (reading files, searching) but before committing to a significant design or architectural decision — orientation is not substantive work; writing is.",
			"Use consult_buddy (stance 'fact_check') when making claims about the codebase, or about library APIs/versions/best practices, that you have not directly verified this session — the buddy can check current docs and the web beyond your knowledge cutoff.",
			"Use consult_buddy (stance 'review') after completing a substantial piece of work and before declaring it done — make the deliverable durable first (files written, changes committed), then ask for the review.",
		],
		parameters: Type.Object({
			stance: StringEnum([...STANCES] as ["discuss", "debate", "fact_check", "review"], {
				description:
					"discuss | debate | fact_check | review — how the buddy should engage",
			}),
			question: Type.String({
				description:
					"What you want the buddy's take on. Be specific; include your current position or the claims to check.",
			}),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			if (!buddyEnabled) {
				throw new Error(DISABLED_MESSAGE);
			}
			tracker.onPull();
			const stance = params.stance as Stance;
			const activity: string[] = [];
			const result = await runConsultation({
				ctx,
				systemPrompt: appendSkillsToBuddyPrompt(
					buildStanceSystemPrompt(stance),
					currentSkills,
				),
				requestText: params.question,
				source: "tool",
				stance,
				harvest: true,
				onActivity: (line) => {
					activity.push(line);
					onUpdate?.({
						content: [{ type: "text", text: `buddy: ${line}` }],
						details: { stance, activity: [...activity] },
					});
				},
			});
			return {
				content: [{ type: "text", text: formatFailoverNotice(result) }],
				details: {
					stance,
					question: params.question,
					activity: result.activity,
					rounds: result.rounds,
					transcriptTokens: result.transcriptTokens,
					usage: result.usage,
					model: result.model,
					modelsAttempted: result.modelsAttempted,
					failoverUsed: result.failoverUsed,
				},
			};
		},
		renderCall(args, theme, context) {
			const stance = typeof args.stance === "string" ? args.stance : "…";
			const question =
				typeof args.question === "string" ? args.question : "";
			let content = theme.fg("toolTitle", theme.bold("buddy "));
			content += theme.fg("accent", `[${stance}] `);
			content += theme.fg("muted", question);
			// Reuse the previous component instance per docs best practice.
			const text =
				(context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(content);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = (result.details ?? {}) as {
				activity?: string[];
				rounds?: number;
			};
			if (isPartial) {
				const last = details.activity?.at(-1);
				text.setText(
					theme.fg("warning", last ? `buddy: ${last}` : "buddy is thinking..."),
				);
				return text;
			}
			const answer = result.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("\n");
			let content = answer;
			if (expanded && details.activity && details.activity.length > 0) {
				content += "\n\n" + theme.fg("dim", "Buddy verified via:");
				for (const line of details.activity) {
					content += "\n" + theme.fg("dim", `  ${line}`);
				}
			} else if (details.activity && details.activity.length > 0) {
				content +=
					"\n" +
					theme.fg(
						"dim",
						`(buddy ran ${details.activity.length} read-only lookup(s))`,
					);
			}
			text.setText(content);
			return text;
		},
	});

	// --- The give_buddy_feedback tool (agent-requested calibration) ---

	pi.registerTool({
		name: GIVE_BUDDY_FEEDBACK_TOOL,
		label: "Give Buddy Feedback",
		description:
			"Give session-scoped feedback that calibrates Buddy's automatic advisory " +
			"cadence and optionally records whether a watchdog concern was fixed or " +
			"rebutted. Use 'less' when automatic advisories are too frequent or " +
			"premature, 'more' when Buddy should be more active, and 'same' when the " +
			"current level is useful. This never disables run-end review, explicit " +
			"consult_buddy, or user /buddy consultations.",
		promptSnippet:
			"Calibrate Buddy's automatic advisory cadence with more, same, or less feedback",
		promptGuidelines: [
			"Use give_buddy_feedback when Buddy's automatic advisories are too frequent, too timid, or currently well-calibrated.",
			"Use give_buddy_feedback with concernDisposition 'fixed' after fixing a watchdog concern, or 'rebutted' after disproving it with evidence; include a concrete reason.",
			"Use 'less' to exponentially back off watchdog cadence; use 'more' to step Buddy back toward normal or more active review.",
			"Do not use this to avoid review: run-end review and explicit Buddy consultations remain available and are not suppressed.",
		],
		parameters: Type.Object({
			feedback: StringEnum([...BUDDY_FEEDBACKS] as ["more", "same", "less"], {
				description: "more | same | less — how Buddy should adjust automatic advisories",
			}),
			concernId: Type.Optional(
				Type.String({
					description:
						"Concern ID from a Buddy advisory. Omit to target the latest open concern.",
				}),
			),
			concernDisposition: Type.Optional(
				StringEnum(["fixed", "rebutted"] as const, {
					description:
						"fixed when the concern was addressed; rebutted when evidence disproved it",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description:
						"Brief reason for auditability. Required when recording a concern disposition; treated as context, not proof.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!buddyEnabled) {
				throw new Error(DISABLED_MESSAGE);
			}
			const feedback = params.feedback as BuddyFeedback;
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const concernId =
				typeof params.concernId === "string" ? params.concernId.trim() : "";
			const concernDisposition = params.concernDisposition as
				| ConcernDisposition
				| undefined;
			if (concernId && !concernDisposition) {
				throw new Error("concernId requires concernDisposition");
			}
			if (concernDisposition && !reason) {
				throw new Error("A concrete reason is required to mark a concern");
			}
			const concernUpdate = concernDisposition
				? concernHistory.mark({
						id: concernId || undefined,
						disposition: concernDisposition,
						reason,
					})
				: undefined;
			if (concernUpdate && !concernUpdate.ok) {
				const message =
					concernUpdate.reason === "no_open_concern"
						? "No open Buddy concern is available to mark"
						: concernUpdate.reason === "not_found"
							? `Buddy concern #${concernId} was not found`
							: `Buddy concern #${concernId} is already closed`;
				throw new Error(message);
			}
			const result = applyBuddyFeedback(advisoryLevel, feedback);
			advisoryLevel = result.newLevel;
			if (feedback !== "same") {
				calibrationNote = {
					feedback,
					reason: reason || undefined,
					level: result.newLevel,
					watchdogThreshold: result.watchdogThreshold,
				};
			}
			const updatedConcern = concernUpdate?.ok
				? concernUpdate.concern
				: undefined;
			await recordFeedback({
				feedback,
				reason: reason || undefined,
				previousLevel: result.previousLevel,
				newLevel: result.newLevel,
				watchdogThreshold: result.watchdogThreshold,
				concernId: updatedConcern?.id,
				concernDisposition: updatedConcern?.status as
					| ConcernDisposition
					| undefined,
			});
			if (ctx.hasUI && feedback !== "same") {
				ctx.ui.notify(formatBuddyFeedbackResult(result), "info");
			}
			const dispositionResult = updatedConcern
				? `Concern #${updatedConcern.id} marked ${updatedConcern.status}: ${
						updatedConcern.status === "rebutted"
							? updatedConcern.reason
							: updatedConcern.headline
					}`
				: undefined;
			return {
				content: [
					{
						type: "text",
						text: [formatBuddyFeedbackResult(result), dispositionResult]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					feedback,
					reason: reason || undefined,
					previousLevel: result.previousLevel,
					newLevel: result.newLevel,
					watchdogThreshold: result.watchdogThreshold,
					concernId: updatedConcern?.id,
					concernHeadline: updatedConcern?.headline,
					concernDisposition: updatedConcern?.status,
				},
			};
		},
		renderCall(args, theme, context) {
			const feedback = typeof args.feedback === "string" ? args.feedback : "…";
			const reason = typeof args.reason === "string" ? args.reason : "";
			let content = theme.fg("toolTitle", theme.bold("buddy feedback "));
			content += theme.fg("accent", `[${feedback}] `);
			content += theme.fg("muted", reason);
			const text =
				(context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(content);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text =
				(context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const answer = result.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("\n");
			text.setText(theme.fg("muted", answer));
			return text;
		},
	});

	// --- /buddy command (user-requested consult) ---

	pi.registerCommand("buddy", {
		description:
			"Ask Buddy or control it (usage: /buddy <question>|on|off|status)",
		handler: async (args, ctx) => {
			const parsed = parseBuddyCommand(args);
			if (parsed.kind === "control") {
				if (parsed.action === "status") {
					notify(ctx, `Buddy is ${buddyEnabled ? "on" : "off"}.`);
					return;
				}
				setBuddyEnabled(parsed.action === "on", ctx);
				return;
			}
			if (!buddyEnabled) {
				if (ctx.hasUI) ctx.ui.notify(DISABLED_MESSAGE, "warning");
				return;
			}
			let question = parsed.kind === "ask" ? parsed.question : "";
			if (!question && ctx.hasUI) {
				question =
					(await ctx.ui.input("Ask the buddy:", "What do you think about...")) ??
					"";
			}
			if (!question) return;
			tracker.onPull();
			try {
				const result = await runConsultation({
					ctx,
					systemPrompt: appendSkillsToBuddyPrompt(
						buildStanceSystemPrompt("discuss"),
						skillsFromCommandContext(ctx),
					),
					requestText:
						`The HUMAN USER is asking you directly (not the agent):\n\n${question}`,
					source: "command",
					stance: "discuss",
					harvest: true,
				});
				const fallbackLine = formatFailoverLine(result);
				const message = {
					customType: BUDDY_REVIEW_TYPE,
					content: fallbackLine
						? `${fallbackLine}\n\n${formatBuddyConsult(result.answer)}`
						: formatBuddyConsult(result.answer),
					display: true,
					details: {
						activity: result.activity,
						source: "command",
						model: result.model,
						modelsAttempted: result.modelsAttempted,
						failoverUsed: result.failoverUsed,
					},
				};
				if (commandConsultDelivery(tracker.deliveryMode()) === "immediate") {
					pi.sendMessage(message);
				} else {
					pi.sendMessage(message, { deliverAs: "nextTurn" });
				}
			} catch (error) {
				ctx.ui.notify(`Buddy failed: ${errorToString(error)}`, "error");
			}
		},
	});

	// --- /buddy-memory command (user curation surface) ---

	pi.registerCommand("buddy-memory", {
		description:
			"Show buddy memory (usage: /buddy-memory [clear <global|project>])",
		handler: async (args, ctx) => {
			const slug = deriveSlug(ctx.cwd);
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "clear") {
				const scope = parts[1];
				if (scope !== "global" && scope !== "project") {
					if (ctx.hasUI) {
						ctx.ui.notify("Usage: /buddy-memory clear <global|project>", "warning");
					}
					return;
				}
				const cleared = memoryStore.clear(scope, slug);
				if (ctx.hasUI) {
					ctx.ui.notify(
						cleared
							? `Buddy ${scope} memory archived and cleared.`
							: `No ${scope} memory to clear.`,
						"info",
					);
				}
				return;
			}
			const sections: string[] = [];
			for (const [label, file] of [
				["Global", memoryStore.globalPath()],
				["Project", memoryStore.projectPath(slug)],
			] as const) {
				const lines = memoryStore.readLines(file);
				sections.push(`${label} (${file}):`);
				if (lines.length === 0) {
					sections.push("  (empty)");
				} else {
					lines.forEach((line, i) => {
						sections.push(
							line.kind === "entry"
								? `  ${i + 1}. [${line.date}] ${line.text}`
								: `  ${i + 1}. ${line.line}`,
						);
					});
				}
				sections.push("");
			}
			sections.push("Edit the files directly to curate; delete a line to forget it.");
			pi.sendMessage({
				customType: BUDDY_REVIEW_TYPE,
				content: sections.join("\n"),
				display: true,
				details: { source: "memory" },
			});
		},
	});

	// --- Automatic triggers ---

	pi.on("session_start", async (_event, ctx) => {
		abortBackgroundReview();
		runEndReviewPending = false;
		memoryCuratedThisSession = false;
		currentSkills = [];
		verdictRing.length = 0;
		rebuildConcernHistory(ctx.sessionManager.getBranch(), concernHistory);
		configWarningsShown.clear();
		advisoryLevel = DEFAULT_ADVISORY_LEVEL;
		calibrationNote = undefined;
		await initializeBuddySwitch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		abortBackgroundReview();
		runEndReviewPending = false;
		verdictRing.length = 0;
		rebuildConcernHistory(ctx.sessionManager.getBranch(), concernHistory);
	});

	// Every main-session mutation advances the optimistic commit token. A
	// revalidation that overlaps any of these events is discarded and retried at
	// the next stable boundary.
	pi.on("input", () => {
		watchdogCoordinator.noteActivity();
	});

	pi.on("turn_start", () => {
		watchdogCoordinator.noteActivity();
	});

	pi.on("message_end", () => {
		watchdogCoordinator.noteActivity();
	});

	pi.on("tool_execution_start", (event) => {
		watchdogCoordinator.toolStarted(event.toolCallId);
	});

	pi.on("tool_execution_end", (event) => {
		watchdogCoordinator.toolEnded(event.toolCallId);
	});

	pi.on("user_bash", () => {
		watchdogCoordinator.noteActivity();
	});

	pi.on("before_agent_start", async (event) => {
		currentSkills = event.systemPromptOptions.skills ?? [];
	});

	pi.on("agent_start", async () => {
		runEndReviewPending = false;
		tracker.onAgentStart();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!buddyEnabled) return;
		await commitPendingReview(ctx);
		// Unlike agent_end, no hasUI guard: turn-cadence reviews deliver via
		// pi.sendMessage steering, which reaches the agent loop even without
		// a UI. Headless delegate workers are excluded upstream by
		// --no-extensions, not here.
		if (tracker.onTurnEnd() && !watchdogCoordinator.hasPending) {
			launchBackgroundReview("turns", ctx);
		}
	});

	pi.on("agent_end", async () => {
		runEndReviewPending = tracker.onAgentEnd();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await commitPendingReview(ctx);
		const shouldReview = runEndReviewPending;
		runEndReviewPending = false;
		if (!buddyEnabled) return;
		// In print/json mode the process exits right after the run, so a
		// run-end review would always be aborted mid-flight — telemetry showed
		// only instant 'discarded' records. hasUI is false exactly in those
		// modes; don't launch a doomed consultation there.
		if (shouldReview && ctx.hasUI && !watchdogCoordinator.hasPending) {
			launchBackgroundReview("run_end", ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		abortBackgroundReview();
		runEndReviewPending = false;
		memoryCuratedThisSession = false;
		verdictRing.length = 0;
		concernHistory.clear();
		configWarningsShown.clear();
		advisoryLevel = DEFAULT_ADVISORY_LEVEL;
		calibrationNote = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setStatus(BG_STATUS_KEY, undefined);
			ctx.ui.setStatus(MODEL_STATUS_KEY, undefined);
		}
		if (browserUsed) {
			await closeBuddyBrowser((command, args, options) =>
				pi.exec(command, args, options),
			);
			browserUsed = false;
		}
	});

	// --- Rendering for pushed reviews ---

	// Pushed buddy messages render as a visually distinct block: label header,
	// an accent gutter bar on every line, and the custom-message background —
	// so even a long concern cannot be mistaken for the agent's own prose.
	pi.registerMessageRenderer(BUDDY_REVIEW_TYPE, (message, options, theme) => {
		const body =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => (block as { text: string }).text)
						.join("\n");
		const label = buddyRendererLabel(
			message.details as BuddyReviewDetails | undefined,
		);
		const lines: string[] = [
			theme.fg("customMessageLabel", theme.bold(label)),
			...body.split("\n").map(
				(line) =>
					theme.fg("borderAccent", "▌ ") +
					theme.fg("customMessageText", line),
			),
		];
		if (options.expanded) {
			const details = message.details as { activity?: string[] } | undefined;
			if (details?.activity?.length) {
				lines.push(theme.fg("dim", "Verified via:"));
				for (const line of details.activity) {
					lines.push(theme.fg("dim", `  ${line}`));
				}
			}
		}
		const box = new Box(1, 0, (s) => theme.bg("customMessageBg", s));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
