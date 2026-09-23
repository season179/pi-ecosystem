import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { fetchZaiQuota, formatZaiQuota } from "../src/zai-quota.js";

const TOKEN = "private-zai-test-key";
const RESET = 1790445470980;
const CODING = { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: RESET };
const MCP = { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, usage: 4000, currentValue: 0, remaining: 4000 };
const envelope = (limits: unknown[]) => ({ success: true, code: 200, data: { limits } });
const reply = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });
const getApiKey = async () => TOKEN;

describe("fetchZaiQuota", () => {
	it("reports coding windows and monthly MCP separately, preserving server percentages", async () => {
		const fetchImpl = vi.fn<typeof fetch>(reply(envelope([
			MCP, CODING, { ...CODING, unit: 6, number: 1, percentage: 12 },
			{ ...CODING, type: "CREDIT_LIMIT", percentage: 8, usage: 100, currentValue: 8.5 },
			{ type: "FUTURE_LIMIT" },
		])));
		const result = await fetchZaiQuota({ getApiKey, fetchImpl });
		assert.deepEqual(result.windows.map(w => [w.label, w.usedPercent]), [
			["MCP calls (monthly)", 0], ["Coding (5 hours)", 1], ["Coding (1 week)", 12], ["Coding credits (5 hours)", 8],
		]);
		assert.equal(result.windows[0]?.limit, 4000);
		assert.deepEqual(result.windows.map(w => w.windowSeconds), [undefined, 18_000, 604_800, 18_000]);
		assert.equal(result.windows[0]?.resetsAt, null);
		assert.equal(result.windows[1]?.resetsAt, new Date(RESET).toISOString());
		assert.match(formatZaiQuota(result), /MCP calls \(monthly\).*0\/4000/);
		assert.ok(formatZaiQuota(result).includes(result.checkedAt));
		assert.ok(!JSON.stringify(result).includes(TOKEN));
		const [url, init] = fetchImpl.mock.calls[0]!;
		assert.equal(url, "https://api.z.ai/api/monitor/usage/quota/limit");
		assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${TOKEN}`);
	});

	it("rejects API-level errors, absent limits and malformed known windows", async () => {
		for (const body of [
			{ success: false, code: 401, msg: TOKEN }, envelope([]), envelope([{ type: "FUTURE_LIMIT" }]),
			envelope([{ ...CODING, percentage: -1 }]), envelope([{ ...CODING, percentage: "12" }]),
			envelope([{ ...CODING, number: 0 }]), envelope([{ ...CODING, nextResetTime: 1e100 }]),
			envelope([{ ...MCP, remaining: -1 }]),
		]) await assert.rejects(fetchZaiQuota({ getApiKey, fetchImpl: reply(body) }), (error: Error) => {
			assert.match(error.message, /rejected|unavailable|invalid/);
			assert.ok(!error.message.includes(TOKEN));
			return true;
		});
	});

	it("never fetches without credentials and sanitizes resolver failures", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		await assert.rejects(fetchZaiQuota({ getApiKey: async () => undefined, fetchImpl }), /No Z.ai API key/);
		await assert.rejects(fetchZaiQuota({ getApiKey: async () => { throw new Error(TOKEN); }, fetchImpl }), /credentials unavailable/);
		assert.equal(fetchImpl.mock.calls.length, 0);
	});

	it("keeps HTTP bodies, invalid JSON and native header errors out of error messages", async () => {
		for (const status of [401, 403, 429, 503]) {
			await assert.rejects(fetchZaiQuota({ getApiKey, fetchImpl: reply(TOKEN, status) }), (error: Error) => {
				assert.match(error.message, new RegExp(`HTTP ${status}`));
				assert.ok(!error.message.includes(TOKEN));
				return true;
			});
		}
		await assert.rejects(fetchZaiQuota({ getApiKey, fetchImpl: async () => new Response(TOKEN) }), /invalid JSON/);
		// Native fetch rejects the malformed header before making a network request.
		await assert.rejects(fetchZaiQuota({ getApiKey: async () => `${TOKEN}\ninvalid` }), (error: Error) => {
			assert.match(error.message, /request failed/);
			assert.ok(!error.message.includes(TOKEN));
			return true;
		});
	});

	it("cancels credential resolution and ignores late rejection without making a request", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>();
		let rejectCredential!: (reason: Error) => void;
		const result = fetchZaiQuota({ signal: controller.signal, fetchImpl, getApiKey: () => new Promise((_resolve, reject) => {
			rejectCredential = reject;
			controller.abort(TOKEN);
		}) });
		await assert.rejects(result, /cancelled/);
		rejectCredential(new Error(TOKEN));
		await Promise.resolve();
		assert.equal(fetchImpl.mock.calls.length, 0);
		const resolver = vi.fn(getApiKey);
		await assert.rejects(fetchZaiQuota({ signal: controller.signal, getApiKey: resolver }), /cancelled/);
		assert.equal(resolver.mock.calls.length, 0);
	});

	it("bounds both a stalled credential resolver and a stalled response body", async () => {
		await assert.rejects(fetchZaiQuota({ getApiKey: () => new Promise(() => {}), timeoutMs: 10 }), /timed out/);
		const fetchImpl: typeof fetch = async (_url, init) => new Response(new ReadableStream({ start(stream) {
			init!.signal!.addEventListener("abort", () => stream.error(TOKEN), { once: true });
		} }));
		await assert.rejects(fetchZaiQuota({ getApiKey, fetchImpl, timeoutMs: 10 }), /timed out/);
	});
});
