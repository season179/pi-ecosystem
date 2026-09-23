import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { ClaudeQuotaSnapshot } from "../src/claude-quota.js";
import { createJevOpener, JevError, type JevSession } from "../src/jev.js";
import {
	runSelection,
	SelectCancelledError,
	type SelectDeps,
	type SelectEnvironment,
	type SelectRequest,
} from "../src/select.js";
import type { QuotaSnapshot } from "../src/types.js";
import { compareModels, modelIdentity } from "../src/workers.js";
import type { ZaiQuotaSnapshot } from "../src/zai-quota.js";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 3_600_000;
const IMAGE = ["text", "image"] as const;
const CATALOG: Record<string, readonly string[]> = {
	"openai-codex/gpt-6-sol": IMAGE,
	"openai-codex/gpt-6-astra": IMAGE,
	"openai-codex/gpt-5.6-sol": IMAGE,
	"anthropic/claude-opus-5-5": IMAGE,
	"anthropic/claude-opus-5": IMAGE,
	"anthropic/claude-fable-5-1": IMAGE,
	"zai/glm-5.3": ["text"],
	"zai/glm-5.3-flash": IMAGE,
};
const ALL_WORKERS = ["pi_gpt_6_sol", "claude_code_opus_5_5", "claude_code_fable_5_1", "pi_gpt_6_astra", "pi_glm_5_3", "pi_glm_5_3_flash"];

function environment(overrides: Partial<SelectEnvironment> = {}): SelectEnvironment {
	return {
		orchestrator: { provider: "openai-codex", id: "gpt-6-sol", input: IMAGE },
		contextUsage: { tokens: 50_000, contextWindow: 272_000, percent: 18.38 },
		lookupModel: (provider, id) => {
			const input = CATALOG[`${provider}/${id}`];
			return input ? { input, authConfigured: true } : undefined;
		},
		knownModels: Object.keys(CATALOG),
		harnessInstalled: () => true,
		...overrides,
	};
}

function codex(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
	return {
		checkedAt: iso(0), allowed: true, limitReached: false,
		primary: { usedPercent: 10, windowSeconds: 18_000, resetAfterSeconds: 1_800 },
		secondary: { usedPercent: 30, windowSeconds: 604_800, resetAfterSeconds: 6 * 3_600 },
		...overrides,
	};
}

function claude(windows?: ClaudeQuotaSnapshot["windows"]): ClaudeQuotaSnapshot {
	return {
		checkedAt: iso(0),
		windows: windows ?? [
			{ label: "5h", usedPercent: 20, resetsAt: iso(2 * HOUR) },
			{ label: "Weekly", usedPercent: 40, resetsAt: iso(72 * HOUR) },
			{ label: "Weekly (Fable)", usedPercent: 50, resetsAt: iso(72 * HOUR) },
		],
	};
}

function zai(usedPercent = 5): ZaiQuotaSnapshot {
	return {
		checkedAt: iso(0),
		windows: [
			{ type: "TOKENS_LIMIT", label: "Coding (5 hours)", usedPercent, resetsAt: iso(HOUR), windowSeconds: 18_000 },
			{ type: "TIME_LIMIT", label: "MCP calls (monthly)", usedPercent: 0, resetsAt: null },
		],
	};
}

/** Choice answer that puts `p` on `pick` and spreads the rest evenly. */
function choice(labels: string[], pick: string, p = 0.7) {
	const rest = (1 - p) / (labels.length - 1);
	return {
		type: "choice", choice: pick, confidence: 0.5,
		probabilities: Object.fromEntries(labels.map((label) => [label, label === pick ? p : rest])),
	};
}

interface Ask { state: any; questions: Record<string, any> }

function fakeJev(allocate: (options: string[], state: any) => unknown, profile?: (questions: Record<string, any>) => Record<string, unknown>) {
	const asks: Ask[] = [];
	const session: JevSession = {
		model: "jev-test",
		async ask(state, questions) {
			asks.push({ state, questions: questions as Record<string, any> });
			if (questions.allocation) {
				const labels = Object.keys((questions.allocation as any).criteria);
				return { model: "jev-1.13.0", answers: { allocation: allocate(labels, state) }, usage: { inputTokens: 900, outputTokens: 20 } };
			}
			return {
				model: "jev-1.13.0",
				answers: profile?.(questions as Record<string, any>) ?? {
					difficulty: choice(["easy", "medium", "hard", "insufficient_context"], "easy", 0.9),
					quick_inline: { type: "noul", noul: 0.2 },
					...(questions.visual ? { visual: { type: "noul", noul: 0.05 } } : {}),
				},
				usage: { inputTokens: 400, outputTokens: 30 },
			};
		},
	};
	return { asks, openJev: async () => session };
}

