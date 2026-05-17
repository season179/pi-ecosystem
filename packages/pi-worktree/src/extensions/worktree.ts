/**
 * Worktree Extension
 *
 * Adds `--worktree` flag to pi. When set, creates an isolated git worktree
 * for the session and redirects bash plus path-aware tools there. On exit,
 * prompts before deleting or keeping the worktree.
 *
 * Usage:
 *   pi --worktree
 *   pi --wt
 *   pi --worktree --worktree-base current --worktree-include-dirty
 *
 * The worktree is created at <repo>/.pi/worktrees/<branch> with a branch
 * named pi-wt/<timestamp>-<pid> based on main (or master) by default.
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
		flag: {
			description: string;
			type: "boolean" | "string";
			default: boolean | string;
		},
	) => void;
	getFlag: (name: string) => boolean | string | undefined;
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

interface DirtyChanges {
	tmpDir: string;
	stagedPatchPath: string;
	unstagedPatchPath: string;
}

type CaptureDirtyChangesResult =
	| { ok: true; dirtyChanges: DirtyChanges }
	| { ok: false; message: string };

type DirtyPatchKind = "staged" | "unstaged";

type ApplyDirtyChangesResult =
	| { ok: true }
	| {
			ok: false;
			failedPatch: DirtyPatchKind;
			message: string;
			partial: boolean;
	  };

type ResolveBaseResult = { ok: true; base: string } | { ok: false; error: string };

interface UnpushedCommits {
	count: number;
	samples: string[];
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function getShellCommand(command: string): { file: string; args: string[] } {
	if (process.platform === "win32") {
		return {
			file: process.env.ComSpec ?? "cmd.exe",
			args: ["/d", "/s", "/c", command],
		};
	}

	return { file: "/bin/sh", args: ["-c", command] };
}

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
				const shell = getShellCommand(command);
				const child = spawn(shell.file, shell.args, {
					cwd,
					env: { ...process.env, ...options.env },
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
							}, options.timeout * 1000)
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

	function getWorktreeBaseFlag(): string {
		const value = pi.getFlag("worktree-base");
		return typeof value === "string" && value.trim().length > 0
			? value.trim()
			: "default";
	}

	async function validateCommitRef(
		ref: string,
		repoRoot: string,
	): Promise<boolean> {
		const result = await git(
			[
				"rev-parse",
				"--verify",
				"--quiet",
				"--end-of-options",
				`${ref}^{commit}`,
			],
			repoRoot,
		);
		return result.code === 0;
	}

	async function resolveDefaultBase(repoRoot: string): Promise<ResolveBaseResult> {
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
		return base
			? { ok: true, base }
			: { ok: false, error: "No main or master branch found" };
	}

	async function resolveWorktreeBase(repoRoot: string): Promise<ResolveBaseResult> {
		const requestedBase = getWorktreeBaseFlag();

		if (requestedBase === "default" || requestedBase === "main-master") {
			return resolveDefaultBase(repoRoot);
		}

		if (requestedBase === "current") {
			const currentBranch = await git(["branch", "--show-current"], repoRoot);
			if (currentBranch.code === 0) {
				const branch = currentBranch.stdout.trim();
				if (branch.length > 0) return { ok: true, base: `refs/heads/${branch}` };
			}

			return (await validateCommitRef("HEAD", repoRoot))
				? { ok: true, base: "HEAD" }
				: { ok: false, error: "Could not resolve current branch or HEAD" };
		}

		return (await validateCommitRef(requestedBase, repoRoot))
			? { ok: true, base: requestedBase }
			: { ok: false, error: `Invalid worktree base ref: ${requestedBase}` };
	}

	async function captureDirtyChanges(
		repoRoot: string,
	): Promise<CaptureDirtyChangesResult> {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-dirty-"));
		const stagedPatchPath = path.join(tmpDir, "staged.patch");
		const unstagedPatchPath = path.join(tmpDir, "unstaged.patch");
		const dirtyChanges = { tmpDir, stagedPatchPath, unstagedPatchPath };

		const statusBefore = await git(
			["status", "--porcelain", "--untracked-files=no"],
			repoRoot,
		);
		if (statusBefore.code !== 0) {
			cleanupDirtyChanges(dirtyChanges);
			return {
				ok: false,
				message:
					statusBefore.stderr.trim() ||
					statusBefore.stdout.trim() ||
					"git status failed before dirty-change capture",
			};
		}

		const staged = await git(
			["diff", "--cached", "--binary", `--output=${stagedPatchPath}`],
			repoRoot,
		);
		if (staged.code !== 0) {
			cleanupDirtyChanges(dirtyChanges);
			return {
				ok: false,
				message:
					staged.stderr.trim() ||
					staged.stdout.trim() ||
					"git diff --cached failed during dirty-change capture",
			};
		}

		const unstaged = await git(
			["diff", "--binary", `--output=${unstagedPatchPath}`],
			repoRoot,
		);
		if (unstaged.code !== 0) {
			cleanupDirtyChanges(dirtyChanges);
			return {
				ok: false,
				message:
					unstaged.stderr.trim() ||
					unstaged.stdout.trim() ||
					"git diff failed during dirty-change capture",
			};
		}

		const statusAfter = await git(
			["status", "--porcelain", "--untracked-files=no"],
			repoRoot,
		);
		if (
			statusAfter.code !== 0 ||
			statusAfter.stdout !== statusBefore.stdout
		) {
			cleanupDirtyChanges(dirtyChanges);
			return {
				ok: false,
				message:
					statusAfter.stderr.trim() ||
					"source checkout changed during dirty-change capture",
			};
		}

		return { ok: true, dirtyChanges };
	}

	function cleanupDirtyChanges(dirtyChanges: DirtyChanges): void {
		try {
			fs.rmSync(dirtyChanges.tmpDir, { recursive: true, force: true });
		} catch {}
	}

	async function applyPatchFile(
		wtDir: string,
		patchPath: string,
		args: string[],
	): Promise<{ code: number; stdout: string; stderr: string }> {
		return git(["apply", "--binary", ...args, patchPath], wtDir);
	}

	function fileHasContent(filePath: string): boolean {
		try {
			return fs.statSync(filePath).size > 0;
		} catch {
			return false;
		}
	}

	async function applyDirtyChanges(
		wtDir: string,
		dirtyChanges: DirtyChanges,
	): Promise<ApplyDirtyChangesResult> {
		const hasStagedPatch = fileHasContent(dirtyChanges.stagedPatchPath);
		const hasUnstagedPatch = fileHasContent(dirtyChanges.unstagedPatchPath);

		if (hasStagedPatch) {
			const stagedResult = await applyPatchFile(
				wtDir,
				dirtyChanges.stagedPatchPath,
				["--index"],
			);
			if (stagedResult.code !== 0) {
				return {
					ok: false,
					failedPatch: "staged",
					message: stagedResult.stderr.trim() || stagedResult.stdout.trim(),
					partial: false,
				};
			}
		}

		if (hasUnstagedPatch) {
			const unstagedResult = await applyPatchFile(
				wtDir,
				dirtyChanges.unstagedPatchPath,
				[],
			);
			if (unstagedResult.code !== 0) {
				return {
					ok: false,
					failedPatch: "unstaged",
					message: unstagedResult.stderr.trim() || unstagedResult.stdout.trim(),
					partial: hasStagedPatch,
				};
			}
		}

		return { ok: true };
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

	async function detectUnpushedCommits(
		info: WorktreeInfo,
	): Promise<UnpushedCommits> {
		const branchRef = `refs/heads/${info.branch}`;
		const excludes: string[] = [];

		if (info.base) {
			const baseCheck = await git(
				["rev-parse", "--verify", "--quiet", info.base],
				info.repoRoot,
			);
			if (baseCheck.code === 0) excludes.push(`^${info.base}`);
		} else {
			for (const candidate of ["main", "master"]) {
				if (candidate === info.branch) continue;
				const check = await git(
					["rev-parse", "--verify", `refs/heads/${candidate}`],
					info.repoRoot,
				);
				if (check.code === 0) excludes.push(`^refs/heads/${candidate}`);
			}
		}

		const upstream = await git(
			["rev-parse", "--verify", "--quiet", `${branchRef}@{u}`],
			info.repoRoot,
		);
		if (upstream.code === 0) excludes.push(`^${branchRef}@{u}`);

		const countResult = await git(
			["rev-list", "--count", branchRef, ...excludes],
			info.repoRoot,
		);
		if (countResult.code !== 0) return { count: 0, samples: [] };
		const count = Number.parseInt(countResult.stdout.trim(), 10);
		if (!Number.isFinite(count) || count <= 0) return { count: 0, samples: [] };

		const logResult = await git(
			["log", "--oneline", "--max-count=5", branchRef, ...excludes],
			info.repoRoot,
		);
		const samples =
			logResult.code === 0
				? logResult.stdout
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line.length > 0)
				: [];
		return { count, samples };
	}

	async function confirmInTerminal(
		branch: string,
		wtPath: string,
		isDirty: boolean,
		unpushed: UnpushedCommits,
	): Promise<boolean> {
		const hasUnpushed = unpushed.count > 0;
		const needsPrompt = isDirty || hasUnpushed;
		if (!process.stdin.isTTY || !process.stderr.isTTY) return !needsPrompt;

		if (process.stdin.isRaw) {
			process.stdin.setRawMode(false);
		}

		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stderr,
		});

		try {
			const warningLines: string[] = [];
			if (isDirty) {
				warningLines.push(
					"Worktree has uncommitted changes.",
					"Deleting it will discard those changes.",
				);
			}
			if (hasUnpushed) {
				const noun = unpushed.count === 1 ? "commit" : "commits";
				warningLines.push(
					`Worktree branch has ${unpushed.count} unpushed ${noun}:`,
					...unpushed.samples.map((line) => `  ${line}`),
				);
				if (unpushed.count > unpushed.samples.length) {
					warningLines.push(
						`  …and ${unpushed.count - unpushed.samples.length} more`,
					);
				}
			}
			const warning =
				warningLines.length > 0 ? `${warningLines.join("\n")}\n` : "";

			// Default to keeping the worktree whenever committed work is at stake;
			// dirty-only stays consistent with prior behavior and defaults to delete.
			const defaultDelete = !hasUnpushed;
			const promptHint = defaultDelete ? "[Y/n]" : "[y/N]";
			const answer = await rl.question(
				`${warning}Delete worktree?\n"${branch}" at ${wtPath}\nRemove it? ${promptHint} `,
			);
			const trimmed = answer.trim();
			if (trimmed === "") return defaultDelete;
			if (/^(y|yes)$/i.test(trimmed)) return true;
			if (/^(n|no)$/i.test(trimmed)) return false;
			return defaultDelete;
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
	pi.registerFlag("wt", {
		description: "Alias for --worktree",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("worktree-base", {
		description:
			"Base ref for the temporary worktree: default, main-master, current, HEAD, or any commit-ish ref",
		type: "string",
		default: "default",
	});
	pi.registerFlag("worktree-include-dirty", {
		description:
			"Copy staged and unstaged changes from the source checkout into the temporary worktree",
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

		if (
			event.reason !== "startup" ||
			(!pi.getFlag("worktree") && !pi.getFlag("wt"))
		) {
			return;
		}

		const baseResult = await resolveWorktreeBase(repoRoot);
		if (!baseResult.ok) {
			ctx.ui.notify(baseResult.error, "error");
			return;
		}

		const includeDirty = pi.getFlag("worktree-include-dirty") === true;
		const dirtyChangesResult = includeDirty
			? await captureDirtyChanges(repoRoot)
			: null;
		if (dirtyChangesResult && !dirtyChangesResult.ok) {
			ctx.ui.notify(
				`Failed to capture source checkout dirty changes: ${dirtyChangesResult.message}`,
				"error",
			);
			return;
		}
		const dirtyChanges = dirtyChangesResult?.ok
			? dirtyChangesResult.dirtyChanges
			: null;

		const worktreeId = `${timestamp()}-${process.pid}`;
		const branch = `pi-wt/${worktreeId}`;
		const wtDir = path.join(
			repoRoot,
			".pi",
			"worktrees",
			`pi-wt-${worktreeId}`,
		);

		const res = await git(
			["worktree", "add", "--no-track", "-b", branch, wtDir, baseResult.base],
			repoRoot,
		);
		if (res.code !== 0) {
			if (dirtyChanges) cleanupDirtyChanges(dirtyChanges);
			ctx.ui.notify(`Failed to create worktree: ${res.stderr}`, "error");
			return;
		}

		if (dirtyChanges) {
			let shouldCleanupDirtyChanges = true;
			try {
				const applyResult = await applyDirtyChanges(wtDir, dirtyChanges);
				if (!applyResult.ok) {
					shouldCleanupDirtyChanges = false;
					const partialNote = applyResult.partial
						? " Some staged changes may already be applied in the worktree."
						: "";
					ctx.ui.notify(
						`Worktree created and activated, but failed to apply ${applyResult.failedPatch} dirty changes.${partialNote} Inspect ${wtDir}; patch files were kept at ${dirtyChanges.tmpDir}. Git said: ${applyResult.message}`,
						"error",
					);
				}
			} finally {
				if (shouldCleanupDirtyChanges) cleanupDirtyChanges(dirtyChanges);
			}
		}

		const baseShaResult = await git(
			["rev-parse", "--verify", baseResult.base],
			repoRoot,
		);
		const baseSha =
			baseShaResult.code === 0 ? baseShaResult.stdout.trim() : undefined;

		const info: WorktreeInfo = {
			path: wtDir,
			branch,
			repoRoot,
			pid: process.pid,
			...(baseSha ? { base: baseSha } : {}),
		};
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
		const unpushed = await detectUnpushedCommits(worktreeState.info);
		const hasUnpushed = unpushed.count > 0;
		const needsConfirmation = isDirty || hasUnpushed;

		if (ctx.hasUI) {
			if (isDirty) {
				ctx.ui.notify(
					`Worktree has uncommitted changes: ${branch}`,
					"warning",
				);
			} else if (hasUnpushed) {
				const noun = unpushed.count === 1 ? "commit" : "commits";
				ctx.ui.notify(
					`Worktree has ${unpushed.count} unpushed ${noun}: ${branch}`,
					"warning",
				);
			}
		}

		// Pi stops the TUI before final shutdown handlers run, so ctx.ui.confirm()
		// is not visible here in interactive mode.
		let shouldDelete = true;
		if (needsConfirmation) {
			shouldDelete = await confirmInTerminal(branch, wtPath, isDirty, unpushed);
		} else {
			terminalMessage("Cleaning up worktree (no pending changes)…");
		}

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

			// User explicitly confirmed discarding committed work, so force-delete
			// the branch instead of refusing on unmerged commits.
			const deleteFlag = hasUnpushed ? "-D" : "-d";
			const deleteBranchResult = await git(
				["branch", deleteFlag, branch],
				repoRoot,
			);
			if (deleteBranchResult.code === 0) {
				terminalMessage("Worktree and branch deleted");
			} else {
				terminalMessage(`Worktree deleted; branch kept: ${branch}`);
			}
		} else {
			if (isDirty) {
				terminalMessage(`Worktree has uncommitted changes; kept at: ${wtPath}`);
			} else if (hasUnpushed) {
				const noun = unpushed.count === 1 ? "commit" : "commits";
				terminalMessage(
					`Worktree has ${unpushed.count} unpushed ${noun}; kept at: ${wtPath}`,
				);
			} else {
				terminalMessage(`Kept at: ${wtPath}`);
			}
		}

		removeWorktreeMarker(repoRoot);
	});
}
