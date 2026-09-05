import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { createMemoryExtension } from "../src/extensions/memory.js";
import { MEMORY_INJECTION_BUDGETS, renderAlwaysBlock } from "../src/injection.js";
import { readMemorySnapshot } from "../src/store.js";
import { ExtensionRegistrationHarness, makeExtensionContext } from "./helpers/extension-harness.js";
import { assertBody, assertNoInjectionPersistence, contextText, createInjectionRig, legacyMemory, plainPrompt, saveInjectionEvidence, type InjectionRig, type InjectionMemory } from "./helpers/injection-harness.js";
import { toolCall } from "./helpers/sdk-harness.js";

const rigs = new Set<InjectionRig>();
const originalMode = process.env.PI_MEMORY_MODE;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const rig of rigs) await rig.dispose();
	rigs.clear();
	if (originalMode === undefined) delete process.env.PI_MEMORY_MODE;
	else process.env.PI_MEMORY_MODE = originalMode;
});

async function setup() {
	delete process.env.PI_MEMORY_MODE;
	const rig = await createInjectionRig();
	rigs.add(rig);
	return rig;
}

function always(id: string, body: string, updated = "2026-08-23T00:00:00.000Z"): InjectionMemory {
	return { ...legacyMemory({ id, body, updated }), injection: "always" };
}
const OVERFLOW_BODY = `EXTERNAL_OVERFLOW_BODY_BEGIN_d9a82c${"漢字😀".repeat(1_000)}EXTERNAL_OVERFLOW_MIDDLE_632abc${"漢字😀".repeat(1_000)}EXTERNAL_OVERFLOW_BODY_END_b63921`;
const SMALL_BODY = "SMALL_NEWEST_ALWAYS_MUST_NOT_BE_PARTIAL_SUBSET_a8ce20";
const OTHER_SCOPE_BODY = "OTHER_SCOPE_ALWAYS_SURVIVES_98f2c1";
const REFERENCE_TITLE = "Independent project on-demand catalog survives";
const REFERENCE_BODY = "REFERENCE_BODY_REMAINS_ON_DEMAND_85c411";

async function seedOverflow(rig: InjectionRig, affected: "project" | "legacy-global") {
	const oversized = [always("m_aaaaaaaaaa", OVERFLOW_BODY), always("m_bbbbbbbbbb", SMALL_BODY, "2026-08-24T00:00:00.000Z")];
	const reference = legacyMemory({ id: "m_cccccccccc", title: REFERENCE_TITLE, body: REFERENCE_BODY });
	await rig.seedLegacy(affected === "project" ? [...oversized, reference] : [always("m_dddddddddd", OTHER_SCOPE_BODY), reference]);
	await rig.seedLegacy(affected === "legacy-global" ? oversized : [always("m_dddddddddd", OTHER_SCOPE_BODY)], "legacy-global");
}

function textBlocks(messages: any[]): Array<{ text: string; piMemory: { kind: string; scope: string } }> {
	return messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "text" && block.piMemory?.owner === "@season179/pi-memory");
}

