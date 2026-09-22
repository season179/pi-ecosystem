import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { fetchCodexQuota } from "../src/quota.js";

const TOKEN = "test-access-token-DOES-NOT-EXIST";
const ACCOUNT = "acc-test-123";

const FLAT_RESPONSE = {
	allowed: true,
	limit_reached: false,
	primary_window: {
		used_percent: 92,
		limit_window_seconds: 604800,
		reset_after_seconds: 158464,
	},
	secondary_window: null,
	plan_type: "pro",
};

const NESTED_RESPONSE = {
	plan_type: "pro",
	rate_limit: {
		allowed: false,
		limit_reached: true,
		primary_window: {
			used_percent: 100,
			limit_window_seconds: 18000,
			reset_after_seconds: 900,
		},
		secondary_window: {
			used_percent: 41,
			limit_window_seconds: 604800,
			reset_after_seconds: 86400,
		},
	},
};

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempAuthPath(body: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-quota-"));
	dirs.push(dir);
	const authPath = join(dir, "auth.json");
	writeFileSync(authPath, JSON.stringify(body));
	return authPath;
}

interface FakeFetchCall {
	url: string;
	init: RequestInit;
}

function fakeFetch(status: number, body: unknown) {
	const calls: FakeFetchCall[] = [];
	const impl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(
			typeof body === "string" ? body : JSON.stringify(body),
			{ status },
		);
	}) as typeof fetch;
	return { impl, calls };
}

function authBody(): Record<string, unknown> {
	return {
		auth_mode: "chatgpt",
		tokens: {
			access_token: TOKEN,
			refresh_token: "refresh-do-not-leak",
			account_id: ACCOUNT,
		},
	};
}

describe("fetchCodexQuota", () => {
	it("normalizes the flat response shape", async () => {
		const snapshot = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: fakeFetch(200, FLAT_RESPONSE).impl,
		});
		assert.equal(snapshot.allowed, true);
		assert.equal(snapshot.limitReached, false);
		assert.equal(snapshot.planType, "pro");
		assert.equal(snapshot.primary?.usedPercent, 92);
		assert.equal(snapshot.primary?.windowSeconds, 604800);
		assert.equal(snapshot.primary?.resetAfterSeconds, 158464);
		assert.equal(snapshot.secondary, undefined);
		assert.ok(!Number.isNaN(Date.parse(snapshot.checkedAt)));
	});

	it("normalizes the nested rate_limit shape", async () => {
		const snapshot = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: fakeFetch(200, NESTED_RESPONSE).impl,
		});
		assert.equal(snapshot.allowed, false);
		assert.equal(snapshot.limitReached, true);
		assert.equal(snapshot.primary?.usedPercent, 100);
		assert.equal(snapshot.primary?.windowSeconds, 18000);
		assert.equal(snapshot.secondary?.usedPercent, 41);
		assert.equal(snapshot.secondary?.windowSeconds, 604800);
	});

	it("tolerates a response with no windows when allowed is present", async () => {
		const snapshot = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: fakeFetch(200, { allowed: true, limit_reached: false }).impl,
		});
		assert.equal(snapshot.allowed, true);
		assert.equal(snapshot.primary, undefined);
		assert.equal(snapshot.secondary, undefined);
	});

	it("sends the OAuth headers to the default endpoint", async () => {
		const { impl, calls } = fakeFetch(200, FLAT_RESPONSE);
		await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: impl,
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
		const headers = calls[0]?.init.headers as Record<string, string>;
		assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
		assert.equal(headers["ChatGPT-Account-ID"], ACCOUNT);
		assert.equal(headers.Accept, "application/json");
	});

	it("maps HTTP 401 to refresh guidance without leaking the token", async () => {
		const error = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: fakeFetch(401, {}).impl,
		}).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.ok(error instanceof Error);
		assert.match(error.message, /codex login|refresh/iu);
		assert.ok(!error.message.includes(TOKEN));
	});

	it("surfaces other HTTP status codes", async () => {
		const error = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: fakeFetch(503, "nope").impl,
		}).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.match(error?.message ?? "", /HTTP 503/u);
	});

	it("rejects an unrecognized response shape", async () => {
		const error = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: fakeFetch(200, { hello: "world" }).impl,
		}).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.match(error?.message ?? "", /unrecognized/iu);
	});

	it("rejects an invalid JSON body", async () => {
		const error = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: fakeFetch(200, "<html>not json</html>").impl,
		}).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.match(error?.message ?? "", /invalid JSON/u);
	});

	it("reports a missing credentials file with a remediation hint", async () => {
		const error = await fetchCodexQuota({
			authPath: join(tmpdir(), `pi-herdr-quota-missing-${Date.now()}.json`),
			fetchImpl: fakeFetch(200, FLAT_RESPONSE).impl,
		}).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.match(error?.message ?? "", /codex login/u);
	});

	it("reports an auth file without an access token", async () => {
		const error = await fetchCodexQuota({
			authPath: tempAuthPath({ auth_mode: "apikey" }),
			fetchImpl: fakeFetch(200, FLAT_RESPONSE).impl,
		}).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.match(error?.message ?? "", /codex login/u);
		assert.ok(!error?.message.includes(TOKEN));
	});

	it("maps network failures to a safe error message", async () => {
		const impl = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as typeof fetch;
		const error = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: impl,
		}).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.match(error?.message ?? "", /usage request failed/u);
	});

	it("never includes the token in a successful snapshot", async () => {
		const snapshot = await fetchCodexQuota({
			authPath: tempAuthPath(authBody()),
			fetchImpl: fakeFetch(200, NESTED_RESPONSE).impl,
		});
		assert.ok(!JSON.stringify(snapshot).includes(TOKEN));
		assert.ok(!JSON.stringify(snapshot).includes("refresh-do-not-leak"));
	});
});
