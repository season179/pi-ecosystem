import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type ExtensionContext,
	type InputSource,
	type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import {
	actionFingerprint,
	classifyTool,
	OneShotApprovals,
	summarizeAction,
	type ActionDescriptor,
} from "../action-policy.js";
import { AuditLog } from "../audit.js";
import { loadGuardConfig, type GuardConfig } from "../config.js";
import { resolveGuardedTarget } from "../path-policy.js";
import {
	decisionAllowsExecution,
	reviewAction,
	type AuthenticatedUserInput,
	type ReviewDecision,
} from "../reviewer.js";
import { SnapshotStore } from "../snapshots.js";

const STATUS_KEY = "pi-guard";
const GUARD_MESSAGE_TYPE = "pi-guard";
const guardModulePath = realpathSync.native(fileURLToPath(import.meta.url));
const guardBaseDir = dirname(guardModulePath);

function canonicalDirectory(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
}

export function isPiGuardSource(source: SourceInfo): boolean {
	return (
		canonicalDirectory(source.baseDir) === guardBaseDir ||
		canonicalDirectory(source.path) === guardModulePath
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class ReviewerDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewerDeniedError";
	}
}

function actionSource(source: SourceInfo): ActionDescriptor["source"] {
	return {
		path: source.path,
		source: source.source,
		baseDir: source.baseDir,
	};
}

