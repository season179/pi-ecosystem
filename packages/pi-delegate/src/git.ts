/**
 * Git safety rail for delegations: checkpoint the tree before the worker
 * touches it, and summarize what changed afterwards (diffstat + untracked).
 *
 * All functions take an exec callback so the extension can pass pi.exec and
 * tests can pass a plain child_process wrapper.
 */

export interface GitExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type GitExec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<GitExecResult>;

export const CHECKPOINT_MESSAGE = "pi-delegate checkpoint";

export interface Checkpoint {
	sha: string;
	/** True when dirty state was auto-committed to create the checkpoint. */
	committed: boolean;
}

export class GitError extends Error {}

async function git(exec: GitExec, cwd: string, args: string[]): Promise<GitExecResult> {
	return exec("git", args, { cwd });
}

/**
 * Ensure cwd is a git repo and record the pre-delegation state: if the tree
 * is dirty, auto-commit everything (--no-verify, hooks must not interfere
 * with a safety checkpoint); either way return the HEAD sha to reset to.
 */
export async function makeCheckpoint(exec: GitExec, cwd: string): Promise<Checkpoint> {
	const inRepo = await git(exec, cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inRepo.code !== 0) {
		throw new GitError(`delegation requires a git repository (checkpoint is the safety rail): ${cwd}`);
	}

	const status = await git(exec, cwd, ["status", "--porcelain"]);
	if (status.code !== 0) {
		throw new GitError(`git status failed: ${status.stderr.trim()}`);
	}

	let committed = false;
	if (status.stdout.trim()) {
		const add = await git(exec, cwd, ["add", "-A"]);
		if (add.code !== 0) throw new GitError(`git add failed: ${add.stderr.trim()}`);
		const commit = await git(exec, cwd, ["commit", "--no-verify", "-m", CHECKPOINT_MESSAGE]);
		if (commit.code !== 0) throw new GitError(`checkpoint commit failed: ${commit.stderr.trim()}`);
		committed = true;
	}

	const head = await git(exec, cwd, ["rev-parse", "HEAD"]);
	if (head.code !== 0) {
		throw new GitError(`cannot resolve HEAD (empty repository?): ${head.stderr.trim()}`);
	}

	return { sha: head.stdout.trim(), committed };
}

export interface WorkChanges {
	/** `git diff --stat <checkpoint>` output; empty when nothing changed. */
	diffstat: string;
	/** Untracked (new) files the diffstat does not cover. */
	untracked: string[];
}

/** Summarize what the worker changed relative to the checkpoint. */
export async function collectChanges(exec: GitExec, cwd: string, checkpointSha: string): Promise<WorkChanges> {
	const diff = await git(exec, cwd, ["diff", "--stat", checkpointSha]);
	if (diff.code !== 0) {
		throw new GitError(`git diff failed: ${diff.stderr.trim()}`);
	}

	const others = await git(exec, cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (others.code !== 0) {
		throw new GitError(`git ls-files failed: ${others.stderr.trim()}`);
	}

	return {
		diffstat: diff.stdout.trimEnd(),
		untracked: others.stdout.split("\n").filter((line) => line.trim()),
	};
}
