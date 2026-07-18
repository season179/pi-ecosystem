import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { BuddyTool } from "./buddy-tool.js";
import type {
	BuddyOutcome,
	BuddySource,
	BuddyTrigger,
	ConsultationInjection,
} from "./buddy-context.js";
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
import { deriveSlug } from "./memory.js";
import type { BuddyMemory } from "./memory-contract.js";
import {
	buddyOutputControl,
	type OutputMaxTokensConfig,
} from "./output-control.js";
import {
	buddyRetryAttemptsForSource,
	classifyBuddyError,
	delayWithAbort,
	isRetriableBuddyError,
	retryDelayMs,
} from "./retry.js";
import {
	recordConsultation,
} from "./telemetry.js";

export type { ConsultationInjection } from "./buddy-context.js";

export interface ResolvedBuddyModelCandidate {
	spec: string;
	label?: string;
	model: Model<Api>;
}

export interface BuddyModelPlan {
	candidates: ResolvedBuddyModelCandidate[];
	maxAttemptsPerModel: number;
	/** Per-source-class output caps from buddy.json (undefined => defaults). */
	outputMaxTokens?: OutputMaxTokensConfig;
}

export type RunConsultationResult = ConsultResult & {
	model: string;
	modelsAttempted: string[];
	failoverUsed: boolean;
};

export interface ConsultationWorkflowRequest {
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
}

type LoadBuddyConfig = typeof loadBuddyConfig;
type ConsultBuddy = typeof consultBuddy;
type RecordConsultation = typeof recordConsultation;

export interface ConsultationWorkflowOptions {
	defaultModelSpec: () => string;
	buildInjection: (cwd: string, includeMemory: boolean) => ConsultationInjection;
	memoryStore: BuddyMemory;
	webTools: readonly BuddyTool[];
	setModelStatus: (
		ctx: ExtensionContext | undefined,
		modelSpec: string | undefined,
		options?: { failover?: boolean },
	) => void;
	notifyConfigWarnings: (
		ctx: ExtensionContext,
		warnings: readonly string[],
	) => void;
	loadConfig?: LoadBuddyConfig;
	consult?: ConsultBuddy;
	record?: RecordConsultation;
	now?: () => number;
	retryDelay?: () => number;
	delay?: typeof delayWithAbort;
}

/**
 * Owns one Consultation from Model Plan resolution through telemetry.
 *
 * Its operational Interface is deliberately small: resolve the current Model
 * Plan for status display, or run a Consultation. Stable dependencies are
 * supplied once at construction instead of repeated across every caller.
 */
export class ConsultationWorkflow {
	private readonly loadConfig: LoadBuddyConfig;
	private readonly consult: ConsultBuddy;
	private readonly record: RecordConsultation;
	private readonly now: () => number;
	private readonly retryDelay: () => number;
	private readonly delay: typeof delayWithAbort;

	constructor(private readonly options: ConsultationWorkflowOptions) {
		this.loadConfig = options.loadConfig ?? loadBuddyConfig;
		this.consult = options.consult ?? consultBuddy;
		this.record = options.record ?? recordConsultation;
		this.now = options.now ?? Date.now;
		this.retryDelay = options.retryDelay ?? retryDelayMs;
		this.delay = options.delay ?? delayWithAbort;
	}

