import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { loadBuddyConfig, parseBuddyConfig } from "../src/extensions/buddy-config.js";

const path = "/tmp/buddy-cadence-config.json";

describe("buddy config watchdog.initialCadence", () => {
	it("accepts only the existing cadence table's integer values", async () => {
		for (const initialCadence of [2, 3, 6, 12, 24]) {
			const result = await loadBuddyConfig(path, async () =>
				JSON.stringify({ watchdog: { initialCadence } }),
			);
			assert.equal(result.initialCadence, initialCadence);
			assert.deepEqual(result.warnings, []);
		}
	});

	it("leaves omitted cadence unset for the session's default of three", async () => {
		for (const config of [{}, { watchdog: {} }]) {
			const result = parseBuddyConfig(config, path);
			assert.equal(result.initialCadence, undefined);
			assert.deepEqual(result.warnings, []);
		}
		const missing = await loadBuddyConfig(path, async () => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		assert.equal(missing.found, false);
		assert.equal(missing.initialCadence, undefined);
		assert.deepEqual(missing.warnings, []);
	});

	it("warns and ignores malformed settings so the session falls back to three", () => {
		for (const initialCadence of [0, -1, 4, 48, 6.5, "6", null, true, [], {}, NaN, Infinity]) {
			const result = parseBuddyConfig({ watchdog: { initialCadence } }, path);
			assert.equal(result.initialCadence, undefined);
			assert.deepEqual(result.warnings, [
				`${path}: watchdog.initialCadence must be one of the integers 2, 3, 6, 12, 24; using default 3.`,
			]);
		}
		for (const watchdog of [6, "6", null, true, []]) {
			const result = parseBuddyConfig({ watchdog }, path);
			assert.equal(result.initialCadence, undefined);
			assert.deepEqual(result.warnings, [
				`${path}: "watchdog" must be an object; using default initialCadence 3.`,
			]);
		}
	});
});
