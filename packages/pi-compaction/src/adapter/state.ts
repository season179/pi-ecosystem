import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Action, Decision, DecisionMap, ExclusionReason } from "../engine/types.js";

export const PASS_ENTRY = "pi-compaction.pass.v1";
export const PIN_ENTRY = "pi-compaction.pin.v1";
export const MODE_ENTRY = "pi-compaction.mode.v1";
/** Telemetry observation scope: rotated when the user continues from an interior tree node. */
export const SCOPE_ENTRY = "pi-compaction.scope.v1";

export interface PassStats {
	candidates: number;
	scored: number;
	kept: number;
	replaced: number;
	dropped: number;
	requests: number;
	latencyMs: number;
	skeletonTokens: number;
	skeletonStage: string;
}

/** One committed scoring pass, persisted as a custom session entry on the branch. */
export interface PassRecord {
	passId: string;
	/** Entry id of the assistant message whose usage was current when the pass was scored. */
	observationId: string | undefined;
	/** Fingerprint of the eligible candidate set plus decision-relevant config. */
	fingerprint: string;
	configFingerprint: string;
	/** Coding model (provider/id) whose usage the pass reacted to; a different model is fresh pressure. */
	modelKey?: string;
	createdAt: number;
	threshold: number;
	/** Estimated tokens the pass removes from the observed context. */
	estimatedSavings: number;
	stats: PassStats;
	decisions: Decision[];
}

export interface PinRecord {
	toolCallId: string;
	resultEntryId: string;
	reason: "user" | "recall";
	createdAt: number;
}

export interface ModeRecord {
	enabled: boolean;
	createdAt: number;
}

export interface ScopeRecord {
	scopeId: string;
	createdAt: number;
}

export interface SessionState {
	/** Branch-level enablement override; undefined means use the config default. */
	enabled: boolean | undefined;
	passes: PassRecord[];
	/** Applied decisions by tool-call id, pins excluded. */
	decisions: Map<string, Decision>;
	pins: Map<string, PinRecord>;
	/**
	 * Tool-call ids a pass has judged since the last compaction or branch summary. Keeps
	 * are not re-asked within one summary interval; after Pi summarizes, the retained
	 * suffix becomes scoreable again because the evidence the keep rested on is gone.
	 */
	considered: Set<string>;
	/** Newest telemetry scope on the branch, if any; undefined means the session-level scope. */
	scopeId: string | undefined;
}

export function emptyState(): SessionState {
	return { enabled: undefined, passes: [], decisions: new Map(), pins: new Map(), considered: new Set(), scopeId: undefined };
}

const ACTIONS: ReadonlySet<Action> = new Set<Action>(["keep", "drop_result", "drop_pair"]);
const ID_PATTERN = /^[A-Za-z0-9_.:|-]{1,128}$/;

function isId(value: unknown): value is string {
	return typeof value === "string" && ID_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function parseDecision(raw: unknown): Decision | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (!isId(record.toolCallId) || !isId(record.resultEntryId) || typeof record.toolName !== "string") return undefined;
	if (!ACTIONS.has(record.requested as Action) || !ACTIONS.has(record.effective as Action)) return undefined;
	if (!isFiniteNumber(record.resultChars) || record.resultChars < 0) return undefined;
	const decision: Decision = {
		toolCallId: record.toolCallId,
		resultEntryId: record.resultEntryId,
		toolName: record.toolName.slice(0, 128),
		resultChars: record.resultChars,
		requested: record.requested as Action,
		effective: record.effective as Action,
	};
	if (typeof record.downgradeReason === "string") decision.downgradeReason = record.downgradeReason as ExclusionReason;
	const scores = record.scores as Record<string, unknown> | undefined;
	if (scores && isFiniteNumber(scores.keepCall) && isFiniteNumber(scores.keepResult)) {
		decision.scores = { keepCall: scores.keepCall, keepResult: scores.keepResult };
	}
	return decision;
}