function deps(openJev: SelectDeps["openJev"], overrides: Partial<SelectDeps> = {}): SelectDeps {
	return {
		openJev,
		fetchCodexQuota: async () => codex(),
		fetchClaudeQuota: async () => claude(),
		fetchZaiQuota: async () => zai(),
		now: () => NOW,
		...overrides,
	};
}

const TASK: SelectRequest = { task: "Fix a typo in packages/pi-herdr/README.md and run the package tests." };
const excludedIds = (result: Awaited<ReturnType<typeof runSelection>>) =>
	result.options.filter((option) => option.status === "excluded").map((option) => option.option).sort();

describe("herdr_select selection", () => {
	it("feeds the Jev profile into allocation and maps Jev's premium pick for easy work to a launch", async () => {
		const jev = fakeJev((labels) => choice(labels, "claude_code_opus_5_5", 0.55));
		const result = await runSelection(TASK, environment(), deps(jev.openJev));
		assert.equal(result.outcome, "selected");
		assert.equal(result.decidedBy, "jev");
		assert.deepEqual(result.selection, {
			option: "claude_code_opus_5_5", harness: "claude-code", model: "claude-opus-5-5",
			launch: ["claude", "--model", "claude-opus-5-5"],
		});
		assert.equal(jev.asks.length, 2);
		const [profile, allocation] = jev.asks;
		assert.ok(profile!.questions.visual);
		// Profile probabilities, exact quota arithmetic and every valid pair reach allocation.
		assert.equal(allocation!.state.profile.difficulty.easy, 0.9);
		assert.equal(allocation!.state.profile.quickInlineProbability, 0.2);
		assert.deepEqual(Object.keys(allocation!.questions.allocation.criteria).sort(),
			["inline", ...ALL_WORKERS, "cannot_select", "needs_context"].sort());
		const primary = allocation!.state.quotaGroups.codex.windows[0];
		// Jev is weak at arithmetic, so code supplies exact interval facts.
		assert.deepEqual([primary.remainingPercent, primary.resetsAt], [90, iso(30 * 60_000)]);
		assert.deepEqual(allocation!.state.options.claude_code_fable_5_1.quota.windows, ["5h", "Weekly", "Weekly (Fable)"]);
		assert.deepEqual(allocation!.state.options.claude_code_opus_5_5.quota.windows, ["5h", "Weekly"]);
	});

	it("offers every candidate when all subscriptions are scarce but not empty, and keeps Jev's inline pick", async () => {
		const jev = fakeJev((labels) => choice(labels, "inline", 0.4));
		const result = await runSelection(TASK, environment(), deps(jev.openJev, {
			fetchCodexQuota: async () => codex({ primary: { usedPercent: 97, windowSeconds: 18_000, resetAfterSeconds: 9_000 } }),
			fetchClaudeQuota: async () => claude([{ label: "5h", usedPercent: 99, resetsAt: iso(4 * HOUR) }]),
			fetchZaiQuota: async () => zai(98),
		}));
		assert.deepEqual(excludedIds(result), []);
		assert.equal(result.outcome, "selected");
		assert.deepEqual(result.selection, { option: "inline", harness: "inline", model: "openai-codex/gpt-6-sol" });
	});

	it("excludes only candidates bound to an exhausted window; missing and unmatched windows stay unknown", async () => {
		const jev = fakeJev((labels) => choice(labels, "pi_glm_5_3"));
		const result = await runSelection(TASK, environment(), deps(jev.openJev, {
			fetchCodexQuota: async () => codex({ allowed: false, limitReached: true }),
			fetchClaudeQuota: async () => claude([
				{ label: "Weekly", usedPercent: 60, resetsAt: iso(HOUR) },
				{ label: "Weekly (Fable)", usedPercent: 100, resetsAt: iso(HOUR) },
				{ label: "Weekly (Sonnet)", usedPercent: 100, resetsAt: iso(HOUR) },
				{ label: "5h", usedPercent: 100, resetsAt: iso(-60_000) },
			]),
			fetchZaiQuota: async () => { throw new Error("Z.ai quota check timed out after 10000ms"); },
		}));
		assert.deepEqual(excludedIds(result), ["claude_code_fable_5_1", "pi_gpt_6_astra", "pi_gpt_6_sol"]);
		assert.deepEqual(Object.keys(jev.asks[1]!.state.options).sort(), ["claude_code_opus_5_5", "inline", "pi_glm_5_3", "pi_glm_5_3_flash"]);
		assert.equal(result.outcome, "selected");
	});

	it("requires provenance for independent evaluation and reports it without calling Jev", async () => {
		const jev = fakeJev(() => assert.fail("no allocation expected"));
		const result = await runSelection({ ...TASK, purpose: "review" }, environment(), deps(jev.openJev));
		assert.equal(result.outcome, "needs_context");
		assert.equal(result.decidedBy, "code");
		assert.deepEqual(result.missing, ["provenance"]);
		assert.equal(jev.asks.length, 0);
		assert.equal(result.failure, undefined);
	});

	it("excludes the same model across harnesses and aliases, including inline", async () => {
		const jev = fakeJev((labels) => choice(labels, "pi_gpt_6_sol"));
		const orchestrator = { provider: "anthropic", id: "claude-opus-5-5", input: IMAGE };
		const result = await runSelection({ ...TASK, purpose: "review", provenance: ["Opus 5.5"] },
			environment({ orchestrator }), deps(jev.openJev));
		assert.deepEqual(excludedIds(result), ["claude_code_opus_5_5", "inline"]);

		const bare = fakeJev((labels) => choice(labels, "pi_glm_5_3"));
		const ambiguous = await runSelection({ ...TASK, purpose: "debate", provenance: ["claude-latest", "sol"] },
			environment(), deps(bare.openJev));
		assert.deepEqual(excludedIds(ambiguous), ["claude_code_fable_5_1", "claude_code_opus_5_5", "inline", "pi_gpt_6_sol"]);
	});

	it("does not exclude a known distinct model, and passes unknown provenance to Jev as unknown", async () => {
		const jev = fakeJev((labels) => choice(labels, "pi_gpt_6_sol"));
		const result = await runSelection({ ...TASK, purpose: "review", provenance: ["openai-codex/gpt-5.6-sol"] },
			environment(), deps(jev.openJev));
		assert.deepEqual(excludedIds(result), []);

		const unknown = fakeJev((labels) => choice(labels, "claude_code_opus_5_5"));
		const unknownResult = await runSelection({ ...TASK, purpose: "review", provenanceUnknown: true }, environment(), deps(unknown.openJev));
		assert.equal(unknownResult.outcome, "selected");
		assert.match(unknown.asks[1]!.state.provenance, /^unknown/);
	});

	it("respects supplied vision metadata and explicit user restrictions as hard constraints", async () => {
		const jev = fakeJev((labels) => choice(labels, "pi_glm_5_3_flash"));
		const result = await runSelection({ ...TASK, requiresVision: true, allowedOptions: ["inline", "pi_glm_5_3", "pi_glm_5_3_flash"] },
			environment({ orchestrator: { provider: "zai", id: "glm-5.3", input: ["text"] } }), deps(jev.openJev));
		assert.equal(jev.asks[0]!.questions.visual, undefined);
		assert.deepEqual(Object.keys(jev.asks[1]!.state.options), ["pi_glm_5_3_flash"]);
		assert.equal(result.selection?.model, "zai/glm-5.3-flash");
		await assert.rejects(runSelection({ ...TASK, allowedOptions: ["gpt-7"] }, environment(), deps(jev.openJev)), /unknown allowedOptions gpt-7/);
	});

	it("returns cannot_select as a valid non-overridable answer", async () => {
		const jev = fakeJev((labels) => choice(labels, "cannot_select", 0.5));
		const result = await runSelection(TASK, environment(), deps(jev.openJev));
		assert.equal(result.outcome, "cannot_select");
		assert.equal(result.decidedBy, "jev");
		assert.equal(result.failure, undefined);

		const none = await runSelection({ ...TASK, allowedOptions: ["pi_glm_5_3"], requiresVision: true }, environment(), deps(jev.openJev));
		assert.equal(none.outcome, "cannot_select");
		assert.equal(none.decidedBy, "code");
	});

	it("fails with override permission on malformed or out-of-set Jev answers", async () => {
		// Jev picks a candidate code already excluded.
		const excluded = await runSelection({ ...TASK, allowedOptions: ["inline"] }, environment(), deps(
			fakeJev((labels) => choice([...labels, "pi_gpt_6_sol"], "pi_gpt_6_sol")).openJev));
		const badProfile = fakeJev(() => assert.fail("no allocation"), () => ({ difficulty: { type: "choice", choice: "trivial" } }));
		for (const result of [excluded, await runSelection(TASK, environment(), deps(badProfile.openJev))]) {
			assert.equal(result.outcome, "failed");
			assert.equal(result.failure?.reason, "invalid_response");
			assert.equal(result.failure?.overrideAllowed, true);
			assert.equal(result.selection, undefined);
		}
	});

	it("rethrows cancellation, and turns an ignored-abort hang into a bounded timeout failure", async () => {
		const hanging: JevSession = { model: "jev-test", ask: () => new Promise(() => {}) };
		const controller = new AbortController();
		const pending = runSelection(TASK, environment(), deps(async () => hanging), controller.signal);
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(pending, SelectCancelledError);

		const slowQuota = vi.fn((signal: AbortSignal) => new Promise<QuotaSnapshot>((_, reject) =>
			signal.addEventListener("abort", () => reject(new Error("Codex usage request cancelled")), { once: true })));
		const timed = await runSelection(TASK, environment(), deps(async () => hanging, { deadlineMs: 30, fetchCodexQuota: slowQuota }));
		assert.equal(timed.outcome, "failed");
		assert.equal(timed.failure?.reason, "timeout");
		// The in-flight quota check was released, not left running.
		assert.equal((slowQuota.mock.calls[0]![0] as AbortSignal).aborted, true);
	});
});

