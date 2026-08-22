import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import type {
	AgentWatchSpec,
	CommandWatchSpec,
	WatchOutcome,
	WatchRecordPublic,
	WatchSpec,
} from "../src/types.js";
import {
	buildWatchArgs,
	CapacityError,
	validateWatchSpec,
	WatchManager,
} from "../src/watches.js";

const fixture = fileURLToPath(
	new URL("./fixtures/fake-herdr.mjs", import.meta.url),
);
const originalBehavior = process.env.FAKE_HERDR_BEHAVIOR;
const originalDelay = process.env.FAKE_HERDR_DELAY_MS;
const originalStallReadyLog = process.env.FAKE_HERDR_STALL_READY_LOG;
const managers: WatchManager[] = [];
const stallReadyLogs: string[] = [];

type OutcomeEvent = { record: WatchRecordPublic; outcome: WatchOutcome };

function agentSpec(overrides: Partial<AgentWatchSpec> = {}): AgentWatchSpec {
	return {
		target: "reviewer",
		mode: "agent",
		wake: true,
		...overrides,
	};
}

function commandSpec(
	overrides: Partial<CommandWatchSpec> = {},
): CommandWatchSpec {
	return {
		mode: "command",
		command: "exit 0",
		timeoutMs: 2_000,
		wake: true,
		...overrides,
	};
}

function createHarness(options: { maxWatches?: number; killGraceMs?: number } = {}) {
	const events: OutcomeEvent[] = [];
	const waiters: Array<(event: OutcomeEvent) => void> = [];
	const manager = new WatchManager({
		maxWatches: options.maxWatches ?? 8,
		command: fixture,
		killGraceMs: options.killGraceMs ?? 100,
		onOutcome: (record, outcome) => {
			const event = { record, outcome };
			events.push(event);
			waiters.shift()?.(event);
		},
	});
	managers.push(manager);
	return {
		manager,
		events,
		nextOutcome: () =>
			new Promise<OutcomeEvent>((resolve) => waiters.push(resolve)),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
	process.env.FAKE_HERDR_BEHAVIOR = "ok";
	delete process.env.FAKE_HERDR_DELAY_MS;
	delete process.env.FAKE_HERDR_STALL_READY_LOG;
});

afterEach(async () => {
	while (managers.length > 0) await managers.pop()?.shutdown();
	while (stallReadyLogs.length > 0) {
		rmSync(stallReadyLogs.pop() as string, { force: true });
	}
	if (originalBehavior === undefined) delete process.env.FAKE_HERDR_BEHAVIOR;
	else process.env.FAKE_HERDR_BEHAVIOR = originalBehavior;
	if (originalDelay === undefined) delete process.env.FAKE_HERDR_DELAY_MS;
	else process.env.FAKE_HERDR_DELAY_MS = originalDelay;
	if (originalStallReadyLog === undefined) {
		delete process.env.FAKE_HERDR_STALL_READY_LOG;
	} else {
		process.env.FAKE_HERDR_STALL_READY_LOG = originalStallReadyLog;
	}
});

describe("buildWatchArgs", () => {
	it("builds agent waits with repeated states and a timeout", () => {
		assert.deepEqual(
			buildWatchArgs(
				agentSpec({ until: ["idle", "blocked"], timeoutMs: 12_000 }),
			),
			[
				"agent",
				"wait",
				"reviewer",
				"--until",
				"idle",
				"--until",
				"blocked",
				"--timeout",
				"12000",
			],
		);
	});

	it("builds output waits for literal and regex conditions", () => {
		assert.deepEqual(
			buildWatchArgs({
				target: "w1:p2",
				mode: "output",
				match: "tests passed",
				wake: false,
			}),
			["pane", "wait-output", "w1:p2", "--match", "tests passed"],
		);
		assert.deepEqual(
			buildWatchArgs({
				target: "w1:p3",
				mode: "output",
				regex: "done|failed",
				timeoutMs: 50,
				wake: true,
			}),
			[
				"pane",
				"wait-output",
				"w1:p3",
				"--regex",
				"done|failed",
				"--timeout",
				"50",
			],
		);
	});

	it("does not build herdr CLI args for command watches", () => {
		assert.throws(
			() => buildWatchArgs(commandSpec()),
			/command watches do not use herdr CLI arguments/u,
		);
	});
});

