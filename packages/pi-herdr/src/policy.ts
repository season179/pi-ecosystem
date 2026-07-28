export type DeliveryReason =
	| "wake-granted"
	| "wake-disabled"
	| "budget-disabled"
	| "budget-exhausted";

export interface DeliveryDecision {
	deliverAs: "steer";
	triggerTurn: boolean;
	countsAsWake: boolean;
	reason: DeliveryReason;
	wakesUsedAfter: number;
}

export function decideDelivery(input: {
	wake: boolean;
	agentBusy: boolean;
	wakesUsed: number;
	wakeBudget: number;
}): DeliveryDecision {
	let reason: DeliveryReason;
	if (!input.wake) reason = "wake-disabled";
	else if (input.wakeBudget === 0) reason = "budget-disabled";
	else if (input.wakesUsed >= input.wakeBudget) reason = "budget-exhausted";
	else reason = "wake-granted";

	const triggerTurn = reason === "wake-granted";
	const countsAsWake = triggerTurn && !input.agentBusy;
	return {
		deliverAs: "steer",
		triggerTurn,
		countsAsWake,
		reason,
		wakesUsedAfter: countsAsWake ? input.wakesUsed + 1 : input.wakesUsed,
	};
}
