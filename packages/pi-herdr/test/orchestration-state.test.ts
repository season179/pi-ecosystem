import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import {
	loadOrchestrationSkill,
	parseOrchestrateArgs,
	readOrchestrationState,
	stripFrontmatter,
	summarizeRoutingStatus,
} from "../src/orchestration-state.js";

const entry = (active: boolean, sessionId: string) => ({
	type: "custom",
	customType: "pi-herdr-orchestration",
	data: { active, sessionId, source: "command", at: "t" },
});

describe("orchestration state helpers", () => {
	it("latest own entry wins; foreign entries only mark inheritance", () => {
		assert.deepEqual(readOrchestrationState([], "s1"), { active: false, inherited: false });
		const own = readOrchestrationState([entry(true, "s1"), entry(false, "s1")], "s1");
		assert.equal(own.active, false);
		assert.equal(own.inherited, false);
		const forked = readOrchestrationState([entry(true, "parent")], "child");
		assert.deepEqual(forked, { active: false, inherited: true });
		const mixed = readOrchestrationState(
			[entry(true, "parent"), { type: "custom", customType: "pi-herdr-orchestration", data: { junk: 1 } }, entry(true, "child")],
			"child",
		);
		assert.equal(mixed.active, true);
		assert.equal(mixed.inherited, true);
	});

	it("parses only bare activation or off", () => {
		assert.deepEqual(parseOrchestrateArgs(""), { kind: "on" });
		assert.deepEqual(parseOrchestrateArgs(" OFF "), { kind: "off" });
		assert.deepEqual(parseOrchestrateArgs("off now"), { kind: "unknown", argument: "off now" });
	});

	it("summarizes routing guidance to its first sentence", () => {
		assert.equal(summarizeRoutingStatus("Routing ready: 5 enabled profiles; call herdr_route. Policy: x."), "Routing ready: 5 enabled profiles; call herdr_route");
		assert.equal(summarizeRoutingStatus("Routing setup required: Cannot read /a/herdr-routing.json (ENOENT). Review docs."), "Routing setup required: Cannot read /a/herdr-routing.json (ENOENT)");
		assert.equal(summarizeRoutingStatus("no period"), "no period");
	});

	it("loads the bundled skill body without frontmatter", () => {
		assert.equal(stripFrontmatter("---\nname: x\n---\nbody\n"), "body");
		assert.equal(stripFrontmatter("no frontmatter"), "no frontmatter");
		const skill = loadOrchestrationSkill();
		assert.ok("body" in skill, JSON.stringify(skill));
		assert.ok(skill.body.startsWith("# Herdr orchestration"));
		assert.equal(readFileSync(resolve(skill.directory, "SKILL.md"), "utf8").includes(skill.body), true);
		const missing = loadOrchestrationSkill(new URL("file:///nonexistent/SKILL.md"));
		assert.ok("error" in missing);
	});

	it("keeps conditional references linked, readable, and out of the loaded core", () => {
		const skill = loadOrchestrationSkill();
		assert.ok("body" in skill);
		assert.match(skill.body, /Do not load all references by default/);
		assert.match(skill.body, /verify eligible external harnesses before first dispatch/);
		assert.match(skill.body, /use automatic selection unless the user specifies a route/);
		assert.match(skill.body, /Reuse available shell panes in the current Herdr workspace, including panes not created by this session/);
		assert.match(skill.body, /Missing\/invalid policy.*read \[Routing decisions\]/);
		assert.match(skill.body, /Pause\/deadline handoff.*read \[Recovery and handoff\]/);
		const links = [...skill.body.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]!);
		assert.deepEqual(links, ["references/routing.md", "references/recovery.md"]);
		for (const link of links) {
			const reference = readFileSync(resolve(skill.directory, link), "utf8");
			assert.ok(reference.startsWith("# "), `${link} readable from the supplied directory`);
			assert.ok(!skill.body.includes(reference.split("\n")[0]!), "reference content is not eagerly injected");
			assert.doesNotMatch(reference, /\]\([^)]*\.md\)/, "no nested reference chain");
		}
	});
});
