import { spawn, type ChildProcess } from "node:child_process";
import { herdrCommand } from "./herdr-cli.js";
import type {
	WatchOutcome,
	WatchRecordPublic,
	WatchSpec,
} from "./types.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_KILL_GRACE_MS = 5_000;

type TerminationCause = "none" | "timeout" | "stopped";

class TailBuffer {
	private value: Buffer = Buffer.alloc(0);

	append(chunk: Buffer | string): void {
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (incoming.length >= MAX_CAPTURE_BYTES) {
			this.value = incoming.subarray(incoming.length - MAX_CAPTURE_BYTES);
			return;
		}

		const combined = Buffer.concat([this.value, incoming]);
		this.value =
			combined.length > MAX_CAPTURE_BYTES
				? combined.subarray(combined.length - MAX_CAPTURE_BYTES)
				: combined;
	}

	toString(): string {
		return this.value.toString("utf8");
	}
}

function parseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		const lastLine = text
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1);
		if (lastLine === undefined) return undefined;
		try {
			return JSON.parse(lastLine);
		} catch {
			return undefined;
		}
	}
}

function copySpec(spec: WatchSpec): WatchSpec {
	if (spec.mode === "agent") {
		return {
			...spec,
			...(spec.until === undefined ? {} : { until: [...spec.until] }),
		};
	}
	return { ...spec };
}

function copyRecord(record: WatchRecordPublic): WatchRecordPublic {
	return { ...record, spec: copySpec(record.spec) };
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The command may not have established a process group yet.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// A close/error event will settle a child that already exited.
	}
}

export class CapacityError extends Error {}

export interface WatchManagerOptions {
	maxWatches: number;
	command?: string;
	onOutcome: (record: WatchRecordPublic, outcome: WatchOutcome) => void;
	killGraceMs?: number;
}

interface WatchEntry {
	record: WatchRecordPublic;
	child: ChildProcess;
	stdout: TailBuffer;
	stderr: TailBuffer;
	closed: boolean;
	terminationCause: TerminationCause;
	timeoutTimer?: NodeJS.Timeout;
	killGraceTimer?: NodeJS.Timeout;
	closePromise: Promise<void>;
	resolveClose: () => void;
}

function hasValue(
	value: Record<string, unknown>,
	key: string,
): boolean {
	return value[key] !== undefined;
}

function requireTarget(value: Record<string, unknown>, mode: string): void {
	if (typeof value.target !== "string" || value.target.trim().length === 0) {
		throw new Error(`${mode} watches require a non-empty target`);
	}
}

function validateSharedFields(value: Record<string, unknown>): void {
	if (typeof value.wake !== "boolean") {
		throw new Error("watch specs require a boolean wake field");
	}
	if (value.note !== undefined && typeof value.note !== "string") {
		throw new Error("watch note must be a string");
	}
}

function validateTimeout(value: unknown, required: boolean): void {
	if (value === undefined && !required) return;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > MAX_TIMEOUT_MS
	) {
		throw new Error(
			`timeoutMs must be a positive finite integer no greater than ${MAX_TIMEOUT_MS}`,
		);
	}
}

