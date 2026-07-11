/**
 * State-shaped progress for a running delegation: what the worker is doing
 * right now, what it recently finished, and how much of the wall-clock
 * budget is gone. Pure (callers supply timestamps) so transitions and label
 * building are unit-testable; delegate.ts owns the wiring and rendering.
 */

import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

export const LABEL_MAX_CHARS = 80;
export const RECENT_MAX = 3;
export const HEARTBEAT_MS = 10_000;

export interface CurrentActivity {
	label: string;
	startedAt: number;
}

export interface CompletedActivity {
	label: string;
	/** Absent for annotations (checkpoint note, worker narration). */
	durationMs?: number;
}

export interface ProgressState {
	turns: number;
	startedAt: number;
	timeoutMs: number;
	current?: CurrentActivity;
	/** Newest last, capped at RECENT_MAX. */
	recent: CompletedActivity[];
}

const SECRET_ARG = /\b([A-Za-z0-9_]*(?:key|token|secret|password|credential)[A-Za-z0-9_]*)=\S+/gi;

/** One line, secrets redacted, capped at LABEL_MAX_CHARS. */
export function sanitizeLabel(text: string): string {
	const oneLine = text.split("\n")[0].replace(SECRET_ARG, "$1=***").trim();
	return oneLine.length > LABEL_MAX_CHARS ? `${oneLine.slice(0, LABEL_MAX_CHARS - 1)}…` : oneLine;
}

/** `bash: npm run build`, `edit: src/worker.ts`, or just the tool name. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
	const detail = [args.command, args.path, args.file_path, args.pattern].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	return sanitizeLabel(detail ? `${name}: ${detail}` : name);
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * Tracks the worker's activity from its event stream. Tool calls queue when
 * an assistant message lands and complete (with durations) as their results
 * stream back; tool-less assistant messages surface as one-line narration.
 */
export function createProgressTracker(startedAt: number, timeoutMs: number) {
	const state: ProgressState = { turns: 0, startedAt, timeoutMs, recent: [] };
	const queue: { id: string; label: string }[] = [];
	let currentId: string | undefined;

	const pushRecent = (item: CompletedActivity) => {
		state.recent.push(item);
		if (state.recent.length > RECENT_MAX) state.recent.shift();
	};

	const startNext = (now: number) => {
		const next = queue.shift();
		currentId = next?.id;
		state.current = next ? { label: next.label, startedAt: now } : undefined;
	};

	return {
		state,

		snapshot(): ProgressState {
			return {
				...state,
				current: state.current ? { ...state.current } : undefined,
				recent: state.recent.map((item) => ({ ...item })),
			};
		},

		/** Annotation without duration (checkpoint made, phase notes). */
		note(label: string): void {
			pushRecent({ label: sanitizeLabel(label) });
		},

		/** Replace the current activity outright (e.g. the verify phase). */
		setPhase(label: string, now: number): void {
			queue.length = 0;
			currentId = undefined;
			state.current = { label: sanitizeLabel(label), startedAt: now };
		},

		onAssistantMessage(message: AssistantMessage, now: number): void {
			state.turns++;
			const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
			if (toolCalls.length === 0) {
				const text = message.content.find((part) => part.type === "text")?.text?.trim();
				if (text) pushRecent({ label: sanitizeLabel(`worker: ${text}`) });
				return;
			}
			for (const call of toolCalls) {
				queue.push({ id: call.id, label: describeToolCall(call.name, call.arguments ?? {}) });
			}
			if (!state.current) startNext(now);
		},

		onToolResult(message: ToolResultMessage, now: number): void {
			if (currentId && message.toolCallId === currentId && state.current) {
				pushRecent({ label: state.current.label, durationMs: now - state.current.startedAt });
				startNext(now);
				return;
			}
			// Out-of-order result: drop the matching queued call so it never
			// shows as the current activity after it already finished.
			const index = queue.findIndex((item) => item.id === message.toolCallId);
			if (index >= 0) queue.splice(index, 1);
		},
	};
}

export type ProgressTracker = ReturnType<typeof createProgressTracker>;

/**
 * Render lines for the running view: head (turn, elapsed/budget, current
 * activity), recent completions newest-first, and the interrupt hint.
 */
export function formatProgressLines(state: ProgressState, now: number, resetSha?: string): string[] {
	const elapsed = formatDuration(now - state.startedAt);
	const budget = formatDuration(state.timeoutMs);
	const current = state.current
		? `${state.current.label} (${formatDuration(now - state.current.startedAt)})`
		: "waiting for worker";
	const lines = [`turn ${state.turns} · ${elapsed} / ${budget} · ${current}`];

	for (const item of [...state.recent].reverse()) {
		lines.push(item.durationMs === undefined ? item.label : `✓ ${item.label} (${formatDuration(item.durationMs)})`);
	}

	if (resetSha) lines.push(`esc stops worker · partial work preserved · reset point ${resetSha}`);
	return lines;
}
