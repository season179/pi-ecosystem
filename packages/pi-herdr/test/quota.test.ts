import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { fetchCodexQuota } from "../src/quota.js";

const TOKEN = "test-access-token";
const WINDOW = { used_percent: 92, limit_window_seconds: 604800, reset_after_seconds: 158464 };
const USAGE = { allowed: true, limit_reached: false, primary_window: WINDOW, secondary_window: null };
const reply = (body: unknown, status = 200): typeof fetch => async () =>
	new Response(JSON.stringify(body), { status });
let dir: string;
let authPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-herdr-quota-"));
	authPath = join(dir, "auth.json");
	writeFileSync(authPath, JSON.stringify({ tokens: { access_token: TOKEN, account_id: "account", refresh_token: "private" } }));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("fetchCodexQuota", () => {
	it.each([false, true])("reads usage and excludes unrelated fields (nested=%s)", async (nested) => {
		const body = { ...(nested ? { rate_limit: USAGE } : USAGE), plan_type: "pro", email: "private", access_token: TOKEN };
		const fetchImpl = vi.fn<typeof fetch>(reply(body));
		const snapshot = await fetchCodexQuota({ authPath, fetchImpl });
		assert.deepEqual(snapshot, {
			checkedAt: snapshot.checkedAt, allowed: true, limitReached: false, planType: "pro",
			primary: { usedPercent: 92, windowSeconds: 604800, resetAfterSeconds: 158464 },
		});
		assert.ok(Number.isFinite(Date.parse(snapshot.checkedAt)));
		const [url, init] = fetchImpl.mock.calls[0]!;
		assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("Authorization"), `Bearer ${TOKEN}`);
		assert.equal(headers.get("ChatGPT-Account-ID"), "account");
	});

	it("preserves explicit blocking, a secondary window, and absent windows", async () => {
		const snapshot = await fetchCodexQuota({ authPath, fetchImpl: reply({ ...USAGE, allowed: false, limit_reached: true, secondary_window: WINDOW }) });
		assert.equal(snapshot.allowed, false);
		assert.equal(snapshot.limitReached, true);
		assert.deepEqual(snapshot.secondary, snapshot.primary);
		const empty = await fetchCodexQuota({ authPath, fetchImpl: reply({ allowed: true, limit_reached: false }) });
		assert.equal(empty.primary, undefined);
	});

	it("rejects incomplete flags and malformed windows instead of inventing quota status", async () => {
		for (const body of [
			{ ...USAGE, allowed: undefined }, { ...USAGE, allowed: "true" },
			{ ...USAGE, limit_reached: undefined },
			...[{}, "invalid", { ...WINDOW, used_percent: -1 }, { ...WINDOW, limit_window_seconds: 0 },
				{ ...WINDOW, reset_after_seconds: -1 }].map(primary_window => ({ ...USAGE, primary_window })),
		]) {
			await assert.rejects(fetchCodexQuota({ authPath, fetchImpl: reply(body) }), /unrecognized|invalid window/);
		}
		// JSON numeric overflow becomes Infinity when parsed.
		await assert.rejects(fetchCodexQuota({ authPath, fetchImpl: async () => new Response(JSON.stringify(USAGE).replace('"used_percent":92', '"used_percent":1e400')) }), /invalid window/);
	});

	it("reports missing or invalid credentials without making a request", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		for (const contents of ["not json", '{"tokens":{}}']) {
			writeFileSync(authPath, contents);
			await assert.rejects(fetchCodexQuota({ authPath, fetchImpl }), /codex login/);
		}
		rmSync(authPath);
		await assert.rejects(fetchCodexQuota({ authPath, fetchImpl }), /codex login/);
		assert.equal(fetchImpl.mock.calls.length, 0);
	});

	it("keeps HTTP bodies and native header errors out of error messages", async () => {
		for (const status of [401, 403, 429, 503]) {
			await assert.rejects(fetchCodexQuota({ authPath, fetchImpl: reply(TOKEN, status) }), (error: Error) => {
				assert.match(error.message, new RegExp(`HTTP ${status}`));
				assert.ok(!error.message.includes(TOKEN));
				return true;
			});
		}
		writeFileSync(authPath, JSON.stringify({ tokens: { access_token: `${TOKEN}\ninvalid` } }));
		// Real fetch rejects this header locally, before any network request.
		await assert.rejects(fetchCodexQuota({ authPath }), (error: Error) => {
			assert.match(error.message, /request failed/);
			assert.ok(!error.message.includes(TOKEN));
			return true;
		});
	});

	it("reports malformed JSON safely", async () => {
		await assert.rejects(fetchCodexQuota({ authPath, fetchImpl: async () => new Response(TOKEN) }), /invalid JSON/);
	});

	it("cancels before credential access and while reading the response body", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>();
		controller.abort(TOKEN);
		await assert.rejects(fetchCodexQuota({ authPath: "missing", signal: controller.signal, fetchImpl }), /cancelled/);
		assert.equal(fetchImpl.mock.calls.length, 0);

		const pending = new AbortController();
		await assert.rejects(fetchCodexQuota({ authPath, signal: pending.signal, fetchImpl: async (_url, init) =>
			new Response(new ReadableStream({ start(stream) {
				init!.signal!.addEventListener("abort", () => stream.error(TOKEN), { once: true });
				pending.abort(TOKEN);
			} })) }), /cancelled/);
	});

	it("times out a stalled response body without calling it invalid JSON", async () => {
		const fetchImpl: typeof fetch = async (_url, init) => new Response(new ReadableStream({ start(stream) {
			init!.signal!.addEventListener("abort", () => stream.error(TOKEN), { once: true });
		} }));
		await assert.rejects(fetchCodexQuota({ authPath, timeoutMs: 10, fetchImpl }), /timed out/);
	});
});
