import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { decideDelivery } from "../src/policy.js";

describe("decideDelivery", () => {
	it("does not trigger when the watch opted out of waking", () => {
		assert.deepEqual(
			decideDelivery({
				wake: false,
				agentBusy: false,
				wakesUsed: 0,
				wakeBudget: 20,
			}),
			{ deliverAs: "steer", triggerTurn: false, countsAsWake: false },
		);
	});

	it("does not trigger after the wake budget is exhausted", () => {
		assert.deepEqual(
			decideDelivery({
				wake: true,
				agentBusy: false,
				wakesUsed: 3,
				wakeBudget: 3,
			}),
			{ deliverAs: "steer", triggerTurn: false, countsAsWake: false },
		);
	});

	it("treats a zero budget as disabling auto-wake", () => {
		assert.deepEqual(
			decideDelivery({
				wake: true,
				agentBusy: false,
				wakesUsed: 0,
				wakeBudget: 0,
			}),
			{ deliverAs: "steer", triggerTurn: false, countsAsWake: false },
		);
	});

	it("steers a busy agent without consuming an idle wake", () => {
		assert.deepEqual(
			decideDelivery({
				wake: true,
				agentBusy: true,
				wakesUsed: 0,
				wakeBudget: 20,
			}),
			{ deliverAs: "steer", triggerTurn: true, countsAsWake: false },
		);
	});

	it("triggers and counts a wake for an idle agent within budget", () => {
		assert.deepEqual(
			decideDelivery({
				wake: true,
				agentBusy: false,
				wakesUsed: 2,
				wakeBudget: 3,
			}),
			{ deliverAs: "steer", triggerTurn: true, countsAsWake: true },
		);
	});
});
