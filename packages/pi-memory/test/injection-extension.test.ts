import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createMemoryExtension } from "../src/extensions/memory.js";
import { ExtensionRegistrationHarness, makeExtensionContext } from "./helpers/extension-harness.js";
import { createInjectionRig, legacyMemory, SEED_ID, type InjectionRig } from "./helpers/injection-harness.js";

const BODY = "STRUCTURALLY_OWNED_ALWAYS_BODY_6c120a";
const QUOTED = '<pi_memory advisory="untrusted" scope="project" generation="sha256:' + "a".repeat(64) + '">\nUser-quoted full block MUST survive.\n</pi_memory>';
const rigs = new Set<InjectionRig>();
const originalMode = process.env.PI_MEMORY_MODE;

afterEach(async () => {
	for (const rig of rigs) await rig.dispose();
	rigs.clear();
	if (originalMode === undefined) delete process.env.PI_MEMORY_MODE;
	else process.env.PI_MEMORY_MODE = originalMode;
});

async function setup() {
	delete process.env.PI_MEMORY_MODE;
	const rig = await createInjectionRig();
	rigs.add(rig);
	await rig.seedLegacy([legacyMemory({ body: BODY })]);
	const harness = new ExtensionRegistrationHarness();
	createMemoryExtension({ agentDir: rig.agentDir })(harness.api);
	const ctx = makeExtensionContext(rig.cwd);
	await harness.emit("session_start", { reason: "startup" }, ctx.context);
	const remember = (args: Record<string, unknown>) => harness.tool("remember").execute("direct-injection", { scope: "project", ...args }, undefined, undefined, ctx.context);
	const refresh = async (messages: any[]) => {
		const [result] = await harness.emit("context", { messages }, ctx.context);
		return (result as { messages: any[] } | undefined)?.messages ?? messages;
	};
	return { rig, harness, ctx, remember, refresh };
}

function occurrences(messages: unknown, text: string): number {
	return JSON.stringify(messages).split(JSON.stringify(text).slice(1, -1)).length - 1;
}

