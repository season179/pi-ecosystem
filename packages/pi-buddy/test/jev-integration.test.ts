import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import setupBuddy from "../src/extensions/buddy.js";
import { ConsultationWorkflow } from "../src/extensions/consultation-workflow.js";
import { __setTelemetryPathForTests } from "../src/extensions/telemetry.js";

let dir: string;
let telemetry: string;
function wire(omit = true) {
	const choice = (yes: string, no: string) => ({ type: "choice", choice: omit ? yes : no, confidence: 0.99, probabilities: { [yes]: omit ? 0.95 : 0.05, [no]: omit ? 0.05 : 0.95 } });
	return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { action: choice("omit", "review"), context: choice("sufficient", "unknown"), risk: choice("low", "investigate") }, usage: { input_tokens: 10, output_tokens: 3 } }));
}
const pass = () => ({ answer: "Done", activity: [], rounds: 1, transcriptTokens: 10, watchdogVerdict: { decision: "pass" } });
const concern = () => ({ ...pass(), watchdogVerdict: { decision: "concern", headline: "Old concern", advisory: "Old task needs work", evidence: ["old.ts:1"] } });
const confirm = () => ({ ...pass(), watchdogVerdict: { ...concern().watchdogVerdict, decision: "confirm" } });
function makeHarness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	let branch: any[] = [
		{ type: "message", id: "u1", message: { role: "user", content: "Explain the helper" } },
		{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Reading the helper" }] } },
	];
	const sent: any[] = [];
	const statuses: string[] = [];
	const notices: string[] = [];
	const runAbort = new AbortController();
	const ctx: any = { hasUI: true, cwd: dir, signal: runAbort.signal, isIdle: () => false,
		sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
		ui: { setStatus: (_key: string, text: string) => statuses.push(text), setWidget() {}, notify: (text: string) => notices.push(text) },
	};
	const pi: any = {
		registerFlag() {}, registerMessageRenderer() {},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getFlag: () => undefined, getActiveTools: () => ["consult_buddy", "give_buddy_feedback"], setActiveTools() {},
		sendMessage: (...args: any[]) => sent.push(args), exec() { throw new Error("unexpected exec"); },
	};
	setupBuddy(pi);
	const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	return { ctx, sent, statuses, notices, runAbort, emit,
		setBranch: (next: any[]) => { branch = next; },
		turns: async (n = 3) => { for (let i = 0; i < n; i++) await emit("turn_end"); },
		command: (arg: string) => commands.get("buddy").handler(arg, ctx),
		consult: () => tools.get("consult_buddy").execute("c1", { stance: "review", question: "Review now" }, undefined, undefined, ctx),
		newRequest: () => { branch = [...branch, { type: "message", id: "u2", message: { role: "user", content: "Now explain another helper" } }, { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "Reading another helper" }] } }]; },
	};
}
function configure(extra = {}) { writeFileSync(join(dir, "typesafe.json"), JSON.stringify({ buddy: { enabled: true, auditEvery: 5 }, ...extra })); }
async function records() {
	// Telemetry is intentionally fire-and-forget; wait until fs appends drain.
	await new Promise((resolve) => setTimeout(resolve, 20));
	try { return readFileSync(telemetry, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}
let reviewer: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "buddy-jev-live-"));
	telemetry = join(dir, "telemetry.jsonl");
	__setTelemetryPathForTests(telemetry);
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-only");
	configure();
	vi.spyOn(ConsultationWorkflow.prototype, "resolveModelPlan").mockResolvedValue({ candidates: [{ spec: "fixture/model" }] } as any);
	reviewer = vi.spyOn(ConsultationWorkflow.prototype, "run").mockImplementation(async (request: any) => {
		const result = pass(); request.outcomeOf?.(result); return result as any;
	});
});
afterEach(async () => {
	await records();
	__setTelemetryPathForTests(undefined);
	vi.restoreAllMocks(); vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
async function start() { const h = makeHarness(); await h.emit("session_start"); await h.emit("agent_start"); return h; }

describe("active Jev at real Buddy extension event boundaries", () => {
	it.each([true, false])("multi-KB read/bash/assistant arguments invoke Jev; omit=%s controls real reviewer invocation", async (omit) => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const payload = JSON.parse(init!.body as string);
			assert.ok(Buffer.byteLength(payload.state) <= 16000);
			const state = JSON.parse(payload.state);
			assert.match(state.currentRequest, /^Explain the existing API/);
			assert.match(state.currentRequest, /Do not change public behavior\.$/);
			assert.ok(state.excerpts.currentRequest.omittedBytes > 0);
			assert.equal(state.recentActivity.length, 3);
			for (let i = 0; i < 3; i++) {
				assert.ok(state.excerpts[`recentActivity[${i}].text`].omittedBytes > 0);
				assert.match(state.recentActivity[i].text, /middle omitted/);
			}
			assert.match(payload.questions.context.instructions, /state.excerpts/);
			assert.match(payload.questions.risk.instructions, /excerpts are not full evidence/);
			return wire(omit);
		});
		const h = await start();
		h.setBranch([
			{ type: "message", id: "u-big", message: { role: "user", content: "Explain the existing API. " + "Background context 中🙂 ".repeat(700) + "Do not change public behavior." } },
			{ type: "message", id: "a-big", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "printf '%s' " + "large literal argument ".repeat(600) + "; git status --short" } }] } },
			{ type: "message", id: "read-big", message: { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "export function existingHelper() {\n" + "  // implementation detail\n".repeat(1500) + "}\n" }] } },
			{ type: "message", id: "bash-big", message: { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "Running checks\n" + "PASS routine check\n".repeat(1500) + "All checks passed" }] } },
		]);
		await h.turns();
		assert.equal(fetch.mock.calls.length, 1);
		assert.equal(reviewer.mock.calls.length, omit ? 0 : 1);
		assert.ok((await records()).some((r) => r.type === "jev_triage" && r.outcome === (omit ? "skip" : "review")));
	});
	it("skips actual reviewer calls but eligible settled run-end bypasses Jev", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wire());
		const h = await start();
		await h.turns();
		assert.equal(reviewer.mock.calls.length, 0);
		await h.emit("agent_end"); await h.emit("agent_settled");
		assert.equal(reviewer.mock.calls.length, 1);
		assert.equal((reviewer.mock.calls[0][0] as any).trigger, "run_end");
		assert.equal(fetch.mock.calls.length, 1);
		const rows = await records();
		assert.equal(rows.filter((r) => r.type === "jev_triage" && r.outcome === "skip").length, 1);
		assert.equal(rows.filter((r) => r.type === "watchdog_commit").length, 0);
	});
	it("review decision launches reviewer; fifth opportunity audits without Jev", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wire());
		const h = await start();
		await h.turns(15);
		assert.equal(fetch.mock.calls.length, 4);
		assert.equal(reviewer.mock.calls.length, 1);
		assert.ok((await records()).some((r) => r.type === "jev_triage" && r.outcome === "audit" && r.opportunity === 5));
		fetch.mockImplementation(async () => wire(false));
		await h.turns(3);
		assert.equal(reviewer.mock.calls.length, 2);
	});
	it("explicit tool and user command bypass Jev", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wire());
		const h = await start();
		await h.consult(); await h.command("Check this directly");
		assert.equal(fetch.mock.calls.length, 0);
		assert.deepEqual(reviewer.mock.calls.map((call: any) => call[0].source), ["tool", "command"]);
	});
	it.each(["no_key", "error", "deadline", "config"])("%s falls back to actual Buddy with bounded visible warning", async (reason) => {
		if (reason === "no_key") vi.stubEnv("TYPESAFE_API_KEY", "");
		if (reason === "config") writeFileSync(join(dir, "typesafe.json"), "{bad");
		if (reason === "deadline") configure({ timeoutMs: 15 });
		vi.spyOn(globalThis, "fetch").mockImplementation(reason === "deadline" ? () => new Promise(() => {}) : async () => new Response("private body", { status: 500 }));
		const h = await start();
		await h.turns(6);
		assert.equal(reviewer.mock.calls.length, 2);
		assert.equal(h.notices.filter((s) => s.includes("Jev triage unavailable")).length, 1);
		assert.ok(h.statuses.some((s) => s?.includes(`fallback (${reason})`)));
		assert.doesNotMatch(JSON.stringify(await records()), /private body|Explain the helper|fixture-only/);
	});
	it.each(["input", "turn_start", "tool_execution_start", "model_select", "session_tree", "session_start", "session_shutdown", "off", "end", "cancel", "consult"])("%s during a gate aborts without stale launch or stranded ownership", async (event) => {
		let complete!: (response: Response) => void;
		let requestSignal: AbortSignal | undefined;
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => { requestSignal = init?.signal as AbortSignal; return new Promise((resolve) => { complete = resolve; }); });
		const h = await start();
		const pending = h.turns();
		await vi.waitFor(() => assert.equal(fetch.mock.calls.length, 1));
		// A duplicate turn boundary cannot overlap a gate.
		await h.emit("turn_end");
		assert.equal(fetch.mock.calls.length, 1);
		if (event === "off") { await h.command("off"); await h.command("on"); }
		else if (event === "end") await h.emit("agent_end");
		else if (event === "cancel") h.runAbort.abort();
		else if (event === "consult") await h.consult();
		else await h.emit(event, { toolCallId: "tool-1" });
		await pending; // Does not need an uncooperative transport to settle.
		assert.ok(requestSignal?.aborted);
		complete(wire(false));
		await Promise.resolve();
		assert.equal(reviewer.mock.calls.length, event === "consult" ? 1 : 0);
		if (event !== "cancel" && event !== "session_shutdown") {
			fetch.mockImplementation(async () => wire(false));
			await h.emit("agent_start"); await h.turns();
			assert.equal(reviewer.mock.calls.length, event === "consult" ? 2 : 1);
		}
	});
	it("run end while gate is in flight still launches eligible run-end review", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		const h = await start(); const pending = h.turns();
		await vi.waitFor(() => assert.equal(fetch.mock.calls.length, 1));
		await h.emit("agent_end"); await h.emit("agent_settled"); await pending;
		assert.equal(reviewer.mock.calls.length, 1);
		assert.equal((reviewer.mock.calls[0][0] as any).trigger, "run_end");
	});
});

