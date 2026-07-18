/**
 * Per-source output-length control for buddy consultations.
 *
 * Automatic watchdog/run-end reviews want tight verdicts (a headline plus the
 * evidence to act); requested consults legitimately need more room. This module
 * maps a consultation's source + stance to a hard output-token cap and a soft
 * brevity request, honoring per-source overrides from buddy.json.
 *
 * The 2048/4096 defaults are guesses ported (as patterns, not magnitudes) from
 * Anthropic's advisor-tool findings; they are revisited against the `truncated`
 * telemetry after real usage (see PLAN §10.12). Kept pure and pi-free so the
 * source/stance mapping is unit-testable.
 */

import { coercePositiveTokens } from "./consult.js";
import type { BuddySource } from "./telemetry.js";

/**
 * Optional per-source-class hard caps from buddy.json. A field may be:
 * - a positive integer → override the default cap for that source class,
 * - `null` → disable the hard cap for that source class (soft target stays),
 * - absent → use the built-in default.
 * `watchdog` covers watchdog + run-end reviews; `consult` covers tool +
 * command consults.
 */
export interface OutputMaxTokensConfig {
	watchdog?: number | null;
	consult?: number | null;
}

export interface BuddyOutputControl {
	/** Hard cap on visible output per model call; omitted when disabled. */
	maxTokens?: number;
	/** Soft brevity request appended after the request text; omitted for none. */
	softTargetLine?: string;
}

/** Default visible-output cap for automatic watchdog/run-end reviews. */
export const WATCHDOG_DEFAULT_MAX_TOKENS = 2048;
/** Default visible-output cap for requested tool/command consults. */
export const CONSULT_DEFAULT_MAX_TOKENS = 4096;

const WATCHDOG_SOFT_TARGET =
	"(Keep your verdict tight: use the structured verdict tool with a one-line headline plus only the evidence needed to act — aim under ~200 words.)";
const DISCUSS_DEBATE_SOFT_TARGET =
	"(Buddy: aim for under ~350 words — focused guidance, not a comprehensive essay.)";
const REVIEW_SOFT_TARGET =
	"(Buddy: aim for under ~300 words — findings ordered by severity, not review prose.)";

/**
 * Resolves the output control for a consultation. `source === "watchdog"`
 * covers both the turn-threshold watchdog and the run-end review; every other
 * source is a requested consult keyed by stance.
 */
export function buddyOutputControl(args: {
	source: BuddySource;
	stance: string;
	config?: OutputMaxTokensConfig;
}): BuddyOutputControl {
	const isWatchdog = args.source === "watchdog";
	const configured = isWatchdog ? args.config?.watchdog : args.config?.consult;
	const fallback = isWatchdog
		? WATCHDOG_DEFAULT_MAX_TOKENS
		: CONSULT_DEFAULT_MAX_TOKENS;
	const maxTokens = resolveMaxTokens(configured, fallback);
	const softTargetLine = isWatchdog
		? WATCHDOG_SOFT_TARGET
		: consultSoftTarget(args.stance);
	return { maxTokens, softTargetLine };
}

function resolveMaxTokens(
	configured: number | null | undefined,
	fallback: number,
): number | undefined {
	// Explicit null disables the hard cap for this source class.
	if (configured === null) return undefined;
	// A positive override wins; absent (or dropped-as-invalid by the config
	// parser) falls back to the built-in default.
	return coercePositiveTokens(configured) ?? fallback;
}

function consultSoftTarget(stance: string): string | undefined {
	switch (stance) {
		case "discuss":
		case "debate":
			return DISCUSS_DEBATE_SOFT_TARGET;
		case "review":
			return REVIEW_SOFT_TARGET;
		// fact_check: per-claim length is inherently variable — no soft target.
		default:
			return undefined;
	}
}
