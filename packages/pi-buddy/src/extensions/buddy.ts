/**
 * pi-buddy: a sparring partner for pi.
 *
 * - `consult_buddy` tool: the main agent pulls the buddy in for discussion,
 *   debate, fact-checking, or review. The buddy sees the full session
 *   transcript and has read-only tools (read/grep/find/ls) to verify claims.
 * - `/buddy <question>` command: the human summons the buddy directly.
 * - Watchdog push: if 3 turns elapse in an agent run without a consultation,
 *   the buddy quietly reviews recent work. It replies PASS (suppressed, no
 *   noise) or raises a concern, injected as a steering message the agent
 *   must address.
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
import { Text } from "@earendil-works/pi-tui";
import { consultBuddy, type ConsultResult } from "./consult.js";
import {
	buildStanceSystemPrompt,
	buildWatchdogSystemPrompt,
	isWatchdogPass,
	type Stance,
	STANCES,
} from "./stances.js";

const DEFAULT_BUDDY_MODEL = "zai/glm-5.2";
const WATCHDOG_TURN_THRESHOLD = 3;
const BUDDY_REVIEW_TYPE = "buddy-review";
const STATUS_KEY = "buddy";

export default function setup(pi: ExtensionAPI): void {
	// --- Watchdog state (per agent run) ---
	let turnsSinceConsult = 0;
	let agentRunActive = false;
	let watchdogInFlight = false;

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
		onActivity?: (line: string) => void;
	}): Promise<ConsultResult> {
		const model = resolveBuddyModel(args.ctx);
		args.ctx.ui.setStatus(STATUS_KEY, "buddy: consulting...");
		try {
			return await consultBuddy({
				requestText: args.requestText,
				systemPrompt: args.systemPrompt,
				entries: args.ctx.sessionManager.getBranch(),
				cwd: args.ctx.cwd,
				model,
				registry: args.ctx.modelRegistry,
				signal: args.ctx.signal,
				onActivity: (line) => {
					args.ctx.ui.setStatus(STATUS_KEY, `buddy: ${line}`);
					args.onActivity?.(line);
				},
			});
		} finally {
			args.ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	// --- The consult_buddy tool (pull) ---

	pi.registerTool({
		name: "consult_buddy",
		label: "Consult Buddy",
		description:
			"Consult your sparring partner (a separate model with read-only access " +
			"to this repository and the full conversation transcript). Stances: " +
			"'discuss' explores tradeoffs and alternatives; 'debate' steelmans the " +
			"case AGAINST your proposal; 'fact_check' verifies claims against the " +
			"actual files; 'review' checks recent work for correctness and missed " +
			"requirements. The buddy is candid and will push back — treat its " +
			"concerns seriously, but you remain responsible for the final decision.",
		promptSnippet:
			"Consult a candid sparring partner to discuss, debate, fact-check, or review",
		promptGuidelines: [
			"Use consult_buddy (stance 'debate' or 'discuss') before committing to a significant design or architectural decision.",
			"Use consult_buddy (stance 'fact_check') when making claims about the codebase you have not directly verified this session.",
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
			turnsSinceConsult = 0; // pull resets the watchdog counter
			const stance = params.stance as Stance;
			const activity: string[] = [];
			const result = await runConsultation({
				ctx,
				systemPrompt: buildStanceSystemPrompt(stance),
				requestText: params.question,
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
		renderCall(args, theme) {
			const stance = typeof args.stance === "string" ? args.stance : "…";
			const question =
				typeof args.question === "string" ? args.question : "";
			let text = theme.fg("toolTitle", theme.bold("buddy "));
			text += theme.fg("accent", `[${stance}] `);
			text += theme.fg("muted", question);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = (result.details ?? {}) as {
				activity?: string[];
				rounds?: number;
			};
			if (isPartial) {
				const last = details.activity?.at(-1);
				return new Text(
					theme.fg("warning", last ? `buddy: ${last}` : "buddy is thinking..."),
					0,
					0,
				);
			}
			const answer = result.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("\n");
			let text = answer;
			if (expanded && details.activity && details.activity.length > 0) {
				text += "\n\n" + theme.fg("dim", "Buddy verified via:");
				for (const line of details.activity) {
					text += "\n" + theme.fg("dim", `  ${line}`);
				}
			} else if (details.activity && details.activity.length > 0) {
				text +=
					"\n" +
					theme.fg(
						"dim",
						`(buddy ran ${details.activity.length} read-only lookup(s))`,
					);
			}
			return new Text(text, 0, 0);
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
			turnsSinceConsult = 0;
			try {
				const result = await runConsultation({
					ctx,
					systemPrompt: buildStanceSystemPrompt("discuss"),
					requestText:
						`The HUMAN USER is asking you directly (not the agent):\n\n${question}`,
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

	// --- Watchdog (push) ---

	pi.on("agent_start", async () => {
		agentRunActive = true;
		turnsSinceConsult = 0;
	});

	pi.on("agent_end", async () => {
		agentRunActive = false;
		turnsSinceConsult = 0;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!agentRunActive || watchdogInFlight) return;
		turnsSinceConsult += 1;
		if (turnsSinceConsult < WATCHDOG_TURN_THRESHOLD) return;

		turnsSinceConsult = 0; // reset on push (fired or PASS)
		watchdogInFlight = true;
		try {
			const result = await runConsultation({
				ctx,
				systemPrompt: buildWatchdogSystemPrompt(),
				requestText:
					`Automatic watchdog check-in: the agent has completed ` +
					`${WATCHDOG_TURN_THRESHOLD} turns without consulting you. Review ` +
					`the recent turns. Reply PASS if there is no real problem.`,
			});
			if (isWatchdogPass(result.answer)) return;
			pi.sendMessage(
				{
					customType: BUDDY_REVIEW_TYPE,
					content:
						"Your buddy reviewed the recent work and raised a concern. " +
						"Address it (fix, rebut with evidence, or consult_buddy to " +
						`discuss) before continuing:\n\n${result.answer}`,
					display: true,
					details: { activity: result.activity, source: "watchdog" },
				},
				{ deliverAs: "steer" },
			);
		} catch (error) {
			// Watchdog is best-effort: never let it break the agent run.
			ctx.ui.notify(
				`Buddy watchdog failed: ${errorToString(error)}`,
				"warning",
			);
		} finally {
			watchdogInFlight = false;
		}
	});

	// --- Rendering for pushed reviews ---

	pi.registerMessageRenderer(BUDDY_REVIEW_TYPE, (message, options, theme) => {
		let text = theme.fg("accent", theme.bold("● buddy "));
		text +=
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => (block as { text: string }).text)
						.join("\n");
		if (options.expanded) {
			const details = message.details as { activity?: string[] } | undefined;
			if (details?.activity?.length) {
				text += "\n" + theme.fg("dim", "Verified via:");
				for (const line of details.activity) {
					text += "\n" + theme.fg("dim", `  ${line}`);
				}
			}
		}
		return new Text(text, 0, 0);
	});
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
