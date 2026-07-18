/**
 * Coerces a caller/config-supplied token count to a positive integer.
 *
 * The rule is shared by Consultation and output policy, so it belongs in a
 * neutral policy Module rather than either caller's implementation.
 */
export function coercePositiveTokens(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}
