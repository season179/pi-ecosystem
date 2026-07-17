/**
 * model-fallback — automatic model failover for pi.
 *
 * When an agent run fails with a persistent provider error (rate limit,
 * overload, 5xx, network), this extension switches to the next model in a
 * user-defined fallback chain and resumes work automatically. The main model
 * settings (settings.json) are never touched.
 *
 * Config (fallback models ONLY), first found wins:
 *   - <project>/.pi/fallback-models.json   (project-local)
 *   - ~/.pi/agent/fallback-models.json     (global)
 *
 * {
 *   "fallbacks": [
 *     { "provider": "openai", "model": "gpt-5.2" },
 *     { "provider": "google", "model": "gemini-3-pro" }
 *   ],
 *   "restoreCooldownMinutes": 10,
 *   "fallbackOnAuthErrors": false
 * }
 *
 * Behavior:
 *   - Triggers only after pi's built-in same-model retries are exhausted.
 *   - Never triggers on user aborts, context-overflow, or 4xx request errors.
 *   - Auth errors (401/403) trigger only when fallbackOnAuthErrors is true.
 *   - Restores the original model on the next interactive message, once the
 *     last failure is older than restoreCooldownMinutes (avoids churn during
 *     an ongoing outage). `/fallback restore` forces it immediately.
 *   - A manual model switch (/model, Ctrl+P) cancels the pending restore.
 *   - The original model is persisted in the session, so resuming a session
 *     that was left on a fallback model triggers an immediate restore attempt.
 *
 * KNOWN PI-CORE LIMITATION: pi persists *every* model switch (including this
 * extension's) as the new global default in ~/.pi/agent/settings.json — there
 * is no session-only setModel in the extension API. The restore path writes
 * the original defaults back, and resumed sessions repair them at startup,
 * but while a fallback is active (or after a crash mid-fallback until the
 * session is resumed), new pi sessions elsewhere will start on the fallback
 * model.
 */
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface FallbackModelRef {
	provider: string;
	model: string;
}

interface FallbackConfig {
	fallbacks: FallbackModelRef[];
	restoreCooldownMinutes: number;
	fallbackOnAuthErrors: boolean;
}

const STATE_ENTRY = "model-fallback-state";
const DEFAULT_COOLDOWN_MINUTES = 10;

type ErrorClass = "fallback" | "auth" | "skip" | "unknown";

