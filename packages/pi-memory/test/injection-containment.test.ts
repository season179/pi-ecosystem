import assert from "node:assert/strict";
import { readFile, rename, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { assertBody, contextText, createInjectionRig, legacyMemory, plainPrompt, type InjectionMemory, type InjectionRig } from "./helpers/injection-harness.js";

const rigs = new Set<InjectionRig>();
const originalMode = process.env.PI_MEMORY_MODE;
afterEach(async () => {
	for (const rig of rigs) await rig.dispose();
	rigs.clear();
	if (originalMode === undefined) delete process.env.PI_MEMORY_MODE;
	else process.env.PI_MEMORY_MODE = originalMode;
});

async function signature(path: string) {
	const value = await stat(path, { bigint: true });
	return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}`;
}

describe.skipIf(process.platform === "win32")("cached always injection containment", () => {
	it.each(["project", "legacy-global"] as const)("rejects a same-signature %s details symlink swap before serving a cached body", async (affected) => {
		delete process.env.PI_MEMORY_MODE;
		const rig = await createInjectionRig();
		rigs.add(rig);
		const project: InjectionMemory = { ...legacyMemory({ body: "CACHED_PROJECT_ALWAYS_7c28b3" }), injection: "always" };
		const global: InjectionMemory = { ...legacyMemory({ body: "CACHED_GLOBAL_ALWAYS_94e1ba" }), injection: "always" };
		await rig.seedLegacy([project]);
		await rig.seedLegacy([global], "legacy-global");
		const subject = await rig.start();
		const initial = await plainPrompt(subject, `containment-${affected}`, "cached");
		assertBody(contextText(initial), project.body);
		assertBody(contextText(initial), global.body);
		const path = join(affected === "project" ? rig.projectDirectory : rig.memoryRoot, "details.md");
		const outside = join(rig.root, `outside-${affected}-details.md`);
		const bytes = await readFile(path);
		const before = await signature(path);
		await rename(path, outside);
		await symlink(outside, path, "file");
		assert.equal(await signature(path), before, "followed stat cache key must actually remain identical");
		const refreshed = await plainPrompt(subject, `containment-${affected}`, "symlink-swapped");
		assertBody(contextText(refreshed), affected === "project" ? project.body : global.body, false);
		assertBody(contextText(refreshed), affected === "project" ? global.body : project.body);
		assert.deepEqual(await readFile(outside), bytes, "outside target must remain unchanged");
	});
});
