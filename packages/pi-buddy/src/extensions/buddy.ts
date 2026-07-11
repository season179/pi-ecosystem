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
 *   a colleague who checks his suspicion before interrupting. PASS verdicts
 *   are suppressed; real concerns are steered in when they land (or queued
 *   for the next turn if the run already ended — never auto-waking the agent).
 * - End-of-run review: runs of >= 2 turns that never consulted the buddy get
 *   a quiet background review at completion, same PASS-suppression.
 *
 * Buddy model defaults to zai/glm-5.2 (override with --buddy-model).
 * Stateless by design: continuity comes from the transcript itself.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
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
	classifyAutomaticVerdict,
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
} from "./telemetry.js";
import { closeBuddyBrowser, createWebTools, type ExecFn } from "./web-tools.js";

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
	const configWarningsShown = new Set<string>();

	function recordVerdict(trigger: BackgroundTrigger, verdict: string): void {
		const time = new Date().toISOString().slice(11, 16);
		verdictRing.push(`[${time}] ${trigger}: ${verdict}`);
		if (verdictRing.length > VERDICT_RING_SIZE) verdictRing.shift();
	}

	function buildInjectionBlock(
		cwd: string,
		options: { includeMemory: boolean },
	): { block?: string; memoryChars: number } {
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
		return {
			block: sections.length > 0 ? sections.join("\n\n") : undefined,
			memoryChars,
		};
	}

	const execFn: ExecFn = async (command, args, options) => {
		browserUsed = true;
		return pi.exec(command, args, options);
	};
	const webTools: BuddyTool[] = createWebTools(execFn);

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
		statusKey?: string;
		trigger?: BuddyTrigger;
		/** Maps a successful answer to a telemetry outcome (watchdog: pass/concern). */
		outcomeOf?: (result: ConsultResult) => BuddyOutcome;
		/** Extra telemetry computed at record time (e.g. verdict staleness). */
		extraTelemetry?: () => { turnsElapsed?: number };
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
							entries: args.ctx.sessionManager.getBranch(),
							cwd: args.ctx.cwd,
							model: candidate.model,
							registry: args.ctx.modelRegistry,
							signal,
							transcriptBudget:
								args.source === "watchdog"
									? automaticTranscriptBudget(candidate.model.contextWindow)
									: undefined,
							outputControl,
							extraTools: webTools,
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

	function launchBackgroundReview(
		trigger: BackgroundTrigger,
		ctx: ExtensionContext,
	): void {
		if (!buddyEnabled) return;
		const launch = tracker.launchBackground(trigger);
		const controller = new AbortController();
		backgroundAbort = controller;

		const requestText =
			trigger === "turns"
				? `Automatic watchdog check-in: the agent has completed ` +
					`${launch.watchdogThreshold} turns without consulting you. Review ` +
					`the recent turns. Reply PASS if there is no real problem.`
				: `Automatic end-of-run review: the agent has finished its run ` +
					`without consulting you. Review the work of this run. Reply PASS ` +
					`if there is no real problem.`;

		// Set once by runConsultation's telemetry outcome hook; re-derived below if absent.
		let recordedOutcome: BuddyOutcome | undefined;
		const automaticOutcome = (
			result: Pick<ConsultResult, "answer" | "truncated">,
		): BuddyOutcome => {
			// Session generation guard is impure; the verdict itself is delegated
			// to the pure, unit-tested classifier (truncated => never PASS).
			if (!tracker.isCurrent(launch)) return "discarded";
			return classifyAutomaticVerdict({
				answer: result.answer,
				truncated: result.truncated,
				turnsElapsed: tracker.turnsElapsedSince(launch),
			});
		};
		const recordAutomaticOutcome = (
			result: Pick<ConsultResult, "answer" | "truncated">,
		): BuddyOutcome => {
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
					outcomeOf: (r) => recordAutomaticOutcome(r),
					extraTelemetry: () => ({
						turnsElapsed: tracker.turnsElapsedSince(launch),
					}),
				});
				// Session was replaced/forked while we investigated: drop the verdict.
				if (!tracker.isCurrent(launch)) return;
				const outcome = recordedOutcome ?? automaticOutcome(result);
				// runConsultation already stripped directives, so PASS detection cannot
				// be spoofed by `PASS\n\nLESSON[...]`.
				if (outcome === "pass") {
					recordVerdict(trigger, "PASS");
					return;
				}
				const staleness = tracker.turnsElapsedSince(launch);
				if (outcome === "stale_suppressed") {
					recordVerdict(
						trigger,
						`stale-suppressed concern: ${result.answer.split("\n")[0].slice(0, 100)}`,
					);
					return;
				}
				recordVerdict(
					trigger,
					`concern: ${result.answer.split("\n")[0].slice(0, 120)}`,
				);
				pi.sendMessage(
					{
						customType: BUDDY_REVIEW_TYPE,
						content: formatBuddyAdvisory(trigger, staleness, result.answer),
						display: true,
						details: {
							activity: result.activity,
							source: "watchdog",
							trigger,
							turnsElapsed: staleness,
						},
					},
					// Steer mid-run; queue for the next prompt when idle. Never
					// auto-wake the agent (no triggerTurn) — nobody holds the leash.
					{ deliverAs: tracker.deliveryMode() },
				);
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
			"cadence. Use 'less' when automatic watchdog advisories are too frequent " +
			"or premature, 'more' when Buddy should be more active, and 'same' when " +
			"the current level is useful. This never disables run-end review, explicit " +
			"consult_buddy, or user /buddy consultations.",
		promptSnippet:
			"Calibrate Buddy's automatic advisory cadence with more, same, or less feedback",
		promptGuidelines: [
			"Use give_buddy_feedback when Buddy's automatic advisories are too frequent, too timid, or currently well-calibrated.",
			"Use 'less' to exponentially back off watchdog cadence; use 'more' to step Buddy back toward normal or more active review.",
			"Do not use this to avoid review: run-end review and explicit Buddy consultations remain available and are not suppressed.",
		],
		parameters: Type.Object({
			feedback: StringEnum([...BUDDY_FEEDBACKS] as ["more", "same", "less"], {
				description: "more | same | less — how Buddy should adjust automatic advisories",
			}),
			reason: Type.Optional(
				Type.String({
					description:
						"Optional brief reason for auditability. Treated as context, not proof.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!buddyEnabled) {
				throw new Error(DISABLED_MESSAGE);
			}
			const feedback = params.feedback as BuddyFeedback;
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
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
			await recordFeedback({
				feedback,
				reason: reason || undefined,
				previousLevel: result.previousLevel,
				newLevel: result.newLevel,
				watchdogThreshold: result.watchdogThreshold,
			});
			if (ctx.hasUI && feedback !== "same") {
				ctx.ui.notify(formatBuddyFeedbackResult(result), "info");
			}
			return {
				content: [{ type: "text", text: formatBuddyFeedbackResult(result) }],
				details: {
					feedback,
					reason: reason || undefined,
					previousLevel: result.previousLevel,
					newLevel: result.newLevel,
					watchdogThreshold: result.watchdogThreshold,
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
		memoryCuratedThisSession = false;
		currentSkills = [];
		verdictRing.length = 0;
		configWarningsShown.clear();
		advisoryLevel = DEFAULT_ADVISORY_LEVEL;
		calibrationNote = undefined;
		await initializeBuddySwitch(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		currentSkills = event.systemPromptOptions.skills ?? [];
	});

	pi.on("agent_start", async () => {
		tracker.onAgentStart();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!buddyEnabled) return;
		// Same guard as agent_end: in print/json mode there is no UI to show
		// the advisory, and headless runs (e.g. pi-delegate workers) would
		// pay for reviews nobody sees. Tracker still advances either way.
		if (tracker.onTurnEnd() && ctx.hasUI) {
			launchBackgroundReview("turns", ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const shouldReview = tracker.onAgentEnd();
		if (!buddyEnabled) return;
		// In print/json mode the process exits right after the run, so a
		// run-end review would always be aborted mid-flight — telemetry showed
		// only instant 'discarded' records. hasUI is false exactly in those
		// modes; don't launch a doomed consultation there.
		if (shouldReview && ctx.hasUI) {
			launchBackgroundReview("run_end", ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		tracker.invalidate();
		backgroundAbort?.abort();
		backgroundAbort = undefined;
		memoryCuratedThisSession = false;
		verdictRing.length = 0;
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
