import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createSdkHarness, type SdkHarness } from "./helpers/sdk-harness.js";
import {
	assertBody, assertNoInjectionPersistence, assertToolSuccess, callTool, contextText,
	CORRECTION_BODY, createInjectionRig, legacyMemory, nonToolText, plainPrompt, RESEARCH_BODY, saveInjectionEvidence, SEED_ID,
	type InjectionRig,
} from "./helpers/injection-harness.js";
import { splitTurnRequest } from "./helpers/split-turn-injection.js";

const rigs = new Set<InjectionRig>();
const extraSubjects = new Set<SdkHarness>();
const originalMode = process.env.PI_MEMORY_MODE;
afterEach(async () => {
	for (const subject of extraSubjects) await subject.dispose();
	extraSubjects.clear();
	for (const rig of rigs) await rig.dispose();
	rigs.clear();
	if (originalMode === undefined) delete process.env.PI_MEMORY_MODE;
	else process.env.PI_MEMORY_MODE = originalMode;
});

async function setup(scenario: string) {
	delete process.env.PI_MEMORY_MODE;
	const rig = await createInjectionRig();
	rigs.add(rig);
	await rig.seedLegacy([
		legacyMemory({ body: CORRECTION_BODY, tags: ["type:feedback"], title: "Synthetic retrospective scope correction" }),
		legacyMemory({ id: "m_bbbbbbbbbb", body: RESEARCH_BODY, title: "Synthetic index research" }),
	]);
	const writer = await rig.start();
	assertToolSuccess((await callTool(writer, "remember", { action: "update", scope: "project", id: SEED_ID, body: CORRECTION_BODY, injection: "always" }, scenario, "setup")).result);
	return { rig, writer };
}

