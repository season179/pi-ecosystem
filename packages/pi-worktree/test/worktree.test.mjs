import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import worktreeExtension from "../dist/extensions/worktree.js";

const execFileAsync = promisify(execFile);

async function git(args, options = {}) {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, options);
		return { code: 0, stdout, stderr };
	} catch (error) {
		return {
			code: typeof error.code === "number" ? error.code : 1,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? String(error),
		};
	}
}

function installTerminal(input) {
	const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
	const originalStderr = Object.getOwnPropertyDescriptor(process, "stderr");
	const stdin = Readable.from(input);
	let output = "";

	Object.defineProperties(stdin, {
		isTTY: { value: true },
		isRaw: { value: false, writable: true },
		setRawMode: { value: () => stdin },
	});

	const stderr = new Writable({
		write(chunk, _encoding, callback) {
			output += chunk.toString();
			callback();
		},
	});
	Object.defineProperty(stderr, "isTTY", { value: true });

	Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
	Object.defineProperty(process, "stderr", { configurable: true, value: stderr });

	return {
		output: () => output,
		restore() {
			Object.defineProperty(process, "stdin", originalStdin);
			Object.defineProperty(process, "stderr", originalStderr);
		},
	};
}

async function createRepo(t) {
	const repoRoot = mkdtempSync(path.join(tmpdir(), "pi-worktree-test-"));
	t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

	await git(["init", "-b", "main", repoRoot]);
	await git(["-C", repoRoot, "config", "commit.gpgsign", "false"]);
	await git(["-C", repoRoot, "config", "user.email", "pi-worktree@example.com"]);
	await git(["-C", repoRoot, "config", "user.name", "Pi Worktree Test"]);
	writeFileSync(path.join(repoRoot, "README.md"), "test\n");
	await git(["-C", repoRoot, "add", "README.md"]);
	await git(["-C", repoRoot, "commit", "-m", "initial"]);

	return repoRoot;
}

function createHarness(repoRoot) {
	const handlers = {};
	const ctx = {
		hasUI: true,
		ui: {
			notifications: [],
			notify(message, level) {
				this.notifications.push({ message, level });
			},
			setStatus() {},
		},
	};
	const pi = {
		exec: (command, args, options) => {
			assert.equal(command, "git");
			return git(args, { cwd: repoRoot, timeout: options.timeout });
		},
		registerFlag() {},
		getFlag: (name) => name === "worktree",
		on(eventName, handler) {
			handlers[eventName] = handler;
		},
	};

	worktreeExtension(pi);
	return { ctx, handlers };
}

async function runSession(t, options) {
	const mutateWorktree =
		typeof options === "function" ? options : options?.mutate;
	const input =
		typeof options === "object" && options?.input ? options.input : "n\n";

	const repoRoot = await createRepo(t);
	const terminal = installTerminal(input);
	t.after(terminal.restore);

	const { ctx, handlers } = createHarness(repoRoot);
	await handlers.session_start({ reason: "startup" }, ctx);

	const markerPath = path.join(repoRoot, ".pi", `worktree-active-${process.pid}.json`);
	const marker = JSON.parse(readFileSync(markerPath, "utf8"));
	await mutateWorktree?.(marker.path);

	await handlers.session_shutdown({ reason: "quit" }, ctx);
	return { marker, terminal, repoRoot };
}

describe("pi-worktree shutdown cleanup", () => {
	it("removes a clean worktree without confirmation", async (t) => {
		const { marker, terminal } = await runSession(t);

		assert.equal(existsSync(marker.path), false);
		assert.match(terminal.output(), /Cleaning up worktree \(no pending changes\)…/);
		assert.doesNotMatch(terminal.output(), /Delete worktree\?/);
	});

	it("still prompts before deleting a dirty worktree", async (t) => {
		const { marker, terminal } = await runSession(t, (worktreePath) => {
			writeFileSync(path.join(worktreePath, "changed.txt"), "dirty\n");
		});

		assert.equal(existsSync(marker.path), true);
		assert.match(terminal.output(), /Worktree has uncommitted changes\./);
		assert.match(terminal.output(), /Delete worktree\?/);
		assert.doesNotMatch(terminal.output(), /Cleaning up worktree/);
	});

	it("prompts before deleting a clean worktree that has unpushed commits", async (t) => {
		const { marker, terminal } = await runSession(t, async (worktreePath) => {
			writeFileSync(path.join(worktreePath, "wt-work.txt"), "real work\n");
			await git(["-C", worktreePath, "add", "wt-work.txt"]);
			await git([
				"-C",
				worktreePath,
				"commit",
				"-m",
				"work done in the worktree",
			]);
		});

		assert.equal(
			existsSync(marker.path),
			true,
			"worktree should be kept after declining the prompt",
		);
		assert.match(terminal.output(), /1 unpushed commit/);
		assert.match(terminal.output(), /work done in the worktree/);
		assert.match(terminal.output(), /Delete worktree\?/);
		assert.match(terminal.output(), /\[y\/N\]/);
		assert.doesNotMatch(terminal.output(), /Cleaning up worktree/);
	});

	it("force-deletes the branch when removing a worktree with unpushed commits", async (t) => {
		const { marker, repoRoot } = await runSession(t, {
			input: "y\n",
			mutate: async (worktreePath) => {
				writeFileSync(path.join(worktreePath, "wt-work.txt"), "real work\n");
				await git(["-C", worktreePath, "add", "wt-work.txt"]);
				await git([
					"-C",
					worktreePath,
					"commit",
					"-m",
					"work done in the worktree",
				]);
			},
		});

		assert.equal(
			existsSync(marker.path),
			false,
			"worktree should be removed after confirming the prompt",
		);
		const branchList = (
			await git(["-C", repoRoot, "branch", "--list", marker.branch])
		).stdout.trim();
		assert.equal(
			branchList,
			"",
			"branch with unpushed commits should be force-deleted on confirmation",
		);
	});

	it("prompt lists both dirty changes and unpushed commits together", async (t) => {
		const { marker, terminal } = await runSession(t, async (worktreePath) => {
			writeFileSync(
				path.join(worktreePath, "committed.txt"),
				"committed work\n",
			);
			await git(["-C", worktreePath, "add", "committed.txt"]);
			await git([
				"-C",
				worktreePath,
				"commit",
				"-m",
				"committed worktree work",
			]);
			writeFileSync(path.join(worktreePath, "scratch.txt"), "still editing\n");
		});

		assert.equal(existsSync(marker.path), true);
		const output = terminal.output();
		assert.match(output, /Worktree has uncommitted changes\./);
		assert.match(output, /1 unpushed commit/);
		assert.match(output, /committed worktree work/);
	});
});
