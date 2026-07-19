/**
 * pi-buddy: a sparring partner for pi.
 *
 * - `consult_buddy` tool: the main agent requests a Buddy consultation for
 *   discussion, debate, fact-checking, or review. The buddy sees the full
 *   session transcript, has read-only repo tools (read/grep/find/ls), and read-only
 *   web tools (lookup_docs via deepwiki, read_webpage via agent-browser) to
 *   verify claims beyond both models' knowledge cutoffs.
 * - `/buddy <question>` command: the human summons the buddy directly.
 * - Detached watchdog: if 3 turns elapse in a run without a consultation, the
 *   buddy investigates IN THE BACKGROUND while the agent keeps working — like
 *   a colleague who checks his suspicion before interrupting. Structured pass
 *   verdicts are suppressed; concerns remain private until revalidated against
 *   a stable current snapshot, then are steered in (or queued for the next
 *   turn if the run already ended — never auto-waking the agent).
 * - End-of-run review: runs of >= 2 turns that never consulted the buddy get
 *   a quiet background review once the agent is fully settled, using the same
 *   revalidation gate.
 *
 * Buddy model defaults to zai/glm-5.2 (override with --buddy-model).
 * Model calls are stateless. A small branch-aware concern history prevents the
 * watchdog from re-raising concerns the agent explicitly fixed or rebutted.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { AutomaticReview } from "./automatic-review.js";
import type { BuddyTool } from "./buddy-tool.js";
import {
	BUDDY_FEEDBACKS,
	formatBuddyFeedbackResult,
	type BuddyFeedback,
} from "./calibration.js";
import { BuddySession } from "./buddy-session.js";
import {
	ConsultationWorkflow,
	formatFailoverLine,
	formatFailoverNotice,
	type ConsultationInjection,
} from "./consultation-workflow.js";
import type { ConcernDisposition } from "./concern-history.js";
import {
	buddyRendererLabel,
	formatBuddyAdvisory,
	formatBuddyConsult,
	type BuddyReviewDetails,
} from "./message-format.js";
import { deriveSlug, MemoryStore } from "./memory.js";
import { commandConsultDelivery } from "./policy.js";
import {
	buildStanceSystemPrompt,
	type Stance,
	STANCES,
} from "./stances.js";
import { appendSkillsToBuddyPrompt } from "./skill-prompt.js";
import {
	CONSULT_BUDDY_TOOL,
	GIVE_BUDDY_FEEDBACK_TOOL,
	parseBuddyCommand,
} from "./switch.js";
import { recordFeedback } from "./telemetry.js";
import { closeBuddyBrowser, createWebTools, type ExecFn } from "./web-tools.js";
import { createWatchdogVerdictTool } from "./watchdog-verdict.js";

const DEFAULT_BUDDY_MODEL = "zai/glm-5.2";
const DISABLED_MESSAGE = "Buddy is disabled. Run `/buddy on` to re-enable.";
const RUN_END_REVIEW_MIN_TURNS = 2;
const BUDDY_REVIEW_TYPE = "buddy-review";
const STATUS_KEY = "buddy";
const BG_STATUS_KEY = "buddy-bg";
const MODEL_STATUS_KEY = "buddy-model";

export default function setup(pi: ExtensionAPI): void {
	const session = new BuddySession(new MemoryStore());
	let currentSkills: Skill[] = [];

	const execFn: ExecFn = async (command, args, options) => {
		session.markBrowserUsed();
		return pi.exec(command, args, options);
	};
	const webTools: BuddyTool[] = createWebTools(execFn);
	const watchdogTools: BuddyTool[] = [
		...webTools,
		createWatchdogVerdictTool("review"),
	];
	const watchdogRevalidationTools: BuddyTool[] = [
		...webTools,
		createWatchdogVerdictTool("revalidation"),
	];
	const consultationWorkflow: ConsultationWorkflow = new ConsultationWorkflow({
		defaultModelSpec: () =>
			String(pi.getFlag("buddy-model") ?? DEFAULT_BUDDY_MODEL),
		buildInjection: (cwd, includeMemory): ConsultationInjection =>
			session.buildInjection(
				deriveSlug(cwd),
				includeMemory,
				automaticReview.context(),
			),
		memoryStore: session.memory,
		webTools,
		setModelStatus: setBuddyModelStatus,
		notifyConfigWarnings,
	});
	const automaticReview: AutomaticReview = new AutomaticReview({
		host: pi,
		consultation: consultationWorkflow,
		tools: watchdogTools,
		revalidationTools: watchdogRevalidationTools,
		getWatchdogThreshold: () => session.watchdogThreshold(),
		isEnabled: () => session.enabled,
		reviewMessageType: BUDDY_REVIEW_TYPE,
		backgroundStatusKey: BG_STATUS_KEY,
		runEndReviewMinTurns: RUN_END_REVIEW_MIN_TURNS,
	});

	pi.registerFlag("buddy-disabled", {
		description:
			"Disable pi-buddy for this session. Re-enable with /buddy on.",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("buddy-model", {
		description: `Buddy model as provider/id (default: ${DEFAULT_BUDDY_MODEL})`,
		type: "string",
		default: DEFAULT_BUDDY_MODEL,
	});

	function applyBuddyToolState(enabled: boolean): void {
		try {
			const activeTools = pi.getActiveTools();
			const nextTools = session.activeToolsFor(enabled, activeTools);
			const changed =
				nextTools.length !== activeTools.length ||
				nextTools.some((tool, i) => tool !== activeTools[i]);
			if (changed) pi.setActiveTools(nextTools);
		} catch {
			// Best-effort UX only; the consult_buddy execute guard is load-bearing.
		}
	}

	function abortBackgroundReview(): void {
		automaticReview.abort();
	}

	async function initializeBuddySwitch(ctx?: ExtensionContext): Promise<void> {
		if (session.seedEnablement(pi.getFlag("buddy-disabled"))) {
			applyBuddyToolState(true);
			await refreshBuddyModelStatus(ctx);
			return;
		}
		abortBackgroundReview();
		applyBuddyToolState(false);
		setBuddyModelStatus(ctx, undefined);
	}

	function notify(ctx: ExtensionContext | undefined, message: string): void {
		if (ctx?.hasUI) ctx.ui.notify(message, "info");
	}

	function setBuddyModelStatus(
		ctx: ExtensionContext | undefined,
		modelSpec: string | undefined,
		options: { failover?: boolean } = {},
	): void {
		if (!ctx?.hasUI) return;
		if (!session.enabled) {
			ctx.ui.setStatus(MODEL_STATUS_KEY, "buddy: off");
			return;
		}
		if (!modelSpec) {
			ctx.ui.setStatus(MODEL_STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(
			MODEL_STATUS_KEY,
			`buddy: ${modelSpec}${options.failover ? " (fallback)" : ""}`,
		);
	}

	async function refreshBuddyModelStatus(ctx: ExtensionContext | undefined): Promise<void> {
		if (!ctx?.hasUI) return;
		if (!session.enabled) {
			setBuddyModelStatus(ctx, undefined);
			return;
		}
		try {
			const plan = await consultationWorkflow.resolveModelPlan(ctx, "tool");
			setBuddyModelStatus(ctx, plan.candidates[0]?.spec);
		} catch {
			ctx.ui.setStatus(MODEL_STATUS_KEY, "buddy: unavailable");
		}
	}

	function setBuddyEnabled(enabled: boolean, ctx?: ExtensionContext): void {
		if (!session.setEnabled(enabled)) {
			notify(ctx, `Buddy is already ${enabled ? "on" : "off"}.`);
			return;
		}
		if (!enabled) abortBackgroundReview();
		applyBuddyToolState(enabled);
		if (enabled) {
			void refreshBuddyModelStatus(ctx);
		} else {
			setBuddyModelStatus(ctx, undefined);
		}
		notify(ctx, `Buddy is now ${enabled ? "on" : "off"}.`);
	}

	function skillsFromCommandContext(ctx: ExtensionContext): Skill[] {
		const commandCtx = ctx as ExtensionContext & {
			getSystemPromptOptions?: () => BuildSystemPromptOptions;
		};
		return commandCtx.getSystemPromptOptions?.().skills ?? currentSkills;
	}

	function notifyConfigWarnings(ctx: ExtensionContext, warnings: readonly string[]): void {
		if (!ctx.hasUI) return;
		for (const warning of session.configWarningsToShow(warnings)) {
			ctx.ui.notify(`Buddy config: ${warning}`, "warning");
		}
	}

	// --- The consult_buddy tool (agent-requested consult) ---

	pi.registerTool({
		name: CONSULT_BUDDY_TOOL,
		label: "Consult Buddy",
		description:
			"Consult your sparring partner (a separate model with read-only access " +
			"to this repository, the web, and the full conversation transcript). " +
			"Stances: 'discuss' explores tradeoffs and alternatives; 'debate' " +
			"steelmans the case AGAINST your proposal; 'fact_check' verifies claims " +
			"against actual files, library docs, and the web (useful past your " +
			"knowledge cutoff); 'review' checks recent work for correctness and " +
			"missed requirements. The buddy is candid and will push back — treat " +
			"its concerns seriously, but you remain responsible for the final " +
			"decision.",
		promptSnippet:
			"Consult a candid sparring partner to discuss, debate, fact-check, or review",
		promptGuidelines: [
			"Use consult_buddy (stance 'debate' or 'discuss') after initial orientation (reading files, searching) but before committing to a significant design or architectural decision — orientation is not substantive work; writing is.",
			"Use consult_buddy (stance 'fact_check') when making claims about the codebase, or about library APIs/versions/best practices, that you have not directly verified this session — the buddy can check current docs and the web beyond your knowledge cutoff.",
			"Use consult_buddy (stance 'review') after completing a substantial piece of work and before declaring it done — make the deliverable durable first (files written, changes committed), then ask for the review.",
		],
		parameters: Type.Object({
			stance: StringEnum([...STANCES] as ["discuss", "debate", "fact_check", "review"], {
				description:
					"discuss | debate | fact_check | review — how the buddy should engage",
			}),
			question: Type.String({
				description:
					"What you want the buddy's take on. Be specific; include your current position or the claims to check.",
			}),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			if (!session.enabled) {
				throw new Error(DISABLED_MESSAGE);
			}
			automaticReview.onConsultationRequested();
			const stance = params.stance as Stance;
			const activity: string[] = [];
			const result = await consultationWorkflow.run({
				ctx,
				systemPrompt: appendSkillsToBuddyPrompt(
					buildStanceSystemPrompt(stance),
					currentSkills,
				),
				requestText: params.question,
				source: "tool",
				stance,
				harvest: true,
				onActivity: (line) => {
					activity.push(line);
					onUpdate?.({
						content: [{ type: "text", text: `buddy: ${line}` }],
						details: { stance, activity: [...activity] },
					});
				},
			});
			return {
				content: [{ type: "text", text: formatFailoverNotice(result) }],
				details: {
					stance,
					question: params.question,
					activity: result.activity,
					rounds: result.rounds,
					transcriptTokens: result.transcriptTokens,
					usage: result.usage,
					model: result.model,
					modelsAttempted: result.modelsAttempted,
					failoverUsed: result.failoverUsed,
				},
			};
		},
		renderCall(args, theme, context) {
			const stance = typeof args.stance === "string" ? args.stance : "…";
			const question =
				typeof args.question === "string" ? args.question : "";
			let content = theme.fg("toolTitle", theme.bold("buddy "));
			content += theme.fg("accent", `[${stance}] `);
			content += theme.fg("muted", question);
			// Reuse the previous component instance per docs best practice.
			const text =
				(context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(content);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = (result.details ?? {}) as {
				activity?: string[];
				rounds?: number;
			};
			if (isPartial) {
				const last = details.activity?.at(-1);
				text.setText(
					theme.fg("warning", last ? `buddy: ${last}` : "buddy is thinking..."),
				);
				return text;
			}
			const answer = result.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("\n");
			let content = answer;
			if (expanded && details.activity && details.activity.length > 0) {
				content += "\n\n" + theme.fg("dim", "Buddy verified via:");
				for (const line of details.activity) {
					content += "\n" + theme.fg("dim", `  ${line}`);
				}
			} else if (details.activity && details.activity.length > 0) {
				content +=
					"\n" +
					theme.fg(
						"dim",
						`(buddy ran ${details.activity.length} read-only lookup(s))`,
					);
			}
			text.setText(content);
			return text;
		},
	});

	// --- The give_buddy_feedback tool (agent-requested calibration) ---

	pi.registerTool({
		name: GIVE_BUDDY_FEEDBACK_TOOL,
		label: "Give Buddy Feedback",
		description:
			"Give session-scoped feedback that calibrates Buddy's automatic advisory " +
			"cadence and optionally records whether a watchdog concern was fixed or " +
			"rebutted. Use 'less' when automatic advisories are too frequent or " +
			"premature, 'more' when Buddy should be more active, and 'same' when the " +
			"current level is useful. This never disables run-end review, explicit " +
			"consult_buddy, or user /buddy consultations.",
		promptSnippet:
			"Calibrate Buddy's automatic advisory cadence with more, same, or less feedback",
		promptGuidelines: [
			"Use give_buddy_feedback when Buddy's automatic advisories are too frequent, too timid, or currently well-calibrated.",
			"Use give_buddy_feedback with concernDisposition 'fixed' after fixing a watchdog concern, or 'rebutted' after disproving it with evidence; include a concrete reason.",
			"Use 'less' to exponentially back off watchdog cadence; use 'more' to step Buddy back toward normal or more active review.",
			"Do not use this to avoid review: run-end review and explicit Buddy consultations remain available and are not suppressed.",
		],
		parameters: Type.Object({
			feedback: StringEnum([...BUDDY_FEEDBACKS] as ["more", "same", "less"], {
				description: "more | same | less — how Buddy should adjust automatic advisories",
			}),
			concernId: Type.Optional(
				Type.String({
					description:
						"Concern ID from a Buddy advisory. Omit to target the latest open concern.",
				}),
			),
			concernDisposition: Type.Optional(
				StringEnum(["fixed", "rebutted"] as const, {
					description:
						"fixed when the concern was addressed; rebutted when evidence disproved it",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description:
						"Brief reason for auditability. Required when recording a concern disposition; treated as context, not proof.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!session.enabled) {
				throw new Error(DISABLED_MESSAGE);
			}
			const feedback = params.feedback as BuddyFeedback;
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const concernId =
				typeof params.concernId === "string" ? params.concernId.trim() : "";
			const concernDisposition = params.concernDisposition as
				| ConcernDisposition
				| undefined;
			if (concernId && !concernDisposition) {
				throw new Error("concernId requires concernDisposition");
			}
			if (concernDisposition && !reason) {
				throw new Error("A concrete reason is required to mark a concern");
			}
			const concernUpdate = concernDisposition
				? automaticReview.markConcern({
						id: concernId || undefined,
						disposition: concernDisposition,
						reason,
					})
				: undefined;
			if (concernUpdate && !concernUpdate.ok) {
				const message =
					concernUpdate.reason === "no_open_concern"
						? "No open Buddy concern is available to mark"
						: concernUpdate.reason === "not_found"
							? `Buddy concern #${concernId} was not found`
							: `Buddy concern #${concernId} is already closed`;
				throw new Error(message);
			}
			const result = session.applyFeedback(feedback, reason || undefined);
			const updatedConcern = concernUpdate?.ok
				? concernUpdate.concern
				: undefined;
			await recordFeedback({
				feedback,
				reason: reason || undefined,
				previousLevel: result.previousLevel,
				newLevel: result.newLevel,
				watchdogThreshold: result.watchdogThreshold,
				concernId: updatedConcern?.id,
				concernDisposition: updatedConcern?.status as
					| ConcernDisposition
					| undefined,
			});
			if (ctx.hasUI && feedback !== "same") {
				ctx.ui.notify(formatBuddyFeedbackResult(result), "info");
			}
			const dispositionResult = updatedConcern
				? `Concern #${updatedConcern.id} marked ${updatedConcern.status}: ${
						updatedConcern.status === "rebutted"
							? updatedConcern.reason
							: updatedConcern.headline
					}`
				: undefined;
			return {
				content: [
					{
						type: "text",
						text: [formatBuddyFeedbackResult(result), dispositionResult]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					feedback,
					reason: reason || undefined,
					previousLevel: result.previousLevel,
					newLevel: result.newLevel,
					watchdogThreshold: result.watchdogThreshold,
					concernId: updatedConcern?.id,
					concernHeadline: updatedConcern?.headline,
					concernDisposition: updatedConcern?.status,
				},
			};
		},
		renderCall(args, theme, context) {
			const feedback = typeof args.feedback === "string" ? args.feedback : "…";
			const reason = typeof args.reason === "string" ? args.reason : "";
			let content = theme.fg("toolTitle", theme.bold("buddy feedback "));
			content += theme.fg("accent", `[${feedback}] `);
			content += theme.fg("muted", reason);
			const text =
				(context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(content);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text =
				(context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const answer = result.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("\n");
			text.setText(theme.fg("muted", answer));
			return text;
		},
	});

	// --- /buddy command (user-requested consult) ---

	pi.registerCommand("buddy", {
		description:
			"Ask Buddy or control it (usage: /buddy <question>|on|off|status)",
		handler: async (args, ctx) => {
			const parsed = parseBuddyCommand(args);
			if (parsed.kind === "control") {
				if (parsed.action === "status") {
					notify(ctx, `Buddy is ${session.enabled ? "on" : "off"}.`);
					return;
				}
				setBuddyEnabled(parsed.action === "on", ctx);
				return;
			}
			if (!session.enabled) {
				if (ctx.hasUI) ctx.ui.notify(DISABLED_MESSAGE, "warning");
				return;
			}
			let question = parsed.kind === "ask" ? parsed.question : "";
			if (!question && ctx.hasUI) {
				question =
					(await ctx.ui.input("Ask the buddy:", "What do you think about...")) ??
					"";
			}
			if (!question) return;
			automaticReview.onConsultationRequested();
			try {
				const result = await consultationWorkflow.run({
					ctx,
					systemPrompt: appendSkillsToBuddyPrompt(
						buildStanceSystemPrompt("discuss"),
						skillsFromCommandContext(ctx),
					),
					requestText:
						`The HUMAN USER is asking you directly (not the agent):\n\n${question}`,
					source: "command",
					stance: "discuss",
					harvest: true,
				});
				const fallbackLine = formatFailoverLine(result);
				const message = {
					customType: BUDDY_REVIEW_TYPE,
					content: fallbackLine
						? `${fallbackLine}\n\n${formatBuddyConsult(result.answer)}`
						: formatBuddyConsult(result.answer),
					display: true,
					details: {
						activity: result.activity,
						source: "command",
						model: result.model,
						modelsAttempted: result.modelsAttempted,
						failoverUsed: result.failoverUsed,
					},
				};
				if (
					commandConsultDelivery(automaticReview.deliveryMode()) === "immediate"
				) {
					pi.sendMessage(message);
				} else {
					pi.sendMessage(message, { deliverAs: "nextTurn" });
				}
			} catch (error) {
				ctx.ui.notify(`Buddy failed: ${errorToString(error)}`, "error");
			}
		},
	});

	// --- /buddy-memory command (user curation surface) ---

	pi.registerCommand("buddy-memory", {
		description:
			"Show buddy memory (usage: /buddy-memory [clear <global|project>])",
		handler: async (args, ctx) => {
			const slug = deriveSlug(ctx.cwd);
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "clear") {
				const scope = parts[1];
				if (scope !== "global" && scope !== "project") {
					if (ctx.hasUI) {
						ctx.ui.notify("Usage: /buddy-memory clear <global|project>", "warning");
					}
					return;
				}
				const cleared = session.memory.clear(scope, slug);
				if (ctx.hasUI) {
					ctx.ui.notify(
						cleared
							? `Buddy ${scope} memory archived and cleared.`
							: `No ${scope} memory to clear.`,
						"info",
					);
				}
				return;
			}
			const sections: string[] = [];
			for (const [label, file] of [
				["Global", session.memory.globalPath()],
				["Project", session.memory.projectPath(slug)],
			] as const) {
				const lines = session.memory.readLines(file);
				sections.push(`${label} (${file}):`);
				if (lines.length === 0) {
					sections.push("  (empty)");
				} else {
					lines.forEach((line, i) => {
						sections.push(
							line.kind === "entry"
								? `  ${i + 1}. [${line.date}] ${line.text}`
								: `  ${i + 1}. ${line.line}`,
						);
					});
				}
				sections.push("");
			}
			sections.push("Edit the files directly to curate; delete a line to forget it.");
			pi.sendMessage({
				customType: BUDDY_REVIEW_TYPE,
				content: sections.join("\n"),
				display: true,
				details: { source: "memory" },
			});
		},
	});

	// --- Automatic triggers ---

	pi.on("session_start", async (_event, ctx) => {
		automaticReview.restoreSession(ctx.sessionManager.getBranch());
		session.resetForSession();
		currentSkills = [];
		await initializeBuddySwitch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		automaticReview.restoreTree(ctx.sessionManager.getBranch());
	});

	// Every main-session mutation advances the optimistic commit token. A
	// revalidation that overlaps any of these events is discarded and retried at
	// the next stable boundary.
	pi.on("input", () => {
		automaticReview.noteActivity();
	});

	pi.on("turn_start", () => {
		automaticReview.noteActivity();
	});

	pi.on("message_end", () => {
		automaticReview.noteActivity();
	});

	pi.on("tool_execution_start", (event) => {
		automaticReview.toolStarted(event.toolCallId);
	});

	pi.on("tool_execution_end", (event) => {
		automaticReview.toolEnded(event.toolCallId);
	});

	pi.on("user_bash", () => {
		automaticReview.noteActivity();
	});

	pi.on("before_agent_start", async (event) => {
		currentSkills = event.systemPromptOptions.skills ?? [];
	});

	pi.on("agent_start", async () => {
		automaticReview.agentStarted();
	});

	pi.on("turn_end", async (_event, ctx) => {
		await automaticReview.turnEnded(ctx);
	});

	pi.on("agent_end", async () => {
		automaticReview.agentEnded();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await automaticReview.agentSettled(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		automaticReview.shutdown();
		session.resetForShutdown();
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setStatus(BG_STATUS_KEY, undefined);
			ctx.ui.setStatus(MODEL_STATUS_KEY, undefined);
		}
		if (session.shouldCloseBrowser) {
			await closeBuddyBrowser((command, args, options) =>
				pi.exec(command, args, options),
			);
			session.markBrowserClosed();
		}
	});

	// --- Rendering for pushed reviews ---

	// Pushed buddy messages render as a visually distinct block: label header,
	// an accent gutter bar on every line, and the custom-message background —
	// so even a long concern cannot be mistaken for the agent's own prose.
	pi.registerMessageRenderer(BUDDY_REVIEW_TYPE, (message, options, theme) => {
		const body =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => (block as { text: string }).text)
						.join("\n");
		const label = buddyRendererLabel(
			message.details as BuddyReviewDetails | undefined,
		);
		const lines: string[] = [
			theme.fg("customMessageLabel", theme.bold(label)),
			...body.split("\n").map(
				(line) =>
					theme.fg("borderAccent", "▌ ") +
					theme.fg("customMessageText", line),
			),
		];
		if (options.expanded) {
			const details = message.details as { activity?: string[] } | undefined;
			if (details?.activity?.length) {
				lines.push(theme.fg("dim", "Verified via:"));
				for (const line of details.activity) {
					lines.push(theme.fg("dim", `  ${line}`));
				}
			}
		}
		const box = new Box(1, 0, (s) => theme.bg("customMessageBg", s));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