export default function (pi: ExtensionAPI) {
	// ---- state -------------------------------------------------------------
	let originalModel: FallbackModelRef | undefined; // set on first incident
	let chainIndex = 0; // next fallback to try
	let lastFailureAt = 0; // epoch ms of last classified failure
	let internalSwitch = false; // guards our own setModel calls
	let restoreFailureWarned = false; // warn only once when auto-restore can't switch back
	let lastHttpStatus: number | undefined; // from after_provider_response
	let stashedStopReason: string | undefined; // from agent_end
	let stashedErrorMessage: string | undefined;

	// ---- config ------------------------------------------------------------
	function loadConfig(cwd: string): FallbackConfig | undefined {
		const candidates = [
			join(cwd, CONFIG_DIR_NAME, "fallback-models.json"),
			join(homedir(), ".pi", "agent", "fallback-models.json"),
		];
		for (const path of candidates) {
			if (!existsSync(path)) continue;
			try {
				const raw = JSON.parse(readFileSync(path, "utf8"));
				const fallbacks = Array.isArray(raw.fallbacks)
					? raw.fallbacks.filter(
							(f: unknown): f is FallbackModelRef =>
								!!f &&
								typeof (f as FallbackModelRef).provider === "string" &&
								typeof (f as FallbackModelRef).model === "string",
						)
					: [];
				return {
					fallbacks,
					restoreCooldownMinutes:
						typeof raw.restoreCooldownMinutes === "number"
							? raw.restoreCooldownMinutes
							: DEFAULT_COOLDOWN_MINUTES,
					fallbackOnAuthErrors: raw.fallbackOnAuthErrors === true,
				};
			} catch (err) {
				notifySafe(`model-fallback: invalid config at ${path}: ${String(err)}`, "error");
				return undefined;
			}
		}
		return undefined;
	}

	// ---- helpers -----------------------------------------------------------
	let notifySafe: (msg: string, level?: "info" | "warning" | "error") => void = () => {};

	function modelKey(m: FallbackModelRef): string {
		return `${m.provider}/${m.model}`;
	}

	function persistState(active: boolean) {
		pi.appendEntry(STATE_ENTRY, { active, originalModel: originalModel ?? null });
	}

	function classify(errorMessage: string | undefined, status: number | undefined, cfg: FallbackConfig): ErrorClass {
		const msg = (errorMessage ?? "").toLowerCase();

		// Context overflow: never fall back — that's compaction's job, and a
		// smaller-context fallback would only make it worse.
		const overflowPatterns = [
			"context length",
			"context_length",
			"maximum context",
			"prompt is too long",
			"too many tokens",
			"exceeds the context",
			"input is too long",
		];
		if (overflowPatterns.some((p) => msg.includes(p))) return "skip";

		// Prefer numeric status; errorMessage often embeds it as a prefix ("529 {...}").
		let code = status;
		if (code === undefined) {
			const m = /^\s*(\d{3})\b/.exec(errorMessage ?? "");
			if (m) code = Number(m[1]);
		}

		if (code !== undefined) {
			if (code === 401 || code === 403) return cfg.fallbackOnAuthErrors ? "fallback" : "auth";
			if (code === 429 || code >= 500) return "fallback";
			if (code >= 400 && code < 500) return "skip"; // bad request: same failure on every model
		}

		// No status: check for network-level failures.
		const networkPatterns = [
			"econnreset",
			"econnrefused",
			"etimedout",
			"enotfound",
			"eai_again",
			"fetch failed",
			"network",
			"socket hang up",
			"terminated",
			"overloaded",
			"rate limit",
			"rate_limit",
		];
		if (networkPatterns.some((p) => msg.includes(p))) return "fallback";

		return "unknown";
	}

	async function switchTo(ref: FallbackModelRef, ctx: ExtensionContext): Promise<boolean> {
		const model = ctx.modelRegistry.find(ref.provider, ref.model);
		if (!model) return false;
		internalSwitch = true;
		try {
			return await pi.setModel(model);
		} finally {
			internalSwitch = false;
		}
	}

	// ---- wiring ------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		notifySafe = (msg, level = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
			else console.error(`[model-fallback] ${msg}`);
		};

		// Re-arm restore if this session was left on a fallback model.
		let persisted: { active: boolean; originalModel: FallbackModelRef | null } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				persisted = entry.data as typeof persisted;
			}
		}
		if (persisted?.active && persisted.originalModel) {
			originalModel = persisted.originalModel;
			lastFailureAt = 0; // outage was in a previous session
			// Restore immediately: this also repairs the global default model that
			// pi persisted when the fallback switch happened.
			const target = originalModel;
			if (await switchTo(target, ctx)) {
				notifySafe(`model-fallback: restored original model ${modelKey(target)} from previous session.`, "info");
				originalModel = undefined;
				chainIndex = 0;
				persistState(false);
			} else {
				notifySafe(
					`model-fallback: session was left on a fallback model and ${modelKey(target)} is unavailable; will retry on your next message (or /fallback restore).`,
					"warning",
				);
			}
		}
	});

	// Primary classification signal: HTTP status of the most recent provider response.
	pi.on("after_provider_response", (event, _ctx) => {
		lastHttpStatus = event.status;
	});

	pi.on("agent_start", async () => {
		lastHttpStatus = undefined;
	});

	// Stash error details here; pi may still auto-retry/compact after agent_end.
	pi.on("agent_end", async (event) => {
		stashedStopReason = undefined;
		stashedErrorMessage = undefined;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const m = event.messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
			if (m.role === "assistant") {
				stashedStopReason = m.stopReason;
				stashedErrorMessage = m.errorMessage;
				break;
			}
		}
	});

	// Act only when pi has truly given up (retries and compaction exhausted).
	pi.on("agent_settled", async (_event, ctx) => {
		if (stashedStopReason !== "error") {
			chainIndex = 0; // healthy (or aborted) run: reset chain position
			return;
		}

		const cfg = loadConfig(ctx.cwd);
		if (!cfg || cfg.fallbacks.length === 0) return;

		const cls = classify(stashedErrorMessage, lastHttpStatus, cfg);
		if (cls === "skip") return;
		if (cls === "auth") {
			notifySafe(
				"model-fallback: auth error (401/403) — not falling back. Fix credentials, or set \"fallbackOnAuthErrors\": true in fallback-models.json.",
				"error",
			);
			return;
		}
		if (cls === "unknown") {
			notifySafe(
				`model-fallback: unrecognized error, not falling back: ${stashedErrorMessage ?? "(no message)"}`,
				"warning",
			);
			return;
		}

		lastFailureAt = Date.now();

		// Remember the model we're abandoning (first incident only).
		if (!originalModel && ctx.model) {
			originalModel = { provider: ctx.model.provider, model: ctx.model.id };
		}

		// Walk the chain from the current position. If a previous incident
		// exhausted the chain, start over — the user may have fixed a key or the
		// outage may have ended for an earlier entry.
		if (chainIndex >= cfg.fallbacks.length) chainIndex = 0;
		while (chainIndex < cfg.fallbacks.length) {
			const candidate = cfg.fallbacks[chainIndex];
			chainIndex++;
			if (originalModel && modelKey(candidate) === modelKey(originalModel)) continue;
			if (ctx.model && modelKey(candidate) === `${ctx.model.provider}/${ctx.model.id}`) continue;
			if (await switchTo(candidate, ctx)) {
				persistState(true);
				notifySafe(
					`model-fallback: ${stashedErrorMessage?.slice(0, 120) ?? "provider error"} — switched to ${modelKey(candidate)}, resuming.`,
					"warning",
				);
				pi.sendUserMessage("continue");
				return;
			}
			notifySafe(`model-fallback: ${modelKey(candidate)} unavailable (not found or no API key), skipping.`, "warning");
		}

		notifySafe("model-fallback: all fallback models exhausted. Stopping.", "error");
	});

	// Restore the original model on the next interactive input, after cooldown.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return;
		if (!originalModel) return;

		const cfg = loadConfig(ctx.cwd);
		const cooldownMs = (cfg?.restoreCooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000;
		if (Date.now() - lastFailureAt < cooldownMs) return; // likely still in the outage window

		const target = originalModel;
		if (await switchTo({ provider: target.provider, model: target.model }, ctx)) {
			notifySafe(`model-fallback: restored original model ${modelKey(target)}.`, "info");
			originalModel = undefined;
			chainIndex = 0;
			restoreFailureWarned = false;
			persistState(false);
		} else if (!restoreFailureWarned) {
			restoreFailureWarned = true;
			notifySafe(
				`model-fallback: cannot restore ${modelKey(target)} (not found or no API key). Staying on fallback; fix credentials and use /fallback restore.`,
				"warning",
			);
		}
	});

	// A genuine manual model switch cancels the pending restore.
	pi.on("model_select", async (event, _ctx) => {
		if (internalSwitch) return;
		if (event.source === "restore") return; // session restore, not a user decision
		if (originalModel) {
			notifySafe("model-fallback: manual model change — pending restore cancelled.", "info");
			originalModel = undefined;
			chainIndex = 0;
			persistState(false);
		}
	});

	// ---- command -----------------------------------------------------------
	pi.registerCommand("fallback", {
		description: "Show model-fallback status; '/fallback restore' switches back to the original model now",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);

			if (args?.trim() === "restore") {
				if (!originalModel) {
					notifySafe("model-fallback: nothing to restore.", "info");
					return;
				}
				const target = originalModel;
				if (await switchTo(target, ctx)) {
					notifySafe(`model-fallback: restored original model ${modelKey(target)}.`, "info");
					originalModel = undefined;
					chainIndex = 0;
					restoreFailureWarned = false;
					persistState(false);
				} else {
					notifySafe(`model-fallback: could not restore ${modelKey(target)} (not found or no API key).`, "error");
				}
				return;
			}

			const lines: string[] = [];
			if (!cfg) {
				lines.push("No config found. Create ~/.pi/agent/fallback-models.json:");
				lines.push('{ "fallbacks": [ { "provider": "openai", "model": "gpt-5.2" } ] }');
			} else {
				lines.push(`Chain: ${cfg.fallbacks.map(modelKey).join(" -> ") || "(empty)"}`);
				lines.push(
					`Cooldown: ${cfg.restoreCooldownMinutes}m | Auth-error fallback: ${cfg.fallbackOnAuthErrors ? "on" : "off"}`,
				);
			}
			lines.push(
				originalModel
					? `ACTIVE: on fallback, original ${modelKey(originalModel)} pending restore (/fallback restore to force).`
					: "Idle: running on your selected model.",
			);
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
			lines.push(`Current model: ${current}`);
			notifySafe(lines.join("\n"), "info");
		},
	});
}
