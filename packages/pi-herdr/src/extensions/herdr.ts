import { StringEnum } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerWatchesCommand } from "../commands.js";
import { loadHerdrConfig } from "../config.js";
import { runHerdr } from "../herdr-cli.js";
import {
	type ActivationSource,
	loadOrchestrationSkill,
	ORCHESTRATION_ENTRY_TYPE,
	parseOrchestrateArgs,
	readOrchestrationState,
	summarizeRoutingStatus,
} from "../orchestration-state.js";
import { registerRoutingTool, routingGuidance } from "../routing-tool.js";
import { decideDelivery, type DeliveryDecision } from "../policy.js";
import {
	formatStatusChip,
	formatWatchCard,
	formatWatchLine,
	summarizeCommand,
} from "../render.js";
import { appendTelemetry } from "../telemetry.js";
import type { WatchOutcome, WatchRecordPublic, WatchSpec } from "../types.js";
import { WatchManager } from "../watches.js";

const WATCH_MESSAGE_TYPE = "pi-herdr-watch";
const WATCH_TOOL_NAMES = [
	"herdr_watch",
	"herdr_unwatch",
	"herdr_watches",
] as const;
/** Tools that become active only while orchestration is explicitly on. */
const ORCHESTRATOR_TOOL_NAMES = [...WATCH_TOOL_NAMES, "herdr_route"] as const;
const ORCHESTRATOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(
	ORCHESTRATOR_TOOL_NAMES,
);

const WATCH_DESCRIPTION =
	"Register a non-blocking watch on a herdr agent, pane, or bounded command. You will be woken with a report when it fires — do NOT poll `herdr agent read` in a loop, and NEVER run `herdr agent wait` or `agent prompt --wait` through bash (that blocks your whole turn). To watch a command finishing (CI runs, builds, deploys), prefer mode: 'command': you are woken with its exit code, with no pane or sentinel needed. For workers, prompt WITHOUT --wait, then herdr_watch them, then end your turn or do other work.";

const WatchParams = Type.Object({
	target: Type.Optional(
		Type.String({
			description: "Required for agent/output mode: unique live agent name or pane ID",
		}),
	),
	mode: Type.Optional(StringEnum(["agent", "output", "command"] as const)),
	until: Type.Optional(Type.Array(Type.String())),
	match: Type.Optional(
		Type.String({
			description:
				"Output mode literal substring. Exactly one of match/regex; the existing pane snapshot is searched immediately on arm.",
		}),
	),
	regex: Type.Optional(
		Type.String({
			description:
				"Output mode Rust-syntax regex. Exactly one of regex/match; the existing pane snapshot is searched immediately on arm.",
		}),
	),
	command: Type.Optional(
		Type.String({
			description:
				"Command mode only: non-empty POSIX-shell command run as /bin/sh -c. Fires on any numeric exit code, including non-zero; signal deaths report as errors.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Positive integer timeout in milliseconds; required for command mode.",
		}),
	),
	note: Type.Optional(Type.String()),
	wake: Type.Optional(Type.Boolean()),
});

