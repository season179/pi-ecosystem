/**
 * Milestone-2 smoke test: drive the built `delegate` tool end-to-end —
 * checkpoint → real glm worker (in-place edits) → harness-run verify →
 * report — against a scratch git repo, with a faked ExtensionAPI (only the
 * surface the tool uses: registerTool capture + exec).
 * Run via `node scripts/smoke-tool.mjs` after a build.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Outside a real pi process the worker spawn must be told how to invoke pi
// (see the seam note in delegate.ts); without this the spawn re-invokes this
// script recursively.
process.env.PI_DELEGATE_PI_COMMAND = "pi";

const { default: setup } = await import("../dist/extensions/delegate.js");

const execFileAsync = promisify(execFile);

const exec = async (command, args, options) => {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd: options?.cwd,
			timeout: options?.timeout,
		});
		return { stdout, stderr, code: 0, killed: false };
	} catch (error) {
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? String(error),
			code: typeof error.code === "number" ? error.code : 1,
			killed: Boolean(error.killed),
		};
	}
};

let tool;
setup({
	exec,
	registerTool(definition) {
		tool = definition;
	},
});
if (!tool || tool.name !== "delegate") {
	console.log("SMOKE FAIL: extension did not register the delegate tool");
	process.exit(1);
}

// Scratch repo with an initial commit AND a pre-existing dirty file, to
// exercise the auto-commit checkpoint path.
const repo = mkdtempSync(join(tmpdir(), "pi-delegate-tool-smoke-"));
await exec("git", ["init"], { cwd: repo });
await exec("git", ["config", "user.email", "smoke@test"], { cwd: repo });
await exec("git", ["config", "user.name", "smoke"], { cwd: repo });
writeFileSync(join(repo, "README.md"), "scratch\n");
await exec("git", ["add", "-A"], { cwd: repo });
await exec("git", ["commit", "-m", "init"], { cwd: repo });
writeFileSync(join(repo, "dirty.txt"), "uncommitted pre-existing change\n");

console.log(`scratch repo: ${repo}`);

const result = await tool.execute(
	"smoke-call-1",
	{
		task: "Create a file util.mjs in the project root exporting a function add(a, b) that returns their sum. ES module syntax.",
		context: "Fresh scratch project, no conventions to follow. Plain JavaScript, no dependencies.",
		files: ["util.mjs"],
		verify:
			'node --input-type=module -e "const { add } = await import(\'./util.mjs\'); if (add(2, 3) !== 5) throw new Error(\'add is wrong\')"',
	},
	undefined,
	(partial) => {
		const line = partial.content?.[0];
		if (line?.type === "text") console.log(`  ${line.text}`);
	},
	{ cwd: repo },
);

const text = result.content[0]?.text ?? "(no content)";
console.log("--- report ---");
console.log(text);
console.log("--------------");

const pass =
	!result.isError &&
	text.includes("status: success") &&
	text.includes("util.mjs") &&
	result.details?.checkpoint?.committed === true;

if (pass) {
	console.log("SMOKE PASS: full delegate flow (dirty-tree checkpoint, worker, verify, report)");
	rmSync(repo, { recursive: true, force: true });
} else {
	console.log("SMOKE FAIL (scratch repo kept for inspection)");
	process.exitCode = 1;
}
