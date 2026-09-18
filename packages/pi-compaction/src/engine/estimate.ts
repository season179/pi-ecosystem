import type { AgentMessage } from "./message.js";

/** Token estimator for one agent message; the adapter injects Pi's own `estimateTokens`. */
export type MessageEstimator = (message: AgentMessage) => number;

/** Conservative fallback used when Pi's estimator is unavailable: characters divided by four. */
export function charsPerFourEstimator(message: AgentMessage): number {
	let chars = 0;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") chars = content.length;
	else if (Array.isArray(content)) {
		for (const block of content as Array<Record<string, unknown>>) {
			if (typeof block.text === "string") chars += block.text.length;
			else if (typeof block.thinking === "string") chars += block.thinking.length;
			else if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length + String(block.name ?? "").length;
			else if (block.type === "image") chars += 4000;
		}
	}
	return Math.ceil(chars / 4);
}

export function estimateMessages(messages: readonly AgentMessage[], estimator: MessageEstimator): number {
	let total = 0;
	for (const message of messages) total += estimator(message);
	return total;
}

export interface HeadroomInput {
	/** Pi's usage-derived estimate of the context about to be compacted. */
	tokensBefore: number;
	/** Estimated tokens the pruned overlay saves relative to what the observation measured. */
	estimatedSavings: number;
	contextWindow: number;
	reserveTokens: number;
	/** Fraction of estimated savings credited (uncertainty discount), 0..1. */
	savingsFactor: number;
	/** Extra tokens kept free below Pi's threshold. */
	marginTokens: number;
}

export interface HeadroomResult {
	predictedTokens: number;
	budgetTokens: number;
	fits: boolean;
}

/**
 * Predict the context size after applying new drops, from Pi's own observation minus a
 * discounted estimate of the savings, and compare against a budget below Pi's threshold.
 */
export function evaluateHeadroom(input: HeadroomInput): HeadroomResult {
	const credited = Math.max(0, input.estimatedSavings) * Math.min(1, Math.max(0, input.savingsFactor));
	const predictedTokens = Math.max(0, Math.ceil(input.tokensBefore - credited));
	const budgetTokens = input.contextWindow - input.reserveTokens - input.marginTokens;
	return { predictedTokens, budgetTokens, fits: budgetTokens > 0 && predictedTokens <= budgetTokens };
}
