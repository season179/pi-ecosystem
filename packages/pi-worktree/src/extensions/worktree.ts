/**
 * Worktree Extension
 *
 * Adds `--worktree` flag to pi. When set, creates an isolated git worktree
 * for the session and redirects bash plus path-aware tools there. On exit,
 * prompts before deleting or keeping the worktree.
 *
 * Usage:
 *   pi --worktree
 *
 * The worktree is created at <repo>/.pi/worktrees/<branch> with a branch
 * named pi-wt/<timestamp>-<pid> based on main (or master).
 *
 * A marker file at <repo>/.pi/worktree-active-<pid>.json tracks the active
 * worktree so it survives /new and /reload within the same pi process.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import {
	readWorktreeMarker,
	removeWorktreeMarker,
	saveWorktreeMarker,
	type WorktreeInfo,
} from "./lib/worktree-shared.js";

interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

interface ExtensionAPI {
	exec: (
		command: string,
		args: string[],
		options: { timeout: number },
	) => Promise<{ code: number; stdout: string; stderr: string }>;
	registerFlag: (
		name: string,
		flag: { description: string; type: "boolean"; default: boolean },
	) => void;
	getFlag: (name: string) => boolean;
	on: (event: string, handler: (...args: any[]) => unknown) => void;
}

interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

interface WorktreeState {
	info: WorktreeInfo;
	repoRootPattern: RegExp;
	bashOperations: BashOperations;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function isToolCallEventType(
	toolName: string,
	event: ToolCallEvent,
): boolean {
	return event.toolName === toolName;
}

function createLocalBashOperations(): BashOperations {
	return {
		exec(command, cwd, options) {
			return new Promise((resolve) => {
				let settled = false;
				const child = spawn(command, {
					cwd,
					env: { ...process.env, ...options.env },
					shell: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				const finish = (exitCode: number | null) => {
					if (settled) return;
					settled = true;
					if (timeout) clearTimeout(timeout);
					options.signal?.removeEventListener("abort", abort);
					resolve({ exitCode });
				};

				const kill = () => {
					if (child.killed) return;
					child.kill("SIGTERM");
				};

				const abort = () => {
					kill();
					finish(null);
				};

				const timeout =
					options.timeout && options.timeout > 0
						? setTimeout(() => {
								kill();
								finish(null);
							}, options.timeout)
						: undefined;

				child.stdout.on("data", options.onData);
				child.stderr.on("data", options.onData);
				child.on("error", (error) => {
					options.onData(Buffer.from(`${error.message}\n`));
					finish(1);
				});
				child.on("close", (code) => finish(code));

				if (options.signal?.aborted) {
					abort();
				} else {
					options.signal?.addEventListener("abort", abort, { once: true });
				}
			});
		},
	};
}

export default function worktreeExtension(pi: ExtensionAPI) {
	let worktreeState: WorktreeState | null = null;

	function samePath(a: string, b: string): boolean {
		return path.resolve(a) === path.resolve(b);
	}

	async function canResumeWorktree(
		info: WorktreeInfo,
		repoRoot: string,
	): Promise<boolean> {
		if (info.repoRoot !== repoRoot || !fs.existsSync(info.path)) return false;

		const rootResult = await git(["rev-parse", "--show-toplevel"], info.path);
		if (
			rootResult.code !== 0 ||
			!samePath(rootResult.stdout.trim(), info.path)
		) {
			return false;
		}

		const branchResult = await git(["branch", "--show-current"], info.path);
		return (
			branchResult.code === 0 && branchResult.stdout.trim() === info.branch
		);
	}

	async function ensureLocalPiIgnored(repoRoot: string): Promise<void> {
		const excludeResult = await git(
			["rev-parse", "--git-path", "info/exclude"],
			repoRoot,
		);
		if (excludeResult.code !== 0) return;

		const exclude = excludeResult.stdout.trim();
		if (!exclude) return;
		const excludePath = path.isAbsolute(exclude)
			? exclude
			: path.join(repoRoot, exclude);
		try {
			fs.mkdirSync(path.dirname(excludePath), { recursive: true });
			const content = fs.existsSync(excludePath)
				? fs.readFileSync(excludePath, "utf-8")
				: "";
			const hasPiIgnore = content
				.split(/\r?\n/)
				.some((line) => [".pi", ".pi/"].includes(line.trim()));
			if (hasPiIgnore) return;

			const separator =
				content.length > 0 && !content.endsWith("\n") ? "\n" : "";
			fs.writeFileSync(excludePath, `${content}${separator}.pi/\n`);
		} catch {}
	}

	function terminalMessage(message: string): void {
		process.stderr.write(`${message}\n`);
	}

	async function git(
		args: string[],
		cwd?: string,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		const fullArgs = cwd ? ["-C", cwd, ...args] : args;
		return pi.exec("git", fullArgs, { timeout: 10_000 });
	}

	function escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function redirectCommandPaths(command: string): string {
		if (!worktreeState) return command;
		return command.replace(
			worktreeState.repoRootPattern,
			worktreeState.info.path,
		);
	}

	function findRepoPathOutsideCurrentWorktree(command: string): string | null {
		if (!worktreeState) return null;
		const { info } = worktreeState;
		const repoPathPattern = new RegExp(
			`${escapeRegExp(info.repoRoot)}(?:/[^\\s'"\\\`;|&<>)]*)?`,
			"g",
		);
		let match: RegExpExecArray | null;
		while ((match = repoPathPattern.exec(command)) !== null) {
			const candidate = path.resolve(match[0]);
			if (!isWithinDirectory(candidate, info.path)) {
				return match[0];
			}
		}
		return null;
	}

	function hasParentTraversal(command: string): boolean {
		return (
			/(^|[\s'"`;|&<>])\.\.(?=\/|$)/.test(command) ||
			/\/\.\.(?=\/|$)/.test(command)
		);
	}

	function rewriteBashCommand(
		command: string,
	): { command: string } | { block: string } {
		const redirected = redirectCommandPaths(command);
		const escapedPath = findRepoPathOutsideCurrentWorktree(redirected);
		if (escapedPath) {
			return {
				block: `Blocked bash command: path escapes the active worktree (${escapedPath})`,
			};
		}
		if (hasParentTraversal(redirected)) {
			return {
				block:
					"Blocked bash command: parent-directory traversal is not allowed while --worktree is active",
			};
		}
		return { command: redirected };
	}

	function shellQuote(value: string): string {
		return `'${value.replace(/'/g, "'\\''")}'`;
	}

	function createWorktreeBashOperations(info: WorktreeInfo): BashOperations {
		const local = createLocalBashOperations();
		return {
			exec: (command, _cwd, options) => {
				const rewritten = rewriteBashCommand(command);
				if ("block" in rewritten) {
					options.onData(Buffer.from(`${rewritten.block}\n`));
					return Promise.resolve({ exitCode: 1 });
				}
				return local.exec(rewritten.command, info.path, options);
			},
		};
	}

	function activateWorktree(info: WorktreeInfo): void {
		worktreeState = {
			info,
			repoRootPattern: new RegExp(
				`${escapeRegExp(info.repoRoot)}(?=$|/)(?!/\\.pi/worktrees(?:/|$))`,
				"g",
			),
			bashOperations: createWorktreeBashOperations(info),
		};
	}

	function timestamp(): string {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	}

	async function confirmInTerminal(
		branch: string,
		wtPath: string,
		isDirty: boolean,
	): Promise<boolean> {
		if (!process.stdin.isTTY || !process.stderr.isTTY) return !isDirty;

		if (process.stdin.isRaw) {
			process.stdin.setRawMode(false);
		}

		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stderr,
		});

		try {
			const dirtyWarning = isDirty
				? "Worktree has uncommitted changes.\nDeleting it will discard those changes.\n"
				: "";
			const answer = await rl.question(
				`${dirtyWarning}Delete worktree?\n"${branch}" at ${wtPath}\nRemove it? [Y/n] `,
			);
			return !/^(n|no)$/i.test(answer.trim());
		} finally {
			rl.close();
		}
	}

	function normalizePathInput(p: string): string {
		const normalized = p.replace(UNICODE_SPACES, " ");
		const withoutAtPrefix = normalized.startsWith("@")
			? normalized.slice(1)
			: normalized;
		if (withoutAtPrefix === "~") return os.homedir();
		if (withoutAtPrefix.startsWith("~/")) {
			return path.join(os.homedir(), withoutAtPrefix.slice(2));
		}
		return withoutAtPrefix;
	}

	function isWithinDirectory(filePath: string, directory: string): boolean {
		const relative = path.relative(directory, filePath);
		return (
			relative === "" ||
			(!relative.startsWith("..") && !path.isAbsolute(relative))
		);
	}

	function redirectPath(
		filePath: string,
		options: { allowExternalAbsolute: boolean },
	): { path: string } | { block: string } {
		if (!worktreeState) return { path: filePath };
		const { info } = worktreeState;
		const expanded = normalizePathInput(filePath);

		if (path.isAbsolute(expanded) && isWithinDirectory(expanded, info.path)) {
			return { path: path.resolve(expanded) };
		}

		if (
			path.isAbsolute(expanded) &&
			isWithinDirectory(expanded, info.repoRoot)
		) {
			if (
				isWithinDirectory(
					expanded,
					path.join(info.repoRoot, ".pi", "worktrees"),
				)
			) {
				return {
					block: `Blocked path outside active worktree: ${expanded}`,
				};
			}
			return {
				path: path.join(info.path, path.relative(info.repoRoot, expanded)),
			};
		}

		if (!path.isAbsolute(expanded)) {
			const candidate = path.resolve(info.path, expanded);
			if (!isWithinDirectory(candidate, info.path)) {
				return {
					block: `Blocked relative path outside active worktree: ${filePath}`,
				};
			}
			return { path: candidate };
		}

		if (!options.allowExternalAbsolute) {
			return {
				block: `Blocked absolute path outside active worktree: ${expanded}`,
			};
		}

		return { path: expanded };
	}

	function blockReason(reason: string): { block: true; reason: string } {
		return { block: true, reason };
	}

	function redirectToolPath(
		event: ToolCallEvent,
	): { block: true; reason: string } | undefined {
		if (!worktreeState) return undefined;

		if (isToolCallEventType("bash", event)) {
			if (typeof event.input.command !== "string") return undefined;
			const rewritten = rewriteBashCommand(event.input.command);
			if ("block" in rewritten) return blockReason(rewritten.block);
			event.input.command = `cd ${shellQuote(worktreeState.info.path)} && ${rewritten.command}`;
			return undefined;
		}

		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("write", event) ||
			isToolCallEventType("edit", event)
		) {
			if (typeof event.input.path === "string") {
				const redirected = redirectPath(event.input.path, {
					allowExternalAbsolute: isToolCallEventType("read", event),
				});
				if ("block" in redirected) return blockReason(redirected.block);
				event.input.path = redirected.path;
			}
			return undefined;
		}

		if (
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event) ||
			isToolCallEventType("ls", event)
		) {
			if (typeof event.input.path === "string") {
				const redirected = redirectPath(event.input.path, {
					allowExternalAbsolute: true,
				});
				if ("block" in redirected) return blockReason(redirected.block);
				event.input.path = redirected.path;
			} else {
				event.input.path = worktreeState.info.path;
			}
		}

		return undefined;
	}

	pi.registerFlag("worktree", {
		description: "Create an isolated git worktree for this session",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (event, ctx) => {
		const { code, stdout } = await git(["rev-parse", "--show-toplevel"]);
		if (code !== 0) return;
		const repoRoot = stdout.trim();
		await ensureLocalPiIgnored(repoRoot);

		const existing = readWorktreeMarker(repoRoot);
		if (existing) {
			if (
				event.reason !== "startup" &&
				(await canResumeWorktree(existing, repoRoot))
			) {
				activateWorktree(existing);
				ctx.ui.setStatus("worktree", `🌿 ${existing.branch}`);
				return;
			}
			removeWorktreeMarker(repoRoot);
		}

		if (event.reason !== "startup" || !pi.getFlag("worktree")) return;

		const branchChecks = await Promise.all(
			["main", "master"].map(async (branch) => ({
				branch,
				exists:
					(
						await git(
							["rev-parse", "--verify", `refs/heads/${branch}`],
							repoRoot,
						)
					).code === 0,
			})),
		);
		const base = branchChecks.find(({ exists }) => exists)?.branch;
		if (!base) {
			ctx.ui.notify("No main or master branch found", "error");
			return;
		}

		const worktreeId = `${timestamp()}-${process.pid}`;
		const branch = `pi-wt/${worktreeId}`;
		const wtDir = path.join(
			repoRoot,
			".pi",
			"worktrees",
			`pi-wt-${worktreeId}`,
		);

		const res = await git(
			["worktree", "add", "-b", branch, wtDir, base],
			repoRoot,
		);
		if (res.code !== 0) {
			ctx.ui.notify(`Failed to create worktree: ${res.stderr}`, "error");
			return;
		}

		const info = { path: wtDir, branch, repoRoot, pid: process.pid };
		activateWorktree(info);
		saveWorktreeMarker(repoRoot, info);
		ctx.ui.setStatus("worktree", `🌿 ${branch}`);
		ctx.ui.notify(`🌿 Worktree created: ${branch}`, "info");
	});

	pi.on("tool_call", (event) => {
		if (!worktreeState) return;
		return redirectToolPath(event);
	});

	pi.on("user_bash", () => {
		if (!worktreeState) return;
		return { operations: worktreeState.bashOperations };
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!worktreeState || event.reason !== "quit") return;

		const { path: wtPath, branch, repoRoot } = worktreeState.info;

		const statusResult = await git(
			["status", "--porcelain", "--untracked-files=normal"],
			wtPath,
		);
		if (statusResult.code !== 0) {
			terminalMessage(
				`Could not inspect worktree status; keeping ${branch}: ${
					statusResult.stderr.trim() || statusResult.stdout.trim()
				}`,
			);
			return;
		}

		const isDirty = statusResult.stdout.trim().length > 0;

		if (isDirty) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Worktree has uncommitted changes: ${branch}`, "warning");
			}
		}

		// Pi stops the TUI before final shutdown handlers run, so ctx.ui.confirm()
		// is not visible here in interactive mode.
		const shouldDelete = await confirmInTerminal(branch, wtPath, isDirty);

		if (shouldDelete) {
			const removeArgs = isDirty
				? ["worktree", "remove", "--force", wtPath]
				: ["worktree", "remove", wtPath];
			const removeResult = await git(removeArgs, repoRoot);
			if (removeResult.code !== 0) {
				terminalMessage(
					`Failed to delete worktree: ${
						removeResult.stderr.trim() || removeResult.stdout.trim()
					}`,
				);
				return;
			}

			const deleteBranchResult = await git(["branch", "-d", branch], repoRoot);
			if (deleteBranchResult.code === 0) {
				terminalMessage("Worktree and branch deleted");
			} else {
				terminalMessage(`Worktree deleted; branch kept: ${branch}`);
			}
		} else {
			if (isDirty) {
				terminalMessage(`Worktree has uncommitted changes; kept at: ${wtPath}`);
			} else {
				terminalMessage(`Kept at: ${wtPath}`);
			}
		}

		removeWorktreeMarker(repoRoot);
	});
}
