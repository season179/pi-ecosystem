import { choice, noul, TypeSafeClient, type Fetch, type Question } from "@typesafe-ai/sdk";
import {
	extractNoulProbability,
	loadTypesafeConfig,
	resolveTypesafeApiKey,
	TYPESAFE_OFFICIAL_BASE_URL,
} from "./semantic.js";
import type { TranscriptEntry } from "./transcript.js";

// ---------------------------------------------------------------------------
// Jev memory gate over one bounded excerpt:
//
//   unit_<i> — one choice per NEW message (a bounded original source unit):
//              user-wide preference, project-specific fact, transferable
//              lesson, or not durable. Each unit is judged on its own, so one
//              preference never makes a mixed transcript user-wide.
//   recall   — would the current work benefit from memories of earlier sessions?
//
// Jev only judges; it never writes the query or the memory text. The shared
// typesafe.json supplies model, timeout and key; the endpoint stays pinned and
// SDK logging stays off, exactly like semantic recall. Any failure is reported
// as unavailable — the caller must not substitute a guessed decision.
// ---------------------------------------------------------------------------

export interface GateInput {
	/** Context already evaluated for retention (or none). */
	earlier: readonly TranscriptEntry[];
	/** Messages not yet judged for retention (newest GATE_MAX_UNITS are judged); empty skips retention. */
	fresh: readonly TranscriptEntry[];
	askRetain: boolean;
	askRecall: boolean;
}

export const APPLICABILITY_LABELS = ["user_preference", "project_fact", "transferable_lesson", "not_durable"] as const;
export type ApplicabilityLabel = (typeof APPLICABILITY_LABELS)[number];
export type UnitProbabilities = Record<ApplicabilityLabel, number>;

/** Per-unit judgments are only asked for the newest units. */
export const GATE_MAX_UNITS = 6;

export interface GateDecision {
	/** One entry per judged fresh unit (same order), or undefined when retention was not asked. */
	units: UnitProbabilities[] | undefined;
	recall: number | undefined;
	model: string;
}

export type GateUnavailableReason = "config-malformed" | "missing-key" | "api-error" | "timeout" | "incomplete-response";

export type GateOutcome =
	| { kind: "decision"; decision: GateDecision }
	| { kind: "unavailable"; reason: GateUnavailableReason; detail?: string }
	| { kind: "aborted" };

export interface GateOptions {
	agentDir: string;
	env: NodeJS.ProcessEnv;
	/** Upper bound for this call; the config timeout also applies. */
	timeoutMs: number;
	signal?: AbortSignal;
	fetch?: Fetch;
}

function unitInstructions(index: number): string {
	return (
		`Classify ONLY state.fresh_messages[${index}] of a coding-agent conversation; every other message is context and must not affect the label. ` +
		"Would this one message still be useful to the agent in a future, separate session, and where would it apply? " +
		"Routine task requests, progress chatter, and facts obvious from the code are not durable. When unsure whether something applies beyond this project, prefer project_fact."
	);
}

const UNIT_CRITERIA = {
	user_preference:
		"The user themself states a preference, standing instruction, or correction of the agent's behavior that plainly applies in every project",
	project_fact: "A durable decision, constraint, convention, or verified finding that applies to this project (or might not apply elsewhere)",
	transferable_lesson:
		"A verified, hard-won lesson (a technique, pitfall, or tool behavior) likely to help in other projects when the same situation arises",
	not_durable: "Transient task content, progress updates, acknowledgements, or easily recoverable facts",
} as const;

function extractUnitProbabilities(answers: unknown, key: string): UnitProbabilities | undefined {
	if (typeof answers !== "object" || answers === null) return undefined;
	const answer = (answers as Record<string, unknown>)[key] as { type?: unknown; probabilities?: unknown } | undefined;
	if (answer?.type !== "choice" || typeof answer.probabilities !== "object" || answer.probabilities === null) return undefined;
	const probabilities = answer.probabilities as Record<string, unknown>;
	const result = {} as UnitProbabilities;
	for (const label of APPLICABILITY_LABELS) {
		const value = probabilities[label];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
		result[label] = value;
	}
	return result;
}

