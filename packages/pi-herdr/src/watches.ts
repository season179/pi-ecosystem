import { spawn, type ChildProcess } from "node:child_process";
import { herdrCommand } from "./herdr-cli.js";
import type {
	WatchOutcome,
	WatchRecordPublic,
	WatchSpec,
} from "./types.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

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
	return {
		...spec,
		...(spec.until === undefined ? {} : { until: [...spec.until] }),
	};
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
	killTimer?: NodeJS.Timeout;
	closePromise: Promise<void>;
	resolveClose: () => void;
}

export function buildWatchArgs(spec: WatchSpec): string[] {
	if (spec.mode === "agent") {
		if (spec.match !== undefined || spec.regex !== undefined) {
			throw new Error("agent watches cannot specify match or regex");
		}
		const args = ["agent", "wait", spec.target];
		for (const until of spec.until ?? []) args.push("--until", until);
		if (spec.timeoutMs !== undefined) {
			args.push("--timeout", String(spec.timeoutMs));
		}
		return args;
	}

	if (spec.mode === "output") {
		if (spec.match !== undefined && spec.regex !== undefined) {
			throw new Error("output watches cannot specify both match and regex");
		}
		if (spec.match === undefined && spec.regex === undefined) {
			throw new Error("output watches require match or regex");
		}
		const args = ["pane", "wait-output", spec.target];
		if (spec.regex !== undefined) args.push("--regex", spec.regex);
		else args.push("--match", spec.match as string);
		if (spec.timeoutMs !== undefined) {
			args.push("--timeout", String(spec.timeoutMs));
		}
		return args;
	}

	throw new Error(`unsupported watch mode: ${String(spec.mode)}`);
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
		const args = buildWatchArgs(spec);
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
		const child = spawn(this.command, args, {
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
		child.once("close", (code) => this.finish(entry, code));

		return copyRecord(record);
	}

	async stop(id: number | "all"): Promise<WatchRecordPublic[]> {
		const targets = [...this.entries.values()].filter(
			(entry) =>
				entry.record.status === "armed" &&
				(id === "all" || entry.record.id === id),
		);

		for (const entry of targets) {
			entry.record.status = "stopped";
			signalChild(entry.child, "SIGTERM");
			entry.killTimer = setTimeout(() => {
				if (!entry.closed) signalChild(entry.child, "SIGKILL");
			}, this.killGraceMs);
		}

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

	private finish(entry: WatchEntry, exitCode: number | null): void {
		if (entry.closed) return;
		entry.closed = true;
		if (entry.killTimer !== undefined) clearTimeout(entry.killTimer);
		if (entry.record.status === "armed") entry.record.status = "fired";

		const stdout = entry.stdout.toString();
		const stderr = entry.stderr.toString();
		const json = parseJson(stdout);
		const errorJson = parseJson(stderr);
		const outcome: WatchOutcome = {
			kind: this.classify(entry.record.status, exitCode, stderr, errorJson),
			exitCode,
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
		status: WatchRecordPublic["status"],
		exitCode: number | null,
		stderr: string,
		errorJson: unknown,
	): WatchOutcome["kind"] {
		if (status === "stopped") return "killed";
		if (exitCode === 0) return "fired";
		const errorText = `${stderr}\n${
			errorJson === undefined ? "" : JSON.stringify(errorJson)
		}`;
		if (/timeout|timed out/iu.test(errorText)) return "timeout";
		return "error";
	}
}