export default function setup(pi: ExtensionAPI): void {
	const audit = new AuditLog();
	const snapshots = new SnapshotStore();
	const approvals = new OneShotApprovals();
	let config: GuardConfig | undefined;
	let initializedCwd: string | undefined;
	let initializationError: string | undefined;
	let initialization: Promise<void> | undefined;
	let currentUserInput: AuthenticatedUserInput | undefined;
	let consecutiveReviewDenials = 0;

	function setStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (initializationError) {
			ctx.ui.setStatus(STATUS_KEY, "guard: BLOCKED (reviewer config failed)");
			return;
		}
		if (!config) {
			ctx.ui.setStatus(STATUS_KEY, "guard: initializing…");
			return;
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			`guard: intent · bash/custom reviewed · reads unrestricted${config.reviewer.model ? ` · ${config.reviewer.model}` : ""}`,
		);
	}

	async function initialize(cwd: string, ctx?: ExtensionContext): Promise<void> {
		if (initialization) return initialization;
		initialization = (async () => {
			initializationError = undefined;
			try {
				const next = await loadGuardConfig(cwd);
				config = next;
				initializedCwd = resolve(cwd);
				approvals.clear();
				if (ctx) {
					setStatus(ctx);
					if (ctx.hasUI) {
						for (const warning of next.warnings) {
							ctx.ui.notify(`pi-guard config: ${warning}`, "warning");
						}
					}
				}
			} catch (error) {
				config = undefined;
				initializedCwd = undefined;
				initializationError = errorMessage(error);
				if (ctx) setStatus(ctx);
				throw error;
			} finally {
				initialization = undefined;
			}
		})();
		return initialization;
	}

	async function requireConfig(ctx: ExtensionContext): Promise<GuardConfig> {
		if (resolve(ctx.cwd) !== initializedCwd || !config) {
			await initialize(ctx.cwd, ctx);
		}
		if (!config || initializationError) {
			throw new Error(`pi-guard reviewer is unavailable: ${initializationError ?? "not initialized"}`);
		}
		return config;
	}

	async function auditBlock(
		action: ActionDescriptor,
		reason: string,
		eligibleForOneShot: boolean,
	): Promise<string> {
		const denied = approvals.recordDenial(action, reason, eligibleForOneShot);
		await audit.append({
			tool: action.toolName,
			outcome: "blocked",
			fingerprint: denied.fingerprint,
			summary: denied.summary,
			reason,
			cwd: action.cwd,
		});
		return reason;
	}

	function noteReviewDenial(ctx: ExtensionContext): void {
		consecutiveReviewDenials += 1;
		if (consecutiveReviewDenials < 3) return;
		if (ctx.hasUI) {
			ctx.ui.notify("pi-guard stopped this run after 3 consecutive intent denials", "warning");
		}
		ctx.abort();
	}

	async function applyReviewer(
		action: ActionDescriptor,
		current: GuardConfig,
		ctx: ExtensionContext,
	): Promise<ReviewDecision | undefined> {
		if (approvals.consume(action)) {
			consecutiveReviewDenials = 0;
			await audit.append({
				tool: action.toolName,
				outcome: "allowed",
				fingerprint: actionFingerprint(action),
				summary: summarizeAction(action),
				reason: "exact one-shot human approval",
				cwd: action.cwd,
			});
			return undefined;
		}
		try {
			const decision = await reviewAction({
				action,
				config: current.reviewer,
				registry: ctx.modelRegistry,
				fallbackModel: ctx.model,
				entries: ctx.sessionManager.getBranch(),
				currentUserInput,
				signal: ctx.signal,
			});
			if (!decisionAllowsExecution(decision)) {
				const reason = `Reviewer denied (${decision.alignment}): ${decision.rationale}`;
				await auditBlock(action, reason, true);
				noteReviewDenial(ctx);
				throw new ReviewerDeniedError(
					`pi-guard ${reason}. Do not retry or route around this denial; ask the user if the intended scope is unclear.`,
				);
			}
			consecutiveReviewDenials = 0;
			await audit.append({
				tool: action.toolName,
				outcome: "allowed",
				fingerprint: actionFingerprint(action),
				summary: summarizeAction(action),
				reason: `reviewer allowed (${decision.alignment}): ${decision.rationale}`,
				cwd: action.cwd,
			});
			return decision;
		} catch (error) {
			if (error instanceof ReviewerDeniedError) throw error;
			await auditBlock(action, `Reviewer failed closed: ${errorMessage(error)}`, false);
			noteReviewDenial(ctx);
			throw new Error(`pi-guard reviewer failed closed: ${errorMessage(error)}`);
		}
	}

	const bootstrapCwd = process.cwd();
	const baseBash = createBashTool(bootstrapCwd);
	pi.registerTool({
		...baseBash,
		label: "bash (pi-guard intent review)",
		async execute(id, params, signal, onUpdate, ctx) {
			const current = await requireConfig(ctx);
			const action: ActionDescriptor = {
				toolName: "bash",
				input: params as Record<string, unknown>,
				cwd: ctx.cwd,
			};
			await applyReviewer(action, current, ctx);
			return createBashTool(ctx.cwd).execute(id, params, signal, onUpdate);
		},
	});

	const baseWrite = createWriteTool(bootstrapCwd);
	pi.registerTool({
		...baseWrite,
		label: "write (pi-guard snapshot)",
		async execute(id, params, signal, onUpdate, ctx) {
			const current = await requireConfig(ctx);
			const target = await resolveGuardedTarget(ctx.cwd, params.path, current.protectedPaths);
			const snapshot = await snapshots.create({
				cwd: ctx.cwd,
				path: target.absolutePath,
				relativePath: target.relativePath,
				tool: "write",
			});
			const action: ActionDescriptor = {
				toolName: "write",
				input: params as Record<string, unknown>,
				cwd: ctx.cwd,
			};
			await audit.append({
				tool: "write",
				outcome: "allowed",
				fingerprint: actionFingerprint(action),
				summary: summarizeAction(action),
				snapshotId: snapshot.id,
				cwd: ctx.cwd,
			});
			return createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate);
		},
	});

	const baseEdit = createEditTool(bootstrapCwd);
	pi.registerTool({
		...baseEdit,
		label: "edit (pi-guard snapshot)",
		async execute(id, params, signal, onUpdate, ctx) {
			const current = await requireConfig(ctx);
			const target = await resolveGuardedTarget(ctx.cwd, params.path, current.protectedPaths);
			const snapshot = await snapshots.create({
				cwd: ctx.cwd,
				path: target.absolutePath,
				relativePath: target.relativePath,
				tool: "edit",
			});
			const action: ActionDescriptor = {
				toolName: "edit",
				input: params as Record<string, unknown>,
				cwd: ctx.cwd,
			};
			await audit.append({
				tool: "edit",
				outcome: "allowed",
				fingerprint: actionFingerprint(action),
				summary: summarizeAction(action),
				snapshotId: snapshot.id,
				cwd: ctx.cwd,
			});
			return createEditTool(ctx.cwd).execute(id, params, signal, onUpdate);
		},
	});

	const baseRead = createReadTool(bootstrapCwd);
	pi.registerTool({
		...baseRead,
		label: "read (pi-guard unrestricted)",
		execute: (id, params, signal, onUpdate, ctx) =>
			createReadTool(ctx.cwd).execute(id, params, signal, onUpdate),
	});

	const baseGrep = createGrepTool(bootstrapCwd);
	pi.registerTool({
		...baseGrep,
		label: "grep (pi-guard unrestricted)",
		execute: (id, params, signal, onUpdate, ctx) =>
			createGrepTool(ctx.cwd).execute(id, params, signal, onUpdate),
	});

	const baseFind = createFindTool(bootstrapCwd);
	pi.registerTool({
		...baseFind,
		label: "find (pi-guard unrestricted)",
		execute: (id, params, signal, onUpdate, ctx) =>
			createFindTool(ctx.cwd).execute(id, params, signal, onUpdate),
	});

	const baseLs = createLsTool(bootstrapCwd);
	pi.registerTool({
		...baseLs,
		label: "ls (pi-guard unrestricted)",
		execute: (id, params, signal, onUpdate, ctx) =>
			createLsTool(ctx.cwd).execute(id, params, signal, onUpdate),
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
		const classification = classifyTool({
			toolName: event.toolName,
			tool,
			isGuardSource: isPiGuardSource,
		});
		const action: ActionDescriptor = {
			toolName: event.toolName,
			input: event.input,
			cwd: ctx.cwd,
			source: tool ? actionSource(tool.sourceInfo) : undefined,
		};
		if (classification.hard) {
			if (classification.allowed) return;
			const reason = classification.reason ?? "Tool hard-denied by pi-guard";
			try {
				await auditBlock(action, reason, false);
			} catch (auditError) {
				return {
					block: true,
					reason: `${reason}; audit also failed: ${errorMessage(auditError)}`,
				};
			}
			return { block: true, reason };
		}
		try {
			const current = await requireConfig(ctx);
			await applyReviewer(action, current, ctx);
		} catch (error) {
			return { block: true, reason: errorMessage(error) };
		}
	});

	pi.registerCommand("guard", {
		description: "Inspect or control pi-guard (status|explain|allow-once|restore|audit|reload)",
		handler: async (args, ctx) => {
			const [command = "status", value] = args.trim().split(/\s+/, 2);
			try {
				if (command === "reload") {
					config = undefined;
					initializedCwd = undefined;
					await initialize(ctx.cwd, ctx);
					ctx.ui.notify("pi-guard configuration reloaded", "info");
					return;
				}
				const current = await requireConfig(ctx);
				if (command === "status") {
					const snapshotUsage = await snapshots.usage(ctx.cwd);
					const lines = [
						"pi-guard: intent",
						"Built-in reads: unrestricted",
						"Bash/CLI: every command intent-reviewed; approved commands run normally",
						"Built-in write/edit: workspace path checks + snapshots",
						"Custom/MCP tools: intent-reviewed (reviewer-only enforcement)",
						`Reviewer: enforce${current.reviewer.model ? ` (${current.reviewer.model})` : " (current Pi model)"}`,
						`Snapshots: ${snapshotUsage.entries} entries, ${snapshotUsage.blobs} blobs, ${(snapshotUsage.storedBytes / 1024 / 1024).toFixed(1)} MiB`,
						`Global config: ${current.globalConfigPath}`,
						`Project restrictions: ${current.projectConfigPath}`,
					];
					if (current.warnings.length) lines.push(`Config warnings: ${current.warnings.join("; ")}`);
					pi.sendMessage({ customType: GUARD_MESSAGE_TYPE, content: lines.join("\n"), display: true });
					return;
				}
				if (command === "explain") {
					const denied = approvals.lastDenied();
					ctx.ui.notify(
						denied
							? `${denied.summary}\n${denied.reason}\nOne-shot eligible: ${denied.eligibleForOneShot ? "yes" : "no"}`
							: "No action has been denied in this session",
						"info",
					);
					return;
				}
				if (command === "allow-once") {
					if (value && value !== "last") throw new Error("Usage: /guard allow-once [last]");
					const denied = approvals.approveLast();
					ctx.ui.notify(`Approved exactly once: ${denied.summary}`, "warning");
					return;
				}
				if (command === "restore") {
					if (!value) throw new Error("Usage: /guard restore <snapshot-id>");
					const restored = await snapshots.restore(ctx.cwd, value);
					await audit.append({
						tool: "restore",
						outcome: "restored",
						summary: `restore ${restored.relativePath}`,
						snapshotId: restored.id,
						cwd: ctx.cwd,
					});
					ctx.ui.notify(`Restored ${restored.relativePath}`, "info");
					return;
				}
				if (command === "audit") {
					const count = value ? Number.parseInt(value, 10) : 20;
					const records = await audit.tail(Number.isFinite(count) ? count : 20);
					pi.sendMessage({
						customType: GUARD_MESSAGE_TYPE,
						content:
							records
								.map((record) => `${record.at} ${record.outcome} ${record.summary}${record.reason ? ` — ${record.reason}` : ""}`)
								.join("\n") || "Audit log is empty",
						display: true,
					});
					return;
				}
				throw new Error("Usage: /guard status|explain|allow-once|restore <id>|audit [count]|reload");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.on("input", (event) => {
		consecutiveReviewDenials = 0;
		currentUserInput = {
			text: event.text,
			source: event.source as InputSource,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		currentUserInput = undefined;
		try {
			await initialize(ctx.cwd, ctx);
			if (ctx.hasUI) ctx.ui.notify("pi-guard intent review initialized", "info");
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`pi-guard failed closed: ${errorMessage(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		approvals.clear();
		config = undefined;
		initializedCwd = undefined;
		initializationError = undefined;
		currentUserInput = undefined;
		consecutiveReviewDenials = 0;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
