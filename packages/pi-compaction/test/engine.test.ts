import { describe, expect, it } from "vitest";
import { charsPerFourEstimator, estimateMessages, evaluateHeadroom } from "../src/engine/estimate.js";
import { DEFAULT_PAIR_DROPPABLE_TOOLS, decide, requestedAction } from "../src/engine/policy.js";
import { isSensitivePath, redactSecrets } from "../src/engine/redact.js";
import { buildSkeleton } from "../src/engine/skeleton.js";
import { PLACEHOLDER_MARKER, applyDecisions, reconcileDecisions } from "../src/engine/transform.js";
import type { Candidate, Decision } from "../src/engine/types.js";
import { collectCandidates } from "../src/engine/candidates.js";
import { parseConfig } from "../src/adapter/config.js";
import { MODE_ENTRY, PASS_ENTRY, PIN_ENTRY, SCOPE_ENTRY, activeDecisions, decidedIds, restoreState, restoreStateAt } from "../src/adapter/state.js";
import { indexArchive, listArchive, readArchive, searchArchive } from "../src/adapter/recall.js";
import { currentObservationId, hasChildren, passFingerprint } from "../src/adapter/pressure.js";
import { assistant, singleTaskTranscript, toolResult, user, withIds } from "./helpers/messages.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { apiRates } from "../src/extensions/compaction.js";

function decision(toolCallId: string, requested: Decision["requested"], extra: Partial<Decision> = {}): Decision {
	return { toolCallId, resultEntryId: `r-${toolCallId}`, toolName: "read", resultChars: 500, requested, effective: requested, ...extra };
}