export function parsePass(raw: unknown): PassRecord | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (!isId(record.passId) || typeof record.fingerprint !== "string" || typeof record.configFingerprint !== "string") return undefined;
	if (!isFiniteNumber(record.createdAt) || !isFiniteNumber(record.threshold) || !isFiniteNumber(record.estimatedSavings)) return undefined;
	if (!Array.isArray(record.decisions)) return undefined;
	const decisions: Decision[] = [];
	for (const item of record.decisions) {
		const decision = parseDecision(item);
		if (!decision) return undefined;
		decisions.push(decision);
	}
	const stats = (record.stats ?? {}) as Record<string, unknown>;
	const number = (key: string): number => (isFiniteNumber(stats[key]) ? (stats[key] as number) : 0);
	return {
		passId: record.passId,
		observationId: isId(record.observationId) ? record.observationId : undefined,
		fingerprint: record.fingerprint,
		configFingerprint: record.configFingerprint,
		modelKey: typeof record.modelKey === "string" ? record.modelKey.slice(0, 256) : undefined,
		createdAt: record.createdAt,
		threshold: record.threshold,
		estimatedSavings: record.estimatedSavings,
		stats: {
			candidates: number("candidates"),
			scored: number("scored"),
			kept: number("kept"),
			replaced: number("replaced"),
			dropped: number("dropped"),
			requests: number("requests"),
			latencyMs: number("latencyMs"),
			skeletonTokens: number("skeletonTokens"),
			skeletonStage: typeof stats.skeletonStage === "string" ? stats.skeletonStage.slice(0, 32) : "unknown",
		},
		decisions,
	};
}

export function parsePin(raw: unknown): PinRecord | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (!isId(record.toolCallId) || !isId(record.resultEntryId)) return undefined;
	const reason = record.reason === "recall" ? "recall" : "user";
	return { toolCallId: record.toolCallId, resultEntryId: record.resultEntryId, reason, createdAt: isFiniteNumber(record.createdAt) ? record.createdAt : 0 };
}

export function parseMode(raw: unknown): ModeRecord | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.enabled !== "boolean") return undefined;
	return { enabled: record.enabled, createdAt: isFiniteNumber(record.createdAt) ? record.createdAt : 0 };
}

export function parseScope(raw: unknown): ScopeRecord | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (!isId(record.scopeId)) return undefined;
	return { scopeId: record.scopeId, createdAt: isFiniteNumber(record.createdAt) ? record.createdAt : 0 };
}

/**
 * Rebuild branch-local state from the entries on the current branch (root first).
 * Decisions are monotone: a later pass never resurrects an earlier drop; only pins do.
 * Malformed entries are ignored rather than trusted.
 */
export function restoreState(branch: readonly SessionEntry[]): SessionState {
	const state = emptyState();
	for (const entry of branch) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// Compaction boundary: applied drops and pins persist, keep verdicts expire.
			state.considered.clear();
			continue;
		}
		if (entry.type !== "custom") continue;
		if (entry.customType === PASS_ENTRY) {
			const pass = parsePass(entry.data);
			if (!pass) continue;
			state.passes.push(pass);
			for (const decision of pass.decisions) {
				state.considered.add(decision.toolCallId);
				if (decision.effective === "keep") continue;
				if (!state.decisions.has(decision.toolCallId)) state.decisions.set(decision.toolCallId, decision);
			}
		} else if (entry.customType === PIN_ENTRY) {
			const pin = parsePin(entry.data);
			if (pin) state.pins.set(pin.toolCallId, pin);
		} else if (entry.customType === MODE_ENTRY) {
			const mode = parseMode(entry.data);
			if (mode) state.enabled = mode.enabled;
		} else if (entry.customType === SCOPE_ENTRY) {
			const scope = parseScope(entry.data);
			if (scope) state.scopeId = scope.scopeId;
		}
	}
	return state;
}

/** State as it stood right after `entryId` was appended (the observation a pass reacted to). */
export function restoreStateAt(branch: readonly SessionEntry[], entryId: string): SessionState {
	const index = branch.findIndex((entry) => entry.id === entryId);
	return restoreState(index < 0 ? branch : branch.slice(0, index + 1));
}

/** Ids not worth asking about: judged since the last summary, or already pruned. */
export function decidedIds(state: SessionState): ReadonlySet<string> {
	return new Set([...state.considered, ...state.decisions.keys()]);
}

/** Decisions that apply right now: effective non-keep decisions without a pin. */
export function activeDecisions(state: SessionState): DecisionMap {
	const map = new Map<string, Decision>();
	for (const [toolCallId, decision] of state.decisions) {
		if (decision.effective === "keep" || state.pins.has(toolCallId)) continue;
		map.set(toolCallId, decision);
	}
	return map;
}

export function pinnedIds(state: SessionState): ReadonlySet<string> {
	return new Set(state.pins.keys());
}

export function lastPass(state: SessionState): PassRecord | undefined {
	return state.passes.length > 0 ? state.passes[state.passes.length - 1] : undefined;
}
