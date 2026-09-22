import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { fetchClaudeQuota, formatClaudeQuota } from "../src/claude-quota.js";

const keychain = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: keychain }));
const TOKEN = "private-test-token";
const RESET = "2026-09-26T15:59:59.000Z";
const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } });
const USAGE = {
	five_hour: { utilization: 24, resets_at: RESET },
	seven_day: { utilization: 45, resets_at: RESET },
	seven_day_opus: null,
	seven_day_sonnet: null,
	limits: [
		{ kind: "session", percent: 24, resets_at: RESET },
		{ kind: "weekly_scoped", percent: 89, resets_at: RESET, scope: { model: { display_name: "Fable" }, surface: null } },
	],
};
const reply = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });
let dir: string;
let authPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-herdr-claude-"));
	authPath = join(dir, ".credentials.json");
	writeFileSync(authPath, LOGIN);
	vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
	keychain.mockReset();
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("fetchClaudeQuota", () => {
	it("reads the configured login and reports scoped Fable usage without duplicating aggregate limits", async () => {
		const fetchImpl = vi.fn<typeof fetch>(reply({ ...USAGE, email: "private", token: TOKEN }));
		const snapshot = await fetchClaudeQuota({ fetchImpl });
		assert.deepEqual(snapshot.windows, [
			{ label: "5h", usedPercent: 24, resetsAt: RESET },
			{ label: "Weekly", usedPercent: 45, resetsAt: RESET },
			{ label: "Weekly (Fable)", usedPercent: 89, resetsAt: RESET },
		]);
		assert.deepEqual(Object.keys(snapshot).sort(), ["checkedAt", "windows"]);
		assert.ok(!JSON.stringify(snapshot).includes(TOKEN));
		assert.match(formatClaudeQuota(snapshot), /Fable.*89%/);
		assert.ok(formatClaudeQuota(snapshot).includes(snapshot.checkedAt));
		const [url, init] = fetchImpl.mock.calls[0]!;
		assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("Authorization"), `Bearer ${TOKEN}`);
		assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
		assert.equal(keychain.mock.calls.length, 0);
	});

	it("keeps unknown reset times and rejects absent or malformed quota data", async () => {
		const snapshot = await fetchClaudeQuota({ authPath, fetchImpl: reply({ five_hour: { utilization: 0, resets_at: null } }) });
		assert.equal(snapshot.windows[0]?.resetsAt, null);
		for (const body of [
			{}, { five_hour: null, seven_day: null },
			{ five_hour: { utilization: -1, resets_at: RESET } },
			{ five_hour: { utilization: 2, resets_at: "invalid" } },
			{ ...USAGE, limits: {} },
			{ ...USAGE, limits: [{ kind: "weekly_scoped", percent: "89", resets_at: RESET }] },
		]) await assert.rejects(fetchClaudeQuota({ authPath, fetchImpl: reply(body) }), /invalid|unavailable/);
	});

	it("reports missing or invalid credentials without falling back to another account", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		for (const body of ["invalid json", '{"mcpOAuth":{}}']) {
			writeFileSync(authPath, body);
			await assert.rejects(fetchClaudeQuota({ fetchImpl }), /claude auth login/);
		}
		rmSync(authPath);
		await assert.rejects(fetchClaudeQuota({ fetchImpl }), /credentials unavailable/);
		assert.equal(fetchImpl.mock.calls.length, 0);
		assert.equal(keychain.mock.calls.length, 0);
	});

	it.skipIf(process.platform !== "darwin")("reads macOS Keychain with a bound and safely handles denial", async () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "");
		keychain.mockImplementation((_file, _args, _options, callback) => callback(null, LOGIN));
		await fetchClaudeQuota({ fetchImpl: reply(USAGE) });
		const [file, args, options] = keychain.mock.calls[0]!;
		assert.equal(file, "/usr/bin/security");
		assert.deepEqual(args, ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
		assert.equal(options.timeout, 5000);
		assert.ok(options.signal instanceof AbortSignal);
		keychain.mockImplementation((_file, _args, _options, callback) => callback(new Error(TOKEN)));
		await assert.rejects(fetchClaudeQuota(), (error: Error) => {
			assert.match(error.message, /credentials unavailable/);
			assert.ok(!error.message.includes(TOKEN));
			return true;
		});
	});

	it("keeps credentials and response bodies out of HTTP and transport errors", async () => {
		for (const status of [401, 403, 429, 503]) {
			await assert.rejects(fetchClaudeQuota({ authPath, fetchImpl: reply(TOKEN, status) }), (error: Error) => {
				assert.match(error.message, new RegExp(`HTTP ${status}`));
				assert.ok(!error.message.includes(TOKEN));
				return true;
			});
		}
		writeFileSync(authPath, JSON.stringify({ claudeAiOauth: { accessToken: `${TOKEN}\ninvalid` } }));
		await assert.rejects(fetchClaudeQuota({ authPath }), (error: Error) => {
			assert.match(error.message, /request failed/);
			assert.ok(!error.message.includes(TOKEN));
			return true;
		});
	});

	it("honors cancellation before credentials and timeout during body reads", async () => {
		const controller = new AbortController();
		controller.abort(TOKEN);
		await assert.rejects(fetchClaudeQuota({ authPath: "missing", signal: controller.signal }), /cancelled/);
		const fetchImpl: typeof fetch = async (_url, init) => new Response(new ReadableStream({ start(stream) {
			init!.signal!.addEventListener("abort", () => stream.error(TOKEN), { once: true });
		} }));
		await assert.rejects(fetchClaudeQuota({ authPath, fetchImpl, timeoutMs: 30 }), /timed out/);
	});
});
