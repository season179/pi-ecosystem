import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { decideDelivery } from "../src/policy.js";

describe("decideDelivery", () => {
	const noWake = (reason: "wake-disabled" | "budget-disabled" | "budget-exhausted", wakesUsedAfter: number) => ({
		deliverAs: "steer" as const,
		triggerTurn: false,
		countsAsWake: false,
		reason,
		wakesUsedAfter,
	});

	it("gives wake:false precedence with positive available budget", () => {
		assert.deepEqual(
			decideDelivery({ wake: false, agentBusy: false, wakesUsed: 1, wakeBudget: 3 }),
			noWake("wake-disabled", 1),
		);
	});

	it("gives wake:false precedence over a zero budget", () => {
		assert.deepEqual(
			decideDelivery({ wake: false, agentBusy: false, wakesUsed: 0, wakeBudget: 0 }),
			noWake("wake-disabled", 0),
		);
	});

	it("treats a zero budget as deliberately disabling auto-wake", () => {
		assert.deepEqual(
			decideDelivery({ wake: true, agentBusy: false, wakesUsed: 0, wakeBudget: 0 }),
			noWake("budget-disabled", 0),
		);
	});

	it("guards an exhausted positive budget while idle", () => {
		assert.deepEqual(
			decideDelivery({ wake: true, agentBusy: false, wakesUsed: 3, wakeBudget: 3 }),
			noWake("budget-exhausted", 3),
		);
	});

	it("guards an exhausted positive budget while busy", () => {
		assert.deepEqual(
			decideDelivery({ wake: true, agentBusy: true, wakesUsed: 3, wakeBudget: 3 }),
			noWake("budget-exhausted", 3),
		);
	});

	it("grants and counts an available idle wake", () => {
		assert.deepEqual(
			decideDelivery({ wake: true, agentBusy: false, wakesUsed: 0, wakeBudget: 3 }),
			{
				deliverAs: "steer",
				triggerTurn: true,
				countsAsWake: true,
				reason: "wake-granted",
				wakesUsedAfter: 1,
			},
		);
	});

	it("grants busy steering without consuming budget", () => {
		assert.deepEqual(
			decideDelivery({ wake: true, agentBusy: true, wakesUsed: 1, wakeBudget: 3 }),
			{
				deliverAs: "steer",
				triggerTurn: true,
				countsAsWake: false,
				reason: "wake-granted",
				wakesUsedAfter: 1,
			},
		);
	});

	it("grants the final slot from penultimate use", () => {
		assert.deepEqual(
			decideDelivery({ wake: true, agentBusy: false, wakesUsed: 2, wakeBudget: 3 }),
			{
				deliverAs: "steer",
				triggerTurn: true,
				countsAsWake: true,
				reason: "wake-granted",
				wakesUsedAfter: 3,
			},
		);
	});

	it("does not increment defensive inputs above budget", () => {
		assert.deepEqual(
			decideDelivery({ wake: true, agentBusy: false, wakesUsed: 5, wakeBudget: 3 }),
			noWake("budget-exhausted", 5),
		);
	});
});