describe("live candidate relevance inside stable coordinator commit", () => {
	it("suppresses irrelevant carried candidates without revalidation, resolution or run-end bookkeeping", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => wire(!!JSON.parse(JSON.parse(init!.body as string).state).candidate));
		reviewer.mockImplementation(async (request: any) => {
			const result = concern(); request.outcomeOf?.(result); return result as any;
		});
		const h = await start(); await h.turns();
		await h.emit("agent_end"); await h.emit("agent_settled");
		h.newRequest(); await h.emit("agent_start");
		await h.turns(2);
		assert.equal(reviewer.mock.calls.length, 1);
		assert.equal(h.sent.length, 0);
		let rows = await records();
		assert.ok(rows.some((r) => r.type === "jev_triage" && r.phase === "candidate" && r.outcome === "suppress"));
		assert.equal(rows.filter((r) => r.type === "watchdog_commit").length, 0);
		await h.emit("agent_end"); await h.emit("agent_settled");
		assert.equal(reviewer.mock.calls.length, 2); // slot released; run-end still eligible
		assert.equal((reviewer.mock.calls[1][0] as any).trigger, "run_end");
	});
	it.each(["review", "error", "no_key"])("candidate %s still gets full revalidation then stable publication", async (decision) => {
		if (decision === "no_key") vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => decision === "error" ? new Response("not logged", { status: 500 }) : wire(false));
		reviewer.mockImplementation(async (request: any) => {
			const result = request.stance === "watchdog" ? concern() : confirm(); request.outcomeOf?.(result); return result as any;
		});
		const h = await start(); await h.turns(); await h.turns(1);
		assert.equal(reviewer.mock.calls.length, 2);
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0][1].deliverAs, "steer");
	});
	it("activity during candidate suppression keeps candidate private and retries at a stable boundary", async () => {
		let finish!: (response: Response) => void;
		let candidateSignal: AbortSignal | undefined;
		let candidateCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const candidate = JSON.parse(JSON.parse(init!.body as string).state).candidate;
			if (!candidate) return wire(false);
			candidateCalls++;
			if (candidateCalls === 1) { candidateSignal = init?.signal as AbortSignal; return new Promise((resolve) => { finish = resolve; }); }
			return wire();
		});
		reviewer.mockImplementation(async () => concern() as any);
		const h = await start(); await h.turns();
		const pending = h.turns(1);
		await vi.waitFor(() => assert.equal(candidateCalls, 1));
		await h.emit("input"); await pending;
		assert.ok(candidateSignal?.aborted);
		finish(wire());
		assert.equal(h.sent.length, 0);
		assert.equal(reviewer.mock.calls.length, 1);
		assert.equal((await records()).filter((r) => r.outcome === "suppress").length, 0);
		await h.turns(1);
		assert.equal(candidateCalls, 2);
		assert.equal((await records()).filter((r) => r.outcome === "suppress").length, 1);
	});
});
