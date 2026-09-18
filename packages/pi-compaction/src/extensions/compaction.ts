import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../engine/message.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_CONFIG, configFingerprint, loadConfig, type CompactionConfig, type LoadedConfig } from "../adapter/config.js";
import { currentObservationId, hasChildren, passFingerprint } from "../adapter/pressure.js";
import { READ_PAGE_DEFAULT, indexArchive, listArchive, readArchive, searchArchive, type ArchiveItem } from "../adapter/recall.js";
import {
	MODE_ENTRY,
	PASS_ENTRY,
	PIN_ENTRY,
	SCOPE_ENTRY,
	activeDecisions,
	decidedIds,
	emptyState,
	lastPass,
	pinnedIds,
	restoreState,
	restoreStateAt,
	type ModeRecord,
	type PassRecord,
	type PinRecord,
	type ScopeRecord,
	type SessionState,
} from "../adapter/state.js";
import { collectCandidates } from "../engine/candidates.js";
import { charsPerFourEstimator, estimateMessages, evaluateHeadroom } from "../engine/estimate.js";
import { fingerprint, newPassId } from "../engine/identity.js";
import { decide } from "../engine/policy.js";
import { buildSkeleton, type Skeleton } from "../engine/skeleton.js";
import { applyDecisions, reconcileDecisions } from "../engine/transform.js";
import type { Candidate, CandidateCollection, ContextEntry, Decision, DecisionMap, ExclusionReason } from "../engine/types.js";
import { TypeSafeScorer, type Scorer, type ScoringRequestMetric } from "../scoring/client.js";
import { runScoring, type ScoringRunResult } from "../scoring/pass.js";
import { planBatches } from "../scoring/questions.js";
import { TelemetryStore, type ReasonCode, type TelemetryCandidate, type TelemetryInput } from "../telemetry.js";
import { VERSION } from "../version.js";

export const RECALL_TOOL_NAME = "compaction_recall";
export const COMMAND_NAME = "compaction";
export const API_KEY_ENV = "TYPESAFE_API_KEY";
export const TELEMETRY_SUBDIR = join("pi-compaction", "telemetry");
export const PREVIEW_SUBDIR = join("pi-compaction", "preview");
/** Custom session entry holding a report; custom entries never enter the model context. */
export const REPORT_ENTRY = "pi-compaction.report.v1";
/** Pi's default reserve when settings omit it (mirrors DEFAULT_COMPACTION_SETTINGS). */
const DEFAULT_RESERVE_TOKENS = 16_384;
const SCORING_PROVIDER = "typesafe";
const SCORING_DEFAULT_MODEL = "jev-latest";

const RECALL_DESCRIPTION =
	"Read original tool outputs from this session's archive. Some earlier tool results in your context are " +
	"shortened to a one-line '[pi-compaction]' note, and some completed read-only calls are omitted entirely; the " +
	"originals remain on disk. Use action 'list' (omitted first) to see archive ids, 'search' to find text inside " +
	"archived outputs, and 'read' with an archive id to fetch the original, paged by offset/limit. 'read' keeps the " +
	"original in context for the rest of the session unless restore=false is passed.";

const RecallParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("search"), Type.Literal("read")], { description: "list | search | read" }),
	query: Type.Optional(Type.String({ description: "search: text to look for in archived outputs (case-insensitive)" })),
	id: Type.Optional(Type.String({ description: "read: archive id from list/search (or the tool call id)" })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "list/read: start position (items for list, characters for read)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000, description: "list: max items (default 30); read: max characters (default 8000)" })),
	omittedOnly: Type.Optional(Type.Boolean({ description: "list: only results currently shortened or omitted (default true)" })),
	restore: Type.Optional(Type.Boolean({ description: "read: pin the original back into context for this session (default true; pass false to read without restoring)" })),
});

interface Overlay {
	beforeTokens: number;
	afterTokens: number;
	replaced: number;
	dropped: number;
	/** Newest pass whose decisions were actually applied to this request. */
	passId: string | undefined;
}

export interface ExtensionDependencies {
	/** Override the scorer (tests inject fakes). Defaults to a TypeSafe client keyed from the environment. */
	scorer?: Scorer;
	/** Override the telemetry store (tests inject a tracked one). */
	telemetry?: TelemetryStore;
	/** Override the agent directory (config file, telemetry and previews live below it). */
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Where long command output goes without a UI (defaults to stderr). */
	output?: (text: string) => void;
}