describe("applyDecisions", () => {
	it("replaces a result body with a shorter placeholder that names the archive id", () => {
		const messages = [user("go"), assistant({ calls: [{ id: "a", name: "read" }] }), toolResult("a", "read", "x".repeat(500)), assistant({ text: "ok" })];
		const result = applyDecisions(messages, new Map([["a", decision("a", "drop_result")]]));
		expect(result.replaced).toEqual(["a"]);
		expect(result.dropped).toEqual([]);
		const replaced = result.messages[2];
		expect(replaced.role).toBe("toolResult");
		if (replaced.role !== "toolResult") throw new Error("unreachable");
		const text = replaced.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain(PLACEHOLDER_MARKER);
		expect(text).toContain("r-a");
		expect(text.length).toBeLessThan(500);
		expect(result.messages).toHaveLength(4);
	});

	it("keeps a tiny result instead of a longer placeholder", () => {
		const messages = [user("go"), assistant({ calls: [{ id: "a", name: "read" }] }), toolResult("a", "read", "ok"), assistant({ text: "done" })];
		const result = applyDecisions(messages, new Map([["a", decision("a", "drop_result", { resultChars: 2 })]]));
		expect(result.replaced).toEqual([]);
		expect(result.messages[2]).toBe(messages[2]);
	});

	it("removes call and result together for drop_pair and never orphans a result", () => {
		const messages = [user("go"), assistant({ calls: [{ id: "a", name: "read" }] }), toolResult("a", "read", "x".repeat(500)), assistant({ text: "ok" })];
		const result = applyDecisions(messages, new Map([["a", decision("a", "drop_pair")]]));
		expect(result.dropped).toEqual(["a"]);
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		for (const message of result.messages) {
			if (message.role === "toolResult") throw new Error("orphaned tool result");
		}
	});

	it("keeps the assistant message when only some of its calls are dropped", () => {
		const messages = [
			user("go"),
			assistant({ calls: [{ id: "a", name: "read" }, { id: "b", name: "read" }] }),
			toolResult("a", "read", "x".repeat(500)),
			toolResult("b", "read", "y".repeat(500)),
			assistant({ text: "ok" }),
		];
		const result = applyDecisions(messages, new Map([["a", decision("a", "drop_pair")]]));
		expect(result.dropped).toEqual(["a"]);
		const call = result.messages[1];
		if (call.role !== "assistant") throw new Error("unreachable");
		expect(call.content.filter((block) => block.type === "toolCall").map((block) => (block.type === "toolCall" ? block.id : ""))).toEqual(["b"]);
		expect(result.messages.filter((message) => message.role === "toolResult").map((message) => (message.role === "toolResult" ? message.toolCallId : ""))).toEqual(["b"]);
	});

	it("treats a thinking-bearing assistant message atomically (Codex signed reasoning)", () => {
		const messages = [
			user("go"),
			assistant({ thinking: "let me look", calls: [{ id: "a", name: "read" }, { id: "b", name: "read" }] }),
			toolResult("a", "read", "x".repeat(500)),
			toolResult("b", "read", "y".repeat(500)),
			assistant({ text: "ok" }),
		];
		// Partial removal must downgrade to a result replacement so the reasoning item keeps every function_call.
		const partial = applyDecisions(messages, new Map([["a", decision("a", "drop_pair")]]));
		expect(partial.dropped).toEqual([]);
		expect(partial.replaced).toEqual(["a"]);
		expect(partial.downgraded).toEqual([{ toolCallId: "a", reason: "provider_atomic" }]);
		// Dropping every call with no text removes the whole message, reasoning included.
		const whole = applyDecisions(messages, new Map([["a", decision("a", "drop_pair")], ["b", decision("b", "drop_pair")]]));
		expect(whole.dropped).toEqual(["a", "b"]);
		expect(whole.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("downgrades when a whole-message removal would leave two user messages adjacent", () => {
		const messages = [user("go"), assistant({ calls: [{ id: "a", name: "read" }] }), toolResult("a", "read", "x".repeat(500)), user("next"), assistant({ text: "ok" })];
		const result = applyDecisions(messages, new Map([["a", decision("a", "drop_pair")]]));
		expect(result.dropped).toEqual([]);
		expect(result.replaced).toEqual(["a"]);
		expect(result.downgraded[0]?.reason).toBe("provider_atomic");
	});

	it("pins override decisions", () => {
		const messages = [user("go"), assistant({ calls: [{ id: "a", name: "read" }] }), toolResult("a", "read", "x".repeat(500)), assistant({ text: "ok" })];
		const result = applyDecisions(messages, new Map([["a", decision("a", "drop_pair")]]), new Set(["a"]));
		expect(result.replaced).toEqual([]);
		expect(result.dropped).toEqual([]);
		expect(result.messages).toEqual(messages);
	});

	it("leaves every message intact when a committed id has become ambiguous or unmatched in the live list", () => {
		const committed = new Map([["a", decision("a", "drop_pair")], ["b", decision("b", "drop_result")], ["c", decision("c", "drop_pair")]]);
		// "a": the same id now appears in two calls; "b": two results share the id; "c": result missing.
		const messages = [
			user("go"),
			assistant({ calls: [{ id: "a", name: "read" }] }),
			toolResult("a", "read", "x".repeat(500)),
			assistant({ calls: [{ id: "a", name: "read" }, { id: "b", name: "read" }, { id: "c", name: "read" }] }),
			toolResult("a", "read", "y".repeat(500)),
			toolResult("b", "read", "z".repeat(500)),
			toolResult("b", "read", "w".repeat(500)),
			assistant({ text: "ok" }),
		];
		const result = applyDecisions(messages, committed);
		expect(result.messages).toEqual(messages);
		expect(result.replaced).toEqual([]);
		expect(result.dropped).toEqual([]);
		expect(result.unmatched).toEqual(expect.arrayContaining([
			{ toolCallId: "a", reason: "ambiguous" },
			{ toolCallId: "b", reason: "ambiguous" },
			{ toolCallId: "c", reason: "incomplete" },
		]));
		// An unambiguous sibling in the same message is still applied.
		const withOk = [...messages.slice(0, 3), assistant({ calls: [{ id: "a", name: "read" }, { id: "d", name: "read" }] }), toolResult("a", "read", "y".repeat(500)), toolResult("d", "read", "q".repeat(500)), assistant({ text: "ok" })];
		const partial = applyDecisions(withOk, new Map([["a", decision("a", "drop_pair")], ["d", decision("d", "drop_result")]]));
		expect(partial.dropped).toEqual([]);
		expect(partial.replaced).toEqual(["d"]);
		expect(partial.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "a")).toHaveLength(2);
		// Reconcile reports the protection so a pass never persists a drop it could not apply.
		const reconciled = reconcileDecisions(messages, [decision("a", "drop_pair")], new Set());
		expect(reconciled[0]).toMatchObject({ effective: "keep", downgradeReason: "ambiguous" });
	});

	it("reconcileDecisions records the effective action for persistence", () => {
		const messages = [user("go"), assistant({ thinking: "t", calls: [{ id: "a", name: "read" }, { id: "b", name: "read" }] }), toolResult("a", "read", "x".repeat(500)), toolResult("b", "read", "y".repeat(500)), assistant({ text: "ok" })];
		const reconciled = reconcileDecisions(messages, [decision("a", "drop_pair"), decision("b", "keep")], new Set());
		expect(reconciled[0]).toMatchObject({ toolCallId: "a", requested: "drop_pair", effective: "drop_result", downgradeReason: "provider_atomic" });
		expect(reconciled[1]).toMatchObject({ toolCallId: "b", effective: "keep" });
	});
});

describe("policy", () => {
	const candidate = (toolName: string): Candidate => ({ toolCallId: "c", resultEntryId: "r", callEntryId: "a", shortId: "t1", toolName, arguments: {}, resultChars: 100, isError: false, callIndex: 1, resultIndex: 2, turnIndex: 0 });
	it("maps probabilities to actions", () => {
		expect(requestedAction({ keepCall: 0.9, keepResult: 0.9 }, 0.35)).toBe("keep");
		expect(requestedAction({ keepCall: 0.9, keepResult: 0.1 }, 0.35)).toBe("drop_result");
		expect(requestedAction({ keepCall: 0.1, keepResult: 0.1 }, 0.35)).toBe("drop_pair");
		expect(requestedAction({ keepCall: 0.1, keepResult: 0.9 }, 0.35)).toBe("keep");
	});
	it("downgrades pair drops for tools with side effects and keeps on invalid scores", () => {
		const options = { keepThreshold: 0.35, pairDroppableTools: DEFAULT_PAIR_DROPPABLE_TOOLS };
		expect(decide(candidate("bash"), { keepCall: 0.1, keepResult: 0.1 }, options)).toMatchObject({ requested: "drop_result", downgradeReason: "unsupported" });
		expect(decide(candidate("read"), { keepCall: 0.1, keepResult: 0.1 }, options)).toMatchObject({ requested: "drop_pair" });
		expect(decide(candidate("read"), undefined, options)).toMatchObject({ requested: "keep", effective: "keep" });
		expect(decide(candidate("read"), { keepCall: Number.NaN, keepResult: 0.1 }, options)).toMatchObject({ requested: "keep" });
	});
});

describe("estimate", () => {
	it("predicts headroom with a discounted savings estimate", () => {
		expect(evaluateHeadroom({ tokensBefore: 100_000, estimatedSavings: 30_000, contextWindow: 128_000, reserveTokens: 16_384, savingsFactor: 0.8, marginTokens: 7_000 })).toMatchObject({ predictedTokens: 76_000, budgetTokens: 104_616, fits: true });
		expect(evaluateHeadroom({ tokensBefore: 120_000, estimatedSavings: 5_000, contextWindow: 128_000, reserveTokens: 16_384, savingsFactor: 0.8, marginTokens: 7_000 }).fits).toBe(false);
	});
	it("estimates messages by characters", () => {
		expect(estimateMessages([toolResult("a", "read", "x".repeat(400))], charsPerFourEstimator)).toBeGreaterThanOrEqual(100);
	});
});

describe("redaction", () => {
	it("masks common credentials and flags sensitive paths", () => {
		const text = redactSecrets("key sk-abcdefghijklmnopqrstuvwxyz0123456789 token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 AKIAABCDEFGHIJKLMNOP -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----");
		expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
		expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
		expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
		expect(text).not.toContain("abc\n-----END");
		expect(isSensitivePath("/home/me/.ssh/id_rsa")).toBe(true);
		expect(isSensitivePath(".env.local")).toBe(true);
		expect(isSensitivePath("src/index.ts")).toBe(false);
	});
});

describe("skeleton", () => {
	it("omits result bodies, labels candidates and fits the budget", () => {
		const entries = withIds(singleTaskTranscript(12, { resultChars: 5_000 }));
		const { candidates } = collectCandidates(entries, { protectRecentGroups: 3, pinned: new Set(), decided: new Set(), protectedTools: new Set() });
		const skeleton = buildSkeleton(entries, candidates, { maxStateTokens: 20_000 });
		expect(skeleton).toBeDefined();
		const serialized = JSON.stringify(skeleton!.state);
		expect(serialized).not.toContain("content of file 0\ncontent of file 0");
		expect(serialized).toContain("t1");
		expect(serialized).toContain("omitted");
		expect(skeleton!.tokens).toBeLessThanOrEqual(20_000);
		expect(skeleton!.stage).toBe("full");
	});
	it("collapses under a tight budget and gives up when nothing fits", () => {
		const entries = withIds(singleTaskTranscript(40, { resultChars: 200 }));
		const { candidates } = collectCandidates(entries, { protectRecentGroups: 3, pinned: new Set(), decided: new Set(), protectedTools: new Set() });
		const tight = buildSkeleton(entries, candidates, { maxStateTokens: 1_000 });
		expect(tight === undefined || tight.stage !== "full").toBe(true);
		expect(buildSkeleton(entries, candidates, { maxStateTokens: 1 })).toBeUndefined();
	});
	it("withholds candidates whose arguments point at sensitive paths", () => {
		const messages = [user("go"), assistant({ calls: [{ id: "s", name: "read", arguments: { path: "/home/me/.ssh/id_rsa" } }] }), toolResult("s", "read", "KEY".repeat(200)), assistant({ calls: [{ id: "o", name: "read", arguments: { path: "src/a.ts" } }] }), toolResult("o", "read", "code".repeat(200)), assistant({ text: "done" })];
		const entries = withIds(messages);
		const { candidates } = collectCandidates(entries, { protectRecentGroups: 0, pinned: new Set(), decided: new Set(), protectedTools: new Set() });
		const skeleton = buildSkeleton(entries, candidates, { maxStateTokens: 10_000 });
		expect(skeleton!.withheld).toEqual(["s"]);
		expect(JSON.stringify(skeleton!.state)).not.toContain("id_rsa");
	});
});

describe("config", () => {
	it("falls back per field with problems listed", () => {
		const { config, problems } = parseConfig({ enabled: true, keepThreshold: 2, protectRecentGroups: 6, model: "", pairDroppableTools: ["read", "read", "custom"] });
		expect(config.enabled).toBe(true);
		expect(config.keepThreshold).toBe(0.35);
		expect(config.protectRecentGroups).toBe(6);
		expect(config.pairDroppableTools).toEqual(["read", "custom"]);
		expect(problems).toHaveLength(2);
	});
});

function entry(id: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-09-18T00:00:00.000Z", customType, data } as SessionEntry;
}

describe("state", () => {
	it("restores monotone decisions, pins and the last mode from branch entries, ignoring malformed data", () => {
		const pass = (passId: string, decisions: unknown[]) => ({ passId, observationId: "obs", fingerprint: "f", configFingerprint: "c", createdAt: 1, threshold: 0.35, estimatedSavings: 10, stats: {}, decisions });
		const branch = [
			entry("1", PASS_ENTRY, pass("p1", [decision("a", "drop_result"), decision("b", "keep")])),
			entry("2", PASS_ENTRY, pass("p2", [decision("a", "keep"), decision("b", "drop_pair")])),
			entry("3", PASS_ENTRY, { garbage: true }),
			entry("4", PIN_ENTRY, { toolCallId: "b", resultEntryId: "r-b", reason: "user", createdAt: 2 }),
			entry("5", MODE_ENTRY, { enabled: true }),
			entry("6", MODE_ENTRY, { enabled: false }),
			entry("7", MODE_ENTRY, { enabled: "yes" }),
		];
		const state = restoreState(branch);
		expect(state.passes.map((item) => item.passId)).toEqual(["p1", "p2"]);
		expect(state.decisions.get("a")?.effective).toBe("drop_result");
		expect(state.decisions.get("b")?.effective).toBe("drop_pair");
		expect([...activeDecisions(state).keys()]).toEqual(["a"]);
		expect(state.enabled).toBe(false);
		expect(state.scopeId).toBeUndefined();
	});

	it("expires keep verdicts at a compaction boundary while applied drops, pins and scope survive", () => {
		const pass = (passId: string, decisions: unknown[]) => ({ passId, observationId: "obs", fingerprint: "f", configFingerprint: "c", modelKey: "fake/m", createdAt: 1, threshold: 0.35, estimatedSavings: 10, stats: {}, decisions });
		const before = [
			entry("s", SCOPE_ENTRY, { scopeId: "scope-1", createdAt: 1 }),
			entry("1", PASS_ENTRY, pass("p1", [decision("kept", "keep"), decision("gone", "drop_pair"), decision("pinned", "drop_result")])),
			entry("2", PIN_ENTRY, { toolCallId: "pinned", resultEntryId: "r-pinned", reason: "recall", createdAt: 2 }),
		];
		const open = restoreState(before);
		expect([...decidedIds(open)].sort()).toEqual(["gone", "kept", "pinned"]);
		expect(open.passes[0].modelKey).toBe("fake/m");
		const after = restoreState([...before, { type: "compaction", id: "c", parentId: "2", timestamp: "", summary: "s", firstKeptEntryId: "1", tokensBefore: 1 } as SessionEntry]);
		// The keep is scoreable again; the drop stays applied and excluded; the pin still overrides it.
		expect([...decidedIds(after)].sort()).toEqual(["gone", "pinned"]);
		expect(after.decisions.get("gone")?.effective).toBe("drop_pair");
		expect([...activeDecisions(after).keys()]).toEqual(["gone"]);
		expect(after.pins.has("pinned")).toBe(true);
		expect(after.scopeId).toBe("scope-1");
		expect(after.passes).toHaveLength(1);
		// State as of an earlier entry ignores everything appended after it.
		expect(restoreStateAt([...before], "s").passes).toHaveLength(0);
		expect(restoreStateAt([...before], "1").pins.size).toBe(0);
	});
});

describe("pressure", () => {
	it("identifies the newest assistant entry with usage", () => {
		const branch: SessionEntry[] = [
			{ type: "message", id: "u", parentId: null, timestamp: "", message: user("go") } as SessionEntry,
			{ type: "message", id: "a1", parentId: "u", timestamp: "", message: assistant({ text: "x", inputTokens: 50 }) } as SessionEntry,
			{ type: "message", id: "a2", parentId: "a1", timestamp: "", message: { ...assistant({ text: "y" }), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } } as SessionEntry,
		];
		expect(currentObservationId(branch)).toBe("a1");
		expect(currentObservationId([branch[0]])).toBeUndefined();
		expect(hasChildren(branch, "u")).toBe(true);
		expect(hasChildren(branch, "a2")).toBe(false);
		expect(hasChildren(branch, null)).toBe(false);
	});

	it("changes the pass fingerprint when the coding model changes", () => {
		expect(passFingerprint(["a", "b"], "cfg", "anthropic/x")).toBe(passFingerprint(["b", "a"], "cfg", "anthropic/x"));
		expect(passFingerprint(["a", "b"], "cfg", "anthropic/x")).not.toBe(passFingerprint(["a", "b"], "cfg", "openai/y"));
	});
});

describe("prices", () => {
	it("emits catalog API rates per million only when a price exists, honouring request-wide tiers", () => {
		expect(apiRates(undefined, 100)).toBeUndefined();
		expect(apiRates({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 100)).toBeUndefined();
		expect(apiRates({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, 100)).toEqual({
			source: "provider_api_rates", inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75,
		});
		const tiered = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 200_000, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }] };
		expect(apiRates(tiered, 1_000)?.inputPerMillionUsd).toBe(1);
		expect(apiRates(tiered, 250_000)?.inputPerMillionUsd).toBe(2);
		expect(apiRates({ input: -1, output: 2, cacheRead: 0, cacheWrite: 0 }, 100)).toBeUndefined();
	});
});

describe("recall", () => {
	const branch = withIds(singleTaskTranscript(4)).map((item, index, all) => ({ type: "message", id: item.id, parentId: index === 0 ? null : all[index - 1].id, timestamp: "", message: item.message }) as SessionEntry);
	const decisions = new Map([["call-0", decision("call-0", "drop_pair", { resultEntryId: "e2" })], ["call-1", decision("call-1", "drop_result", { resultEntryId: "e4" })]]);
	it("lists omitted results first, searches text and reads pages", () => {
		const items = indexArchive(branch, decisions, new Map());
		expect(items).toHaveLength(4);
		const omitted = listArchive(items, { omittedOnly: true, offset: 0, limit: 10 });
		expect(omitted.total).toBe(2);
		expect(omitted.items.map((item) => [item.id, item.omitted])).toEqual([["e2", "pair"], ["e4", "result"]]);
		const found = searchArchive(items, "file 3", 10);
		expect(found.map((item) => item.id)).toEqual(["e8"]);
		expect(found[0].matches).toBeGreaterThan(1);
		const page = readArchive(items, "e2", 0, 50)!;
		expect(page.text).toHaveLength(50);
		expect(page.nextOffset).toBe(50);
		expect(readArchive(items, "call-0", page.nextOffset!, 16_000)!.nextOffset).toBeUndefined();
		expect(readArchive(items, "nope", 0, 10)).toBeUndefined();
	});
});
