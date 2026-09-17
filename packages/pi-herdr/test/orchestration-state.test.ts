import assert from "node:assert/strict";
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
		const missing = loadOrchestrationSkill(new URL("file:///nonexistent/SKILL.md"));
		assert.ok("error" in missing);
	});
});
