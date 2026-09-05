// Regenerate inspection views only from actual SDK evidence, never from a renderer.
// Usage: node test/helpers/write-injection-manifest.mjs <PI_MEMORY_EVIDENCE_DIR>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2] ?? process.env.PI_MEMORY_EVIDENCE_DIR;
assert.ok(root, "Pass an evidence directory or set PI_MEMORY_EVIDENCE_DIR after running the injection tests.");
const correction = "When asked for a retrospective, limit the work to analysis. Do not write tests or project instructions unless the current user request explicitly asks for them.";
const canaries = ["ALWAYS_FULL_BODY_BEGIN_f17ab4", "ALWAYS_FULL_BODY_MIDDLE_61a193", "ALWAYS_FULL_BODY_END_8cd905"];
const scenarios = [
	{ phase: "fresh", source: "cold-start--fresh.json", reference: "Synthetic on-demand index research", preRoles: ["user"], providerRoles: ["user"] },
	{ phase: "postcompact", source: "split-turn--postcompact.json", reference: "Synthetic index research", preRoles: ["compactionSummary", "assistant", "toolResult"], providerRoles: ["user", "assistant", "toolResult"] },
];
const manifest = {
	provenance: "Extracted from actual real SDK assembled provider Context captures. See verification.log for the test-run verdicts.",
	regenerate: "node packages/pi-memory/test/helpers/write-injection-manifest.mjs <evidence-directory>",
	contexts: [],
};
for (const scenario of scenarios) {
	const capture = JSON.parse(await readFile(join(root, scenario.source), "utf8"));
	const last = capture.captures.at(-1);
	const context = last.context;
	const input = capture.preMemoryContextInputs.find((candidate) => candidate.captureIndex === last.index);
	assert.ok(input, "Selected provider request must have an actual observed pre-memory input.");
	const text = JSON.stringify(context);
	const providerRoles = context.messages.map((message) => message.role);
	const preConversionRoles = input.messages.map((message) => message.role);
	assert.deepEqual(preConversionRoles, scenario.preRoles);
	assert.deepEqual(providerRoles, scenario.providerRoles);
	assert.ok(text.includes(correction));
	assert.ok(text.includes(scenario.reference), "Reference metadata must be present so body absence is non-vacuous.");
	assert.equal(text.includes("ON_DEMAND_REFERENCE"), false);
	assert.equal(context.systemPrompt?.includes(canaries[0]), false);
	const canaryOccurrences = Object.fromEntries(canaries.map((canary) => [canary, text.split(canary).length - 1]));
	for (const count of Object.values(canaryOccurrences)) assert.equal(count, 1);
	const file = `${scenario.phase}-assembled-context.json`;
	const bytes = `${JSON.stringify(context, null, 2)}\n`;
	await writeFile(join(root, file), bytes, { mode: 0o600 });
	manifest.contexts.push({
		phase: scenario.phase, source: scenario.source, captureIndex: last.index, file,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		preConversionRoles, literalUserCountBeforeConversion: preConversionRoles.filter((role) => role === "user").length,
		providerRoles, completeCorrectionPresent: true, canaryOccurrences,
		referenceMetadataPresent: true, referenceCanariesAbsent: true, correctionNotInSystem: true,
	});
}
await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(join(root, "manifest.json"));
