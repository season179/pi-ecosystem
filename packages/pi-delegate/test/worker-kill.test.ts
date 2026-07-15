/**
 * Kill-path tests against a real child process: SIGTERM→SIGKILL escalation
 * when the worker ignores SIGTERM, process-group kill reaching the worker's
 * children, and clean completion leaving no stray processes.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorker } from "../src/worker.js";

const dirs: string[] = [];

function makeFakePi(script: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-fakepi-"));
	dirs.push(dir);
	const bin = join(dir, "fake-pi.sh");
	writeFileSync(bin, `#!/bin/sh\n${script}\n`);
	chmodSync(bin, 0o755);
	return bin;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("runWorker kill path", () => {
	it("escalates to SIGKILL when the worker ignores SIGTERM", async () => {
		// The busy loop keeps the trap-owning shell in the foreground, so the
		// whole group survives SIGTERM and only SIGKILL can end the run. The
		// kill is triggered by abort AFTER the script reports ready via the
		// event stream — racing a short timeout against script startup made
		// this flaky under parallel suite load.
		const bin = makeFakePi(
			`trap '' TERM\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ready"}]}}'\nwhile :; do sleep 0.1; done`,
		);

		const controller = new AbortController();
		let abortedAt = 0;
		const result = await runWorker({
			model: "test/model",
			task: "noop",
			cwd: process.cwd(),
			timeoutMs: 60_000,
			sigkillGraceMs: 300,
			signal: controller.signal,
			piCommand: bin,
			onEvent: () => {
				if (!abortedAt) {
					abortedAt = Date.now();
					controller.abort();
				}
			},
		});
		const endedAt = Date.now();

		expect(result.aborted).toBe(true);
		expect(result.exitCode).not.toBe(0);
		// SIGTERM alone cannot have ended it (trapped, busy loop restarts);
		// the run must have lasted at least the escalation grace — with the
		// old proc.killed check the SIGKILL never fired and this hung 60s.
		expect(abortedAt).toBeGreaterThan(0);
		expect(endedAt - abortedAt).toBeGreaterThanOrEqual(250);
		expect(endedAt - abortedAt).toBeLessThan(10_000);
	}, 15_000);

	it("kills the worker's process group, not just pi itself", async () => {
		// The fake pi reports its child's PID through the JSON event stream
		// (a file write from the detached grandchild can be blocked in
		// sandboxed test environments); the kill is abort-triggered once the
		// PID is known, so nothing races script startup.
		const bin = makeFakePi(
			`sleep 60 &\necho "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"$!\\"}]}}"\nwait`,
		);

		const controller = new AbortController();
		let childPid = 0;
		const result = await runWorker({
			model: "test/model",
			task: "noop",
			cwd: process.cwd(),
			timeoutMs: 60_000,
			sigkillGraceMs: 300,
			signal: controller.signal,
			piCommand: bin,
			onEvent: (ev) => {
				if (ev.type === "message" && childPid === 0) {
					const part = ev.message.content[0] as { text?: string } | undefined;
					childPid = Number(part?.text?.trim());
					controller.abort();
				}
			},
		});

		expect(result.aborted).toBe(true);
		expect(childPid).toBeGreaterThan(0);
		// The group signal must reach the shell's `sleep` child, not just pi.
		for (let i = 0; i < 20 && isAlive(childPid); i++) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(isAlive(childPid)).toBe(false);
	}, 15_000);

	it("completes cleanly without killing and reports exit 0", async () => {
		const bin = makeFakePi(
			`echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}'`,
		);

		const controller = new AbortController();
		const result = await runWorker({
			model: "test/model",
			task: "noop",
			cwd: process.cwd(),
			timeoutMs: 60_000,
			signal: controller.signal,
			piCommand: bin,
		});

		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
		expect(result.messages).toHaveLength(1);
		// Listener was removed on close: aborting now must not mark anything.
		controller.abort();
		expect(result.aborted).toBe(false);
	}, 15_000);

	it("does not spawn at all when the signal is already aborted", async () => {
		// The fake pi would emit a message if it ever ran.
		const bin = makeFakePi(
			`echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ran"}]}}'`,
		);

		const controller = new AbortController();
		controller.abort();
		const result = await runWorker({
			model: "test/model",
			task: "noop",
			cwd: process.cwd(),
			timeoutMs: 60_000,
			signal: controller.signal,
			piCommand: bin,
		});

		expect(result.aborted).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(result.messages).toHaveLength(0);
		expect(result.durationMs).toBe(0);
	});

	it("aborts via signal and reports aborted with nonzero exit", async () => {
		const bin = makeFakePi(`echo start\nsleep 60`);

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const result = await runWorker({
			model: "test/model",
			task: "noop",
			cwd: process.cwd(),
			timeoutMs: 60_000,
			sigkillGraceMs: 300,
			signal: controller.signal,
			piCommand: bin,
		});

		expect(result.aborted).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).not.toBe(0);
	}, 15_000);
});