const UnwatchParams = Type.Object({
	id: Type.Optional(Type.Number({ description: "Watch ID to stop" })),
	all: Type.Optional(Type.Boolean({ description: "Stop every armed watch" })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findStringForKey(
	value: unknown,
	keys: ReadonlySet<string>,
	depth = 0,
): string | undefined {
	if (!isRecord(value) || depth > 5) return undefined;
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	for (const nested of Object.values(value)) {
		const candidate = findStringForKey(nested, keys, depth + 1);
		if (candidate !== undefined) return candidate;
	}
	return undefined;
}

function extractAgentState(json: unknown): string | undefined {
	if (!isRecord(json)) return undefined;
	const result = isRecord(json.result) ? json.result : undefined;
	const agent = result && isRecord(result.agent) ? result.agent : undefined;
	if (typeof agent?.agent_status === "string") return agent.agent_status;
	if (typeof result?.agent_status === "string") return result.agent_status;
	return typeof json.agent_status === "string" ? json.agent_status : undefined;
}

function extractTail(json: unknown, stdout: string): string | undefined {
	const text = findStringForKey(
		json,
		new Set(["text", "content", "output", "snapshot", "recent_unwrapped"]),
	);
	if (text !== undefined) return text;
	if (json !== undefined) return undefined;
	const raw = stdout.trim();
	return raw.length > 0 ? raw : undefined;
}

function conditionSummary(spec: WatchSpec): string {
	if (spec.mode === "agent") {
		return spec.until && spec.until.length > 0
			? `until ${spec.until.join("|")}`
			: "until idle|done|blocked";
	}
	if (spec.mode === "command") {
		return `command "${summarizeCommand(spec.command)}"`;
	}
	if (spec.regex !== undefined) return `regex /${spec.regex}/`;
	return `match "${spec.match}"`;
}

function lastLines(text: string, count: number): string | undefined {
	const trimmed = text.replace(/\n+$/u, "");
	if (trimmed.length === 0) return undefined;
	return trimmed.split(/\r?\n/u).slice(-count).join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type TelemetrySnapshot =
	| { delivery: DeliveryDecision; wakeBudget: number }
	| { delivery?: undefined; wakesUsed: number; wakeBudget: number };

export function buildTelemetryRecord(
	record: WatchRecordPublic,
	outcome: WatchOutcome,
	snapshot: TelemetrySnapshot,
): Record<string, unknown> {
	const delivery = snapshot.delivery;
	const wakesUsed =
		delivery === undefined ? snapshot.wakesUsed : delivery.wakesUsedAfter;
	return {
		watchId: record.id,
		...(record.spec.mode === "command"
			? { exitCode: outcome.exitCode }
			: { target: record.spec.target }),
		mode: record.spec.mode,
		kind: outcome.kind,
		durationMs: outcome.durationMs,
		triggerTurn: delivery?.triggerTurn ?? false,
		countsAsWake: delivery?.countsAsWake ?? false,
		...(delivery === undefined ? {} : { deliveryReason: delivery.reason }),
		wakesUsed,
		wakeBudget: snapshot.wakeBudget,
	};
}

export default function herdrExtension(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
		return;
	}

	const agentDir = getAgentDir();
	const config = loadHerdrConfig(agentDir);
	const envActivation = process.env.PI_HERDR_ORCHESTRATOR === "1";
	let manager: WatchManager | undefined;
	// Activation belongs to the session: it is decided in session_start from
	// persisted entries (or the explicit env launch) and never assumed from
	// package installation alone.
	let promoted = false;
	let recoveryNote: string | undefined;
	const noticedSessions = new Set<string>();
	let agentBusy = false;
	let wakesUsed = 0;
	let exhaustionNotified = false;
	let uiCtx: ExtensionContext | undefined;
	let sessionGeneration = 0;

	const updateFooter = (): void => {
		try {
			if (!uiCtx?.hasUI) return;
			if (!promoted) {
				uiCtx.ui.setStatus("herdr", undefined);
				return;
			}
			const armedCount =
				manager?.list().filter((record) => record.status === "armed").length ?? 0;
			uiCtx.ui.setStatus(
				"herdr",
				formatStatusChip(armedCount, wakesUsed, config.wakeBudget),
			);
		} catch {
			// Footer rendering is best-effort and must not affect watches.
		}
	};

	const setOrchestratorToolsActive = (active: boolean): void => {
		const current = pi.getActiveTools();
		pi.setActiveTools(
			active
				? [...new Set([...current, ...ORCHESTRATOR_TOOL_NAMES])]
				: current.filter((name) => !ORCHESTRATOR_TOOL_NAME_SET.has(name)),
		);
	};

	const notify = (
		ctx: ExtensionContext | undefined,
		message: string,
		level: "info" | "warning" | "error",
	): void => {
		try {
			if (ctx?.hasUI) ctx.ui.notify(message, level);
		} catch {
			// Notifications are best-effort.
		}
	};

	const persistActivation = (
		ctx: ExtensionContext,
		active: boolean,
		source: ActivationSource,
	): void => {
		pi.appendEntry(ORCHESTRATION_ENTRY_TYPE, {
			active,
			sessionId: ctx.sessionManager.getSessionId(),
			source,
			at: new Date().toISOString(),
		});
	};

	/** Single activation path shared by `/orchestrate`, `herdr_orchestrate`, env, and restore. */
	const activate = (
		ctx: ExtensionContext,
		source: ActivationSource,
		options: { persist: boolean },
	): boolean => {
		const changed = !promoted;
		promoted = true;
		setOrchestratorToolsActive(true);
		updateFooter();
		if (changed && options.persist) persistActivation(ctx, true, source);
		return changed;
	};

	/** Deactivate guidance and tools; stops only this extension's armed watches. */
	const deactivate = async (ctx: ExtensionContext): Promise<number> => {
		const stopped = manager ? (await manager.stop("all")).length : 0;
		const changed = promoted;
		promoted = false;
		recoveryNote = undefined;
		setOrchestratorToolsActive(false);
		updateFooter();
		if (changed) persistActivation(ctx, false, "command");
		return stopped;
	};

	/** Concise routing status for notifications; reads/validates the policy now. */
	const routingStatus = (): { line: string; ready: boolean } => {
		const line = summarizeRoutingStatus(routingGuidance(agentDir));
		return { line, ready: line.startsWith("Routing ready") };
	};

	const OFF_DISCLOSURE =
		"workers were NOT stopped and conversation history is unchanged; resolve any outstanding supervision deliberately.";

	const buildGuidance = (): string => {
		const skill = loadOrchestrationSkill();
		const body =
			"body" in skill
				? `${skill.body}\n\nSkill directory: ${skill.directory}\nResolve relative reference links from this directory. Read a reference only when its stated condition applies.`
				: `Orchestration workflow guidance is unavailable (${skill.error}). Follow the user's explicit instructions and the herdr_watch tool guidance only.`;
		const lines = [
			"# Herdr orchestration (active for this session)",
			"",
			body,
			"",
			"## Runtime status",
			`- ${routingGuidance(agentDir)}`,
			"- Armed watches never survive reload, resume, new session, or fork; re-arm only after reconciling what is actually running.",
			...(recoveryNote ? [`- ${recoveryNote}`] : []),
			`- \`/orchestrate off\` removes this guidance and stops armed watches only; ${OFF_DISCLOSURE}`,
		];
		return lines.join("\n");
	};

	const writeTelemetry = (
		record: WatchRecordPublic,
		outcome: WatchOutcome,
		snapshot: TelemetrySnapshot,
	): void => {
		appendTelemetry(
			config.telemetryPath,
			buildTelemetryRecord(record, outcome, snapshot),
		);
	};

	const handleOutcome = async (
		generation: number,
		record: WatchRecordPublic,
		outcome: WatchOutcome,
	): Promise<void> => {
		let telemetryWritten = false;
		let telemetrySnapshot: TelemetrySnapshot | undefined;
		try {
			updateFooter();
			if (record.status === "stopped") {
				telemetrySnapshot = {
					wakesUsed,
					wakeBudget: config.wakeBudget,
				};
				writeTelemetry(record, outcome, telemetrySnapshot);
				telemetryWritten = true;
				return;
			}

			let tail: string | undefined;
			if (
				config.includeTailLines > 0 &&
				record.spec.mode === "agent" &&
				outcome.kind === "fired"
			) {
				const tailResult = await runHerdr(
					[
						"agent",
						"read",
						record.spec.target,
						"--source",
						"recent-unwrapped",
						"--lines",
						String(config.includeTailLines),
					],
					{ timeoutMs: 5_000 },
				);
				if (tailResult.exitCode === 0) {
					tail = extractTail(tailResult.json, tailResult.stdout);
				}
			}
			if (record.spec.mode === "command") {
				tail = lastLines(
					[outcome.stdout, outcome.stderr].filter(Boolean).join("\n"),
					10,
				);
			} else if (tail === undefined && outcome.json === undefined) {
				tail = lastLines(outcome.stdout || outcome.stderr, 10);
			}

			if (generation !== sessionGeneration) {
				telemetrySnapshot = {
					wakesUsed,
					wakeBudget: config.wakeBudget,
				};
				writeTelemetry(record, outcome, telemetrySnapshot);
				telemetryWritten = true;
				return;
			}

			const busyAtDecision = agentBusy;
			const delivery = decideDelivery({
				wake: record.spec.wake,
				agentBusy: busyAtDecision,
				wakesUsed,
				wakeBudget: config.wakeBudget,
			});
			wakesUsed = delivery.wakesUsedAfter;
			telemetrySnapshot = { delivery, wakeBudget: config.wakeBudget };
			const content = formatWatchCard(record, outcome, tail, {
				reason: delivery.reason,
				wakesUsedAfter: delivery.wakesUsedAfter,
				wakeBudget: config.wakeBudget,
				countsAsWake: delivery.countsAsWake,
			});
			pi.sendMessage(
				{
					customType: WATCH_MESSAGE_TYPE,
					content,
					display: true,
					details: { record, outcomeKind: outcome.kind },
				},
				{
					deliverAs: delivery.deliverAs,
					triggerTurn: delivery.triggerTurn,
				},
			);
			const notifyExhaustion =
				delivery.reason === "budget-exhausted" &&
				!busyAtDecision &&
				!exhaustionNotified;
			if (notifyExhaustion) exhaustionNotified = true;
			updateFooter();

			if (notifyExhaustion) {
				try {
					await runHerdr(
						[
							"notification",
							"show",
							`Herdr wake budget exhausted (${delivery.wakesUsedAfter}/${config.wakeBudget}); watch #${record.id} did not start a turn`,
							"--sound",
							"request",
						],
						{ timeoutMs: 5_000 },
					);
				} catch {
					// Exhaustion notifications are best-effort; the latch stays set.
				}
			}

			const state =
				record.spec.mode === "agent"
					? extractAgentState(outcome.json)
					: undefined;
			if (
				record.spec.mode === "agent" &&
				outcome.kind === "fired" &&
				state !== undefined &&
				config.toastOn.includes(state)
			) {
				try {
					await runHerdr([
						"notification",
						"show",
						`${record.spec.target} ${state}`,
						"--sound",
						"request",
					]);
				} catch {
					// Herdr notifications are best-effort.
				}
			}

			writeTelemetry(record, outcome, telemetrySnapshot);
			telemetryWritten = true;
		} catch (error) {
			if (!telemetryWritten) {
				telemetrySnapshot ??= {
					wakesUsed,
					wakeBudget: config.wakeBudget,
				};
				writeTelemetry(record, outcome, telemetrySnapshot);
			}
			if (generation === sessionGeneration) {
				try {
					pi.sendMessage(
						{
							customType: WATCH_MESSAGE_TYPE,
							content: `watch #${record.id} delivery failed: ${errorMessage(error)}`,
							display: true,
							details: { record, outcomeKind: outcome.kind },
						},
						{ deliverAs: "steer", triggerTurn: false },
					);
				} catch {
					// A delivery failure must never become an unhandled rejection.
				}
			}
		} finally {
			updateFooter();
		}
	};

	pi.registerTool({
		name: "herdr_orchestrate",
		label: "Herdr Orchestrate",
		description:
			"Activate herdr orchestration for this session: enables herdr_watch/herdr_unwatch/herdr_watches/herdr_route and returns the orchestration workflow to follow. Call this ONLY when the user explicitly asks you to act as the orchestrator (e.g. 'you are the orchestrator', 'dispatch this to workers'). Never call it on your own initiative or because a worker brief mentions orchestration. Activation starts no workers.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const changed = activate(ctx, "tool", { persist: true });
			const guidance = buildGuidance();
			const header = changed
				? "orchestration activated for this session (persisted; restored on reload/resume, not on fork). No workers were started. Follow this workflow now:"
				: "orchestration already active for this session. Current workflow:";
			return {
				content: [{ type: "text", text: `${header}\n\n${guidance}` }],
				details: { promoted: true, changed },
			};
		},
	});

	registerRoutingTool(pi, { isActive: () => promoted });

	pi.registerMessageRenderer(
		WATCH_MESSAGE_TYPE,
		(message, _options, theme) => {
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.map((part) => (part.type === "text" ? part.text : "[image]"))
							.join("\n");
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(content, 0, 0));
			return box;
		},
	);

	pi.registerTool({
		name: "herdr_watch",
		label: "Herdr Watch",
		description: WATCH_DESCRIPTION,
		promptSnippet: "Register a non-blocking herdr watch that reports when it fires",
		promptGuidelines: [
			"Use herdr_watch after prompting a herdr worker without --wait; continue other work or end the turn until the watch reports.",
			"Never poll herdr agent read in a loop or run herdr agent wait or agent prompt --wait through bash; use herdr_watch instead.",
			"To watch a command finishing (CI runs, builds, deploys), prefer mode: 'command' — you are woken with the exit code; no pane or sentinel is needed.",
			"If a pane sentinel is still appropriate, print the exit status inline: …; printf '\\n__TAG_%s__\\n' \"$?\". Never assign to status: it is read-only in zsh and aborts the rest of the line. Keep a %s-style placeholder in the typed command so its echoed text cannot false-match the regex.",
		],
		parameters: WatchParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (manager === undefined) throw new Error("no active session");
			const specInput = {
				mode: params.mode ?? "agent",
				...(params.target === undefined ? {} : { target: params.target }),
				...(params.until === undefined ? {} : { until: params.until }),
				...(params.match === undefined ? {} : { match: params.match }),
				...(params.regex === undefined ? {} : { regex: params.regex }),
				...(params.command === undefined ? {} : { command: params.command }),
				...(params.timeoutMs === undefined
					? {}
					: { timeoutMs: params.timeoutMs }),
				...(params.note === undefined ? {} : { note: params.note }),
				wake: params.wake ?? true,
			};
			const record = manager.start(specInput as WatchSpec);
			updateFooter();
			const armedOn =
				record.spec.mode === "command"
					? conditionSummary(record.spec)
					: `${record.spec.target} (${conditionSummary(record.spec)})`;
			const deliveryPromise = record.spec.wake
				? "you will be woken when it fires; continue other work or end your turn."
				: "report will be delivered without starting a turn";
			return {
				content: [
					{
						type: "text",
						text: `watch #${record.id} armed on ${armedOn} — ${deliveryPromise}`,
					},
				],
				details: { watchId: record.id },
			};
		},
	});

	pi.registerTool({
		name: "herdr_unwatch",
		label: "Herdr Unwatch",
		description:
			"Stop armed herdr watches by providing an id or all: true. A stopped watch delivers no report.",
		parameters: UnwatchParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (manager === undefined) throw new Error("no active session");
			const target = params.all === true ? "all" : params.id;
			if (target === undefined) throw new Error("provide a watch id or all: true");
			const stopped = await manager.stop(target);
			updateFooter();
			const text =
				stopped.length === 0
					? "no armed watches stopped"
					: stopped.length === 1
						? `stopped watch #${stopped[0]?.id}`
						: `stopped ${stopped.length} watches: ${stopped
								.map((record) => `#${record.id}`)
								.join(", ")}`;
			return {
				content: [{ type: "text", text }],
				details: { stoppedIds: stopped.map((record) => record.id) },
			};
		},
	});

	pi.registerTool({
		name: "herdr_watches",
		label: "Herdr Watches",
		description: "List armed herdr watches and recent watch history.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			if (manager === undefined) throw new Error("no active session");
			const records = manager.list();
			const header =
				config.wakeBudget === 0
					? "wake: off (budget 0)"
					: `wake budget: ${wakesUsed}/${config.wakeBudget} attempted idle wakes since last interactive or RPC input`;
			const rows =
				records.length === 0
					? "no watches"
					: records
							.map((record) => formatWatchLine(record, Date.now()))
							.join("\n");
			return {
				content: [{ type: "text", text: `${header}\n${rows}` }],
				details: {
					count: records.length,
					wakesUsed,
					wakeBudget: config.wakeBudget,
					exhausted:
						config.wakeBudget > 0 && wakesUsed >= config.wakeBudget,
				},
			};
		},
	});

	registerWatchesCommand(pi, {
		list: () => manager?.list() ?? [],
		stop: async (id) => {
			if (manager === undefined) return [];
			const stopped = await manager.stop(id);
			updateFooter();
			return stopped;
		},
	});

	pi.registerCommand("orchestrate", {
		description:
			"Activate herdr orchestration for this session (`/orchestrate`) or switch it off (`/orchestrate off`)",
		getArgumentCompletions: (prefix) =>
			"off".startsWith(prefix.toLowerCase()) ? [{ value: "off", label: "off" }] : null,
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const parsed = parseOrchestrateArgs(args);
			if (parsed.kind === "unknown") {
				notify(
					ctx,
					`unknown /orchestrate argument "${parsed.argument}"; use /orchestrate or /orchestrate off. Task arguments are not supported.`,
					"error",
				);
				return;
			}
			if (parsed.kind === "off") {
				const wasActive = promoted;
				const stopped = await deactivate(ctx);
				const watches =
					stopped === 0
						? "no armed watches"
						: `stopped ${stopped} armed watch${stopped === 1 ? "" : "es"} (their child processes were terminated)`;
				notify(
					ctx,
					`${wasActive ? "orchestration off" : "orchestration was already off"}: ${watches}; ${OFF_DISCLOSURE}`,
					"info",
				);
				return;
			}
			const changed = activate(ctx, "command", { persist: true });
			const routing = routingStatus();
			notify(
				ctx,
				`${
					changed
						? "orchestration active for this session: workflow guidance and herdr_watch/herdr_route enabled; no workers started. Restored on reload/resume, not on fork."
						: "orchestration already active for this session."
				} ${routing.line}.`,
				routing.ready ? "info" : "warning",
			);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!promoted) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildGuidance()}` };
	});

	pi.on("input", (event, ctx) => {
		uiCtx = ctx;
		if (event.source === "interactive" || event.source === "rpc") {
			wakesUsed = 0;
			exhaustionNotified = false;
			updateFooter();
		}
	});

	/**
	 * Decide activation for the session that just started. Pi re-runs this
	 * extension factory on reload/new/resume/fork, so nothing in memory
	 * survives; the persisted entries of this session are authoritative.
	 * Fork/clone copies entries under a new session id, so they never match,
	 * and the explicit env launch never activates such an inherited session.
	 */
	const restoreActivation = (
		ctx: ExtensionContext,
		reason: string,
	): void => {
		const sessionId = ctx.sessionManager.getSessionId();
		const state = readOrchestrationState(ctx.sessionManager.getEntries(), sessionId);
		const firstNotice = !noticedSessions.has(sessionId);
		noticedSessions.add(sessionId);

		if (state.own) {
			promoted = state.own.active;
			setOrchestratorToolsActive(promoted);
			if (promoted) {
				recoveryNote = `Orchestration was restored for this session (${reason}); any watches armed before that point are gone and workers dispatched earlier are not being supervised until you verify them and re-arm.`;
				if (firstNotice) {
					notify(
						ctx,
						`orchestration restored for this session (${reason}): armed watches were NOT restored; reconcile owned workers before re-arming.`,
						"warning",
					);
				}
			}
			return;
		}

		// CLI --fork starts with reason "startup"; an inactive parent may have
		// no activation entries to mark inherited. Its header still identifies it.
		const forked = state.inherited || reason === "fork" ||
			Boolean(ctx.sessionManager.getHeader()?.parentSession);
		if (envActivation && !forked) {
			activate(ctx, "env", { persist: true });
			if (firstNotice) {
				const routing = routingStatus();
				notify(
					ctx,
					`orchestration active from PI_HERDR_ORCHESTRATOR=1 for this session; no workers started. ${routing.line}.`,
					routing.ready ? "info" : "warning",
				);
			}
			return;
		}

		promoted = false;
		setOrchestratorToolsActive(false);
		if (forked && firstNotice) {
			notify(
				ctx,
				`forked/cloned session: orchestration is inactive here${envActivation ? " (PI_HERDR_ORCHESTRATOR=1 is ignored for forks)" : ""}; the parent's workers and watches are not owned by this session. Run /orchestrate to activate.`,
				"info",
			);
		}
	};

	pi.on("session_start", async (event, ctx) => {
		uiCtx = ctx;
		agentBusy = false;
		wakesUsed = 0;
		exhaustionNotified = false;
		const generation = ++sessionGeneration;
		const oldManager = manager;
		manager = undefined;
		updateFooter();
		await oldManager?.shutdown();
		if (generation !== sessionGeneration) return;
		manager = new WatchManager({
			maxWatches: config.maxWatches,
			onOutcome: (record, outcome) => {
				void handleOutcome(generation, record, outcome);
			},
		});
		restoreActivation(ctx, event.reason);
		updateFooter();
	});

	pi.on("agent_start", (_event, ctx) => {
		uiCtx = ctx;
		agentBusy = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		uiCtx = ctx;
		agentBusy = false;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		uiCtx = ctx;
		agentBusy = false;
		sessionGeneration += 1;
		const oldManager = manager;
		manager = undefined;
		await oldManager?.shutdown();
		updateFooter();
	});
}