/** Runtime validation for tool callers and other non-TypeScript consumers. */
export function validateWatchSpec(spec: unknown): asserts spec is WatchSpec {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new Error("watch spec must be an object");
	}
	const value = spec as Record<string, unknown>;
	if (
		value.mode !== "agent" &&
		value.mode !== "output" &&
		value.mode !== "command"
	) {
		throw new Error(`unsupported watch mode: ${String(value.mode)}`);
	}
	validateSharedFields(value);

	switch (value.mode) {
		case "agent":
			requireTarget(value, "agent");
			if (hasValue(value, "match") || hasValue(value, "regex") || hasValue(value, "command")) {
				throw new Error("agent watches cannot specify match, regex, or command");
			}
			if (
				value.until !== undefined &&
				(!Array.isArray(value.until) ||
					!value.until.every((state) => typeof state === "string"))
			) {
				throw new Error("agent watch until must be an array of strings");
			}
			validateTimeout(value.timeoutMs, false);
			return;
		case "output": {
			requireTarget(value, "output");
			if (hasValue(value, "until") || hasValue(value, "command")) {
				throw new Error("output watches cannot specify until or command");
			}
			const conditionCount = Number(hasValue(value, "match")) + Number(hasValue(value, "regex"));
			if (conditionCount !== 1) {
				throw new Error("output watches require exactly one of match or regex");
			}
			const condition = hasValue(value, "match") ? value.match : value.regex;
			if (typeof condition !== "string") {
				throw new Error("output match or regex must be a string");
			}
			validateTimeout(value.timeoutMs, false);
			return;
		}
		case "command":
			if (typeof value.command !== "string" || value.command.trim().length === 0) {
				throw new Error("command watches require a non-empty command");
			}
			if (
				hasValue(value, "target") ||
				hasValue(value, "until") ||
				hasValue(value, "match") ||
				hasValue(value, "regex")
			) {
				throw new Error("command watches cannot specify target, until, match, or regex");
			}
			validateTimeout(value.timeoutMs, true);
			return;
	}
}

export function buildWatchArgs(spec: WatchSpec): string[] {
	validateWatchSpec(spec);
	if (spec.mode === "agent") {
		const args = ["agent", "wait", spec.target];
		for (const until of spec.until ?? []) args.push("--until", until);
		if (spec.timeoutMs !== undefined) {
			args.push("--timeout", String(spec.timeoutMs));
		}
		return args;
	}

	if (spec.mode === "output") {
		const args = ["pane", "wait-output", spec.target];
		if (spec.regex !== undefined) args.push("--regex", spec.regex);
		else args.push("--match", spec.match);
		if (spec.timeoutMs !== undefined) {
			args.push("--timeout", String(spec.timeoutMs));
		}
		return args;
	}

	throw new Error("command watches do not use herdr CLI arguments");
}

export class WatchManager {
	private readonly entries = new Map<number, WatchEntry>();
	private readonly maxWatches: number;
	private readonly command: string;
	private readonly onOutcome: WatchManagerOptions["onOutcome"];
	private readonly killGraceMs: number;
	private nextId = 1;
	private isShutdown = false;

	constructor(opts: WatchManagerOptions) {
		this.maxWatches = opts.maxWatches;
		this.command = opts.command ?? herdrCommand();
		this.onOutcome = opts.onOutcome;
		this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
	}

	start(spec: WatchSpec): WatchRecordPublic {
		if (this.isShutdown) throw new Error("watch manager is shut down");
		validateWatchSpec(spec);
		const armedCount = [...this.entries.values()].filter(
			(entry) => entry.record.status === "armed",
		).length;
		if (armedCount >= this.maxWatches) {
			throw new CapacityError(
				`watch capacity reached (${this.maxWatches} armed watches)`,
			);
		}

		const record: WatchRecordPublic = {
			id: this.nextId++,
			spec: copySpec(spec),
			startedAt: Date.now(),
			status: "armed",
		};
		const child =
			spec.mode === "command"
				? spawn("/bin/sh", ["-c", spec.command], {
						detached: true,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
					})
				: spawn(this.command, buildWatchArgs(spec), {
						detached: true,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
					});
		let resolveClose = (): void => undefined;
		const closePromise = new Promise<void>((resolve) => {
			resolveClose = resolve;
		});
		const entry: WatchEntry = {
			record,
			child,
			stdout: new TailBuffer(),
			stderr: new TailBuffer(),
			closed: false,
			terminationCause: "none",
			closePromise,
			resolveClose,
		};
		this.entries.set(record.id, entry);

		child.stdout?.on("data", (chunk: Buffer | string) =>
			entry.stdout.append(chunk),
		);
		child.stderr?.on("data", (chunk: Buffer | string) =>
			entry.stderr.append(chunk),
		);
		child.once("error", (error) => {
			entry.stderr.append(
				`${entry.stderr.toString() ? "\n" : ""}${error.message}`,
			);
			this.finish(entry, null);
		});
		child.once("close", (code, signal) => this.finish(entry, code, signal));
		if (spec.mode === "command") {
			entry.timeoutTimer = setTimeout(
				() => this.terminate(entry, "timeout"),
				spec.timeoutMs,
			);
		}

		return copyRecord(record);
	}

