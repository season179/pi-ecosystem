import assert from "node:assert/strict";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const indexSource = readFileSync(join(pkgRoot, "index.js"), "utf8");
const bundlePath = join(pkgRoot, "dist", "herdr.bundle.js");

/**
 * The package entry must stay a stable shim that re-resolves the bundle by
 * content hash on every factory call. A static re-export of dist (the pre-fix
 * shape) makes /reload silently keep old code, because Pi's jiti delegates
 * "type":"module" .js entries to Node's process-wide ESM cache.
 */
describe("loader entry shim", () => {
	it("exports a default async factory, not a static dist re-export", () => {
		assert.ok(!/export\s*\{[^}]*\}\s*from\s*["']\.\/dist/.test(indexSource), "index.js must not statically re-export dist");
		const match = /export\s+default\s+(async\s+)?function[\s\S]*?import\(/.exec(indexSource);
		assert.ok(match, "index.js must default-export a factory that dynamically imports the bundle");
		assert.match(indexSource, /createHash|sha256/, "factory must fingerprint the bundle by content");
		assert.match(indexSource, /\?v=/, "factory must import the bundle under a query-busted URL");
	});

	it("references the bundle the build produces", () => {
		assert.match(indexSource, /\.\/dist\/herdr\.bundle\.js/);
	});
});

/** Appended to fixture bundle copies only: counts module evaluations. */
const EVAL_COUNTER = "\nglobalThis.__herdrBundleEvals = (globalThis.__herdrBundleEvals ?? 0) + 1;\n";

/** Runs in a child process with a real Node ESM cache and a real on-disk fixture. */
const CHILD_SCRIPT = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const bundle = "__BUNDLE__";
const entry = await import(pathToFileURL("__ENTRY__").href);
const mkApi = () => {
	const tools = new Map(), commands = new Map(), renderers = new Map(), handlers = [];
	return {
		tools, commands, renderers, handlers,
		on: (_event, handler) => handlers.push(handler),
		registerTool: (t) => tools.set(t.name, t),
		registerCommand: (name, options) => commands.set(name, options),
		registerMessageRenderer: (type, renderer) => renderers.set(type, renderer),
	};
};
const verdict = {};
// Initial load (what Pi does at startup).
const api1 = mkApi();
await entry.default(api1);
verdict.evalsAfterLoad = globalThis.__herdrBundleEvals;
verdict.toolsAfterLoad = [...api1.tools.keys()];
verdict.commands = [...api1.commands.keys()];
// Externals must keep host identity: the watch renderer returns the host's Box.
const { Box } = await import("@earendil-works/pi-tui");
const renderer = api1.renderers.get("pi-herdr-watch");
const box = renderer?.({ content: "probe" }, {}, { bg: (_n, text) => text });
verdict.rendererReturnsExternalBox = box instanceof Box;
// Reload with an unchanged bundle: factory re-invoked, module graph reused.
const api2 = mkApi();
await entry.default(api2);
verdict.evalsAfterUnchangedReload = globalThis.__herdrBundleEvals;
verdict.toolsAfterUnchangedReload = [...api2.tools.keys()];
// Dependency-only rebuild: mutate the bundle on disk (rename one tool).
writeFileSync(bundle, readFileSync(bundle, "utf8").replaceAll('"herdr_orchestrate"', '"herdr_orchestrate_v2"'));
// Reload after rebuild: factory re-invoked, new module graph evaluated.
const api3 = mkApi();
await entry.default(api3);
verdict.evalsAfterRebuildReload = globalThis.__herdrBundleEvals;
verdict.toolsAfterRebuildReload = [...api3.tools.keys()];
// One more unchanged reload stays pinned to the rebuilt module.
const api4 = mkApi();
await entry.default(api4);
verdict.evalsAfterSecondUnchangedReload = globalThis.__herdrBundleEvals;
console.log(JSON.stringify(verdict));
`;

describe.skipIf(!existsSync(bundlePath))("entry reload mechanism (built bundle required)", () => {
	it("picks up a rebuilt bundle on factory re-invocation and stays pinned otherwise", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-entry-"));
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", private: true }));
			cpSync(join(pkgRoot, "index.js"), join(dir, "index.js"));
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "dist", "herdr.bundle.js"), readFileSync(bundlePath, "utf8") + EVAL_COUNTER);
			// Externals (@earendil-works/*, typebox) resolve through the workspace root.
			symlinkSync(join(pkgRoot, "../../node_modules"), join(dir, "node_modules"));
			const agentDir = join(dir, "agent");
			mkdirSync(agentDir);
			const script = CHILD_SCRIPT
				.replaceAll("__BUNDLE__", join(dir, "dist", "herdr.bundle.js"))
				.replaceAll("__ENTRY__", join(dir, "index.js"));
			const scriptPath = join(dir, "run.mjs");
			writeFileSync(scriptPath, script);
			const stdout = execFileSync(process.execPath, [scriptPath], {
				env: {
					...process.env,
					HERDR_ENV: "1",
					HERDR_PANE_ID: "entry-test",
					PI_HERDR_ORCHESTRATOR: "0",
					PI_CODING_AGENT_DIR: agentDir,
				},
				encoding: "utf8",
			});
			const verdict = JSON.parse(stdout.trim().split("\n").pop());
			assert.equal(verdict.evalsAfterLoad, 1);
			assert.ok(verdict.toolsAfterLoad.includes("herdr_orchestrate"));
			assert.equal(verdict.rendererReturnsExternalBox, true);
			assert.equal(verdict.evalsAfterUnchangedReload, 1, "unchanged reload must reuse the cached module graph");
			assert.deepEqual(verdict.toolsAfterUnchangedReload, verdict.toolsAfterLoad);
			assert.equal(verdict.evalsAfterRebuildReload, 2, "rebuilt bundle must be re-evaluated");
			assert.ok(verdict.toolsAfterRebuildReload.includes("herdr_orchestrate_v2"));
			assert.ok(!verdict.toolsAfterRebuildReload.includes("herdr_orchestrate"));
			assert.equal(verdict.evalsAfterSecondUnchangedReload, 2, "unchanged reload after rebuild must stay pinned");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
