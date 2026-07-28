export interface DeliveryDecision {
	deliverAs: "steer";
	triggerTurn: boolean;
	countsAsWake: boolean;
}

export function decideDelivery(input: {
	wake: boolean;
	agentBusy: boolean;
	wakesUsed: number;
	wakeBudget: number;
}): DeliveryDecision {
	const triggerTurn =
		input.wake && input.wakeBudget !== 0 && input.wakesUsed < input.wakeBudget;
	return {
		deliverAs: "steer",
		triggerTurn,
		countsAsWake: triggerTurn && !input.agentBusy,
	};
}