	async stop(id: number | "all"): Promise<WatchRecordPublic[]> {
		const targets = [...this.entries.values()].filter(
			(entry) =>
				entry.record.status === "armed" &&
				(id === "all" || entry.record.id === id),
		);

		for (const entry of targets) this.terminate(entry, "stopped");

		await Promise.all(targets.map((entry) => entry.closePromise));
		return targets.map((entry) => copyRecord(entry.record));
	}

	list(): WatchRecordPublic[] {
		return [...this.entries.values()]
			.map((entry) => entry.record)
			.sort((left, right) => {
				const leftGroup = left.status === "armed" ? 0 : 1;
				const rightGroup = right.status === "armed" ? 0 : 1;
				return leftGroup - rightGroup || left.id - right.id;
			})
			.map(copyRecord);
	}

	get(id: number): WatchRecordPublic | undefined {
		const entry = this.entries.get(id);
		return entry === undefined ? undefined : copyRecord(entry.record);
	}

	async shutdown(): Promise<void> {
		this.isShutdown = true;
		await this.stop("all");
	}

	private terminate(
		entry: WatchEntry,
		cause: Exclude<TerminationCause, "none">,
	): void {
		if (entry.closed) return;
		if (entry.timeoutTimer !== undefined) {
			clearTimeout(entry.timeoutTimer);
			entry.timeoutTimer = undefined;
		}
		if (entry.terminationCause === "none") {
			entry.terminationCause = cause;
			if (cause === "stopped") entry.record.status = "stopped";
		}
		signalChild(entry.child, "SIGTERM");
		entry.killGraceTimer ??= setTimeout(() => {
			if (!entry.closed) signalChild(entry.child, "SIGKILL");
		}, this.killGraceMs);
	}

	private finish(
		entry: WatchEntry,
		exitCode: number | null,
		signal?: NodeJS.Signals | null,
	): void {
		if (entry.closed) return;
		entry.closed = true;
		if (entry.timeoutTimer !== undefined) clearTimeout(entry.timeoutTimer);
		if (entry.killGraceTimer !== undefined) clearTimeout(entry.killGraceTimer);
		if (entry.record.status === "armed") entry.record.status = "fired";

		const stdout = entry.stdout.toString();
		const stderr = entry.stderr.toString();
		const json = parseJson(stdout);
		const errorJson = parseJson(stderr);
		const outcome: WatchOutcome = {
			kind: this.classify(entry, exitCode, stderr, errorJson),
			exitCode,
			...(signal == null ? {} : { signal }),
			durationMs: Date.now() - entry.record.startedAt,
			stdout,
			stderr,
			...(json === undefined ? {} : { json }),
			...(errorJson === undefined ? {} : { errorJson }),
		};

		try {
			this.onOutcome(copyRecord(entry.record), outcome);
		} catch {
			// Outcome observers must not interfere with process cleanup.
		}
		entry.resolveClose();
	}

	private classify(
		entry: WatchEntry,
		exitCode: number | null,
		stderr: string,
		errorJson: unknown,
	): WatchOutcome["kind"] {
		if (entry.terminationCause === "stopped") return "killed";
		if (entry.terminationCause === "timeout") return "timeout";
		if (entry.record.spec.mode === "command") {
			return typeof exitCode === "number" ? "fired" : "error";
		}
		if (exitCode === 0) return "fired";
		const errorText = `${stderr}\n${
			errorJson === undefined ? "" : JSON.stringify(errorJson)
		}`;
		if (/timeout|timed out/iu.test(errorText)) return "timeout";
		return "error";
	}
}
