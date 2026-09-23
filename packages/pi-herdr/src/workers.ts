/**
 * Worker candidates for `herdr_select` and model-identity normalization.
 *
 * The candidate list is the user's approved set (2026-09-23): Pi + gpt-6-sol and
 * Claude Code + Opus 5.5 are the preferred defaults for most work, including easy
 * work; the others are additional options. Launch IDs were checked against the
 * installed Pi catalog (`pi --list-models`) and Claude Code 2.1.280. Preferences
 * are supplied to Jev as user preferences, not benchmarks.
 */

export type Harness = "pi" | "claude-code";
export type QuotaGroupId = "codex" | "claude" | "zai";
export type ModelFamily = "openai" | "anthropic" | "zai";

export interface WorkerCandidate {
	/** Choice option key (Jev never sees question ids, but it does see option keys). */
	id: string;
	harness: Harness;
	/** Exact ID for the harness's --model flag. */
	launchModel: string;
	/** Pi catalog entry describing the same model (capabilities; availability for Pi). */
	catalog: { provider: string; id: string };
	family: ModelFamily;
	quotaGroup: QuotaGroupId;
	/** Token naming a Claude model-scoped weekly window, e.g. "Weekly (Fable)". */
	scopedWindowToken?: string;
	preference: string;
}

export const WORKER_CANDIDATES: readonly WorkerCandidate[] = [
	{
		id: "pi_gpt_6_sol", harness: "pi", launchModel: "openai-codex/gpt-6-sol",
		catalog: { provider: "openai-codex", id: "gpt-6-sol" }, family: "openai", quotaGroup: "codex",
		preference: "User-preferred default for most work, including easy work.",
	},
	{
		id: "claude_code_opus_5_5", harness: "claude-code", launchModel: "claude-opus-5-5",
		catalog: { provider: "anthropic", id: "claude-opus-5-5" }, family: "anthropic", quotaGroup: "claude",
		scopedWindowToken: "opus",
		preference: "User-preferred default for most work, including easy work.",
	},
	{
		id: "claude_code_fable_5_1", harness: "claude-code", launchModel: "claude-fable-5-1",
		catalog: { provider: "anthropic", id: "claude-fable-5-1" }, family: "anthropic", quotaGroup: "claude",
		scopedWindowToken: "fable",
		preference: "User-approved additional option; the user prefers it for hard work.",
	},
	{
		id: "pi_gpt_6_astra", harness: "pi", launchModel: "openai-codex/gpt-6-astra",
		catalog: { provider: "openai-codex", id: "gpt-6-astra" }, family: "openai", quotaGroup: "codex",
		preference: "User-approved additional option.",
	},
	{
		id: "pi_glm_5_3", harness: "pi", launchModel: "zai/glm-5.3",
		catalog: { provider: "zai", id: "glm-5.3" }, family: "zai", quotaGroup: "zai",
		preference: "User-approved additional option.",
	},
	{
		id: "pi_glm_5_3_flash", harness: "pi", launchModel: "zai/glm-5.3-flash",
		catalog: { provider: "zai", id: "glm-5.3-flash" }, family: "zai", quotaGroup: "zai",
		preference: "User-approved additional option; the user's vision-capable GLM choice.",
	},
];

export const HARNESS_LABEL: Record<Harness, string> = { pi: "Pi", "claude-code": "Claude Code" };
export const FAMILY_LABEL: Record<ModelFamily, string> = { openai: "OpenAI", anthropic: "Anthropic", zai: "Z.ai GLM" };

export function launchArgv(candidate: WorkerCandidate): string[] {
	return [candidate.harness === "pi" ? "pi" : "claude", "--model", candidate.launchModel];
}

// ---------------------------------------------------------------------------
// Model identity
// ---------------------------------------------------------------------------

const VENDOR_FAMILY: Record<string, ModelFamily> = {
	anthropic: "anthropic", claude: "anthropic",
	openai: "openai", codex: "openai", chatgpt: "openai",
	zai: "zai",
};
const MODEL_FAMILY: Record<string, ModelFamily> = {
	opus: "anthropic", fable: "anthropic", sonnet: "anthropic", haiku: "anthropic",
	gpt: "openai",
	glm: "zai",
};
const NOISE = new Set(["latest"]);

export interface ModelIdentity {
	/** Original label, control characters removed and bounded. */
	label: string;
	/** Tokens with provider prefixes, vendor words, dates and suffixes removed. */
	tokens: string[];
	key: string;
	family?: ModelFamily;
}

export function sanitizeLabel(value: string, max = 120): string {
	return value.replace(/[\x00-\x1f\x7f]/gu, " ").trim().slice(0, max);
}

/**
 * Harness- and provider-independent identity: "openai-codex/gpt-6-sol",
 * "openrouter/openai/gpt-6-sol:batch" and "GPT 6 Sol" share one key, and
 * "claude-opus-5-5[1m]", "anthropic/claude-opus-5.5" and "Opus 5.5" another.
 */
export function modelIdentity(raw: string): ModelIdentity {
	const label = sanitizeLabel(raw);
	let text = label.toLowerCase().replace(/\[[^\]]*\]$/u, "");
	const segments = text.split("/");
	text = (segments.pop() ?? "").replace(/:[^:]*$/u, "").replace(/^~/u, "");
	let family: ModelFamily | undefined;
	for (const word of [...segments.join(" ").split(/[\s._-]+/u), ...text.split(/[\s._-]+/u)]) {
		family ??= VENDOR_FAMILY[word];
	}
	const tokens = text
		.replace(/([a-z])(\d)/gu, "$1-$2")
		.replace(/(\d)([a-z])/gu, "$1-$2")
		.split(/[\s._-]+/u)
		.filter((token) => token.length > 0 && !NOISE.has(token) && !(token in VENDOR_FAMILY) && !/^\d{8}$/u.test(token));
	for (const token of tokens) family ??= MODEL_FAMILY[token] ?? (/^o\d/u.test(token) ? "openai" : undefined);
	return { label, tokens, key: tokens.join("-"), ...(family ? { family } : {}) };
}

export type SameModel = "same" | "possibly" | "different";

/**
 * Compare a supplied label against a concrete model. Known distinct catalog
 * models compare as different; an incomplete or unrecognized alias that could
 * name the target ("opus", "claude-latest", "sol", "gpt-6-sol-high") compares as
 * possibly the same, so a bare alias cannot bypass independence exclusion.
 */
export function compareModels(
	supplied: ModelIdentity,
	target: ModelIdentity,
	knownKeys: ReadonlySet<string>,
): SameModel {
	if (supplied.key.length > 0 && supplied.key === target.key) return "same";
	if (knownKeys.has(supplied.key)) return "different";
	if (supplied.tokens.length === 0) {
		return supplied.family !== undefined && supplied.family === target.family ? "possibly" : "different";
	}
	const subset = supplied.tokens.some((token) => !/^\d+$/u.test(token)) &&
		supplied.tokens.every((token) => target.tokens.includes(token));
	const extended = target.tokens.length > 0 && target.tokens.every((token, index) => supplied.tokens[index] === token);
	return subset || extended ? "possibly" : "different";
}
