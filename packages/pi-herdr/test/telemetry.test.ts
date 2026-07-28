import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { appendTelemetry } from "../src/telemetry.js";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-herdr-telemetry-"));
}

describe("appendTelemetry", () => {
	it("appends two records as two parseable JSON lines", () => {
		const path = join(tmpDir(), "telemetry.jsonl");
		appendTelemetry(path, { event: "armed", target: "w1" });
		appendTelemetry(path, { event: "fired", target: "w1", ms: 1234 });

		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]);
		const second = JSON.parse(lines[1]);
		assert.equal(first.event, "armed");
		assert.equal(second.event, "fired");
		assert.equal(second.ms, 1234);
	});

	it("creates missing parent directories recursively", () => {
		const dir = tmpDir();
		const path = join(dir, "nested", "deep", "telemetry.jsonl");
		appendTelemetry(path, { ok: true });
		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		assert.equal(lines.length, 1);
		assert.deepEqual(JSON.parse(lines[0]), { ok: true });
	});

	it("is a no-op (and does not throw) when path is empty", () => {
		const dir = tmpDir();
		assert.doesNotThrow(() =>
			appendTelemetry("", { event: "should-not-write" }),
		);
		// nothing created under the temp dir
		assert.throws(
			() => statSync(join(dir, "telemetry.jsonl")),
			(err) => (err as NodeJS.ErrnoException).code === "ENOENT",
		);
	});

	it("does not throw when the path is unwritable (parent is a file)", () => {
		const dir = tmpDir();
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "i am a file, not a directory");
		const impossible = join(blocker, "telemetry.jsonl");
		assert.doesNotThrow(() => appendTelemetry(impossible, { event: "x" }));
	});
});