	async resolveModelPlan(
		ctx: ExtensionContext,
		source: BuddySource,
	): Promise<BuddyModelPlan> {
		// Read per consultation so edits to buddy.json take effect immediately.
		const config = await this.loadConfig();
		const warnings = [...config.warnings];
		const configured = config.models.length > 0;
		const candidateConfigs = configured
			? config.models
			: [
					{
						id: this.options.defaultModelSpec(),
						priority: 1,
					} satisfies BuddyModelCandidate,
				];
		const candidates: ResolvedBuddyModelCandidate[] = [];
		for (const candidate of candidateConfigs) {
			try {
				candidates.push({
					spec: candidate.id,
					label: candidate.label,
					model: this.resolveModel(ctx, candidate.id),
				});
			} catch (error) {
				warnings.push(`${candidate.id}: ${errorToString(error)}`);
			}
		}
		if (configured && candidates.length === 0) {
			warnings.push(
				"No usable models in buddy.json; falling back to --buddy-model/default.",
			);
			const fallback = this.options.defaultModelSpec();
			candidates.push({ spec: fallback, model: this.resolveModel(ctx, fallback) });
		}
		this.options.notifyConfigWarnings(ctx, warnings);
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

	async run(args: ConsultationWorkflowRequest): Promise<RunConsultationResult> {
		const statusKey = args.statusKey ?? "buddy";
		const startedAt = this.now();
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
		let primaryModel = this.options.defaultModelSpec();
		try {
			const plan = await this.resolveModelPlan(args.ctx, args.source);
			primaryModel = plan.candidates[0]?.spec ?? primaryModel;
			this.options.setModelStatus(args.ctx, primaryModel);
			const injection = this.options.buildInjection(
				args.ctx.cwd,
				args.source !== "watchdog",
			);
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
				this.options.setModelStatus(args.ctx, candidate.spec, {
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
						raw = await this.consult({
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
							extraTools: args.extraTools ?? this.options.webTools,
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
							const delayMs = this.retryDelay();
							args.ctx.ui.setStatus(
								statusKey,
								`buddy: ${candidate.spec} busy; retrying in ${(delayMs / 1000).toFixed(1)}s...`,
							);
							await this.delay(delayMs, signal);
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
			this.options.setModelStatus(args.ctx, result.model, {
				failover: result.failoverUsed,
			});
			let applied = { lessons: 0, retractions: 0, retractMisses: 0 };
			// Never persist directives from a truncated answer: a line cut mid-token
			// could store a corrupt lesson or make RETRACT's substring match remove
			// the wrong entry. Harvesting still strips those lines from visible text.
			if (
				args.harvest &&
				!raw.truncated &&
				(harvested.lessons.length > 0 || harvested.retractions.length > 0)
			) {
				applied = this.options.memoryStore.applyDirectives(
					deriveSlug(args.ctx.cwd),
					harvested.lessons,
					harvested.retractions,
				);
				const notice = harvestNotice(applied);
				if (notice && args.ctx.hasUI) args.ctx.ui.notify(notice, "info");
			}
			await this.record({
				source: args.source,
				stance: args.stance,
				outcome: args.outcomeOf?.(result) ?? "ok",
				model: result.model,
				totalMs: this.now() - startedAt,
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
				retried: attempts > modelsAttempted.length,
				modelsAttempted,
				failoverUsed: result.failoverUsed,
				modelFailures: modelFailures.length > 0 ? modelFailures : undefined,
			});
			return result;
		} catch (error) {
			await this.record({
				source: args.source,
				stance: args.stance,
				outcome:
					args.source === "watchdog" && signal?.aborted ? "discarded" : "error",
				model: modelsAttempted.at(-1) ?? primaryModel,
				totalMs: this.now() - startedAt,
				trigger: args.trigger,
				attempts,
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

	private resolveModel(ctx: ExtensionContext, spec: string): Model<Api> {
		const { provider, id } = splitModelSpec(spec);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) {
			throw new Error(`Buddy model ${spec} not found in the model registry`);
		}
		return model as Model<Api>;
	}
}

export function formatFailoverLine(
	result: RunConsultationResult,
): string | undefined {
	if (!result.failoverUsed) return undefined;
	return (
		`Buddy fallback used: ${result.modelsAttempted.join(" → ")}; ` +
		`answered by ${result.model}.`
	);
}

export function formatFailoverNotice(result: RunConsultationResult): string {
	const line = formatFailoverLine(result);
	return line ? `${line}\n\n${result.answer}` : result.answer;
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
