/**
 * pi-delegate extension: registers the `delegate` tool.
 *
 * Flow per call (DELEGATE.md §5): git checkpoint → spawn worker (cheap
 * model, headless pi, in-place edits) → harness-run verify → compact report.
 * The harness never retries; the orchestrator decides retry vs take-over.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildWorkerPrompt, WORKER_SYSTEM_PROMPT, type DelegateBrief } from "../brief.js";
import { collectChanges, makeCheckpoint, type Checkpoint, type WorkChanges } from "../git.js";
import { deriveStatus, formatReport, type DelegateStatus, type VerifyOutcome } from "../result.js";
import { getFinalOutput, runWorker, type WorkerResult, type WorkerUsage } from "../worker.js";

// Hardcoded until milestone 3 (config loading).
export const WORKER_MODEL = "zai/glm-5.2";
export const WORKER_TIMEOUT_MS = 10 * 60 * 1000;
export const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

const DelegateParams = Type.Object({
	task: Type.String({
		description:
			"What to build or change and why, written for an implementer with ZERO conversation context. Be complete and specific.",
	}),
	context: Type.String({
		description:
			"Conversation-derived constraints the worker cannot discover from the repo: decisions already made, files to avoid, conventions agreed earlier. The worker sees none of the session history — omitting these is the classic delegation failure.",
	}),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files or directories in scope. Advisory focus hint, not a sandbox.",
		}),
	),
	verify: Type.String({
		description:
			"Shell command that must exit 0 for the work to count (tests, typecheck, build). Runs from the project root after the worker finishes.",
	}),
});

interface DelegateDetails {
	status: DelegateStatus | "running";
	brief: DelegateBrief;
	checkpoint?: Checkpoint;
	usage?: WorkerUsage;
	model?: string;
	durationMs?: number;
	changes?: WorkChanges | null;
	verify?: VerifyOutcome | null;
	progress: string[];
}

export default function setup(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate a well-scoped coding task to a cheap worker model that edits the repo in place and reports back with a diffstat and a mechanically-verified result. " +
			"Good for: implement-from-spec, boilerplate, applying a known pattern across files, writing tests for defined behavior, mechanical refactors. " +
			"Bad for: debugging with unknown cause, subtle cross-cutting changes, anything where writing the brief requires already knowing the solution. " +
			"A git checkpoint is made first; reject the work with `git reset --hard <checkpoint>`.",
		promptSnippet: "Delegate a well-scoped coding task to a cheap worker model",
		promptGuidelines: [
			"Use delegate for well-specified, mechanically-verifiable coding work (implement-from-spec, boilerplate, pattern application, tests for defined behavior) instead of doing the tool-loop churn yourself.",
			"Always fill delegate's `context` with conversation-derived constraints — the worker sees none of the session history.",
			"Delegate the same task at most twice; after that, do it yourself. On verify_failed, prefer sharpening the brief over blind retry.",
			"After a delegation succeeds, spot-check the diff where you have doubts instead of re-reading everything.",
		],
		parameters: DelegateParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (process.env.PI_DELEGATE_WORKER) {
				throw new Error("delegate is not available inside a delegated worker (no recursive delegation)");
			}

			const brief: DelegateBrief = {
				task: params.task,
				context: params.context,
				files: params.files,
				verify: params.verify,
			};

			const details: DelegateDetails = { status: "running", brief, progress: [] };
			const emit = (line: string) => {
				details.progress.push(line);
				onUpdate?.({
					content: [{ type: "text", text: line }],
					details: { ...details },
				});
			};

			const exec: Parameters<typeof makeCheckpoint>[0] = (cmd, args, opts) => pi.exec(cmd, args, opts);
			const checkpoint = await makeCheckpoint(exec, ctx.cwd);
			details.checkpoint = checkpoint;
			emit(
				`checkpoint ${checkpoint.sha.slice(0, 12)}${checkpoint.committed ? " (auto-committed dirty tree)" : ""}`,
			);

			const worker = await runWorker({
				model: WORKER_MODEL,
				task: buildWorkerPrompt(brief),
				cwd: ctx.cwd,
				systemPrompt: WORKER_SYSTEM_PROMPT,
				timeoutMs: WORKER_TIMEOUT_MS,
				signal,
				// Test seam: getPiInvocation is only valid inside a real pi
				// process (argv[1] is pi's entry script). Harnesses that load
				// this extension outside pi must set PI_DELEGATE_PI_COMMAND=pi
				// or the worker spawn re-invokes the harness script itself.
				piCommand: process.env.PI_DELEGATE_PI_COMMAND || undefined,
				onEvent: (ev) => {
					if (ev.type === "message" && ev.message.role === "assistant") {
						const tools = ev.message.content
							.filter((part) => part.type === "toolCall")
							.map((part) => (part as { name: string }).name);
						emit(tools.length > 0 ? `worker: ${tools.join(", ")}` : "worker: thinking/summarizing");
					}
				},
			});
			details.usage = worker.usage;
			details.model = worker.model;
			details.durationMs = worker.durationMs;

			if (worker.aborted) {
				return {
					content: [
						{
							type: "text",
							text: `delegation aborted; the tree may contain partial changes. Reject with: git reset --hard ${checkpoint.sha.slice(0, 12)}`,
						},
					],
					details: { ...details, status: "worker_error" as const },
					isError: true,
				};
			}

			const changes = await collectChanges(exec, ctx.cwd, checkpoint.sha);
			details.changes = changes;

			let verify: VerifyOutcome | null = null;
			const workerFinishedCleanly = worker.exitCode === 0 && !worker.timedOut && worker.stopReason !== "error";
			if (workerFinishedCleanly) {
				emit(`verify: ${brief.verify}`);
				const verifyResult = await pi.exec("bash", ["-c", brief.verify], {
					cwd: ctx.cwd,
					timeout: VERIFY_TIMEOUT_MS,
					signal,
				});
				verify = {
					code: verifyResult.code,
					output: [verifyResult.stdout, verifyResult.stderr].filter(Boolean).join("\n"),
					timedOut: verifyResult.killed,
				};
			}
			details.verify = verify;

			const status = deriveStatus(worker, verify);
			details.status = status;

			return {
				content: [{ type: "text", text: formatReport({ status, checkpoint, worker, changes, verify }) }],
				details: { ...details },
				isError: status === "worker_error" || status === "timeout",
			};
		},

		renderCall(args, theme, context) {
			const task = typeof args.task === "string" ? args.task : "…";
			const preview = task.length > 80 ? `${task.slice(0, 80)}...` : task;
			let content = theme.fg("toolTitle", theme.bold("delegate "));
			content += theme.fg("accent", `[${WORKER_MODEL}] `);
			content += theme.fg("muted", preview);
			if (typeof args.verify === "string") {
				content += `\n  ${theme.fg("muted", "verify: ")}${theme.fg("dim", args.verify)}`;
			}
			const text = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(content);
			return text;
		},

		renderResult(result, { expanded }, theme, context) {
			const details = (result.details ?? {}) as Partial<DelegateDetails>;
			const status = details.status ?? "running";
			const icon =
				status === "success"
					? theme.fg("success", "✓")
					: status === "running"
						? theme.fg("warning", "⏳")
						: theme.fg("error", "✗");

			let content = `${icon} ${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", status)}`;

			if (status === "running") {
				const recent = (details.progress ?? []).slice(-5);
				for (const line of recent) content += `\n  ${theme.fg("dim", line)}`;
			} else {
				if (details.changes?.diffstat) {
					const stat = expanded
						? details.changes.diffstat
						: details.changes.diffstat.split("\n").slice(-1)[0].trim();
					content += `\n  ${theme.fg("toolOutput", stat)}`;
				}
				if (details.usage) {
					const seconds = details.durationMs ? `${(details.durationMs / 1000).toFixed(1)}s` : "";
					content += `\n  ${theme.fg("dim", `${details.model ?? WORKER_MODEL} — ${details.usage.turns} turns ${seconds}`)}`;
				}
				if (expanded) {
					const text = result.content[0];
					if (text?.type === "text") content += `\n${theme.fg("toolOutput", text.text)}`;
				} else {
					content += `\n  ${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
			}

			const text = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(content);
			return text;
		},
	});
}