const RECALL_INSTRUCTIONS =
	"state.earlier_messages followed by state.fresh_messages are the most recent messages of a coding-agent conversation. " +
	"Would the agent's next step on the latest user request likely be improved by retrieving memories from earlier sessions — " +
	"such as the user's preferences, past corrections, prior project decisions, or earlier findings — that are not already stated in these messages?";

const RECALL_CRITERIA = {
	true: "Memories of the user's preferences, corrections, or prior project decisions could plausibly change or improve the next step",
	false: "The request is self-contained small talk or fully specified, so earlier-session memories would not help",
} as const;

function view(entries: readonly TranscriptEntry[]): Array<{ role: string; text: string }> {
	return entries.map((entry) => ({ role: entry.role, text: entry.text }));
}

export async function runMemoryGate(input: GateInput, options: GateOptions): Promise<GateOutcome> {
	const config = await loadTypesafeConfig(options.agentDir);
	if (config.state === "malformed") return { kind: "unavailable", reason: "config-malformed" };
	const settings =
		config.state === "loaded"
			? config.settings
			: { model: "jev-1.13.0", timeoutMs: 3000, apiKeyFile: undefined, memory: { enabled: false, minRelevance: 0.5 } };
	const apiKey = await resolveTypesafeApiKey(options.agentDir, settings, options.env);
	if (apiKey === undefined) return { kind: "unavailable", reason: "missing-key" };
	if (options.signal?.aborted) return { kind: "aborted" };

	const fresh = input.fresh.slice(-GATE_MAX_UNITS);
	const unitKeys = input.askRetain ? fresh.map((_entry, index) => `unit_${index}`) : [];
	const questions: Record<string, Question> = {};
	unitKeys.forEach((key, index) => {
		questions[key] = choice(unitInstructions(index), UNIT_CRITERIA);
	});
	if (input.askRecall) questions.recall = noul(RECALL_INSTRUCTIONS, RECALL_CRITERIA);
	if (Object.keys(questions).length === 0) {
		return { kind: "decision", decision: { units: undefined, recall: undefined, model: settings.model } };
	}

	const timeoutMs = Math.max(1, Math.min(settings.timeoutMs, options.timeoutMs));
	const controller = new AbortController();
	let timedOut = false;
	let rejectWall!: (error: Error) => void;
	const wall = new Promise<never>((_resolve, reject) => {
		rejectWall = reject;
	});
	wall.catch(() => undefined);
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
		rejectWall(new Error("memory gate deadline exceeded"));
	}, timeoutMs);
	const forwardAbort = () => {
		controller.abort();
		rejectWall(new Error("memory gate aborted"));
	};
	options.signal?.addEventListener("abort", forwardAbort, { once: true });
	try {
		const client = new TypeSafeClient({
			apiKey,
			baseURL: TYPESAFE_OFFICIAL_BASE_URL,
			defaultModel: settings.model,
			logLevel: "off",
			retry: { maxRetries: 0 },
			timeout: timeoutMs,
			...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
		});
		const request = client.systemOne(
			{
				state: { earlier_messages: view(input.earlier), fresh_messages: view(fresh) },
				questions,
				model: settings.model,
			},
			{ signal: controller.signal, timeout: timeoutMs, retry: { maxRetries: 0 } },
		);
		// SDK body parsing is not signal-bound; the wall is the hard deadline.
		const result = await Promise.race([request, wall]);
		if (options.signal?.aborted) return { kind: "aborted" };
		const answers: unknown = (result as { answers?: unknown }).answers;
		const units = unitKeys.map((key) => extractUnitProbabilities(answers, key));
		const recall = questions.recall === undefined ? undefined : extractNoulProbability(answers, "recall");
		// Any missing or malformed judgment voids the whole decision: nothing is guessed.
		if (units.some((unit) => unit === undefined) || (questions.recall !== undefined && recall === undefined)) {
			return { kind: "unavailable", reason: "incomplete-response" };
		}
		return {
			kind: "decision",
			decision: { units: unitKeys.length > 0 ? (units as UnitProbabilities[]) : undefined, recall, model: settings.model },
		};
	} catch (error) {
		if (options.signal?.aborted) return { kind: "aborted" };
		if (timedOut) return { kind: "unavailable", reason: "timeout" };
		const status = (error as { status?: unknown }).status;
		return { kind: "unavailable", reason: "api-error", detail: typeof status === "number" ? `HTTP ${status}` : "request failed" };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", forwardAbort);
	}
}
