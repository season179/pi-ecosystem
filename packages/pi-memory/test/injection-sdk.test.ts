import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "vitest";
import {
	assertBody, assertNoInjectionPersistence, assertToolSuccess, callTool, contextText,
	createInjectionRig, legacyMemory, nonToolText, plainPrompt, SEED_ID, CORRECTION_BODY as ALWAYS_BODY, RESEARCH_BODY as REFERENCE_BODY,
	type InjectionRig,
} from "./helpers/injection-harness.js";

const EDITED_BODY = "EDITED_ALWAYS_BODY_BEGIN_36cd88\nReplacement paragraph, not the prior body.\nEDITED_ALWAYS_BODY_END_f728ad";
const rigs = new Set<InjectionRig>();
const savedMode = process.env.PI_MEMORY_MODE;

afterEach(async () => {
	for (const rig of rigs) await rig.dispose();
	rigs.clear();
	if (savedMode === undefined) delete process.env.PI_MEMORY_MODE;
	else process.env.PI_MEMORY_MODE = savedMode;
});

async function rig(mode: "read-write" | "read-only" | "off" = "read-write") {
	// Keep developer-shell mode overrides from changing test policy.
	delete process.env.PI_MEMORY_MODE;
	const created = await createInjectionRig(mode);
	rigs.add(created);
	return created;
}

function createArgs(body: string, injection?: "always" | "on-demand", scope = "project") {
	return {
		action: "create", scope, title: "Injection contract entry", cue: "Injection contract regression",
		body, tags: ["type:reference"], ...(injection === undefined ? {} : { injection }),
	};
}