describe("external injection overflow and tool admission diagnostics", () => {
	it.each(["project", "legacy-global"] as const)("excludes the ENTIRE overflowing %s always set, preserves the other scope and project catalog", async (affected) => {
		const rig = await setup();
		await seedOverflow(rig, affected);
		const before = { project: await rig.bytes(), global: await rig.bytes("legacy-global") };
		const subject = await rig.start();
		for (let turn = 0; turn < 2; turn++) {
			const capture = await plainPrompt(subject, `overflow-${affected}`, `request-${turn}`);
			const text = contextText(capture);
			assertBody(text, OVERFLOW_BODY, false);
			assertBody(text, SMALL_BODY, false);
			assertBody(text, OTHER_SCOPE_BODY);
			assertBody(text, REFERENCE_BODY, false);
			assertBody(text, REFERENCE_TITLE);
			const blocks = textBlocks(capture.context.messages);
			const diagnostic = blocks.find((block) => block.piMemory.kind === "always" && block.piMemory.scope === affected);
			assert.ok(diagnostic, "overflow notice must replace the affected owned always block");
			assert.match(diagnostic.text, /all .*always.*excluded/iu);
			assert.match(diagnostic.text, /bytes.*tokens|tokens.*bytes/iu);
			assert.match(diagnostic.text, /shrink|delete|demote/iu);
			const maxBytes = affected === "project" ? 8_192 : 4_096;
			const maxTokens = affected === "project" ? 2_000 : 1_000;
			assert.ok(Buffer.byteLength(diagnostic.text, "utf8") <= maxBytes);
			assert.ok(Math.ceil(diagnostic.text.length / 4) <= maxTokens);
			assert.ok(blocks.reduce((bytes, block) => bytes + Buffer.byteLength(block.text, "utf8"), 0) <= 16_384);
			assert.ok(blocks.reduce((tokens, block) => tokens + Math.ceil(block.text.length / 4), 0) <= 4_000);
		}
		assert.deepEqual(await rig.bytes(), before.project);
		assert.deepEqual(await rig.bytes("legacy-global"), before.global);
		assertNoInjectionPersistence(subject, [OVERFLOW_BODY, SMALL_BODY, OTHER_SCOPE_BODY]);
	});

	it.each(["project", "legacy-global"] as const)("keeps huge external %s overflow actionable within the diagnostic reservation, including compact fallback", async (affected) => {
		const rig = await setup();
		const huge = `HUGE_EXTERNAL_BEGIN_612ab${"x".repeat(2_000_000)}HUGE_EXTERNAL_MIDDLE_61bf${"y".repeat(2_000_000)}HUGE_EXTERNAL_END_c28a`;
		const memories = [always("m_aaaaaaaaaa", huge), always("m_bbbbbbbbbb", SMALL_BODY)];
		await rig.seedLegacy(memories, affected);
		const subject = await rig.start();
		const capture = await plainPrompt(subject, `huge-overflow-${affected}`, "request");
		assertBody(contextText(capture), huge, false);
		assertBody(contextText(capture), SMALL_BODY, false);
		const notice = textBlocks(capture.context.messages).find((block) => block.piMemory.scope === affected && block.piMemory.kind === "always");
		assert.ok(notice);
		const assertActionable = (text: string, maxBytes = 512, maxTokens = 128) => {
			assert.ok(Buffer.byteLength(text, "utf8") <= maxBytes);
			assert.ok(Math.ceil(text.length / 4) <= maxTokens);
			assert.match(text, /excluded/iu);
			assert.match(text, /\/pi-memory status/u);
			assert.match(text, /shrink|shrinking/iu);
			assert.match(text, /delete|deleting/iu);
			assert.match(text, /demote|demoting/iu);
		};
		assertActionable(notice.text);
		// Current short wording fits 512 even for multi-megabyte usage. Exercise
		// the real compact fallback with its supported smaller reservation, using
		// the same externally authored snapshot; this is supplemental, not SDK evidence.
		const snapshot = await readMemorySnapshot(affected === "project" ? rig.projectDirectory : rig.memoryRoot);
		assert.ok(Buffer.byteLength(notice.text, "utf8") > 400, "smaller reservation must actually force a different candidate");
		const compact = renderAlwaysBlock(snapshot, { scope: affected, budget: { ...MEMORY_INJECTION_BUDGETS[affected], reservedBytes: 400, reservedEstimatedTokens: 100 } });
		assert.ok(compact && compact.state === "overflow");
		assert.notEqual(compact.content, notice.text);
		assertActionable(compact.content, 400, 100);
		assertBody(JSON.stringify(compact.content), huge, false);
		assertBody(JSON.stringify(compact.content), SMALL_BODY, false);
	});

	it("rejects an over-budget tool create precommit without consuming one of the three successful mutation slots", async () => {
		const rig = await setup();
		const subject = await rig.start();
		const args = (title: string, body: string) => ({ action: "create", scope: "project", title, cue: "Budget admission", body, injection: "always" });
		subject.enqueueResponses(
			{ kind: "tools", calls: [
				toolCall("reject-budget", "remember", args("Rejected", "x".repeat(8_000))),
				...Array.from({ length: 3 }, (_, i) => toolCall(`accepted-${i}`, "remember", args(`Accepted ${i}`, `ACCEPTED_ALWAYS_BODY_${i}`))),
			] },
			{ kind: "text", text: "Budget batch completed." },
		);
		try { await subject.prompt("Run the four synthetic admission checks in sequence, then finish."); }
		finally { await saveInjectionEvidence("budget-admission", "post-tool", subject); }
		assert.equal(subject.captures.length, 2);
		const results = subject.session.messages.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 4);
		assert.equal(results[0].isError, true);
		assert.match(JSON.stringify(results[0].content), /PI_MEMORY_INJECTION_BUDGET_EXCEEDED/u);
		for (const result of results.slice(1)) assert.equal(result.isError, false, JSON.stringify(result.content));
		const memories = await rig.memories();
		assert.equal(memories.length, 3);
		assert.equal(memories.some((memory) => memory.title === "Rejected"), false);
	});

	it.each(["rpc", "print", "json"] as const)("reports overflow capacity in %s without injecting command output into session", async (mode) => {
		const rig = await setup();
		await seedOverflow(rig, "project");
		const harness = new ExtensionRegistrationHarness();
		createMemoryExtension({ agentDir: rig.agentDir })(harness.api);
		const ctx = makeExtensionContext(rig.cwd, { mode, hasUI: mode === "rpc" });
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => { stderr.push(String(chunk)); return true; }) as any);
		await harness.emit("session_start", { reason: "startup" }, ctx.context);
		const [result] = await harness.emit("context", { messages: [{ role: "user", content: "ordinary prompt", timestamp: 1 }] }, ctx.context);
		assert.ok(result);
		const reported = mode === "rpc" ? ctx.notifications.map((notice) => notice.message).join("\n") : stderr.join("\n");
		assert.match(reported, /budget|overflow/iu);
		assert.match(reported, /project/iu);
		stderr.length = 0;
		ctx.notifications.length = 0;
		await harness.command("pi-memory").handler("status", ctx.context);
		if (mode === "json") assert.deepEqual(stderr, [], "command output intentionally remains silent in JSON mode");
		else {
			const status = mode === "rpc" ? ctx.notifications.map((notice) => notice.message).join("\n") : stderr.join("\n");
			assert.match(status, /m_aaaaaaaaaa/u);
			assert.match(status, /m_bbbbbbbbbb/u);
			assert.match(status, /excluded/iu);
		}
		assert.deepEqual(harness.sentMessages, []);
	});
});