describe("model identity", () => {
	it("matches harness/provider/suffix aliases, flags partial aliases, and keeps catalog siblings distinct", () => {
		const known = new Set(Object.keys(CATALOG).map((model) => modelIdentity(model).key));
		const compare = (a: string, b: string) => compareModels(modelIdentity(a), modelIdentity(b), known);
		assert.equal(compare("openrouter/openai/gpt-6-sol:batch", "openai-codex/gpt-6-sol"), "same");
		assert.equal(compare("claude-opus-5-5[1m]", "anthropic/claude-opus-5-5"), "same");
		assert.equal(compare("gpt-6-sol-high", "openai-codex/gpt-6-sol"), "possibly");
		assert.equal(compare("zai/glm-5.3", "zai/glm-5.3-flash"), "different");
	});
});

describe("Jev transport", () => {
	const KEY = "ts-private-test-key";
	let dir: string;
	const originalKey = process.env.TYPESAFE_API_KEY;
	const originalBase = process.env.TYPESAFE_BASE_URL;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-herdr-jev-"));
		delete process.env.TYPESAFE_API_KEY;
		process.env.TYPESAFE_BASE_URL = "https://attacker.example";
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
		if (originalBase === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = originalBase;
	});

	const configure = () => {
		writeFileSync(join(dir, "typesafe.json"), JSON.stringify({ model: "jev-1.13.0", timeoutMs: 2000, apiKeyFile: "typesafe.key", memory: { enabled: true } }));
		writeFileSync(join(dir, "typesafe.key"), `${KEY}\n`);
	};

	it("reads the shared config and key file, pins the official endpoint and retries at most once", async () => {
		configure();
		const calls: Array<{ url: string; auth: string | null; body: any }> = [];
		const fetch = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
			return new Response(`{"error":"overloaded ${KEY}"}`, { status: 529 });
		});
		const session = await createJevOpener({ agentDir: dir, fetch })(new AbortController().signal);
		const error = await session.ask({ a: 1 }, { q: { type: "noul", instructions: "?" } }, new AbortController().signal).catch((e) => e);
		assert.ok(error instanceof JevError);
		assert.equal(error.reason, "service");
		assert.ok(!error.message.includes(KEY));
		assert.equal(calls.length, 2);
		assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
		assert.equal(calls[0]!.auth, `Bearer ${KEY}`);
		assert.equal(calls[0]!.body.model, "jev-1.13.0");
	});
});