describe("real SDK always/on-demand injection contract", () => {
	it("puts the complete always body in a cold-start assembled Context, not persisted conversation", async () => {
		const setup = await rig();
		await setup.seedLegacy([legacyMemory({ title: "Synthetic on-demand index research", body: REFERENCE_BODY })]);
		const writer = await setup.start();
		const created = await callTool(writer, "remember", { ...createArgs(ALWAYS_BODY, "always"), title: "Synthetic retrospective scope correction", tags: ["type:feedback"] }, "cold-start", "setup");
		assertToolSuccess(created.result);
		const before = await setup.bytes();
		// A separately constructed runtime proves startup, not just newSession replacement.
		const reader = await setup.start({ persistSession: true });
		const capture = await plainPrompt(reader, "cold-start", "fresh");
		assertBody(contextText(capture), ALWAYS_BODY);
		assertBody(contextText(capture), REFERENCE_BODY, false);
		assert.ok(contextText(capture).includes("Synthetic on-demand index research"));
		assert.equal(contextText(capture).split("ALWAYS_FULL_BODY_BEGIN_f17ab4").length - 1, 1);
		assertBody(JSON.stringify(capture.context.systemPrompt), ALWAYS_BODY, false);
		assert.ok(contextText(capture).includes('advisory=\\"untrusted\\"'));
		assert.match(contextText(capture), /not instructions/u);
		assertBody(nonToolText(created.followup), ALWAYS_BODY);
		assert.equal((await setup.memories()).find((memory) => memory.body === ALWAYS_BODY)?.injection, "always");
		assert.deepEqual(await setup.bytes(), before, "injection must not write or repair the store");
		assertNoInjectionPersistence(reader, [ALWAYS_BODY, REFERENCE_BODY]);
		assert.ok(reader.session.sessionFile);
		assertBody(await readFile(reader.session.sessionFile, "utf8"), ALWAYS_BODY, false);
	});

	it.each([undefined, "on-demand"] as const)("omitted/explicit %s create stays out of auto context but real recall returns its full body", async (injection) => {
		const setup = await rig();
		const writer = await setup.start();
		const created = await callTool(writer, "remember", createArgs(REFERENCE_BODY, injection), `reference-${injection ?? "default"}`, "create");
		assertToolSuccess(created.result);
		const [memory] = await setup.memories();
		assert.ok(memory);
		assert.equal(memory.injection ?? "on-demand", "on-demand");
		const reader = await setup.start();
		const fresh = await plainPrompt(reader, `reference-${injection ?? "default"}`, "fresh");
		assertBody(contextText(fresh), REFERENCE_BODY, false);
		const recalled = await callTool(reader, "recall", { scope: "project", query: memory.id, includeDetails: true }, `reference-${injection ?? "default"}`, "recall");
		assertToolSuccess(recalled.result);
		assertBody(JSON.stringify(recalled.result.content), REFERENCE_BODY);
		assert.equal((recalled.result.details as { matches: Array<{ injection: string }> }).matches[0].injection, "on-demand");
		assertBody(contextText(recalled.followup), REFERENCE_BODY, true);
		assertBody(nonToolText(recalled.followup), REFERENCE_BODY, false);
		const matches = (recalled.result.details as { matches: Array<{ id: string; scope: string; body: string }> }).matches;
		assert.deepEqual(matches.map(({ id, scope, body }) => ({ id, scope, body })), [{ id: memory.id, scope: "project", body: REFERENCE_BODY }]);
	});

	it("preserves legacy authoritative bytes and omitted policy as on-demand during injection and recall", async () => {
		const setup = await rig("read-only");
		await setup.seedLegacy([legacyMemory({ body: REFERENCE_BODY })]);
		const before = await setup.bytes();
		assert.doesNotMatch(before.details, /^Injection:/mu, "fixture must actually use the legacy format");
		const reader = await setup.start();
		assertBody(contextText(await plainPrompt(reader, "legacy-project", "fresh")), REFERENCE_BODY, false);
		const recalled = await callTool(reader, "recall", { scope: "project", query: SEED_ID }, "legacy-project", "recall");
		assertToolSuccess(recalled.result);
		assertBody(JSON.stringify(recalled.result.content), REFERENCE_BODY);
		assert.deepEqual(await setup.bytes(), before);
	});

	it("promotes, edits, demotes, re-promotes, and deletes the same ID without stale automatic bodies", async () => {
		const setup = await rig();
		await setup.seedLegacy([legacyMemory({ body: ALWAYS_BODY })]);
		const subject = await setup.start();
		const phases = [
			{ name: "promote", mutation: { injection: "always" }, expectedBody: ALWAYS_BODY, policy: "always" },
			{ name: "edit-preserves-always", mutation: { body: EDITED_BODY }, expectedBody: EDITED_BODY, policy: "always" },
			{ name: "demote", mutation: { injection: "on-demand" }, expectedBody: undefined, policy: "on-demand" },
			{ name: "edit-preserves-on-demand", mutation: { body: REFERENCE_BODY }, expectedBody: undefined, policy: "on-demand" },
			{ name: "repromote", mutation: { injection: "always" }, expectedBody: REFERENCE_BODY, policy: "always" },
		] as const;
		for (const phase of phases) {
			const changed = await callTool(subject, "remember", { action: "update", scope: "project", id: SEED_ID, ...phase.mutation }, "same-id", phase.name);
			assertToolSuccess(changed.result);
			const memories = await setup.memories();
			assert.equal(memories.length, 1);
			assert.equal(memories[0].id, SEED_ID);
			assert.equal(memories[0].injection, phase.policy);
			for (const body of [ALWAYS_BODY, EDITED_BODY, REFERENCE_BODY]) {
				assertBody(nonToolText(changed.followup), body, body === phase.expectedBody);
			}
			// No historical mutation arguments/results: assert across the entire Context too.
			await subject.newSession();
			const clean = await plainPrompt(subject, "same-id", `${phase.name}-clean`);
			for (const body of [ALWAYS_BODY, EDITED_BODY, REFERENCE_BODY]) assertBody(contextText(clean), body, body === phase.expectedBody);
		}
		const deleted = await callTool(subject, "remember", { action: "delete", scope: "project", id: SEED_ID }, "same-id", "delete");
		assertToolSuccess(deleted.result);
		assert.deepEqual(await setup.memories(), []);
		assertBody(nonToolText(deleted.followup), REFERENCE_BODY, false);
		await subject.newSession();
		const clean = await plainPrompt(subject, "same-id", "delete-clean");
		for (const body of [ALWAYS_BODY, EDITED_BODY, REFERENCE_BODY]) assertBody(contextText(clean), body, false);
	});

	it("read-only injects always and permits recall but blocks promote/demote/edit/delete/create", async () => {
		const setup = await rig();
		const writer = await setup.start();
		assertToolSuccess((await callTool(writer, "remember", createArgs(ALWAYS_BODY, "always"), "readonly", "setup")).result);
		const [memory] = await setup.memories();
		await setup.setMode("read-only");
		const subject = await setup.start();
		const before = await setup.bytes();
		assertBody(contextText(await plainPrompt(subject, "readonly", "fresh")), ALWAYS_BODY);
		const recalled = await callTool(subject, "recall", { scope: "project", query: memory.id }, "readonly", "recall");
		assertToolSuccess(recalled.result);
		assertBody(JSON.stringify(recalled.result.content), ALWAYS_BODY);
		const mutations = [
			{ action: "update", id: memory.id, injection: "on-demand" },
			{ action: "update", id: memory.id, injection: "always" },
			{ action: "update", id: memory.id, body: EDITED_BODY },
			{ action: "delete", id: memory.id },
			createArgs(REFERENCE_BODY, "always"),
		];
		for (const [index, mutation] of mutations.entries()) {
			const blocked = await callTool(subject, "remember", { ...mutation, scope: "project" }, "readonly", `blocked-${index}`);
			assert.equal(blocked.result.isError, true);
			assert.match(JSON.stringify(blocked.result.content), /PI_MEMORY_READ_ONLY/u);
			assert.deepEqual(await setup.bytes(), before);
			assertBody(nonToolText(blocked.followup), ALWAYS_BODY);
			assertBody(nonToolText(blocked.followup), EDITED_BODY, false);
		}
	});

	it("keeps same-ID project/global entries isolated and never auto-injects global on-demand bodies",  async () => {
		const setup = await rig();
		await setup.seedLegacy([legacyMemory({ body: ALWAYS_BODY })]);
		await setup.seedLegacy([legacyMemory({ title: "Global twin", body: REFERENCE_BODY })], "legacy-global");
		const writer = await setup.start();
		const globalBefore = await setup.bytes("legacy-global");
		assertToolSuccess((await callTool(writer, "remember", { action: "update", scope: "project", id: SEED_ID, injection: "always" }, "scope", "promote-project")).result);
		assert.deepEqual(await setup.bytes("legacy-global"), globalBefore);
		const subject = await setup.start();
		const fresh = await plainPrompt(subject, "scope", "fresh");
		assertBody(contextText(fresh), ALWAYS_BODY);
		assertBody(contextText(fresh), REFERENCE_BODY, false);
		const project = await callTool(subject, "recall", { scope: "project", query: SEED_ID }, "scope", "recall-project");
		assertToolSuccess(project.result);
		assertBody(JSON.stringify(project.result.content), ALWAYS_BODY);
		assertBody(JSON.stringify(project.result.content), REFERENCE_BODY, false);
		const global = await callTool(subject, "recall", { scope: "legacy-global", query: SEED_ID }, "scope", "recall-global");
		assertToolSuccess(global.result);
		assertBody(JSON.stringify(global.result.content), REFERENCE_BODY);
		assertBody(JSON.stringify(global.result.content), ALWAYS_BODY, false);
		const all = await callTool(subject, "recall", { scope: "all", query: SEED_ID }, "scope", "recall-all");
		assertToolSuccess(all.result);
		assert.deepEqual((all.result.details as { matches: Array<{ scope: string; id: string }> }).matches.map(({ scope, id }) => [scope, id]).sort(), [["legacy-global", SEED_ID], ["project", SEED_ID]]);
		const projectBefore = await setup.bytes();
		assertToolSuccess((await callTool(subject, "remember", { action: "delete", scope: "legacy-global", id: SEED_ID }, "scope", "delete-global")).result);
		assert.deepEqual(await setup.bytes(), projectBefore);
	});

	it("retains scope-less legacy tool compatibility without implicitly enabling global injection", async () => {
		const setup = await rig("off");
		await setup.seedLegacy([legacyMemory({ body: ALWAYS_BODY })]);
		await setup.seedLegacy([legacyMemory({ body: REFERENCE_BODY })], "legacy-global");
		const projectBefore = await setup.bytes();
		const subject = await setup.start();
		const recalled = await callTool(subject, "recall", { query: SEED_ID }, "legacy-scopeless", "recall");
		assertToolSuccess(recalled.result);
		assertBody(JSON.stringify(recalled.result.content), REFERENCE_BODY);
		assertBody(JSON.stringify(recalled.result.content), ALWAYS_BODY, false);
		const changed = await callTool(subject, "remember", { action: "update", id: SEED_ID, body: EDITED_BODY }, "legacy-scopeless", "update");
		assertToolSuccess(changed.result);
		assert.equal((await setup.memories("legacy-global"))[0].body, EDITED_BODY);
		assert.deepEqual(await setup.bytes(), projectBefore);
		await subject.newSession();
		const fresh = await plainPrompt(subject, "legacy-scopeless", "fresh");
		for (const body of [ALWAYS_BODY, REFERENCE_BODY, EDITED_BODY]) assertBody(contextText(fresh), body, false);
	});

	it.each(["unknown", "Always", "", null, 1, {}, []].map((injection) => ({ injection })))("rejects malformed injection $injection in actual SDK validation without mutating storage", async ({ injection }) => {
		const setup = await rig();
		await setup.seedLegacy([legacyMemory({ body: REFERENCE_BODY })]);
		const before = await setup.bytes();
		const subject = await setup.start();
		for (const action of ["create", "update"] as const) {
			const args = action === "create" ? createArgs(ALWAYS_BODY) : { action, scope: "project", id: SEED_ID, body: EDITED_BODY };
			const attempt = await callTool(subject, "remember", { ...args, injection }, `invalid-${typeof injection}-${JSON.stringify(injection).replace(/[^a-z0-9]/gu, "") || "empty"}`, action);
			assert.equal(attempt.result.isError, true, "unknown policy must not be ignored or downgraded");
			assert.match(JSON.stringify(attempt.result.content), /injection/iu);
			assert.deepEqual(await setup.bytes(), before);
		}
	});
});
