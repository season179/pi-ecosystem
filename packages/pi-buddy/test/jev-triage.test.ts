import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { loadJevConfig, loadJevKey } from "../src/extensions/jev-config.js";
import { buildJevState, LiveJevTriage } from "../src/extensions/jev-triage.js";

export const entries: any[] = [
	{ type: "message", id: "request", message: { role: "user", content: "Explain the existing helper" } },
	{ type: "message", id: "activity", message: { role: "assistant", content: [{ type: "text", text: "I am reading the helper." }] } },
];
export function answer(omit = true) {
	const choice = (yes: string, no: string) => ({ type: "choice", choice: omit ? yes : no, confidence: 0.99, probabilities: { [yes]: omit ? 0.95 : 0.05, [no]: omit ? 0.05 : 0.95 } });
	return { model: "jev-1.13.0", answers: { action: choice("omit", "review"), context: choice("sufficient", "unknown"), risk: choice("low", "investigate") }, usage: { input_tokens: 12, output_tokens: 3 } };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
let dir: string;
function config(extra = {}) {
	writeFileSync(join(dir, "typesafe.json"), JSON.stringify({ buddy: { enabled: true }, ...extra }));
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "buddy-jev-"));
	vi.stubEnv("TYPESAFE_API_KEY", "test-only");
	config();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function triage(fetch: any) { return new LiveJevTriage({ agentDir: dir, fetch }); }
function input(extra = {}) { return { entries, opportunity: 1, signal: new AbortController().signal, ...extra }; }

describe("Jev SDK launch/candidate adapter", () => {
	it("uses actual SDK wire contract, pinned model, official endpoint, zero retry, no debug logging", async () => {
		vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
		vi.stubEnv("TYPESAFE_BASE_URL", "https://must-not-receive.invalid");
		vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "wrong-model");
		const log = vi.spyOn(console, "debug").mockImplementation(() => {});
		const fetch = vi.fn(async (url, init) => {
			assert.equal(url, "https://api.typesafe.ai/v1/systemone");
			const body = JSON.parse(init.body);
			assert.equal(body.model, "jev-1.13.0");
			assert.ok(Buffer.byteLength(body.state) < 16000);
			assert.deepEqual(Object.keys(body.questions), ["action", "context", "risk"]);
			for (const q of Object.values(body.questions) as any[]) assert.match(q.instructions, /state.currentRequest/);
			return response(answer());
		});
		assert.equal((await triage(fetch).decide(input())).outcome, "skip");
		assert.equal(fetch.mock.calls.length, 1);
		assert.equal(log.mock.calls.length, 0);
	});
	it("only suppresses candidates with all three affirmative signals; confidence is insufficient", async () => {
		const candidate = { headline: "Old chore", advisory: "Fix the old chore", evidence: [] };
		assert.equal((await triage(async () => response(answer())).decide(input({ candidate }))).outcome, "suppress");
		for (const key of ["action", "context", "risk"] as const) {
			const body = answer();
			body.answers[key] = answer(false).answers[key];
			assert.equal((await triage(async () => response(body)).decide(input({ candidate }))).outcome, "review");
		}
		const body = answer();
		body.answers.action.probabilities = { omit: 0.6, review: 0.4 };
		assert.equal((await triage(async () => response(body)).decide(input())).outcome, "review");
	});
	it("audits every fifth periodic opportunity without an SDK call; candidates do not consume audit slots", async () => {
		const fetch = vi.fn();
		assert.equal((await triage(fetch).decide(input({ opportunity: 5 }))).outcome, "audit");
		assert.equal(fetch.mock.calls.length, 0);
	});
	it.each([{}, { answers: {} }, { answers: { action: { type: "noul", noul: 1 } } }])("malformed answers fail open", async (body) => {
		assert.equal((await triage(async () => response(body)).decide(input())).reason, "malformed");
	});
	it("API errors fall back exactly once and never expose provider payloads", async () => {
		const fetch = vi.fn(async () => new Response("sensitive provider body", { status: 429 }));
		const result = await triage(fetch).decide(input());
		assert.equal(result.outcome, "fallback");
		assert.equal(result.reason, "error");
		assert.doesNotMatch(JSON.stringify(result), /sensitive/);
		assert.equal(fetch.mock.calls.length, 1);
	});
	it("bounds a transport that ignores cancellation and aborts it at the whole deadline", async () => {
		config({ timeoutMs: 20 });
		let signal: AbortSignal | undefined;
		const result = await triage((_url: string, init: any) => { signal = init.signal; return new Promise(() => {}); }).decide(input());
		assert.equal(result.reason, "deadline");
		assert.ok(signal?.aborted);
	});
	it("bounds a response body that never completes", async () => {
		config({ timeoutMs: 20 });
		const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"answers":')); } });
		const result = await triage(async () => new Response(body)).decide(input());
		assert.equal(result.reason, "deadline");
	});
	it("bounds post-buffer SDK text parsing and rejects late completion", async () => {
		config({ timeoutMs: 20 });
		let release!: (text: string) => void;
		vi.spyOn(Response.prototype, "text").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		const result = await triage(async () => response(answer())).decide(input());
		assert.equal(result.reason, "deadline");
		release(JSON.stringify(answer()));
		await Promise.resolve();
		assert.equal(result.outcome, "fallback");
	});
	it("post-buffer caller cancellation cannot become a late skip or fallback", async () => {
		let release!: (text: string) => void;
		const text = vi.spyOn(Response.prototype, "text").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		const controller = new AbortController();
		const pending = triage(async () => response(answer())).decide(input({ signal: controller.signal }));
		await vi.waitFor(() => assert.equal(text.mock.calls.length, 1));
		controller.abort();
		assert.equal((await pending).outcome, "cancelled");
		release(JSON.stringify(answer()));
	});
	it("rejects oversized responses before SDK JSON parsing", async () => {
		const text = vi.spyOn(Response.prototype, "text");
		const result = await triage(async () => new Response("x".repeat(65537))).decide(input());
		assert.equal(result.reason, "error");
		assert.equal(text.mock.calls.length, 0);
	});
	it("distinguishes user cancellation from deadline/error and never retries", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(() => new Promise(() => {}));
		const pending = triage(fetch).decide(input({ signal: controller.signal }));
		await vi.waitFor(() => assert.equal(fetch.mock.calls.length, 1));
		controller.abort();
		assert.equal((await pending).outcome, "cancelled");
		assert.equal(fetch.mock.calls.length, 1);
	});
	it("pre-aborted input does not make a request", async () => {
		const fetch = vi.fn();
		assert.equal((await triage(fetch).decide(input({ signal: AbortSignal.abort() }))).outcome, "cancelled");
		assert.equal(fetch.mock.calls.length, 0);
	});
});

