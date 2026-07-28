import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { runHerdr } from "../src/herdr-cli.js";

const fixture = fileURLToPath(
	new URL("./fixtures/fake-herdr.mjs", import.meta.url),
);
const originalCommand = process.env.PI_HERDR_COMMAND;
const originalBehavior = process.env.FAKE_HERDR_BEHAVIOR;

beforeEach(() => {
	process.env.PI_HERDR_COMMAND = fixture;
	process.env.FAKE_HERDR_BEHAVIOR = "ok";
});

afterEach(() => {
	if (originalCommand === undefined) delete process.env.PI_HERDR_COMMAND;
	else process.env.PI_HERDR_COMMAND = originalCommand;
	if (originalBehavior === undefined) delete process.env.FAKE_HERDR_BEHAVIOR;
	else process.env.FAKE_HERDR_BEHAVIOR = originalBehavior;
});

describe("runHerdr", () => {
	it("runs the configured executable and parses its JSON output", async () => {
		const args = ["agent", "wait", "reviewer", "--until", "done"];
		const result = await runHerdr(args);

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.json, {
			id: "x",
			result: { type: "agent_info", echo: args },
		});
		assert.equal(result.stderr, "");
	});

	it("captures a non-JSON error from a bad exit", async () => {
		process.env.FAKE_HERDR_BEHAVIOR = "bad-exit";
		const result = await runHerdr([]);

		assert.equal(result.exitCode, 3);
		assert.equal(result.json, undefined);
		assert.equal(result.errorJson, undefined);
		assert.match(result.stderr, /not-json garbage/u);
	});

	it("kills and resolves a child when its timeout expires", async () => {
		process.env.FAKE_HERDR_BEHAVIOR = "stall";
		const startedAt = Date.now();
		const result = await runHerdr([], { timeoutMs: 100 });

		assert.equal(result.exitCode, null);
		assert.ok(Date.now() - startedAt < 2_000);
	});

	it("kills and resolves a child when its signal is aborted", async () => {
		process.env.FAKE_HERDR_BEHAVIOR = "stall";
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = runHerdr([], {
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);

		const result = await pending;
		assert.equal(result.exitCode, null);
		assert.ok(Date.now() - startedAt < 2_000);
	});

	it("resolves an ENOENT spawn error", async () => {
		process.env.PI_HERDR_COMMAND = join(
			tmpdir(),
			`missing-herdr-${process.pid}-${Date.now()}`,
		);
		assert.equal(existsSync(process.env.PI_HERDR_COMMAND), false);

		const result = await runHerdr([]);

		assert.equal(result.exitCode, null);
		assert.match(result.stderr, /ENOENT|no such file/iu);
	});
});