describe("validateWatchSpec", () => {
	const valid = (spec: unknown): void => {
		assert.doesNotThrow(() => validateWatchSpec(spec));
	};
	const invalid = (spec: unknown, message: RegExp): void => {
		assert.throws(() => validateWatchSpec(spec), message);
	};

	it("accepts each valid discriminated-union branch", () => {
		valid(agentSpec());
		valid({ mode: "output", target: "w1:p2", match: "done", wake: true });
		valid({ mode: "output", target: "w1:p2", regex: "done$", wake: false });
		valid(commandSpec());
	});

	it("validates shared and branch field types for non-TypeScript callers", () => {
		invalid({ mode: "agent", target: "reviewer" }, /boolean wake/u);
		invalid(
			{ mode: "agent", target: "reviewer", until: "done", wake: true },
			/until must be an array of strings/u,
		);
		invalid(
			{ mode: "output", target: "w1:p2", match: 3, wake: true },
			/match or regex must be a string/u,
		);
	});

	it("requires non-empty targets for agent and output watches", () => {
		invalid({ mode: "agent", target: "  ", wake: true }, /non-empty target/u);
		invalid({ mode: "output", regex: "done", wake: true }, /non-empty target/u);
	});

	it("requires exactly one output condition and rejects other-mode fields", () => {
		invalid(
			{ mode: "output", target: "w1:p2", wake: true },
			/exactly one of match or regex/u,
		);
		invalid(
			{
				mode: "output",
				target: "w1:p2",
				match: "done",
				regex: "done$",
				wake: true,
			},
			/exactly one of match or regex/u,
		);
		for (const forbidden of ["until", "command"] as const) {
			invalid(
				{
					mode: "output",
					target: "w1:p2",
					match: "done",
					[forbidden]: forbidden === "until" ? ["done"] : "echo done",
					wake: true,
				},
				/cannot specify until or command/u,
			);
		}
	});

	it("rejects output fields and commands in agent mode", () => {
		for (const [field, value] of [
			["match", "done"],
			["regex", "done$"],
			["command", "echo done"],
		] as const) {
			invalid(
				{ mode: "agent", target: "reviewer", [field]: value, wake: true },
				/cannot specify match, regex, or command/u,
			);
		}
	});

	it("requires a bounded command and rejects every target-mode field", () => {
		invalid(
			{ mode: "command", timeoutMs: 100, wake: true },
			/non-empty command/u,
		);
		invalid(
			{ mode: "command", command: "  ", timeoutMs: 100, wake: true },
			/non-empty command/u,
		);
		invalid(
			{ mode: "command", command: "exit 0", wake: true },
			/timeoutMs/u,
		);
		for (const [field, value] of [
			["target", "w1:p2"],
			["until", ["done"]],
			["match", "done"],
			["regex", "done$"],
		] as const) {
			invalid(
				{
					mode: "command",
					command: "exit 0",
					timeoutMs: 100,
					[field]: value,
					wake: true,
				},
				/cannot specify target, until, match, or regex/u,
			);
		}
	});

	it("accepts only positive finite integer timeouts in Node's timer range", () => {
		for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648]) {
			invalid(
				{ ...commandSpec(), timeoutMs },
				/positive finite integer/u,
			);
		}
		valid(commandSpec({ timeoutMs: 2_147_483_647 }));
	});
});