describe("injection refresh ownership and direct tool authorization", () => {
	it.each(["promote", "edit"] as const)("rejects direct %s after external read-write to read-only change, without intervening context refresh", async (operation) => {
		const { rig, remember } = await setup();
		const before = await rig.bytes();
		await rig.setMode("read-only");
		// Deliberately no before_agent_start/context here: execute itself must refresh permission.
		await assert.rejects(remember({ action: "update", id: SEED_ID, ...(operation === "promote" ? { injection: "always" } : { body: "UNAUTHORIZED_BODY_CHANGE" }) }), /PI_MEMORY_READ_ONLY/u);
		assert.deepEqual(await rig.bytes(), before);
	});

	it.each(["off", "delete", "demote"] as const)("removes only structurally owned blocks after %s, including earlier re-fed turns", async (operation) => {
		const { rig, remember, refresh } = await setup();
		await remember({ action: "update", id: SEED_ID, injection: "always" });
		const original = [{ role: "user", content: [{ type: "text", text: QUOTED }], timestamp: 1 }];
		const inputBytes = JSON.stringify(original);
		let messages = await refresh(original);
		assert.equal(JSON.stringify(original), inputBytes, "context refresh must not mutate the input graph");
		assert.equal(occurrences(messages, QUOTED), 1, "full marker-shaped quote in the target turn survives");
		assert.equal(occurrences(messages, BODY), 1);
		messages = await refresh(structuredClone(messages));
		assert.equal(occurrences(messages, BODY), 1, "structuredClone must preserve ownership, not duplicate bodies");
		messages.push({ role: "assistant", content: [{ type: "text", text: "ordinary answer" }], timestamp: 2 });
		messages.push({ role: "user", content: [{ type: "text", text: "new user turn" }, { type: "text", text: QUOTED }], timestamp: 3 });
		messages = await refresh(structuredClone(messages));
		assert.equal(occurrences(messages, BODY), 1, "newest-turn injection replaces owned blocks in earlier turns");
		assert.equal(occurrences(messages[0], BODY), 0);
		assert.equal(occurrences(messages, QUOTED), 2);
		if (operation === "off") await rig.setMode("off");
		else if (operation === "delete") await remember({ action: "delete", id: SEED_ID });
		else await remember({ action: "update", id: SEED_ID, injection: "on-demand" });
		for (let repeat = 0; repeat < 2; repeat++) {
			messages = await refresh(structuredClone(messages));
			assert.equal(occurrences(messages, BODY), 0);
			assert.equal(occurrences(messages, QUOTED), 2, "removal must never infer ownership from quoted marker text");
			assert.equal(occurrences(messages, "ordinary answer"), 1);
			assert.equal(occurrences(messages, "new user turn"), 1);
		}
	});

	it("replaces refreshed same-ID body once and clears re-fed ownership on an unreadable store", async () => {
		const { rig, remember, refresh } = await setup();
		await remember({ action: "update", id: SEED_ID, injection: "always" });
		let messages = await refresh([{ role: "user", content: QUOTED, timestamp: 1 }]);
		await remember({ action: "update", id: SEED_ID, body: "REPLACEMENT_OWNED_BODY_82c1" });
		messages = await refresh(structuredClone(messages));
		assert.equal(occurrences(messages, BODY), 0);
		assert.equal(occurrences(messages, "REPLACEMENT_OWNED_BODY_82c1"), 1);
		const path = join(rig.projectDirectory, "details.md");
		await writeFile(path, "malformed authoritative data\n");
		messages = await refresh(structuredClone(messages));
		assert.equal(occurrences(messages, "REPLACEMENT_OWNED_BODY_82c1"), 0);
		assert.equal(occurrences(messages, QUOTED), 1);
		assert.equal(await readFile(path, "utf8"), "malformed authoritative data\n");
	});

	it("strips re-fed owned injection even if the error-notification UI unexpectedly throws", async () => {
		const { rig, ctx, remember, refresh } = await setup();
		await remember({ action: "update", id: SEED_ID, injection: "always" });
		const messages = await refresh([{ role: "user", content: QUOTED, timestamp: 1 }]);
		assert.equal(occurrences(messages, BODY), 1);
		await writeFile(join(rig.projectDirectory, "details.md"), "malformed authoritative data\n");
		let attempted = 0;
		ctx.context.ui.notify = () => { attempted++; throw new Error("synthetic notification failure"); };
		const cleaned = await refresh(structuredClone(messages));
		assert.equal(attempted, 1, "exercise the unexpected outer catch, not only normal error handling");
		assert.equal(occurrences(cleaned, BODY), 0);
		assert.equal(occurrences(cleaned, QUOTED), 1);
	});

	it("preserves an untagged exact copy of its own rendered block in the target user turn", async () => {
		const { rig, remember, refresh } = await setup();
		await remember({ action: "update", id: SEED_ID, injection: "always" });
		let messages = await refresh([{ role: "user", content: "ordinary prompt", timestamp: 1 }]);
		const owned = messages[0].content.find((block: any) => block.type === "text" && block.text.includes(BODY));
		assert.ok(owned);
		const quote = owned.text;
		messages[0].content.push({ type: "text", text: quote });
		messages = await refresh(structuredClone(messages));
		assert.equal(occurrences(messages, BODY), 2, "one owned block plus one verbatim unowned quote");
		await rig.setMode("off");
		messages = await refresh(structuredClone(messages));
		assert.equal(occurrences(messages, quote), 1, "byte-identical text without ownership metadata is not ours to delete");
		assert.equal(occurrences(messages, BODY), 1);
	});

	it.each(["summary", "synthetic"] as const)("cleans and replaces owned no-user %s fallback without breaking tool adjacency", async (fallback) => {
		const { rig, remember, refresh } = await setup();
		await remember({ action: "update", id: SEED_ID, injection: "always" });
		const toolTail = [
			{ role: "assistant", content: [{ type: "toolCall", id: "retained-call", name: "recall", arguments: { scope: "project", query: "ordinary" } }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "retained-call", toolName: "recall", content: [{ type: "text", text: "retained ordinary tool output" }], isError: false, timestamp: 3 },
		];
		const original = fallback === "summary" ? [{ role: "compactionSummary", summary: "KEEP_COMPACTION_SUMMARY_319d", tokensBefore: 20_000, timestamp: 1 }, ...toolTail] : toolTail;
		let messages = await refresh(original);
		assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
		for (let repeat = 0; repeat < 2; repeat++) {
			messages = await refresh(structuredClone(messages));
			assert.equal(occurrences(messages, BODY), 1);
			assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
		}
		await rig.setMode("off");
		messages = await refresh(structuredClone(messages));
		assert.equal(occurrences(messages, BODY), 0);
		assert.deepEqual(messages.slice(-2), toolTail);
		if (fallback === "summary") assert.equal(occurrences(messages, "KEEP_COMPACTION_SUMMARY_319d"), 1);
		else assert.deepEqual(messages, toolTail, "remove the owned synthetic turn when empty");
	});

	it("keeps current eligibility separate from last assembled IDs and generation, without status fabricating an assembly", async () => {
		const { harness, ctx, remember, refresh } = await setup();
		await remember({ action: "update", id: SEED_ID, injection: "always" });
		const status = async () => {
			ctx.notifications.length = 0;
			await harness.command("pi-memory").handler("status", ctx.context);
			return ctx.notifications.map((notice) => notice.message).join("\n");
		};
		const initial = await status();
		assert.match(initial, /Eligible now[\s\S]*m_aaaaaaaaaa/u);
		assert.match(initial, /Last assembled request: none yet/u);
		const assembled = await refresh([{ role: "user", content: "first assembly", timestamp: 1 }]);
		const firstGeneration = assembled[0].content.find((block: any) => block.piMemory?.kind === "always").piMemory.generation;
		const firstStatus = await status();
		const lastSection = (text: string) => text.slice(text.indexOf("Last assembled request:")).split("\nNote:")[0];
		assert.ok(lastSection(firstStatus).includes(firstGeneration));
		assert.match(lastSection(firstStatus), /always bodies m_aaaaaaaaaa/u);
		await remember({ action: "update", id: SEED_ID, body: "STATUS_EDIT_NOT_YET_ASSEMBLED_891cd" });
		const changed = await status();
		assert.equal(lastSection(changed), lastSection(firstStatus), "reading new eligibility must not rewrite actual assembly history");
		const next = await refresh([{ role: "user", content: "second assembly", timestamp: 2 }]);
		const nextGeneration = next[0].content.find((block: any) => block.piMemory?.kind === "always").piMemory.generation;
		assert.notEqual(nextGeneration, firstGeneration);
		const nextStatus = await status();
		assert.ok(lastSection(nextStatus).includes(nextGeneration));
		assert.equal(lastSection(nextStatus).includes(firstGeneration), false);
		ctx.notifications.length = 0;
		await harness.command("pi-memory").handler(`show project ${SEED_ID} --details`, ctx.context);
		assert.match(ctx.notifications.map((notice) => notice.message).join("\n"), /Injection: always[\s\S]*STATUS_EDIT_NOT_YET_ASSEMBLED_891cd/u);
	});

	it("still injects explicit global always when project identity cannot resolve", async () => {
		const { rig } = await setup();
		await rig.seedLegacy([{ ...legacyMemory({ body: "GLOBAL_SURVIVES_UNAVAILABLE_PROJECT_673b" }), injection: "always" }], "legacy-global");
		process.env.PI_MEMORY_MODE = "read-only";
		const harness = new ExtensionRegistrationHarness();
		createMemoryExtension({ agentDir: rig.agentDir })(harness.api);
		const ctx = makeExtensionContext(join(rig.root, "missing-project-directory"));
		await harness.emit("session_start", { reason: "startup" }, ctx.context);
		assert.match(ctx.notifications.map((notice) => notice.message).join("\n"), /PROJECT_UNAVAILABLE/u);
		const [result] = await harness.emit("context", { messages: [{ role: "user", content: "ordinary prompt", timestamp: 1 }] }, ctx.context);
		assert.equal(occurrences(result, "GLOBAL_SURVIVES_UNAVAILABLE_PROJECT_673b"), 1);
		assert.equal(occurrences(result, BODY), 0);
	});

	it("removes historical pi-memory-catalog custom messages even when automatic memory is off", async () => {
		const { rig, refresh } = await setup();
		await rig.setMode("off");
		const messages = await refresh([
			{ role: "custom", customType: "pi-memory-catalog", content: "OLD_OWNED_CUSTOM_CATALOG", display: false, timestamp: 1 },
			{ role: "custom", customType: "other-extension", content: "KEEP_OTHER_CUSTOM", display: false, timestamp: 2 },
			{ role: "user", content: QUOTED, timestamp: 3 },
		]);
		assert.equal(occurrences(messages, "OLD_OWNED_CUSTOM_CATALOG"), 0);
		assert.equal(occurrences(messages, "KEEP_OTHER_CUSTOM"), 1);
		assert.equal(occurrences(messages, QUOTED), 1);
	});
});