describe("shared config and bounded state", () => {
	it("absent/disabled config preserves Buddy, malformed config and no key visibly fail open", async () => {
		const fetch = vi.fn();
		rmSync(join(dir, "typesafe.json"));
		assert.equal((await triage(fetch).decide(input())).outcome, "disabled");
		config({ buddy: { enabled: false } });
		assert.equal((await triage(fetch).decide(input())).outcome, "disabled");
		writeFileSync(join(dir, "typesafe.json"), "{bad");
		assert.equal((await triage(fetch).decide(input())).reason, "config");
		config(); vi.stubEnv("TYPESAFE_API_KEY", "");
		assert.equal((await triage(fetch).decide(input())).reason, "no_key");
		assert.equal(fetch.mock.calls.length, 0);
	});
	it("re-reads config and key file each decision with env precedence", async () => {
		config({ apiKeyFile: "typesafe.key" });
		vi.stubEnv("TYPESAFE_API_KEY", "");
		const fetch = vi.fn(async () => response(answer()));
		const adapter = triage(fetch);
		assert.equal((await adapter.decide(input())).reason, "no_key");
		// Isolated test fixture only, never the user's agent directory.
		writeFileSync(join(dir, "typesafe.key"), "fixture-only");
		assert.equal((await adapter.decide(input())).outcome, "skip");
		const loaded = await loadJevConfig(dir);
		assert.equal(loaded.kind, "enabled");
		if (loaded.kind !== "enabled") throw new Error();
		vi.stubEnv("TYPESAFE_API_KEY", "env-fixture");
		assert.equal(await loadJevKey(loaded.config, dir), "env-fixture");
		config({ buddy: { enabled: false } });
		assert.equal((await adapter.decide(input())).outcome, "disabled");
		assert.equal(fetch.mock.calls.length, 1);
	});
	it.each([{ timeoutMs: 0 }, { timeoutMs: 10001 }, { buddy: { enabled: "yes" } }, { buddy: { enabled: true, auditEvery: 0 } }, { buddy: { enabled: true, skipThreshold: 2 } }])("rejects malformed active options %j", async (options) => {
		config(options);
		assert.equal((await loadJevConfig(dir)).kind, "fallback");
	});
	it("never serializes full transcript or hidden thinking, and fails open on lost intent/multimodal content", async () => {
		const older = { type: "message", id: "old", message: { role: "user", content: "old private task" } };
		const recent = Array.from({ length: 30 }, (_, i) => ({ type: "message", id: `m${i}`, message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: `progress ${i}` }] } }));
		const state = buildJevState({ entries: [older, ...entries, ...recent] as any });
		assert.ok(state); assert.doesNotMatch(state, /old private|hidden|progress 1"/);
		assert.equal(JSON.parse(state).recentActivity.length, 8);
		assert.equal(JSON.parse(state).olderActivityOmitted, true);
		const fetch = vi.fn();
		for (const bad of [[], [entries[1]], [entries[0], { ...entries[1], message: { role: "assistant", content: [{ type: "image", data: "x" }] } }]]) {
			assert.equal((await triage(fetch).decide(input({ entries: bad }))).reason, "incomplete");
		}
		assert.equal(fetch.mock.calls.length, 0);
	});
	it("excerpts oversized multilingual requests with both intent edges and truthful omission metadata", () => {
		const request = "HEAD: Explain only, do not edit. " + "中🧪文🙂".repeat(2500) + " TAIL: Keep the public API unchanged.";
		const state = buildJevState({ entries: [{ ...entries[0], message: { role: "user", content: request } }, entries[1]] });
		assert.ok(state);
		const parsed = JSON.parse(state);
		assert.match(parsed.currentRequest, /^HEAD: Explain only, do not edit\./);
		assert.match(parsed.currentRequest, /TAIL: Keep the public API unchanged\.$/);
		assert.doesNotMatch(parsed.currentRequest, /\uFFFD/);
		const metadata = parsed.excerpts.currentRequest;
		assert.equal(metadata.originalBytes, Buffer.byteLength(request));
		assert.ok(metadata.omittedBytes > 0);
		const marker = `\n[... middle omitted: ${metadata.omittedBytes} UTF-8 bytes ...]\n`;
		assert.ok(parsed.currentRequest.includes(marker));
		assert.equal(Buffer.byteLength(parsed.currentRequest.replace(marker, "")) + metadata.omittedBytes, metadata.originalBytes);
		assert.ok(Buffer.byteLength(JSON.stringify(parsed.currentRequest)) <= 4000);
	});
	it("bounds escaping-heavy activity/candidate/history deterministically without verbosity fallback", () => {
		const noisy = "\u0000\n\t\\\"中🙂".repeat(8000);
		const largeEntries = [entries[0], ...Array.from({ length: 8 }, (_, i) => ({ type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: `HEAD ${noisy} TAIL` }] } }))] as any;
		const input = { entries: largeEntries, candidate: { headline: noisy, advisory: noisy, evidence: Array(20).fill(noisy) }, concernDigest: noisy };
		const state = buildJevState(input);
		assert.ok(state);
		assert.equal(buildJevState(input), state);
		assert.ok(Buffer.byteLength(state) <= 16000);
		const parsed = JSON.parse(state);
		assert.equal(parsed.recentActivity.length, 8);
		assert.equal(parsed.candidate.evidence.length, 5);
		assert.equal(parsed.evidenceItemsOmitted, 15);
		assert.ok(parsed.excerpts["candidate.advisory"].omittedBytes > 0);
		assert.ok(parsed.excerpts.concernDigest.omittedBytes > 0);
		for (const activity of parsed.recentActivity) {
			assert.match(activity.text, /^HEAD/); assert.match(activity.text, /TAIL$/);
			assert.doesNotMatch(activity.text, /\uFFFD/);
		}
	});
	it("failed tool-argument serialization remains a normal-review fallback", () => {
		const args: any = {}; args.self = args;
		assert.equal(buildJevState({ entries: [entries[0], { ...entries[1], message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: args }] } }] }), undefined);
	});
});
