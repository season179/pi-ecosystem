import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { DEFAULT_CONFIG, loadHerdrConfig } from "../src/config.js";
import { ConfigError } from "../src/types.js";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-herdr-config-"));
}

function withConfig(json: string): string {
	const dir = tmpDir();
	writeFileSync(join(dir, "herdr.json"), json);
	return dir;
}

describe("loadHerdrConfig", () => {
	it("missing file returns defaults as a fresh copy", () => {
		const dir = tmpDir();
		const cfg = loadHerdrConfig(dir);
		assert.notEqual(cfg, DEFAULT_CONFIG, "must not be the same object reference");
		assert.equal(cfg.maxWatches, DEFAULT_CONFIG.maxWatches);
		assert.equal(cfg.wakeBudget, DEFAULT_CONFIG.wakeBudget);
		assert.equal(cfg.includeTailLines, DEFAULT_CONFIG.includeTailLines);
		assert.deepEqual(cfg.toastOn, DEFAULT_CONFIG.toastOn);
		assert.notEqual(cfg.toastOn, DEFAULT_CONFIG.toastOn, "toastOn must be a fresh array");
		// default telemetryPath carries a leading ~/ that loadHerdrConfig expands
		assert.equal(
			cfg.telemetryPath,
			join(homedir(), ".pi", "agent", "herdr-telemetry.jsonl"),
		);
		// mutating the copy must not leak into DEFAULT_CONFIG
		cfg.toastOn.push("idle");
		assert.deepEqual(DEFAULT_CONFIG.toastOn, ["blocked"]);
	});

	it("merges a valid partial file with the defaults", () => {
		const dir = withConfig(JSON.stringify({ wakeBudget: 5 }));
		const cfg = loadHerdrConfig(dir);
		assert.equal(cfg.wakeBudget, 5);
		assert.equal(cfg.maxWatches, DEFAULT_CONFIG.maxWatches);
		assert.equal(cfg.includeTailLines, DEFAULT_CONFIG.includeTailLines);
		assert.deepEqual(cfg.toastOn, DEFAULT_CONFIG.toastOn);
	});

	it("expands a leading ~/ in telemetryPath", () => {
		const dir = withConfig(
			JSON.stringify({ telemetryPath: "~/logs/herdr.jsonl" }),
		);
		const cfg = loadHerdrConfig(dir);
		assert.equal(cfg.telemetryPath, join(homedir(), "logs", "herdr.jsonl"));
	});

	it("leaves an absolute telemetryPath untouched", () => {
		const abs = join(tmpDir(), "t.jsonl");
		const dir = withConfig(JSON.stringify({ telemetryPath: abs }));
		assert.equal(loadHerdrConfig(dir).telemetryPath, abs);
	});

	it("accepts all typed fields", () => {
		const dir = withConfig(
			JSON.stringify({
				maxWatches: 3,
				wakeBudget: 0,
				includeTailLines: 0,
				toastOn: ["blocked", "idle"],
				telemetryPath: "",
			}),
		);
		const cfg = loadHerdrConfig(dir);
		assert.equal(cfg.maxWatches, 3);
		assert.equal(cfg.wakeBudget, 0);
		assert.equal(cfg.includeTailLines, 0);
		assert.deepEqual(cfg.toastOn, ["blocked", "idle"]);
		assert.equal(cfg.telemetryPath, "");
	});

	it("throws ConfigError naming an unknown key", () => {
		const dir = withConfig(JSON.stringify({ maxWathes: 8 }));
		assert.throws(
			() => loadHerdrConfig(dir),
			(err) =>
				err instanceof ConfigError &&
				/maxWathes/.test(err.message),
		);
	});

	it("throws ConfigError on wrong-typed maxWatches", () => {
		const dir = withConfig(JSON.stringify({ maxWatches: "8" }));
		assert.throws(
			() => loadHerdrConfig(dir),
			(err) =>
				err instanceof ConfigError &&
				/maxWatches/.test(err.message),
		);
	});

	it("throws ConfigError on a negative integer", () => {
		const dir = withConfig(JSON.stringify({ wakeBudget: -1 }));
		assert.throws(
			() => loadHerdrConfig(dir),
			(err) => err instanceof ConfigError && /wakeBudget/.test(err.message),
		);
	});

	it("throws ConfigError on a non-string-array toastOn", () => {
		const dir = withConfig(JSON.stringify({ toastOn: "blocked" }));
		assert.throws(
			() => loadHerdrConfig(dir),
			(err) => err instanceof ConfigError && /toastOn/.test(err.message),
		);
	});

	it("throws ConfigError on invalid JSON", () => {
		const dir = withConfig("{ not json");
		assert.throws(
			() => loadHerdrConfig(dir),
			(err) =>
				err instanceof ConfigError && /herdr\.json/.test(err.message),
		);
	});

	it("throws ConfigError when the file is not a JSON object", () => {
		const dir = withConfig(JSON.stringify([1, 2, 3]));
		assert.throws(
			() => loadHerdrConfig(dir),
			(err) => err instanceof ConfigError,
		);
	});

	it("throws ConfigError on a non-string telemetryPath", () => {
		const dir = withConfig(JSON.stringify({ telemetryPath: 42 }));
		assert.throws(
			() => loadHerdrConfig(dir),
			(err) =>
				err instanceof ConfigError && /telemetryPath/.test(err.message),
		);
	});
});