describe("WatchManager", () => {
	it("reports natural completion once with parsed JSON", async () => {
		const harness = createHarness();
		const completed = harness.nextOutcome();
		const started = harness.manager.start(agentSpec());
		const event = await completed;

		assert.equal(started.status, "armed");
		assert.equal(event.record.status, "fired");
		assert.equal(event.outcome.kind, "fired");
		assert.equal(event.outcome.exitCode, 0);
		assert.deepEqual(event.outcome.json, {
			id: "x",
			result: {
				type: "agent_info",
				echo: ["agent", "wait", "reviewer"],
			},
		});
		assert.equal(harness.events.length, 1);
		assert.equal(harness.manager.get(started.id)?.status, "fired");
	});

	it("classifies CLI timeout errors", async () => {
		process.env.FAKE_HERDR_BEHAVIOR = "timeout-error";
		const harness = createHarness();
		const completed = harness.nextOutcome();
		harness.manager.start(agentSpec());
		const event = await completed;

		assert.equal(event.outcome.kind, "timeout");
		assert.equal(event.outcome.exitCode, 1);
		assert.deepEqual(event.outcome.errorJson, {
			error: { code: "wait_timeout" },
		});
	});

	it("classifies other nonzero exits as errors", async () => {
		process.env.FAKE_HERDR_BEHAVIOR = "bad-exit";
		const harness = createHarness();
		const completed = harness.nextOutcome();
		harness.manager.start(agentSpec());
		const event = await completed;

		assert.equal(event.outcome.kind, "error");
		assert.equal(event.outcome.exitCode, 3);
		assert.match(event.outcome.stderr, /not-json garbage/u);
	});

	it.skipIf(process.platform === "win32")(
		"fires command watches on a direct non-zero exit",
		async () => {
			const harness = createHarness();
			const completed = harness.nextOutcome();
			harness.manager.start(commandSpec({ command: "exit 3" }));
			const event = await completed;

			assert.equal(event.record.spec.mode, "command");
			assert.equal(event.outcome.kind, "fired");
			assert.equal(event.outcome.exitCode, 3);
		},
	);

	it.skipIf(process.platform === "win32")(
		"escalates a timed-out TERM-ignoring command and classifies it as timeout",
		async () => {
			const harness = createHarness({ killGraceMs: 200 });
			const completed = harness.nextOutcome();
			const startedAt = Date.now();
			harness.manager.start(
				commandSpec({
					command: "trap '' TERM; sleep 30",
					timeoutMs: 200,
				}),
			);
			const event = await completed;
			const elapsedMs = Date.now() - startedAt;

			assert.equal(event.outcome.kind, "timeout");
			assert.equal(event.outcome.exitCode, null);
			assert.ok(elapsedMs >= 300, `expected kill grace, got ${elapsedMs}ms`);
			assert.ok(elapsedMs < 3_000, `timeout took ${elapsedMs}ms`);
		},
	);

	it.skipIf(process.platform === "win32")(
		"preserves timeout classification when shutdown starts during kill grace",
		async () => {
			const harness = createHarness({ killGraceMs: 500 });
			const completed = harness.nextOutcome();
			harness.manager.start(
				commandSpec({
					command: "trap '' TERM; sleep 30",
					timeoutMs: 200,
				}),
			);
			await sleep(300);

			const shutdown = harness.manager.shutdown();
			const event = await completed;
			await shutdown;

			assert.equal(event.outcome.kind, "timeout");
			assert.equal(event.outcome.exitCode, null);
		},
	);

	it.skipIf(process.platform === "win32")(
		"classifies an explicitly stopped command watch as killed",
		async () => {
			const harness = createHarness({ killGraceMs: 200 });
			const completed = harness.nextOutcome();
			const started = harness.manager.start(
				commandSpec({
					command: "trap '' TERM; sleep 30",
					timeoutMs: 5_000,
				}),
			);
			await sleep(100);

			const stopped = await harness.manager.stop(started.id);
			const event = await completed;

			assert.deepEqual(stopped.map((record) => record.id), [started.id]);
			assert.equal(event.record.status, "stopped");
			assert.equal(event.outcome.kind, "killed");
		},
	);

	it.skipIf(process.platform === "win32")(
		"escalates an ignored SIGTERM to SIGKILL when stopped",
		async () => {
			process.env.FAKE_HERDR_BEHAVIOR = "stall";
			const readyLog = join(
				tmpdir(),
				`pi-herdr-stall-ready-${process.pid}-${Date.now()}`,
			);
			process.env.FAKE_HERDR_STALL_READY_LOG = readyLog;
			stallReadyLogs.push(readyLog);
			const harness = createHarness({ killGraceMs: 100 });
			const completed = harness.nextOutcome();
			const started = harness.manager.start(agentSpec());
			const readyDeadline = Date.now() + 2_000;
			while (!existsSync(readyLog) && Date.now() < readyDeadline) await sleep(10);
			assert.ok(existsSync(readyLog), "fake herdr did not become ready");

			const stopped = await harness.manager.stop(started.id);
			const event = await completed;

			assert.match(readFileSync(readyLog, "utf8"), /^ready\nSIGTERM\n$/u);
			assert.deepEqual(stopped.map((record) => record.id), [started.id]);
			assert.equal(event.record.status, "stopped");
			assert.equal(event.outcome.kind, "killed");
			assert.equal(event.outcome.exitCode, null);
			assert.equal(event.outcome.signal, "SIGKILL");
			assert.equal(harness.events.length, 1);
		},
	);

	it("enforces capacity only while watches are armed", async () => {
		process.env.FAKE_HERDR_DELAY_MS = "100";
		const harness = createHarness({ maxWatches: 1 });
		const firstCompleted = harness.nextOutcome();
		const first = harness.manager.start(agentSpec());

		assert.throws(
			() => harness.manager.start(agentSpec({ target: "second" })),
			CapacityError,
		);
		await firstCompleted;
		assert.equal(harness.manager.get(first.id)?.status, "fired");

		delete process.env.FAKE_HERDR_DELAY_MS;
		const secondCompleted = harness.nextOutcome();
		const second = harness.manager.start(agentSpec({ target: "second" }));
		await secondCompleted;
		assert.equal(second.id, 2);
	});

	it("lists armed records first and protects all internal record data", async () => {
		const harness = createHarness();
		const firstCompleted = harness.nextOutcome();
		const input = agentSpec({ until: ["done"] });
		const first = harness.manager.start(input);
		input.target = "mutated-input";
		input.until?.push("blocked");
		await firstCompleted;

		process.env.FAKE_HERDR_BEHAVIOR = "stall";
		const second = harness.manager.start(agentSpec({ target: "worker" }));
		const listed = harness.manager.list();
		assert.deepEqual(
			listed.map((record) => record.id),
			[second.id, first.id],
		);
		assert.equal(listed[1]?.spec.target, "reviewer");
		assert.deepEqual(listed[1]?.spec.until, ["done"]);

		if (listed[0] !== undefined) listed[0].spec.target = "corrupted";
		listed[1]?.spec.until?.push("corrupted");
		assert.equal(harness.manager.get(second.id)?.spec.target, "worker");
		assert.deepEqual(harness.manager.get(first.id)?.spec.until, ["done"]);

		await harness.manager.stop(second.id);
	});

	it("rejects starts after shutdown is latched and remains idempotent", async () => {
		const harness = createHarness();
		await harness.manager.shutdown();

		assert.throws(
			() => harness.manager.start(agentSpec()),
			/watch manager is shut down/u,
		);
		await harness.manager.shutdown();
		assert.equal(harness.events.length, 0);
	});

	it("can shut down twice safely", async () => {
		process.env.FAKE_HERDR_BEHAVIOR = "stall";
		const harness = createHarness({ killGraceMs: 100 });
		harness.manager.start(agentSpec());
		await sleep(150);

		await Promise.all([harness.manager.shutdown(), harness.manager.shutdown()]);
		await harness.manager.shutdown();
		assert.equal(harness.events.length, 1);
		assert.equal(harness.events[0]?.outcome.kind, "killed");
	});
});
