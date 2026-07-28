import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { WatchOutcome, WatchRecordPublic, WatchSpec } from "../src/types.js";
import {
	buildWatchArgs,
	CapacityError,
	WatchManager,
} from "../src/watches.js";

const fixture = fileURLToPath(
	new URL("./fixtures/fake-herdr.mjs", import.meta.url),
);
const originalBehavior = process.env.FAKE_HERDR_BEHAVIOR;
const originalDelay = process.env.FAKE_HERDR_DELAY_MS;
const managers: WatchManager[] = [];

type OutcomeEvent = { record: WatchRecordPublic; outcome: WatchOutcome };

function agentSpec(overrides: Partial<WatchSpec> = {}): WatchSpec {
	return {
		target: "reviewer",
		mode: "agent",
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
});

afterEach(async () => {
	while (managers.length > 0) await managers.pop()?.shutdown();
	if (originalBehavior === undefined) delete process.env.FAKE_HERDR_BEHAVIOR;
	else process.env.FAKE_HERDR_BEHAVIOR = originalBehavior;
	if (originalDelay === undefined) delete process.env.FAKE_HERDR_DELAY_MS;
	else process.env.FAKE_HERDR_DELAY_MS = originalDelay;
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

	it("rejects invalid mode-specific conditions", () => {
		assert.throws(
			() => buildWatchArgs(agentSpec({ match: "done" })),
			/agent watches cannot specify/u,
		);
		assert.throws(
			() =>
				buildWatchArgs({ target: "w1:p2", mode: "output", wake: true }),
			/require match or regex/u,
		);
		assert.throws(
			() =>
				buildWatchArgs({
					target: "w1:p2",
					mode: "output",
					match: "done",
					regex: "done$",
					wake: true,
				}),
			/both match and regex/u,
		);
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

	it("escalates an ignored SIGTERM to SIGKILL when stopped", async () => {
		process.env.FAKE_HERDR_BEHAVIOR = "stall";
		const harness = createHarness({ killGraceMs: 100 });
		const completed = harness.nextOutcome();
		const started = harness.manager.start(agentSpec());
		await sleep(150);

		const stopStartedAt = Date.now();
		const stopped = await harness.manager.stop(started.id);
		const event = await completed;

		assert.ok(Date.now() - stopStartedAt >= 100);
		assert.ok(Date.now() - stopStartedAt < 2_000);
		assert.deepEqual(stopped.map((record) => record.id), [started.id]);
		assert.equal(event.record.status, "stopped");
		assert.equal(event.outcome.kind, "killed");
		assert.equal(harness.events.length, 1);
	});

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
