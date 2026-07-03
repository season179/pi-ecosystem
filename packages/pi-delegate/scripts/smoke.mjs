/**
 * Milestone-1 smoke test: spawn a real worker on zai/glm-5.2 with a hardcoded
 * brief in a scratch directory, then mechanically verify the file it was
 * asked to create. Run via `npm run smoke -w @season179/pi-delegate`.
 * Costs GLM coding-plan quota (flat rate), no API spend.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFinalOutput, runWorker } from "../dist/worker.js";

const MODEL = process.env.PI_DELEGATE_SMOKE_MODEL || "zai/glm-5.2";
const EXPECTED = "hello from the delegate worker\n";

const scratchDir = mkdtempSync(join(tmpdir(), "pi-delegate-smoke-"));
console.log(`scratch: ${scratchDir}`);
console.log(`model:   ${MODEL}`);

const result = await runWorker({
	model: MODEL,
	cwd: scratchDir,
	piCommand: "pi",
	timeoutMs: 5 * 60 * 1000,
	task: `Create a file named hello.txt in the current directory containing exactly this single line:\n\nhello from the delegate worker\n\nDo nothing else. When done, reply with a one-sentence summary.`,
	systemPrompt: "You are a delegated worker. Complete the brief exactly. Never run git commands.",
	onEvent: (ev) => {
		if (ev.type === "message" && ev.message.role === "assistant") {
			const tools = ev.message.content
				.filter((p) => p.type === "toolCall")
				.map((p) => p.name)
				.join(", ");
			console.log(`  turn: ${tools ? `tools[${tools}]` : "text"}`);
		}
	},
});

console.log("---");
console.log(`exit code:  ${result.exitCode}`);
console.log(`timed out:  ${result.timedOut}`);
console.log(`stop:       ${result.stopReason ?? "(none)"}`);
console.log(`model:      ${result.model ?? "(none)"}`);
console.log(
	`usage:      ${result.usage.turns} turns, in ${result.usage.input}, out ${result.usage.output}, cost $${result.usage.cost.toFixed(4)}`,
);
console.log(`duration:   ${(result.durationMs / 1000).toFixed(1)}s`);
console.log(`summary:    ${getFinalOutput(result.messages) || "(none)"}`);
if (result.stderr.trim()) console.log(`stderr:\n${result.stderr.trim()}`);

let verified = false;
try {
	verified = readFileSync(join(scratchDir, "hello.txt"), "utf-8") === EXPECTED;
} catch {
	/* missing file = failed */
}

console.log("---");
if (result.exitCode === 0 && !result.timedOut && verified) {
	console.log("SMOKE PASS: worker ran and hello.txt has the exact expected content");
	rmSync(scratchDir, { recursive: true, force: true });
} else {
	console.log(`SMOKE FAIL: verified=${verified} (scratch dir kept for inspection)`);
	process.exitCode = 1;
}
