/**
 * pi-buddy: a sparring partner for pi.
 *
 * - `consult_buddy` tool: the main agent pulls the buddy in for discussion,
 *   debate, fact-checking, or review. The buddy sees the full session
 *   transcript, has read-only repo tools (read/grep/find/ls), and read-only
 *   web tools (lookup_docs via deepwiki, read_webpage via agent-browser) to
 *   verify claims beyond both models' knowledge cutoffs.
 * - `/buddy <question>` command: the human summons the buddy directly.
 * - Detached watchdog: if 3 turns elapse in a run without a consultation, the
 *   buddy investigates IN THE BACKGROUND while the agent keeps working — like
 *   a colleague who checks his suspicion before interrupting. PASS verdicts
 *   are suppressed; real concerns are steered in when they land (or queued
 *   for the next turn if the run already ended — never auto-waking the agent).
 * - End-of-run review: runs of >= 2 turns that never consulted the buddy get
 *   a quiet background review at completion, same PASS-suppression.
 *
 * Buddy model defaults to zai/glm-5.2 (override with --buddy-model).
 * Stateless by design: continuity comes from the transcript itself.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import type { BuddyTool } from "./buddy-tools.js";
import { consultBuddy, type ConsultResult } from "./consult.js";
import { type BackgroundTrigger, BuddyRunTracker } from "./policy.js";
import {
	buildStanceSystemPrompt,
	buildWatchdogSystemPrompt,
	isWatchdogPass,
	type Stance,
	STANCES,
} from "./stances.js";
import {
	type BuddyOutcome,
	type BuddySource,
	type BuddyTrigger,
	recordConsultation,
} from "./telemetry.js";
import { closeBuddyBrowser, createWebTools, type ExecFn } from "./web-tools.js";

const DEFAULT_BUDDY_MODEL = "zai/glm-5.2";
const WATCHDOG_TURN_THRESHOLD = 3;
const RUN_END_REVIEW_MIN_TURNS = 2;
const BUDDY_REVIEW_TYPE = "buddy-review";
const STATUS_KEY = "buddy";
const BG_STATUS_KEY = "buddy-bg";

export default function setup(pi: ExtensionAPI): void {
	const tracker = new BuddyRunTracker(
		WATCHDOG_TURN_THRESHOLD,
		RUN_END_REVIEW_MIN_TURNS,
	);
	let backgroundAbort: AbortController | undefined;
	let browserUsed = false;

	const execFn: ExecFn = async (command, args, options) => {
		browserUsed = true;
		return pi.exec(command, args, options);
	};
	const webTools: BuddyTool[] = createWebTools(execFn);

	pi.registerFlag("buddy-model", {
		description: `Buddy model as provider/id (default: ${DEFAULT_BUDDY_MODEL})`,
		type: "string",
		default: DEFAULT_BUDDY_MODEL,
	});

	function resolveBuddyModel(ctx: ExtensionContext): Model<Api> {
		const spec = String(pi.getFlag("buddy-model") ?? DEFAULT_BUDDY_MODEL);
		const slash = spec.indexOf("/");
		if (slash <= 0) {
			throw new Error(
				`Invalid buddy model "${spec}" — expected provider/id, e.g. ${DEFAULT_BUDDY_MODEL}`,
			);
		}
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) {
			throw new Error(`Buddy model ${spec} not found in the model registry`);
		}
		return model as Model<Api>;
	}

	async function runConsultation(args: {
		ctx: ExtensionContext;
		systemPrompt: string;
		requestText: string;
		source: BuddySource;
		stance: string;
		/** Foreground consultations use ctx.signal; detached ones pass their own. */
		signal?: AbortSignal;
		statusKey?: string;
		trigger?: BuddyTrigger;
		/** Maps a successful answer to a telemetry outcome (watchdog: pass/concern). */
		outcomeOf?: (result: ConsultResult) => BuddyOutcome;
		/** Extra telemetry computed at record time (e.g. verdict staleness). */
		extraTelemetry?: () => { turnsElapsed?: number };
		onActivity?: (line: string) => void;
	}): Promise<ConsultResult> {
		const model = resolveBuddyModel(args.ctx);
		const modelSpec = `${model.provider}/${model.id}`;
		const statusKey = args.statusKey ?? STATUS_KEY;
		const startedAt = Date.now();
		args.ctx.ui.setStatus(statusKey, "buddy: consulting...");
		try {
			const result = await consultBuddy({
				requestText: args.requestText,
				systemPrompt: args.systemPrompt,
				entries: args.ctx.sessionManager.getBranch(),
				cwd: args.ctx.cwd,
				model,
				registry: args.ctx.modelRegistry,
				signal: args.signal ?? args.ctx.signal,
				extraTools: webTools,
				onActivity: (line) => {
					args.ctx.ui.setStatus(statusKey, `buddy: ${line}`);
					args.onActivity?.(line);
				},
			});
			await recordConsultation({
				source: args.source,
				stance: args.stance,
				outcome: args.outcomeOf?.(result) ?? "ok",
				model: modelSpec,
				totalMs: Date.now() - startedAt,
				trigger: args.trigger,
				...args.extraTelemetry?.(),
				rounds: result.rounds,
				toolCalls: result.activity.length,
				transcriptTokens: result.transcriptTokens,
				answerChars: result.answer.length,
			});
			return result;
		} catch (error) {
			await recordConsultation({
				source: args.source,
				stance: args.stance,
				// Aborted background reviews (session shutdown/switch) are not failures.
				outcome: args.signal?.aborted ? "discarded" : "error",
				model: modelSpec,
				totalMs: Date.now() - startedAt,
				trigger: args.trigger,
				error: errorToString(error),
			});
			throw error;
		} finally {
			args.ctx.ui.setStatus(statusKey, undefined);
		}
	}

	// --- Detached background review (watchdog + end-of-run) ---

	function launchBackgroundReview(
		trigger: BackgroundTrigger,
		ctx: ExtensionContext,
	): void {
		const launch = tracker.launchBackground(trigger);
		const controller = new AbortController();
		backgroundAbort = controller;

		const requestText =
			trigger === "turns"
				? `Automatic watchdog check-in: the agent has completed ` +
					`${WATCHDOG_TURN_THRESHOLD} turns without consulting you. Review ` +
					`the recent turns. Reply PASS if there is no real problem.`
				: `Automatic end-of-run review: the agent has finished its run ` +
					`without consulting you. Review the work of this run. Reply PASS ` +
					`if there is no real problem.`;

		// Fire-and-forget: the agent keeps working while the buddy investigates.
		void (async () => {
			try {
				const result = await runConsultation({
					ctx,
					systemPrompt: buildWatchdogSystemPrompt(),
					requestText,
					source: "watchdog",
					stance: "watchdog",
					signal: controller.signal,
					statusKey: BG_STATUS_KEY,
					trigger,
					outcomeOf: (r) =>
						!tracker.isCurrent(launch)
							? "discarded"
							: isWatchdogPass(r.answer)
								? "pass"
								: "concern",
					extraTelemetry: () => ({
						turnsElapsed: tracker.turnsElapsedSince(launch),
					}),
				});
				// Session was replaced/forked while we investigated: drop the verdict.
				if (!tracker.isCurrent(launch)) return;
				if (isWatchdogPass(result.answer)) return;
				const staleness = tracker.turnsElapsedSince(launch);
				const framing =
					staleness > 0
						? `Your buddy reviewed the work in the background and raised a ` +
							`concern. It reflects the state as of ~${staleness} turn(s) ago — ` +
							`if you have since addressed it, say so briefly and continue. ` +
							`Otherwise address it (fix, rebut with evidence, or ` +
							`consult_buddy to discuss):`
						: `Your buddy reviewed the recent work and raised a concern. ` +
							`Address it (fix, rebut with evidence, or consult_buddy to ` +
							`discuss) before continuing:`;
				pi.sendMessage(
					{
						customType: BUDDY_REVIEW_TYPE,
						content: `${framing}\n\n${result.answer}`,
						display: true,
						details: {
							activity: result.activity,
							source: "watchdog",
							trigger,
							turnsElapsed: staleness,
						},
					},
					// Steer mid-run; queue for the next prompt when idle. Never
					// auto-wake the agent (no triggerTurn) — nobody holds the leash.
					{ deliverAs: tracker.deliveryMode() },
				);
			} catch (error) {
				// Background review is best-effort: never surface as a failure,
				// telemetry already recorded it. Notify only if the session is live.
				if (tracker.isCurrent(launch) && !controller.signal.aborted) {
					ctx.ui.notify(
						`Buddy background review failed: ${errorToString(error)}`,
						"warning",
					);
				}
			} finally {
				tracker.settleBackground();
				if (backgroundAbort === controller) backgroundAbort = undefined;
			}
		})();
	}

	// --- The consult_buddy tool (pull) ---

	pi.registerTool({
		name: "consult_buddy",
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
			"Use consult_buddy (stance 'debate' or 'discuss') before committing to a significant design or architectural decision.",
			"Use consult_buddy (stance 'fact_check') when making claims about the codebase, or about library APIs/versions/best practices, that you have not directly verified this session — the buddy can check current docs and the web beyond your knowledge cutoff.",
			"Use consult_buddy (stance 'review') after completing a substantial piece of work and before declaring it done.",
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
			tracker.onPull();
			const stance = params.stance as Stance;
			const activity: string[] = [];
			const result = await runConsultation({
				ctx,
				systemPrompt: buildStanceSystemPrompt(stance),
				requestText: params.question,
				source: "tool",
				stance,
				onActivity: (line) => {
					activity.push(line);
					onUpdate?.({
						content: [{ type: "text", text: `buddy: ${line}` }],
						details: { stance, activity: [...activity] },
					});
				},
			});
			return {
				content: [{ type: "text", text: result.answer }],
				details: {
					stance,
					question: params.question,
					activity: result.activity,
					rounds: result.rounds,
					transcriptTokens: result.transcriptTokens,
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

	// --- /buddy command (human pull) ---

	pi.registerCommand("buddy", {
		description: "Ask the buddy directly (usage: /buddy <question>)",
		handler: async (args, ctx) => {
			let question = args?.trim() ?? "";
			if (!question && ctx.hasUI) {
				question =
					(await ctx.ui.input("Ask the buddy:", "What do you think about...")) ??
					"";
			}
			if (!question) return;
			tracker.onPull();
			try {
				const result = await runConsultation({
					ctx,
					systemPrompt: buildStanceSystemPrompt("discuss"),
					requestText:
						`The HUMAN USER is asking you directly (not the agent):\n\n${question}`,
					source: "command",
					stance: "discuss",
				});
				pi.sendMessage(
					{
						customType: BUDDY_REVIEW_TYPE,
						content: `Buddy (asked by the user): ${result.answer}`,
						display: true,
						details: { activity: result.activity, source: "command" },
					},
					{ deliverAs: "nextTurn" },
				);
			} catch (error) {
				ctx.ui.notify(`Buddy failed: ${errorToString(error)}`, "error");
			}
		},
	});

	// --- Automatic triggers ---

	pi.on("agent_start", async () => {
		tracker.onAgentStart();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (tracker.onTurnEnd()) {
			launchBackgroundReview("turns", ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const shouldReview = tracker.onAgentEnd();
		// In print/json mode the process exits right after the run, so a
		// run-end review would always be aborted mid-flight — telemetry showed
		// only instant 'discarded' records. hasUI is false exactly in those
		// modes; don't launch a doomed consultation there.
		if (shouldReview && ctx.hasUI) {
			launchBackgroundReview("run_end", ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		tracker.invalidate();
		backgroundAbort?.abort();
		backgroundAbort = undefined;
		if (browserUsed) {
			await closeBuddyBrowser((command, args, options) =>
				pi.exec(command, args, options),
			);
			browserUsed = false;
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
		const lines: string[] = [
			theme.fg("customMessageLabel", theme.bold("● buddy")),
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