/** Build the extension factory; the default export is `createCompactionExtension()`. */
export function createCompactionExtension(deps: ExtensionDependencies = {}) {
	return function compactionExtension(pi: ExtensionAPI): void {
		const env = deps.env ?? process.env;
		const now = deps.now ?? (() => Date.now());
		const agentDir = deps.agentDir ?? getAgentDir();
		const output = deps.output ?? ((text: string) => process.stderr.write(`${text}\n`));
		let loaded: LoadedConfig = { config: parseDefaults(), source: "defaults", problems: [] };
		let scorer: Scorer = deps.scorer ?? new TypeSafeScorer({ apiKey: env[API_KEY_ENV] });
		let telemetry: TelemetryStore | undefined = deps.telemetry;
		const pendingWrites = new Set<Promise<void>>();
		let state: SessionState = emptyState();
		let sessionKey = "";
		let sessionId = "";
		let turn = 0;
		let overlay: Overlay | undefined;
		let cancelledByUs = false;
		let scoringInFlight = false;
		let lastScoringAt = 0;

		const cfg = (): CompactionConfig => loaded.config;
		const enabled = (): boolean => state.enabled ?? cfg().enabled;
		const mode = (): "on" | "off" => (enabled() ? "on" : "off");
		const modelKeyOf = (ctx: ExtensionContext): string => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown");
		const scoringModel = (): string => cfg().model ?? SCORING_DEFAULT_MODEL;

		function store(): TelemetryStore {
			telemetry ??= new TelemetryStore(join(agentDir, TELEMETRY_SUBDIR), { now });
			return telemetry;
		}

		/** Monotone per-branch turn: the number of user prompts on the current branch. */
		function currentTurn(ctx: ExtensionContext): number {
			let count = 0;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "user") count++;
			}
			turn = count;
			return count;
		}

		function record(input: Omit<TelemetryInput, "sessionId" | "version" | "mode"> & Partial<Pick<TelemetryInput, "mode">>, ctx?: ExtensionContext): void {
			if (!sessionKey) return;
			const event: TelemetryInput = {
				...input,
				sessionId: sessionKey,
				version: VERSION,
				mode: input.mode ?? mode(),
				timestamp: input.timestamp ?? now(),
				configFingerprint: input.configFingerprint ?? configFingerprint(cfg()),
			};
			if (ctx?.model) {
				event.provider ??= ctx.model.provider;
				event.model ??= ctx.model.id;
			}
			if (ctx && event.measures?.turn === undefined) event.measures = { ...event.measures, turn: currentTurn(ctx) };
			const write = store()
				.record(event)
				.catch(() => undefined)
				.finally(() => pendingWrites.delete(write));
			pendingWrites.add(write);
		}

		/** Wait for queued telemetry writes (used at shutdown so nothing is lost on exit). */
		async function flushTelemetry(): Promise<void> {
			while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites]);
		}

		function passIdFor(toolCallId: string): string | undefined {
			for (let index = state.passes.length - 1; index >= 0; index--) {
				if (state.passes[index].decisions.some((decision) => decision.toolCallId === toolCallId)) return state.passes[index].passId;
			}
			return undefined;
		}

		function refreshKey(): void {
			sessionKey = fingerprint(`pi-compaction:session:${sessionId}${state.scopeId ? `:${state.scopeId}` : ""}`, 32);
		}

		function reload(ctx: ExtensionContext): void {
			state = restoreState(ctx.sessionManager.getBranch());
			sessionId = ctx.sessionManager.getSessionId();
			refreshKey();
			overlay = undefined;
		}

		async function init(ctx: ExtensionContext): Promise<void> {
			loaded = await loadConfig(agentDir);
			if (!deps.scorer) scorer = new TypeSafeScorer({ apiKey: env[API_KEY_ENV], model: cfg().model });
			reload(ctx);
			if (loaded.problems.length > 0 && ctx.hasUI) ctx.ui.notify(`pi-compaction config: ${loaded.problems.join("; ")}`, "warning");
		}

		pi.on("session_start", async (event, ctx) => {
			await init(ctx);
			record({ kind: "session", outcome: "started", reason: event.reason === "fork" ? "user_request" : undefined }, ctx);
		});

		pi.on("session_tree", async (event, ctx) => {
			reload(ctx);
			// Continuing from an interior node creates a sibling of an existing branch: give it its own
			// telemetry scope so sibling traffic never closes another branch's pass interval. Moving to
			// an existing tip adopts that branch's scope (or the session scope).
			if (event.newLeafId !== event.oldLeafId && hasChildren(ctx.sessionManager.getEntries(), event.newLeafId)) {
				const scope: ScopeRecord = { scopeId: newPassId(), createdAt: now() };
				pi.appendEntry(SCOPE_ENTRY, scope);
				state.scopeId = scope.scopeId;
				refreshKey();
			}
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			record({ kind: "session", outcome: "ended" }, ctx);
			await flushTelemetry();
		});

		pi.on("message_end", async (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || !message.usage) return;
			const usage = message.usage;
			const measured = usage.input + usage.cacheRead + usage.cacheWrite;
			if (measured <= 0) return;
			const contextWindow = ctx.model?.contextWindow;
			const prices = ctx.model ? apiRates(ctx.model.cost, measured) : undefined;
			record(
				{
					kind: "request",
					role: "coding",
					outcome: message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "completed",
					passId: overlay?.passId,
					measures: {
						turn: currentTurn(ctx),
						inputTokens: usage.input,
						outputTokens: usage.output,
						cacheReadTokens: usage.cacheRead,
						cacheWriteTokens: usage.cacheWrite,
						contextTokensMeasured: measured,
						...(contextWindow ? { contextFractionMeasured: measured / contextWindow } : {}),
						...(overlay ? { contextBeforeTokensEstimate: overlay.beforeTokens, contextAfterTokensEstimate: overlay.afterTokens } : {}),
					},
					...(prices ? { prices } : {}),
				},
				ctx,
			);
		});

		// Replay only: apply committed decisions to the outgoing context. Never scores, never touches the network.
		pi.on("context", async (event) => {
			overlay = undefined;
			if (!enabled()) return;
			const decisions = activeDecisions(state);
			if (decisions.size === 0) return;
			const result = applyDecisions(event.messages, decisions, pinnedIds(state));
			if (result.replaced.length === 0 && result.dropped.length === 0) return;
			overlay = {
				beforeTokens: estimateMessages(event.messages, charsPerFourEstimator),
				afterTokens: estimateMessages(result.messages, charsPerFourEstimator),
				replaced: result.replaced.length,
				dropped: result.dropped.length,
				passId: newestPassOf([...result.replaced, ...result.dropped]),
			};
			return { messages: result.messages };
		});

		function newestPassOf(toolCallIds: readonly string[]): string | undefined {
			const ids = new Set(toolCallIds);
			for (let index = state.passes.length - 1; index >= 0; index--) {
				if (state.passes[index].decisions.some((decision) => decision.effective !== "keep" && ids.has(decision.toolCallId))) return state.passes[index].passId;
			}
			return undefined;
		}

		pi.on("session_before_compact", async (event, ctx) => {
			if (event.reason !== "threshold") return undefined; // manual and overflow compaction are never intercepted
			if (!enabled()) return undefined; // baseline mode: Pi compacts as usual, telemetry keeps observing
			if (!scorer.configured) {
				return fallback({ kind: "pass", outcome: "skipped", reason: "not_configured" }, ctx);
			}
			if (scoringInFlight) return undefined;
			scoringInFlight = true;
			try {
				return await onThresholdCompaction(event, ctx);
			} catch (error) {
				fallback({ kind: "error", outcome: "failed", reason: "error" }, ctx);
				if (ctx.hasUI) ctx.ui.notify(`pi-compaction: scoring failed (${describe(error)}); Pi will summarize as usual`, "warning");
				return undefined;
			} finally {
				scoringInFlight = false;
			}
		});

		/**
		 * The payload Pi's usage observation was measured against: the overlay as it stood when the
		 * observed assistant message was appended (its decisions, pins and mode), applied to the
		 * live messages. Savings are always measured from this baseline, so restores, pins and
		 * mode changes since the observation are accounted for instead of credited twice.
		 */
		function observedPayload(branch: readonly SessionEntry[], observationId: string, messages: readonly AgentMessage[]): AgentMessage[] {
			const then = restoreStateAt(branch, observationId);
			if (!(then.enabled ?? cfg().enabled)) return [...messages];
			return applyDecisions(messages, activeDecisions(then), pinnedIds(then)).messages;
		}

		async function onThresholdCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<{ cancel: true } | undefined> {
			const branch = ctx.sessionManager.getBranch();
			const observationId = currentObservationId(branch);
			const leafBefore = ctx.sessionManager.getLeafId();
			const contextWindow = ctx.model?.contextWindow;
			if (!contextWindow || observationId === undefined) {
				return fallback({ kind: "pass", outcome: "skipped", reason: "unknown_accounting" }, ctx);
			}
			const reserveTokens = event.preparation.settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
			const marginTokens = cfg().marginTokens + Math.floor(cfg().marginFraction * contextWindow);
			const headroom = (estimatedSavings: number) =>
				evaluateHeadroom({ tokensBefore: event.preparation.tokensBefore, estimatedSavings, contextWindow, reserveTokens, savingsFactor: cfg().savingsFactor, marginTokens });
			const configFp = configFingerprint(cfg());
			const modelKey = modelKeyOf(ctx);

			const entries = contextEntriesOf(ctx.sessionManager.buildContextEntries());
			const messages = entries.map((entry) => entry.message);
			const pins = pinnedIds(state);
			const observed = observedPayload(branch, observationId, messages);
			const observedTokens = estimateMessages(observed, charsPerFourEstimator);
			const savingsOf = (decisions: DecisionMap): number => observedTokens - estimateMessages(applyDecisions(messages, decisions, pins).messages, charsPerFourEstimator);

			const previous = lastPass(state);
			// Same observation as an already committed pass: the pruned payload has not been measured
			// yet, so no new evidence exists. Cancel again only if what is pruned right now (after any
			// restore, pin or mode change since that pass) still fits under the same config and model.
			if (previous && previous.observationId === observationId) {
				const current = activeDecisions(state);
				const savings = current.size > 0 ? savingsOf(current) : 0;
				const fit = headroom(savings);
				const fresh = previous.configFingerprint === configFp && (previous.modelKey ?? modelKey) === modelKey;
				const skip = { kind: "pass", outcome: "skipped", reason: "duplicate_observation", passId: previous.passId, measures: { contextBeforeTokensEstimate: event.preparation.tokensBefore, contextAfterTokensEstimate: fit.predictedTokens } } as const;
				if (fresh && savings > 0 && fit.fits) {
					record(skip, ctx);
					return cancelSummary(previous.passId, ctx);
				}
				return fallback(skip, ctx);
			}

			const collection = collectCandidates(entries, {
				protectRecentGroups: cfg().protectRecentGroups,
				pinned: pins,
				decided: decidedIds(state),
				protectedTools: new Set([RECALL_TOOL_NAME]),
			});
			const reasons = countReasons(collection.excluded);
			if (collection.candidates.length === 0) {
				return fallback({ kind: "pass", outcome: "skipped", reason: "no_candidates", reasons, measures: { candidates: 0, excluded: collection.excluded.length } }, ctx);
			}
			const fp = passFingerprint(collection.candidates.map((candidate) => candidate.toolCallId), configFp, modelKey);
			if (previous && previous.fingerprint === fp) {
				return fallback({ kind: "pass", outcome: "skipped", reason: "stale", passId: previous.passId, reasons, measures: { candidates: collection.candidates.length } }, ctx);
			}
			if (now() - lastScoringAt < cfg().scoringCooldownMs) {
				return fallback({ kind: "pass", outcome: "skipped", reason: "other", reasons, measures: { candidates: collection.candidates.length } }, ctx);
			}

			const skeleton = buildSkeleton(entries, collection.candidates, { maxStateTokens: cfg().maxStateTokens });
			if (!skeleton) {
				return fallback({ kind: "pass", outcome: "skipped", reason: "budget", reasons, measures: { candidates: collection.candidates.length } }, ctx);
			}
			const withheld = new Set(skeleton.withheld);
			const scorable = collection.candidates.filter((candidate) => !withheld.has(candidate.toolCallId));
			if (withheld.size > 0) reasons.secret = (reasons.secret ?? 0) + withheld.size;

			const passId = newPassId();
			lastScoringAt = now();
			const scoring = await score(skeleton, scorable, event.signal);
			recordScoringRequests(scoring.requestMetrics, passId, ctx);
			if (scoring.failure && scoring.scores.size === 0) {
				return fallback({ kind: "pass", outcome: "failed", reason: scoring.failure, passId, reasons, measures: { candidates: collection.candidates.length, latencyMs: scoring.latencyMs } }, ctx);
			}

			const policy = { keepThreshold: cfg().keepThreshold, pairDroppableTools: new Set(cfg().pairDroppableTools) };
			const requested = collection.candidates.map((candidate) => decide(candidate, scoring.scores.get(candidate.toolCallId), policy));
			const existing = [...activeDecisions(state).values()];
			const reconciledAll = reconcileDecisions(messages, [...existing, ...requested], pins);
			const newIds = new Set(requested.map((decision) => decision.toolCallId));
			const reconciled = reconciledAll.filter((decision) => newIds.has(decision.toolCallId));

			const nextDecisions = new Map(activeDecisions(state));
			for (const decision of reconciled) if (decision.effective !== "keep") nextDecisions.set(decision.toolCallId, decision);
			const estimatedSavings = savingsOf(nextDecisions);

			const stats = {
				candidates: collection.candidates.length,
				scored: scoring.scores.size,
				kept: reconciled.filter((decision) => decision.effective === "keep").length,
				replaced: reconciled.filter((decision) => decision.effective === "drop_result").length,
				dropped: reconciled.filter((decision) => decision.effective === "drop_pair").length,
				requests: scoring.requests,
				latencyMs: scoring.latencyMs,
				skeletonTokens: skeleton.tokens,
				skeletonStage: skeleton.stage,
			};
			const pass: PassRecord = {
				passId,
				observationId,
				fingerprint: fp,
				configFingerprint: configFp,
				modelKey,
				createdAt: now(),
				threshold: cfg().keepThreshold,
				estimatedSavings,
				stats,
				decisions: reconciled,
			};

			// Transactional commit: the branch must be exactly what we scored.
			if (event.signal.aborted || ctx.sessionManager.getLeafId() !== leafBefore || ctx.sessionManager.getSessionId() !== sessionId) {
				return fallback({ kind: "pass", outcome: "cancelled", reason: event.signal.aborted ? "cancelled" : "stale", passId, reasons, measures: { candidates: stats.candidates, latencyMs: scoring.latencyMs } }, ctx);
			}
			pi.appendEntry(PASS_ENTRY, pass);
			state.passes.push(pass);
			for (const decision of reconciled) {
				state.considered.add(decision.toolCallId);
				if (decision.effective !== "keep" && !state.decisions.has(decision.toolCallId)) state.decisions.set(decision.toolCallId, decision);
			}
			const fit = headroom(estimatedSavings);
			record(
				{
					kind: "pass",
					outcome: "committed",
					reason: "threshold",
					passId,
					configFingerprint: configFp,
					// Partial scoring failures are counted per failed attempt; unscored candidates were kept.
					reasons: scoring.failure ? { ...reasons, [scoring.failure]: (reasons[scoring.failure] ?? 0) + scoring.failedRequests } : reasons,
					measures: {
						candidates: stats.candidates,
						eligible: scorable.length,
						kept: stats.kept,
						replaced: stats.replaced,
						dropped: stats.dropped,
						excluded: collection.excluded.length,
						contextBeforeTokensEstimate: event.preparation.tokensBefore,
						contextAfterTokensEstimate: fit.predictedTokens,
						latencyMs: scoring.latencyMs,
					},
					candidates: telemetryCandidates(reconciled, collection.candidates),
				},
				ctx,
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-compaction: ${stats.replaced} result(s) shortened, ${stats.dropped} pair(s) omitted (est. −${estimatedSavings} tokens); ` +
						(fit.fits && stats.replaced + stats.dropped > 0 ? "summary deferred" : "summary proceeds"),
					"info",
				);
			}
			if (stats.replaced + stats.dropped > 0 && fit.fits) return cancelSummary(passId, ctx);
			// Nothing pruned, or not enough: Pi's summary proceeds over the originals.
			return fallback({ kind: "pass", outcome: "skipped", reason: "insufficient_reduction", passId, measures: { contextAfterTokensEstimate: fit.predictedTokens } }, ctx);
		}

		function score(skeleton: Skeleton, candidates: readonly Candidate[], signal?: AbortSignal): Promise<ScoringRunResult> {
			return runScoring({
				skeleton,
				candidates,
				scorer,
				maxRequestTokens: cfg().maxRequestTokens,
				maxCandidatesPerBatch: cfg().maxCandidatesPerBatch,
				concurrency: cfg().concurrency,
				timeoutMs: cfg().timeoutMs,
				deadlineMs: cfg().deadlineMs,
				signal,
			});
		}

		/** One event per measured transport attempt; TypeSafe reports input totals without a cache split. */
		function recordScoringRequests(metrics: readonly ScoringRequestMetric[], passId: string | undefined, ctx: ExtensionContext): void {
			for (const metric of metrics) {
				record(
					{
						kind: "request",
						role: "scoring",
						passId,
						provider: SCORING_PROVIDER,
						model: scoringModel(),
						outcome: metric.outcome,
						reason: metric.outcome === "failed" ? metric.failure ?? "error" : undefined,
						measures: {
							latencyMs: Math.round(metric.latencyMs),
							...(metric.usage ? { reportedInputTokens: metric.usage.inputTokens, outputTokens: metric.usage.outputTokens } : {}),
						},
					},
					ctx,
				);
			}
		}

		/**
		 * The threshold hook declines to prune and Pi's summary proceeds: exactly one event per
		 * hook invocation carries `fallback: true` with the concrete reason. Successful
		 * cancellations, baseline-off and manual/overflow compaction are never fallbacks.
		 */
		function fallback(input: Parameters<typeof record>[0], ctx: ExtensionContext): undefined {
			record({ ...input, fallback: true }, ctx);
			return undefined;
		}

		function cancelSummary(passId: string, ctx: ExtensionContext): { cancel: true } {
			cancelledByUs = true;
			record({ kind: "summary", outcome: "cancelled", reason: "threshold", passId }, ctx);
			return { cancel: true };
		}

		pi.on("session_compact", async (event, ctx) => {
			record({ kind: "summary", outcome: "completed", reason: event.reason, passId: lastPass(state)?.passId }, ctx);
			reload(ctx);
		});

		pi.on("session_compact_failed", async (event, ctx) => {
			if (event.aborted && cancelledByUs) {
				cancelledByUs = false;
				return;
			}
			record({ kind: "summary", outcome: event.aborted ? "cancelled" : "failed", reason: event.aborted ? "cancelled" : "error" }, ctx);
		});

		pi.registerTool({
			name: RECALL_TOOL_NAME,
			label: "Compaction recall",
			description: RECALL_DESCRIPTION,
			promptSnippet: "compaction_recall: read original tool outputs that were shortened or omitted from context",
			promptGuidelines: [
				"A tool result shown as a one-line '[pi-compaction]' note has its original archived. Call compaction_recall with action 'read' and the archive id from the note when you need the original again.",
			],
			parameters: RecallParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const items = indexArchive(ctx.sessionManager.getBranch(), activeDecisions(state), state.pins);
				if (params.action === "list") {
					const omittedOnly = params.omittedOnly ?? true;
					const page = listArchive(items, { omittedOnly, offset: params.offset ?? 0, limit: Math.min(params.limit ?? 30, 200) });
					record({ kind: "recall", outcome: "completed", reason: "user_request", measures: { candidates: page.total } }, ctx);
					const lines = page.items.map(formatItem);
					const header = `${page.total} archived result(s)${omittedOnly ? " currently shortened or omitted" : ""}; showing ${page.items.length} from offset ${params.offset ?? 0}.`;
					return textResult([header, ...lines].join("\n"));
				}
				if (params.action === "search") {
					if (!params.query?.trim()) return textResult("search requires a non-empty query");
					const matches = searchArchive(items, params.query, Math.min(params.limit ?? 20, 100));
					record({ kind: "recall", outcome: "completed", reason: "user_request", measures: { candidates: matches.length } }, ctx);
					if (matches.length === 0) return textResult(`no archived output matches ${JSON.stringify(params.query)}`);
					return textResult(matches.map((match) => `${formatItem(match)}\n    ${match.matches} match(es): ${match.snippet.replace(/\s+/g, " ")}`).join("\n"));
				}
				if (!params.id) return textResult("read requires an archive id (see action 'list')");
				const page = readArchive(items, params.id, params.offset ?? 0, params.limit ?? READ_PAGE_DEFAULT);
				if (!page) return textResult(`no archived result with id ${params.id} on this branch`);
				const passId = passIdFor(page.item.toolCallId);
				record({ kind: "recall", outcome: "completed", passId }, ctx);
				let note = "";
				if ((params.restore ?? true) && page.item.omitted !== "none" && !state.pins.has(page.item.toolCallId)) {
					pin(page.item, "recall", ctx);
					note = "\n[original restored to context for this session]";
				}
				const range = `chars ${page.offset}–${page.offset + page.text.length} of ${page.total}${page.nextOffset !== undefined ? `; continue with offset=${page.nextOffset}` : ""}`;
				return textResult(`${formatItem(page.item)} (${range})${note}\n${page.text}`);
			},
		});

		function pin(item: Pick<ArchiveItem, "toolCallId" | "id">, reason: PinRecord["reason"], ctx: ExtensionContext): void {
			const record_: PinRecord = { toolCallId: item.toolCallId, resultEntryId: item.id, reason, createdAt: now() };
			pi.appendEntry(PIN_ENTRY, record_);
			state.pins.set(item.toolCallId, record_);
			record({ kind: "restore", outcome: "completed", reason: reason === "recall" ? undefined : "user_request", passId: passIdFor(item.toolCallId) }, ctx);
		}

		// Reports are shown from a custom entry: visible in the TUI transcript, never sent to the model.
		pi.registerEntryRenderer<{ text: string }>(REPORT_ENTRY, (entry) => ({
			render(width: number): string[] {
				const columns = Math.max(20, width);
				const lines: string[] = [];
				for (const line of String(entry.data?.text ?? "").split("\n")) {
					if (line.length <= columns) lines.push(line);
					else for (let start = 0; start < line.length; start += columns) lines.push(line.slice(start, start + columns));
				}
				return lines;
			},
			invalidate(): void {},
		}));

		pi.registerCommand(COMMAND_NAME, {
			description: "Structured context pruning: on | off | status | restore <id|all> | preview | score | report [days] | feedback bad-prune [passId] | export <path>",
			getArgumentCompletions: (prefix) =>
				["on", "off", "status", "restore", "preview", "score", "report", "feedback bad-prune", "export"]
					.filter((item) => item.startsWith(prefix))
					.map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				const say = (text: string, type: "info" | "warning" | "error" = "info") => {
					if (ctx.hasUI) ctx.ui.notify(text, type);
					else output(text);
				};
				switch (sub) {
					case "on":
					case "off": {
						const next = sub === "on";
						const mode_: ModeRecord = { enabled: next, createdAt: now() };
						pi.appendEntry(MODE_ENTRY, mode_);
						state.enabled = next;
						record({ kind: "mode", outcome: next ? "enabled" : "disabled", reason: "user_request", passId: lastPass(state)?.passId }, ctx);
						if (next && !scorer.configured) say(`pi-compaction is on for this session, but ${API_KEY_ENV} is not set: nothing will be pruned until a key is available. Baseline telemetry continues.`, "warning");
						else say(next ? "pi-compaction: on for this session (scoring runs only when Pi's threshold compaction would start)" : "pi-compaction: off for this session; originals are sent again");
						return;
					}
					case "restore": {
						const target = rest[0];
						if (!target) return say("usage: /compaction restore <archive id|all>", "warning");
						const items = indexArchive(ctx.sessionManager.getBranch(), activeDecisions(state), state.pins);
						const targets = target === "all" ? items.filter((item) => item.omitted !== "none") : items.filter((item) => item.id === target || item.toolCallId === target);
						if (targets.length === 0) return say(target === "all" ? "pi-compaction: nothing is currently pruned" : `pi-compaction: no archived result ${target} on this branch`, "warning");
						for (const item of targets) if (!state.pins.has(item.toolCallId)) pin(item, "user", ctx);
						return say(`pi-compaction: restored ${targets.length} result(s); they are sent in full from the next request`);
					}
					case "preview":
						return say(await preview(ctx));
					case "score": {
						if (!scorer.configured) return say(`pi-compaction: ${API_KEY_ENV} is not set; cannot score`, "warning");
						say("pi-compaction: scoring current candidates (nothing is committed)…");
						return say(await scorePreview(ctx));
					}
					case "report": {
						const days = parseDays(rest[0]);
						const text = `pi-compaction report (${days}d)\n${await store().report(days)}`;
						pi.appendEntry(REPORT_ENTRY, { text, days, createdAt: now() });
						if (ctx.hasUI) ctx.ui.notify("pi-compaction: report added to the transcript (not sent to the model)", "info");
						else output(text);
						return;
					}
					case "feedback": {
						if (rest[0] !== "bad-prune") return say("usage: /compaction feedback bad-prune [passId]", "warning");
						const passId = rest[1] ?? lastPass(state)?.passId;
						if (!passId) return say("pi-compaction: no pass to label on this branch", "warning");
						record({ kind: "feedback", outcome: "bad_prune", reason: "bad_prune", passId }, ctx);
						return say(`pi-compaction: recorded bad-prune feedback for pass ${passId}`);
					}
					case "export": {
						const path = rest[0];
						if (!path) return say("usage: /compaction export <new file path> [days]", "warning");
						const result = await store().exportMetadata(path, parseDays(rest[1]));
						return say(result.available ? `pi-compaction: exported ${result.exportedEvents} metadata event(s) to ${path}` : `pi-compaction: export failed (${result.reason ?? "unknown"})`, result.available ? "info" : "warning");
					}
					case "status":
					default:
						return say(status(ctx));
				}
			},
		});

		function status(ctx: ExtensionContext): string {
			const active = activeDecisions(state);
			let replaced = 0;
			let dropped = 0;
			for (const decision of active.values()) decision.effective === "drop_pair" ? dropped++ : replaced++;
			const last = lastPass(state);
			const lines = [
				`pi-compaction ${VERSION}: ${enabled() ? "on" : "off"}${state.enabled === undefined ? " (config default)" : " (session override)"}; scoring key ${scorer.configured ? "present" : `missing (${API_KEY_ENV})`}`,
				`config: ${loaded.source}${loaded.problems.length ? `, problems: ${loaded.problems.join("; ")}` : ""}; keepThreshold ${cfg().keepThreshold}, protectRecentGroups ${cfg().protectRecentGroups}`,
				`overlay: ${replaced} result(s) shortened, ${dropped} pair(s) omitted, ${state.pins.size} pinned, ${state.passes.length} pass(es) on this branch`,
				overlay ? `last request: ~${overlay.beforeTokens} → ~${overlay.afterTokens} estimated tokens` : "last request: overlay not applied",
				last ? `last pass ${last.passId}: ${last.stats.scored}/${last.stats.candidates} scored, ${last.stats.replaced} shortened, ${last.stats.dropped} omitted, ${last.stats.requests} request(s), ${last.stats.latencyMs} ms` : "no pass yet",
			];
			const usage = ctx.getContextUsage();
			if (usage) lines.push(`context: ${usage.tokens ?? "?"} / ${usage.contextWindow} tokens`);
			return lines.join("\n");
		}

		function collect(ctx: ExtensionContext): { entries: ContextEntry[]; collection: CandidateCollection } {
			const entries = contextEntriesOf(ctx.sessionManager.buildContextEntries());
			const collection = collectCandidates(entries, {
				protectRecentGroups: cfg().protectRecentGroups,
				pinned: pinnedIds(state),
				decided: decidedIds(state),
				protectedTools: new Set([RECALL_TOOL_NAME]),
			});
			return { entries, collection };
		}

		/**
		 * Exactly what a pass would send, without sending it: the redacted, fitted state and the
		 * question batches are written to a private file; the interface shows a bounded summary.
		 */
		async function preview(ctx: ExtensionContext): Promise<string> {
			const { entries, collection } = collect(ctx);
			const reasons = countReasons(collection.excluded);
			const skeleton = buildSkeleton(entries, collection.candidates, { maxStateTokens: cfg().maxStateTokens });
			const totalChars = collection.candidates.reduce((sum, candidate) => sum + candidate.resultChars, 0);
			const lines = [
				`pi-compaction preview: ${collection.candidates.length} candidate(s) (~${Math.ceil(totalChars / 4)} result tokens), ${collection.excluded.length} excluded ${formatReasons(reasons)}`,
			];
			if (!skeleton) {
				lines.push(`state does not fit ${cfg().maxStateTokens} tokens; nothing would be sent`);
				return lines.join("\n");
			}
			const withheld = new Set(skeleton.withheld);
			const scorable = collection.candidates.filter((candidate) => !withheld.has(candidate.toolCallId));
			const plan = planBatches(scorable, skeleton.tokens, cfg().maxRequestTokens, cfg().maxCandidatesPerBatch);
			lines.push(`state: ~${skeleton.tokens} tokens (${skeleton.stage}), ${skeleton.redactions} redaction(s), ${withheld.size} withheld; ${plan.batches.length} request(s) would be sent to ${SCORING_PROVIDER}/${scoringModel()}, ${plan.unbatched.length} candidate(s) do not fit any request`);
			const payload = {
				createdAt: new Date(now()).toISOString(),
				version: VERSION,
				configFingerprint: configFingerprint(cfg()),
				scoringModel: scoringModel(),
				candidates: collection.candidates.map((candidate) => ({ shortId: candidate.shortId, toolName: candidate.toolName, archiveId: candidate.resultEntryId, resultChars: candidate.resultChars, withheld: withheld.has(candidate.toolCallId) })),
				excluded: reasons,
				state: skeleton.state,
				requests: plan.batches.map((batch) => ({ candidates: batch.candidates.map((candidate) => candidate.shortId), questions: batch.questions })),
				unbatched: plan.unbatched.map((candidate) => candidate.shortId),
			};
			const dir = join(agentDir, PREVIEW_SUBDIR);
			const path = join(dir, `preview-${now()}.json`);
			try {
				await mkdir(dir, { recursive: true, mode: 0o700 });
				await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600, flag: "wx" });
				lines.push(`exact state and questions written to ${path} (nothing was sent)`);
			} catch (error) {
				lines.push(`could not write the preview file (${describe(error)})`);
			}
			lines.push(...collection.candidates.slice(0, 12).map((candidate) => `  ${candidate.shortId} ${candidate.toolName} ${candidate.resultChars} chars (id ${candidate.resultEntryId})${withheld.has(candidate.toolCallId) ? " withheld" : ""}`));
			if (collection.candidates.length > 12) lines.push(`  … ${collection.candidates.length - 12} more in the file`);
			return lines.join("\n");
		}

		async function scorePreview(ctx: ExtensionContext): Promise<string> {
			const { entries, collection } = collect(ctx);
			if (collection.candidates.length === 0) return "pi-compaction: no candidates to score";
			const skeleton = buildSkeleton(entries, collection.candidates, { maxStateTokens: cfg().maxStateTokens });
			if (!skeleton) return `pi-compaction: state does not fit ${cfg().maxStateTokens} tokens`;
			const withheld = new Set(skeleton.withheld);
			const scoring = await score(skeleton, collection.candidates.filter((candidate) => !withheld.has(candidate.toolCallId)));
			recordScoringRequests(scoring.requestMetrics, undefined, ctx);
			const policy = { keepThreshold: cfg().keepThreshold, pairDroppableTools: new Set(cfg().pairDroppableTools) };
			const lines = collection.candidates.map((candidate) => {
				const scores = scoring.scores.get(candidate.toolCallId);
				const decision = decide(candidate, scores, policy);
				return `  ${candidate.shortId} ${candidate.toolName} ${candidate.resultChars} chars → ${decision.requested}${scores ? ` (call ${scores.keepCall.toFixed(2)}, result ${scores.keepResult.toFixed(2)})` : " (unscored)"}`;
			});
			return [`pi-compaction score preview: ${scoring.scores.size}/${collection.candidates.length} scored in ${scoring.requests} request(s), ${scoring.latencyMs} ms${scoring.failure ? `, failure: ${scoring.failure}` : ""}`, ...lines].join("\n");
		}
	};
}

function parseDefaults(): CompactionConfig {
	// loadConfig() replaces this on session_start; until then the defaults apply.
	return { ...DEFAULT_CONFIG, pairDroppableTools: [...DEFAULT_CONFIG.pairDroppableTools] };
}

function parseDays(raw: string | undefined): number {
	const match = /^(\d{1,3})d?$/.exec(raw ?? "");
	const days = match ? Number(match[1]) : 7;
	return Math.min(90, Math.max(1, days));
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
	return { content: [{ type: "text", text }], details: {} };
}

function formatItem(item: ArchiveItem): string {
	const status = item.pinned ? "pinned" : item.omitted === "pair" ? "omitted" : item.omitted === "result" ? "shortened" : "in context";
	return `- ${item.id}  ${item.toolName} ${item.arguments}  ${item.chars} chars${item.isError ? " (error)" : ""}  turn ${item.turn}  [${status}]`;
}

function countReasons(excluded: ReadonlyArray<{ reason: ExclusionReason }>): Partial<Record<ReasonCode, number>> {
	const reasons: Partial<Record<ReasonCode, number>> = {};
	for (const item of excluded) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
	return reasons;
}

function formatReasons(reasons: Partial<Record<ReasonCode, number>>): string {
	const parts = Object.entries(reasons).map(([reason, count]) => `${reason} ${count}`);
	return parts.length ? `(${parts.join(", ")})` : "";
}

function telemetryCandidates(decisions: readonly Decision[], candidates: readonly Candidate[]): TelemetryCandidate[] {
	const byId = new Map(candidates.map((candidate) => [candidate.toolCallId, candidate] as const));
	return decisions.slice(0, 64).map((decision) => ({
		id: fingerprint(`pi-compaction:candidate:${decision.resultEntryId}`, 32),
		decision: decision.effective === "drop_pair" ? "drop" : decision.effective === "drop_result" ? "replace" : "keep",
		reason: decision.downgradeReason,
		estimatedTokens: Math.ceil((byId.get(decision.toolCallId)?.resultChars ?? decision.resultChars) / 4),
		callProbability: decision.scores?.keepCall,
		resultProbability: decision.scores?.keepResult,
	}));
}

interface ModelCostLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
}

/**
 * pi-ai's `Model.cost` holds API list rates in USD per million tokens (pi-ai's
 * `calculateCost` divides `rates.x * usage.x` by 1e6), with optional request-wide tiers
 * chosen by total input. All-zero rates mean the catalog has no price: nothing is emitted.
 */
export function apiRates(cost: ModelCostLike | undefined, inputTokens: number): TelemetryInput["prices"] | undefined {
	if (!cost) return undefined;
	let rates: ModelCostLike = cost;
	let matched = -1;
	for (const tier of cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			rates = tier;
			matched = tier.inputTokensAbove;
		}
	}
	const values = [rates.input, rates.output, rates.cacheRead, rates.cacheWrite];
	if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
	if (values.every((value) => value === 0)) return undefined;
	return {
		source: "provider_api_rates",
		inputPerMillionUsd: rates.input,
		outputPerMillionUsd: rates.output,
		cacheReadPerMillionUsd: rates.cacheRead,
		cacheWritePerMillionUsd: rates.cacheWrite,
	};
}

/** Map Pi's context entries to messages with archive identity, mirroring buildSessionContext. */
export function contextEntriesOf(entries: readonly SessionEntry[]): ContextEntry[] {
	const result: ContextEntry[] = [];
	for (const entry of entries) {
		switch (entry.type) {
			case "message":
				result.push({ id: entry.id, message: entry.message });
				break;
			case "compaction":
			case "branch_summary":
				result.push({ message: summaryMessage(entry.summary, entry.timestamp) });
				break;
			case "custom_message":
				result.push({ message: { role: "user", content: typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content, timestamp: Date.parse(entry.timestamp) || 0 } });
				break;
			default:
				break;
		}
	}
	return result;
}

function summaryMessage(summary: string, timestamp: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text: summary }], timestamp: Date.parse(timestamp) || 0 };
}

export default createCompactionExtension();
