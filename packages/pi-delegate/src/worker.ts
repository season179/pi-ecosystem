/**
 * Worker spawn layer: runs a headless `pi` subprocess in JSON mode and
 * collects its event stream into a WorkerResult.
 *
 * Ported from pi upstream `examples/extensions/subagent/index.ts` (spawn,
 * line-buffered JSON event parsing, usage accumulation), simplified to a
 * single worker: no agent discovery, no parallel/chain modes.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): WorkerUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Accumulated state of one worker run's event stream. */
export interface WorkerTranscript {
	messages: Message[];
	usage: WorkerUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface WorkerResult extends WorkerTranscript {
	exitCode: number;
	timedOut: boolean;
	aborted: boolean;
	stderr: string;
	durationMs: number;
}

export type WorkerStreamEvent =
	| { type: "message"; message: Message }
	| { type: "tool_result"; message: Message };

/**
 * Line-buffered collector for `pi --mode json` stdout. Pure (no I/O) so the
 * parsing and usage accumulation are unit-testable. Feed raw chunks with
 * push(); call flush() once the stream ends to process a trailing line.
 */
export function createEventCollector(onEvent?: (event: WorkerStreamEvent) => void) {
	const transcript: WorkerTranscript = { messages: [], usage: emptyUsage() };
	let buffer = "";

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message as Message;
			transcript.messages.push(msg);

			if (msg.role === "assistant") {
				transcript.usage.turns++;
				const usage = (msg as any).usage;
				if (usage) {
					transcript.usage.input += usage.input || 0;
					transcript.usage.output += usage.output || 0;
					transcript.usage.cacheRead += usage.cacheRead || 0;
					transcript.usage.cacheWrite += usage.cacheWrite || 0;
					transcript.usage.cost += usage.cost?.total || 0;
					transcript.usage.contextTokens = usage.totalTokens || 0;
				}
				if (!transcript.model && (msg as any).model) transcript.model = (msg as any).model;
				if ((msg as any).stopReason) transcript.stopReason = (msg as any).stopReason;
				if ((msg as any).errorMessage) transcript.errorMessage = (msg as any).errorMessage;
			}
			onEvent?.({ type: "message", message: msg });
		}

		if (event.type === "tool_result_end" && event.message) {
			const msg = event.message as Message;
			transcript.messages.push(msg);
			onEvent?.({ type: "tool_result", message: msg });
		}
	};

	return {
		transcript,
		push(chunk: string): void {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		},
		flush(): void {
			if (buffer.trim()) processLine(buffer);
			buffer = "";
		},
	};
}

/** Last assistant text in the transcript — the worker's summary message. */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Resolve how to invoke `pi`. Inside a running pi process this re-invokes the
 * same script with the same runtime; outside (tests, smoke script) callers
 * should pass an explicit `piCommand` instead, since argv[1] is not pi there.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export interface RunWorkerOptions {
	/** Model as provider/id, e.g. "zai/glm-5.2". */
	model: string;
	/** The brief: the worker's user prompt. */
	task: string;
	/** Working directory for the worker (the project root). */
	cwd: string;
	/** Appended to the worker's system prompt via --append-system-prompt. */
	systemPrompt?: string;
	/** Tool allowlist (--tools). Omit for the default coding toolset. */
	tools?: string[];
	/** Wall-clock cap; on expiry the worker is killed and timedOut is set. */
	timeoutMs?: number;
	signal?: AbortSignal;
	onEvent?: (event: WorkerStreamEvent) => void;
	/** Override the pi executable (used outside a pi process). */
	piCommand?: string;
	/** SIGTERM→SIGKILL escalation grace. Test seam; defaults to 5s. */
	sigkillGraceMs?: number;
}

const SIGKILL_GRACE_MS = 5000;

export async function runWorker(options: RunWorkerOptions): Promise<WorkerResult> {
	if (options.signal?.aborted) {
		return {
			messages: [],
			usage: emptyUsage(),
			exitCode: 1,
			timedOut: false,
			aborted: true,
			stderr: "",
			durationMs: 0,
		};
	}

	// --no-extensions: the worker gets built-in tools, skills, and context
	// files, but not the orchestrator's extension stack (MoA, buddy, MCP
	// servers) — those cost startup seconds and per-turn tokens and can fire
	// LLM calls of their own inside the worker.
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--model", options.model];
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));

	let tmpPromptDir: string | null = null;
	const startedAt = Date.now();
	let stderr = "";
	let timedOut = false;
	let aborted = false;

	const collector = createEventCollector(options.onEvent);

	try {
		if (options.systemPrompt?.trim()) {
			tmpPromptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-delegate-"));
			const promptPath = path.join(tmpPromptDir, "system-prompt.md");
			await fs.promises.writeFile(promptPath, options.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}

		args.push(options.task);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = options.piCommand
				? { command: options.piCommand, args }
				: getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// Own process group, so the kill path takes down tool children
				// (builds, test runs) along with pi itself. Trade-off: if the
				// orchestrator process dies without running the kill path, the
				// worker is orphaned rather than auto-killed.
				detached: true,
				// Marker lets the delegate tool refuse to run inside a worker,
				// preventing recursive delegation chains.
				env: { ...process.env, PI_DELEGATE_WORKER: "1" },
			});

			let closed = false;
			let killInitiated = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let hardKillHandle: NodeJS.Timeout | undefined;

			// Signal the worker's whole process group; fall back to the direct
			// process when the group is already gone (ChildProcess.kill on a
			// dead child returns false rather than throwing).
			const signalWorker = (sig: NodeJS.Signals) => {
				try {
					if (proc.pid) process.kill(-proc.pid, sig);
					else proc.kill(sig);
				} catch {
					try {
						proc.kill(sig);
					} catch {
						/* already dead */
					}
				}
			};

			// Escalation must key on `closed`, never `proc.killed` — killed
			// only records that a signal was SENT, so it is already true right
			// after the SIGTERM and would make the SIGKILL branch dead code.
			const killProc = () => {
				killInitiated = true;
				signalWorker("SIGTERM");
				hardKillHandle = setTimeout(() => {
					if (!closed) signalWorker("SIGKILL");
				}, options.sigkillGraceMs ?? SIGKILL_GRACE_MS);
				hardKillHandle.unref();
			};

			const onAbort = () => {
				aborted = true;
				killProc();
			};

			const cleanup = () => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (hardKillHandle) clearTimeout(hardKillHandle);
				options.signal?.removeEventListener("abort", onAbort);
			};

			if (options.timeoutMs && options.timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					killProc();
				}, options.timeoutMs);
				timeoutHandle.unref();
			}

			proc.stdout.on("data", (data) => {
				collector.push(data.toString());
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code, sig) => {
				closed = true;
				// pi closing does not mean its group is empty: a tool child
				// that traps SIGTERM (test runner, dev server) would survive
				// the cancelled grace timer and keep mutating the tree. Once
				// a kill was initiated there is no graceful path left — reap
				// the group before reporting the worker dead.
				if (killInitiated) signalWorker("SIGKILL");
				cleanup();
				collector.flush();
				// Signal-killed workers (timeout, abort, external) must not
				// read as exit 0.
				resolve(code ?? (sig ? 1 : 0));
			});

			proc.on("error", (err) => {
				closed = true;
				cleanup();
				stderr += stderr ? `\n${err.message}` : err.message;
				resolve(1);
			});

			if (options.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		return {
			...collector.transcript,
			exitCode,
			timedOut,
			aborted,
			stderr,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		if (tmpPromptDir) {
			try {
				fs.rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}