describe("always bodies through real SDK lifecycle replacement and compaction", () => {
	it("reinjects the complete correction on split-turn automatic continuation with no literal user retained", async () => {
		const { rig } = await setup("split-turn");
		const subject = await rig.start({ persistSession: true, compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 20 } });
		const result = await splitTurnRequest(subject, "split-turn");
		for (const capture of [result.fresh, result.postcompact]) {
			assertBody(contextText(capture), CORRECTION_BODY);
			assertBody(contextText(capture), RESEARCH_BODY, false);
		}
		assert.deepEqual(result.postcompact.context.messages.map((message) => message.role), ["user", "assistant", "toolResult"], "summary conversion carries injection without a synthetic trailing user");
		assertBody(contextText(result.summarizer), CORRECTION_BODY, false);
		assertBody(contextText(result.summarizer), RESEARCH_BODY, false);
		assertNoInjectionPersistence(subject, [CORRECTION_BODY, RESEARCH_BODY]);
		assert.ok(subject.session.sessionFile);
		assertBody(await readFile(subject.session.sessionFile, "utf8"), CORRECTION_BODY, false);
	});

	it.each(["reload", "new", "resume", "fork"] as const)("%s refreshes external edits and then removals without stale injection", async (operation) => {
		const { rig, writer } = await setup(`lifecycle-${operation}`);
		const subject = await rig.start({ persistSession: true });
		assertBody(contextText(await plainPrompt(subject, `lifecycle-${operation}`, "fresh")), CORRECTION_BODY);
		const savedPath = subject.session.sessionFile;
		assert.ok(savedPath);
		const forkPoint = subject.entries().find((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(forkPoint);
		const replacement = "LIFECYCLE_REPLACEMENT_BODY_2b896d";
		assertToolSuccess((await callTool(writer, "remember", { action: "update", scope: "project", id: SEED_ID, body: replacement }, `lifecycle-${operation}`, "external-edit")).result);
		const replace = async () => {
			if (operation === "reload") await subject.reload();
			else if (operation === "new") await subject.newSession();
			else if (operation === "fork") await subject.fork(forkPoint.id);
			else { await subject.newSession(); await subject.resume(savedPath); }
		};
		await replace();
		const edited = await plainPrompt(subject, `lifecycle-${operation}`, "edited");
		assertBody(contextText(edited), CORRECTION_BODY, false);
		assertBody(contextText(edited), replacement);
		assertToolSuccess((await callTool(writer, "remember", { action: "delete", scope: "project", id: SEED_ID }, `lifecycle-${operation}`, "external-delete")).result);
		await replace();
		const deleted = await plainPrompt(subject, `lifecycle-${operation}`, "deleted");
		assertBody(contextText(deleted), CORRECTION_BODY, false);
		assertBody(contextText(deleted), replacement, false);
		assertNoInjectionPersistence(subject, [CORRECTION_BODY, replacement]);
	});

	it("omits transient full bodies from a real branch summarizer then reinjects on the next ordinary request", async () => {
		const { rig } = await setup("branch-summary");
		const subject = await rig.start({ persistSession: true });
		await plainPrompt(subject, "branch-summary", "first");
		const target = subject.entries().find((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(target);
		await plainPrompt(subject, "branch-summary", "abandoned");
		const before = subject.captures.length;
		subject.enqueueResponses({ kind: "text", text: "Synthetic branch summary of ordinary conversation only." });
		try { await subject.session.navigateTree(target.id, { summarize: true }); }
		finally { await saveInjectionEvidence("branch-summary", "summarized", subject); }
		assert.equal(subject.captures.length, before + 1);
		assertBody(contextText(subject.captures[before]), CORRECTION_BODY, false);
		assertBody(contextText(subject.captures[before]), RESEARCH_BODY, false);
		assert.ok(subject.entries().some((entry) => entry.type === "branch_summary"));
		const next = await plainPrompt(subject, "branch-summary", "next-ordinary");
		assertBody(contextText(next), CORRECTION_BODY);
		assertNoInjectionPersistence(subject, [CORRECTION_BODY, RESEARCH_BODY]);
	});

	it("explicit global always works in another project and readonly, while project memory stays isolated; off suppresses both", async () => {
		const { rig, writer } = await setup("global-opt-in");
		const globalBody = "EXPLICIT_GLOBAL_ALWAYS_BODY_5ee0da";
		assertToolSuccess((await callTool(writer, "remember", { action: "create", scope: "legacy-global", title: "Explicit global correction", cue: "Across projects", body: globalBody, injection: "always" }, "global-opt-in", "create")).result);
		const projectReader = await rig.start();
		const local = await plainPrompt(projectReader, "global-opt-in", "original-project");
		assertBody(contextText(local), CORRECTION_BODY);
		assertBody(contextText(local), globalBody);
		const otherCwd = join(rig.root, "other-project");
		await mkdir(otherCwd);
		// A mode override enables this distinct project without guessing any new global config setting.
		process.env.PI_MEMORY_MODE = "read-only";
		const other = await createSdkHarness({ cwd: otherCwd, agentDir: rig.agentDir, responses: [] });
		extraSubjects.add(other);
		const isolated = await plainPrompt(other, "global-opt-in", "other-project-readonly");
		assertBody(contextText(isolated), CORRECTION_BODY, false);
		assertBody(contextText(isolated), globalBody);
		const [global] = await rig.memories("legacy-global");
		const updated = await callTool(other, "remember", { action: "update", scope: "legacy-global", id: global.id, body: "GLOBAL_UPDATED_READONLY_419c" }, "global-opt-in", "readonly-global-write");
		assertToolSuccess(updated.result);
		assertBody(nonToolText(updated.followup), "GLOBAL_UPDATED_READONLY_419c");
		assertBody(nonToolText(updated.followup), globalBody, false);
		const demoted = await callTool(other, "remember", { action: "update", scope: "legacy-global", id: global.id, injection: "on-demand" }, "global-opt-in", "demote");
		assertToolSuccess(demoted.result);
		assertBody(nonToolText(demoted.followup), "GLOBAL_UPDATED_READONLY_419c", false);
		const promoted = await callTool(other, "remember", { action: "update", scope: "legacy-global", id: global.id, injection: "always" }, "global-opt-in", "promote");
		assertToolSuccess(promoted.result);
		assertBody(nonToolText(promoted.followup), "GLOBAL_UPDATED_READONLY_419c");
		const deleted = await callTool(other, "remember", { action: "delete", scope: "legacy-global", id: global.id }, "global-opt-in", "delete");
		assertToolSuccess(deleted.result);
		assertBody(nonToolText(deleted.followup), "GLOBAL_UPDATED_READONLY_419c", false);
		const recreated = await callTool(other, "remember", { action: "create", scope: "legacy-global", title: "Global off gate", cue: "Off suppression", body: globalBody, injection: "always" }, "global-opt-in", "recreate");
		assertToolSuccess(recreated.result);
		assertBody(nonToolText(recreated.followup), globalBody);
		process.env.PI_MEMORY_MODE = "off";
		await other.newSession();
		const disabled = await plainPrompt(other, "global-opt-in", "off");
		for (const body of [CORRECTION_BODY, globalBody, "GLOBAL_UPDATED_READONLY_419c"]) assertBody(contextText(disabled), body, false);
	});
});
