/**
 * Milestone-2 tests: git checkpoint/changes against a real scratch repo,
 * brief construction, and the result contract (status derivation, caps,
 * report formatting).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkerPrompt, WORKER_SYSTEM_PROMPT } from "../src/brief.js";
import { CHECKPOINT_MESSAGE, collectChanges, GitError, makeCheckpoint, type GitExec } from "../src/git.js";
import {
	capText,
	deriveStatus,
	formatReport,
	tailLines,
	workerFailed,
	type VerifyOutcome,
} from "../src/result.js";
import { emptyUsage, type WorkerResult } from "../src/worker.js";

const execFileAsync = promisify(execFile);

const exec: GitExec = async (command, args, options) => {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, { cwd: options?.cwd });
		return { stdout, stderr, code: 0 };
	} catch (error: any) {
		return { stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), code: error.code ?? 1 };
	}
};

function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text: "did the thing" }] } as any],
		usage: emptyUsage(),
		exitCode: 0,
		timedOut: false,
		aborted: false,
		stderr: "",
		durationMs: 1000,
		model: "glm-5.2",
		stopReason: "stop",
		...overrides,
	};
}

describe("git checkpoint + changes (scratch repo)", () => {
	let repo: string;

	beforeEach(async () => {
		repo = mkdtempSync(join(tmpdir(), "pi-delegate-git-"));
		await exec("git", ["init"], { cwd: repo });
		await exec("git", ["config", "user.email", "test@test"], { cwd: repo });
		await exec("git", ["config", "user.name", "test"], { cwd: repo });
		writeFileSync(join(repo, "a.txt"), "one\n");
		await exec("git", ["add", "-A"], { cwd: repo });
		await exec("git", ["commit", "-m", "init"], { cwd: repo });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("returns existing HEAD without committing when the tree is clean", async () => {
		const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
		const checkpoint = await makeCheckpoint(exec, repo);

		expect(checkpoint).toEqual({ sha: before, committed: false });
	});

	it("auto-commits a dirty tree and returns the new sha", async () => {
		const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
		writeFileSync(join(repo, "a.txt"), "changed\n");
		writeFileSync(join(repo, "new.txt"), "untracked\n");

		const checkpoint = await makeCheckpoint(exec, repo);

		expect(checkpoint.committed).toBe(true);
		expect(checkpoint.sha).not.toBe(before);
		const subject = (await exec("git", ["log", "-1", "--format=%s"], { cwd: repo })).stdout.trim();
		expect(subject).toBe(CHECKPOINT_MESSAGE);
		const status = (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim();
		expect(status).toBe("");
	});

	it("throws GitError outside a git repository", async () => {
		const bare = mkdtempSync(join(tmpdir(), "pi-delegate-nongit-"));
		try {
			await expect(makeCheckpoint(exec, bare)).rejects.toThrow(GitError);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("collects diffstat and untracked files relative to the checkpoint", async () => {
		const checkpoint = await makeCheckpoint(exec, repo);
		writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "brand-new.txt"), "hi\n");

		const changes = await collectChanges(exec, repo, checkpoint.sha);

		expect(changes.diffstat).toContain("a.txt");
		expect(changes.untracked).toEqual(["brand-new.txt"]);
	});

	it("reports no changes when the worker touched nothing", async () => {
		const checkpoint = await makeCheckpoint(exec, repo);
		const changes = await collectChanges(exec, repo, checkpoint.sha);

		expect(changes.diffstat).toBe("");
		expect(changes.untracked).toEqual([]);
	});
});

describe("buildWorkerPrompt", () => {
	it("includes task, context, files, and verify sections", () => {
		const prompt = buildWorkerPrompt({
			task: "Add a util",
			context: "We use vitest",
			files: ["src/util.ts"],
			verify: "npm test",
		});

		expect(prompt).toContain("# Delegated task");
		expect(prompt).toContain("Add a util");
		expect(prompt).toContain("# Context from the orchestrator");
		expect(prompt).toContain("We use vitest");
		expect(prompt).toContain("- src/util.ts");
		expect(prompt).toContain("`npm test`");
	});

	it("omits the files section when not provided", () => {
		const prompt = buildWorkerPrompt({ task: "t", context: "c", verify: "v" });
		expect(prompt).not.toContain("Files in scope");
	});

	it("system prompt forbids git mutations and demands a summary", () => {
		expect(WORKER_SYSTEM_PROMPT).toContain("NEVER run `git commit`");
		expect(WORKER_SYSTEM_PROMPT).toContain("final message");
	});
});

describe("status derivation", () => {
	const okVerify: VerifyOutcome = { code: 0, output: "ok", timedOut: false };

	it("success when worker clean and verify passes", () => {
		expect(deriveStatus(makeWorkerResult(), okVerify)).toBe("success");
	});

	it("treats stopReason 'stop' as clean (M1 smoke finding)", () => {
		expect(workerFailed(makeWorkerResult({ stopReason: "stop" }))).toBe(false);
	});

	it("timeout wins over everything", () => {
		expect(deriveStatus(makeWorkerResult({ timedOut: true, exitCode: 1 }), null)).toBe("timeout");
	});

	it("worker_error on nonzero exit, error stop, or abort", () => {
		expect(deriveStatus(makeWorkerResult({ exitCode: 1 }), null)).toBe("worker_error");
		expect(deriveStatus(makeWorkerResult({ stopReason: "error" }), null)).toBe("worker_error");
		expect(deriveStatus(makeWorkerResult({ aborted: true }), null)).toBe("worker_error");
	});

	it("verify_failed on nonzero verify, verify timeout, or skipped verify", () => {
		expect(deriveStatus(makeWorkerResult(), { code: 1, output: "fail", timedOut: false })).toBe("verify_failed");
		expect(deriveStatus(makeWorkerResult(), { code: 0, output: "", timedOut: true })).toBe("verify_failed");
		expect(deriveStatus(makeWorkerResult(), null)).toBe("verify_failed");
	});
});

describe("report formatting", () => {
	it("renders the compact contract with all sections", () => {
		const report = formatReport({
			status: "success",
			checkpoint: { sha: "abcdef1234567890", committed: true },
			worker: makeWorkerResult(),
			changes: { diffstat: " a.txt | 2 +-", untracked: ["new.txt"] },
			verify: { code: 0, output: "1 passed", timedOut: false },
		});

		expect(report).toContain("status: success");
		expect(report).toContain("checkpoint: abcdef123456");
		expect(report).toContain("auto-committed");
		expect(report).toContain("git reset --hard abcdef123456");
		expect(report).toContain(" a.txt | 2 +-");
		expect(report).toContain("new.txt");
		expect(report).toContain("verify (exit 0):");
		expect(report).toContain("did the thing");
	});

	it("marks skipped verify and includes the worker error reason", () => {
		const report = formatReport({
			status: "worker_error",
			checkpoint: { sha: "abcdef1234567890", committed: false },
			worker: makeWorkerResult({ exitCode: 1, stderr: "spawn failed" }),
			changes: { diffstat: "", untracked: [] },
			verify: null,
		});

		expect(report).toContain("status: worker_error");
		expect(report).toContain("spawn failed");
		expect(report).toContain("verify: skipped");
		expect(report).toContain("(no tracked changes)");
	});

	it("timeout with partial work points at manual salvage", () => {
		const report = formatReport({
			status: "timeout",
			checkpoint: { sha: "abcdef1234567890", committed: false },
			worker: makeWorkerResult({ timedOut: true, exitCode: 1 }),
			changes: { diffstat: " a.txt | 5 +++--", untracked: ["gen.txt"] },
			verify: null,
		});

		expect(report).toContain("status: timeout");
		expect(report).toContain("wall-clock timeout");
		expect(report).toContain("verify: skipped (worker killed at timeout) — partial work exists");
		expect(report).toContain("run the verify command yourself");
	});

	it("timeout without changes says so instead of hinting at salvage", () => {
		const report = formatReport({
			status: "timeout",
			checkpoint: { sha: "abcdef1234567890", committed: false },
			worker: makeWorkerResult({ timedOut: true, exitCode: 1 }),
			changes: { diffstat: "", untracked: [] },
			verify: null,
		});

		expect(report).toContain("verify: skipped (worker killed at timeout; no changes were made)");
		expect(report).not.toContain("salvage");
	});

	it("user abort reports the partial-work state, not a generic worker error", () => {
		const report = formatReport({
			status: "worker_error",
			checkpoint: { sha: "abcdef1234567890", committed: false },
			worker: makeWorkerResult({ aborted: true, exitCode: 1 }),
			changes: { diffstat: " a.txt | 2 +-", untracked: [] },
			verify: null,
		});

		expect(report).toContain("worker aborted by the user; partial changes remain in the tree.");
		expect(report).toContain("verify: skipped (delegation aborted by the user)");
		expect(report).toContain(" a.txt | 2 +-");
		expect(report).not.toContain("worker error:");
	});

	it("caps the worker summary", () => {
		const long = "x".repeat(3000);
		const report = formatReport({
			status: "success",
			checkpoint: { sha: "abcdef1234567890", committed: false },
			worker: makeWorkerResult({
				messages: [{ role: "assistant", content: [{ type: "text", text: long }] } as any],
			}),
			changes: { diffstat: "", untracked: [] },
			verify: { code: 0, output: "", timedOut: false },
		});

		expect(report).toContain("[truncated 1000 chars]");
	});
});

describe("text caps", () => {
	it("capText passes short text through and truncates long text", () => {
		expect(capText("short", 10)).toBe("short");
		expect(capText("0123456789abc", 10)).toBe("0123456789\n[truncated 3 chars]");
	});

	it("tailLines keeps the last N lines with an omission marker", () => {
		const text = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");
		const tail = tailLines(text, 50);
		expect(tail).toContain("[... 10 earlier lines omitted]");
		expect(tail).toContain("line59");
		expect(tail).not.toContain("line5\n");
	});
});
