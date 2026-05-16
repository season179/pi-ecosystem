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

async function runSession(t, mutateWorktree) {
	const repoRoot = await createRepo(t);
	const terminal = installTerminal("n\n");
	t.after(terminal.restore);

	const { ctx, handlers } = createHarness(repoRoot);
	await handlers.session_start({ reason: "startup" }, ctx);

	const markerPath = path.join(repoRoot, ".pi", `worktree-active-${process.pid}.json`);
	const marker = JSON.parse(readFileSync(markerPath, "utf8"));
	await mutateWorktree?.(marker.path);

	await handlers.session_shutdown({ reason: "quit" }, ctx);
	return { marker, terminal };
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
});
