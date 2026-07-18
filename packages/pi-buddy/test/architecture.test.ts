import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const extensions = new URL("../src/extensions/", import.meta.url);

function source(file: string): string {
	return readFileSync(new URL(file, extensions), "utf8");
}

describe("architecture boundaries", () => {
	it("keeps domain and session modules independent of Pi and side-effect adapters", () => {
		const coreModules = [
			"buddy-context.ts",
			"buddy-session.ts",
			"calibration.ts",
			"concern-history.ts",
			"memory-contract.ts",
			"memory-prompt.ts",
			"output-control.ts",
			"policy.ts",
			"token-policy.ts",
			"watchdog-coordinator-core.ts",
		];
		const forbiddenImports = [
			"@earendil-works/",
			"node:",
			"./telemetry.js",
			"./web-tools.js",
		];

		for (const file of coreModules) {
			const contents = source(file);
			for (const forbidden of forbiddenImports) {
				assert.equal(
					contents.includes(`from \"${forbidden}`),
					false,
					`${file} must not import ${forbidden}`,
				);
			}
		}
	});

	it("routes shared contracts through neutral modules", () => {
		assert.doesNotMatch(source("output-control.ts"), /from "\.\/consult\.js"/);
		assert.match(source("buddy-session.ts"), /from "\.\/memory-prompt\.js"/);
		assert.doesNotMatch(source("buddy-session.ts"), /from "\.\/stances\.js"/);
		for (const file of ["web-tools.ts", "watchdog-verdict.ts"]) {
			assert.match(source(file), /from "\.\/buddy-tool\.js"/);
			assert.doesNotMatch(source(file), /from "\.\/buddy-tools\.js"/);
		}
	});
});
