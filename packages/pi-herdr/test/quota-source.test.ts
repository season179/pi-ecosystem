import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { collectQuota, type QuotaGroup } from "../src/quota-source.js";

const keys = ["PI_HERDR_CODEXBAR", "FAKE_CODEXBAR_LOG", "FAKE_CODEXBAR_MODE"] as const;
let old: Array<string | undefined>;
let dir: string;
const group: QuotaGroup = { id: "fable", provider: "claude", source: "cli", account: "A named account", profiles: ["claude-fable"] };
beforeEach(() => {
	old = keys.map(k => process.env[k]); dir = mkdtempSync(join(tmpdir(), "herdr-quota-source-"));
	process.env.PI_HERDR_CODEXBAR = fileURLToPath(new URL("./fixtures/fake-codexbar.mjs", import.meta.url));
	process.env.FAKE_CODEXBAR_LOG = join(dir, "args.jsonl"); delete process.env.FAKE_CODEXBAR_MODE;
});
afterEach(() => { keys.forEach((k, i) => old[i] === undefined ? delete process.env[k] : process.env[k] = old[i]); rmSync(dir, { recursive: true, force: true }); });

describe.sequential("bounded CodexBar executable boundary", () => {
	it("passes provider/source/account as individual argv and returns sanitized data", async () => {
		const result = await collectQuota(group, new AbortController().signal);
		const args = JSON.parse(readFileSync(process.env.FAKE_CODEXBAR_LOG!, "utf8"));
		assert.deepEqual(args.slice(-2), ["--account", "A named account"]);
		assert.deepEqual(args.slice(0, 5), ["usage", "--provider", "claude", "--source", "cli"]);
		assert.equal(result.windows[0]!.usedPercent, 95);
		assert.doesNotMatch(JSON.stringify(result), /private@example|secret/);
	});
	it("sanitizes CLI diagnostics and malformed/oversized output", async () => {
		for (const mode of ["invalid", "error", "oversized"]) {
			process.env.FAKE_CODEXBAR_MODE = mode;
			await assert.rejects(collectQuota(group, new AbortController().signal), error => !/secret/.test(String(error)));
		}
	});
	it("aborts a hung CLI and does not start when already cancelled", async () => {
		process.env.FAKE_CODEXBAR_MODE = "hang";
		const controller = new AbortController();
		const work = collectQuota(group, controller.signal);
		const rejected = assert.rejects(work, /cancelled/);
		await vi.waitFor(() => assert.ok(existsSync(process.env.FAKE_CODEXBAR_LOG!)), { timeout: 3000 });
		controller.abort();
		await rejected;
		await assert.rejects(collectQuota(group, AbortSignal.abort()), /cancelled/);
		assert.equal(readFileSync(process.env.FAKE_CODEXBAR_LOG!, "utf8").trim().split("\n").length, 1);
	});
});
