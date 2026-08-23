import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";
import { storeContainment, type MemoryRoot } from "../src/paths.js";
import {
	loadMemoryConfig,
	memoryConfigPath,
	resolveEffectiveMode,
	updateMemoryConfig,
	type LoadedMemoryConfig,
	type MemoryConfigV1,
	type MemoryMode,
} from "../src/config.js";

const temporaryDirectories = new Set<string>();

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-config-"));
	temporaryDirectories.add(root);
	return root;
}

function loaded(config?: MemoryConfigV1): LoadedMemoryConfig {
	return {
		path: "/unused/config.json",
		config: config ?? { version: 1, defaultMode: "off", projects: {} },
		valid: true,
		exists: config !== undefined,
		warnings: [],
	};
}

function config(
	defaultMode: MemoryMode,
	projects: MemoryConfigV1["projects"] = {},
): MemoryConfigV1 {
	return { version: 1, defaultMode, projects };
}

const builtConfigUrl = pathToFileURL(
	fileURLToPath(new URL("../dist/config.js", import.meta.url)),
).href;
const concurrentUpdateWorker = String.raw`
const [configUrl, root, role] = process.argv.slice(1);
const { updateMemoryConfig } = await import(configUrl);
const send = (message) => process.send?.(message);
const waitFor = (type) => new Promise((resolve) => {
  const receive = (message) => {
    if (message?.type !== type) return;
    process.off("message", receive);
    resolve();
  };
  process.on("message", receive);
});
send({ type: "ready" });
await waitFor("go");
try {
  if (role === "first") {
    await updateMemoryConfig(root, async (current) => {
      current.projects["sha256:first"] = { mode: "read-only" };
      const release = waitFor("release");
      send({ type: "entered" });
      await release;
    });
  } else {
    send({ type: "started" });
    await updateMemoryConfig(root, (current) => {
      if (current.projects["sha256:first"]?.mode !== "read-only") {
        throw new Error("second writer did not re-read the first writer's update");
      }
      current.projects["sha256:second"] = { mode: "read-write" };
    });
  }
  send({ type: "done" });
  process.disconnect?.();
} catch (error) {
  send({ type: "failed", error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
  process.disconnect?.();
}
`;

function spawnUpdateWorker(root: string, role: "first" | "second"): ChildProcess {
	return spawn(
		process.execPath,
		["--input-type=module", "--eval", concurrentUpdateWorker, builtConfigUrl, root, role],
		{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
	);
}

function waitForChildMessage(child: ChildProcess, type: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		child.stdout?.on("data", (chunk) => (output += String(chunk)));
		child.stderr?.on("data", (chunk) => (output += String(chunk)));
		const cleanup = (): void => {
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const onMessage = (message: unknown): void => {
			if (!message || typeof message !== "object") return;
			const event = message as { type?: string; error?: string };
			if (event.type === "failed") {
				cleanup();
				reject(new Error(`${event.error ?? "config update worker failed"}\n${output}`));
			} else if (event.type === type) {
				cleanup();
				resolve();
			}
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			cleanup();
			reject(
				new Error(
					`config update worker exited before ${type} (code ${String(code)}, signal ${String(signal)})\n${output}`,
				),
			);
		};
		child.on("message", onMessage);
		child.on("error", onError);
		child.on("exit", onExit);
	});
}

function waitForChildExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) {
		return child.exitCode === 0
			? Promise.resolve()
			: Promise.reject(new Error(`config update worker exited ${child.exitCode}`));
	}
	return new Promise((resolve, reject) => {
		child.once("exit", (code, signal) => {
			code === 0
				? resolve()
				: reject(new Error(`config update worker exited ${String(code)} (${String(signal)})`));
		});
	});
}

afterEach(async () => {
	await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryDirectories.clear();
});

describe("loadMemoryConfig", () => {
	it("leaves an absent memory root absent", async () => {
		const parent = await makeRoot();
		const absentRoot = join(parent, "not-created");
		const path = memoryConfigPath(absentRoot);

		const result = await loadMemoryConfig(path);

		assert.equal(result.valid, true);
		assert.equal(result.exists, false);
		assert.deepEqual(result.config, { version: 1, defaultMode: "read-write", projects: {} });
		assert.deepEqual(result.warnings, []);
		await assert.rejects(access(absentRoot), { code: "ENOENT" });
		assert.deepEqual(await readdir(parent), []);
	});

	it("loads v1 settings and retains unknown data", async () => {
		const root = await makeRoot();
		const path = memoryConfigPath(root);
		const input = {
			version: 1,
			defaultMode: "read-only",
			projects: {
				"sha256:project": { mode: "read-write", futureProjectField: { enabled: true } },
			},
			futureTopLevelField: ["kept"],
		};
		await writeFile(path, `${JSON.stringify(input)}\n`, "utf8");

		const result = await loadMemoryConfig(path);

		assert.equal(result.valid, true);
		assert.equal(result.exists, true);
		assert.deepEqual(result.config, input);
		assert.deepEqual(result.warnings, []);
	});

	it.each([
		["invalid JSON", "{ definitely not JSON\n"],
		["unsupported version", '{"version":2,"defaultMode":"off","projects":{}}\n'],
		["missing default", '{"version":1,"projects":{}}\n'],
		["invalid default", '{"version":1,"defaultMode":"enabled","projects":{}}\n'],
		["invalid projects", '{"version":1,"defaultMode":"off","projects":[]}\n'],
		[
			"invalid project mode",
			'{"version":1,"defaultMode":"off","projects":{"sha256:x":{"mode":"enabled"}}}\n',
		],
	])("marks %s invalid, warns once, and preserves exact bytes", async (_name, bytes) => {
		const root = await makeRoot();
		const path = memoryConfigPath(root);
		await writeFile(path, bytes, "utf8");

		const result = await loadMemoryConfig(path);

		assert.equal(result.valid, false);
		assert.equal(result.exists, true);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /safely off.*left unchanged/i);
		assert.equal(await readFile(path, "utf8"), bytes);
	});
});

describe("resolveEffectiveMode", () => {
	const identityHash = "sha256:current";
	const configured = loaded(
		config("read-only", {
			[identityHash]: { mode: "read-write" },
		}),
	);

	it.each([
		["valid environment", configured, { PI_MEMORY_MODE: "off" }, "off", "env"],
		["project", configured, {}, "read-write", "project"],
		["default", configured, {}, "read-only", "default"],
		["builtin", loaded(), {}, "read-write", "builtin"],
	] as const)("uses %s precedence", (_name, input, env, expectedMode, expectedSource) => {
		const identity = expectedSource === "default" ? "sha256:other" : identityHash;
		const effective = resolveEffectiveMode(input, identity, env);
		assert.equal(effective.mode, expectedMode);
		assert.equal(effective.source, expectedSource);
		assert.deepEqual(effective.warnings, []);
	});

	it("warns about an invalid environment mode and ignores it", () => {
		const effective = resolveEffectiveMode(configured, identityHash, { PI_MEMORY_MODE: "on" });
		assert.equal(effective.mode, "read-write");
		assert.equal(effective.source, "project");
		assert.equal(effective.warnings.length, 1);
		assert.match(effective.warnings[0], /PI_MEMORY_MODE.*invalid value was ignored/);
	});

	it("fails safely for malformed config when no valid environment override exists", () => {
		const malformed: LoadedMemoryConfig = {
			...loaded(),
			valid: false,
			exists: true,
			warnings: ["config warning"],
		};
		assert.deepEqual(resolveEffectiveMode(malformed, identityHash, {}), {
			mode: "off",
			source: "safe-off",
			warnings: ["config warning"],
		});

		const overridden = resolveEffectiveMode(malformed, identityHash, { PI_MEMORY_MODE: "read-only" });
		assert.equal(overridden.mode, "read-only");
		assert.equal(overridden.source, "env");
		assert.deepEqual(overridden.warnings, ["config warning"]);
	});
});

describe("updateMemoryConfig", () => {
	it.skipIf(process.platform === "win32")(
		"rejects symlinked memory roots and config files under a containment contract",
		async () => {
			const agentDir = await makeRoot();
			const canonicalAgentDir = await realpath(agentDir);
			const memoryRoot = join(canonicalAgentDir, "pi-memory");
			const root: MemoryRoot = { agentDir: canonicalAgentDir, root: memoryRoot };
			const containment = storeContainment(root);
			const externalDirectory = join(canonicalAgentDir, "external-directory");
			await mkdir(externalDirectory);
			await writeFile(join(externalDirectory, "canary"), "unchanged");
			await symlink(externalDirectory, memoryRoot, "dir");

			await assert.rejects(updateMemoryConfig(memoryRoot, () => config("read-only"), containment), {
				code: "PATH_UNSAFE",
			});
			assert.equal(await readFile(join(externalDirectory, "canary"), "utf8"), "unchanged");
			await assert.rejects(access(join(externalDirectory, "config.json")), { code: "ENOENT" });

			await rm(memoryRoot);
			await mkdir(memoryRoot);
			const externalConfig = join(canonicalAgentDir, "external-config.json");
			const externalBytes = `${JSON.stringify(config("off"))}\n`;
			await writeFile(externalConfig, externalBytes);
			await symlink(externalConfig, memoryConfigPath(memoryRoot), "file");
			await assert.rejects(loadMemoryConfig(memoryConfigPath(memoryRoot), containment), { code: "PATH_UNSAFE" });
			await assert.rejects(updateMemoryConfig(memoryRoot, () => config("read-only"), containment), {
				code: "PATH_UNSAFE",
			});
			assert.equal(await readFile(externalConfig, "utf8"), externalBytes);
		},
	);

	it("creates a restrictive atomic config and removes lock/temp residue", async () => {
		const parent = await makeRoot();
		const root = join(parent, "memory-root");

		const result = await updateMemoryConfig(root, (current) => {
			current.defaultMode = "read-only";
		});

		assert.equal(result.valid, true);
		assert.equal(result.exists, true);
		assert.equal(result.config.defaultMode, "read-only");
		assert.equal((await stat(memoryConfigPath(root))).mode & 0o777, 0o600);
		assert.deepEqual(await readdir(root), ["config.json"]);
		assert.equal(
			await readFile(memoryConfigPath(root), "utf8"),
			'{\n  "version": 1,\n  "defaultMode": "read-only",\n  "projects": {}\n}\n',
		);
	});

	it("preserves unknown top-level and project keys during a targeted update", async () => {
		const root = await makeRoot();
		const path = memoryConfigPath(root);
		await writeFile(
			path,
			`${JSON.stringify({
				version: 1,
				defaultMode: "off",
				projects: {
					"sha256:existing": { mode: "read-only", future: { retained: true } },
				},
				catalog: { futureOnly: 123 },
				future: "retained",
			})}\n`,
			"utf8",
		);

		await updateMemoryConfig(root, (current) => ({
			version: 1,
			defaultMode: current.defaultMode,
			projects: {
				"sha256:existing": { mode: "read-write" },
				"sha256:new": { mode: "read-write" },
			},
		}));
		const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

		assert.deepEqual(written, {
			version: 1,
			defaultMode: "off",
			projects: {
				"sha256:existing": { mode: "read-write", future: { retained: true } },
				"sha256:new": { mode: "read-write" },
			},
			catalog: { futureOnly: 123 },
			future: "retained",
		});
	});

	it("refuses to overwrite malformed config or invalid updater output", async () => {
		const root = await makeRoot();
		const path = memoryConfigPath(root);
		const malformed = "{ keep these exact broken bytes\n";
		await writeFile(path, malformed, "utf8");

		await assert.rejects(updateMemoryConfig(root, () => config("read-write")), {
			code: "CONFIG_INVALID",
		});
		assert.equal(await readFile(path, "utf8"), malformed);
		assert.deepEqual(await readdir(root), ["config.json"]);

		await writeFile(path, `${JSON.stringify(config("off"))}\n`, "utf8");
		const validBytes = await readFile(path, "utf8");
		await assert.rejects(
			updateMemoryConfig(root, () => ({ version: 1, defaultMode: "bad", projects: {} }) as never),
			{ code: "CONFIG_INVALID" },
		);
		assert.equal(await readFile(path, "utf8"), validBytes);
		assert.deepEqual(await readdir(root), ["config.json"]);
	});

	it("serializes two child-process updates without losing either", { timeout: 10_000 }, async () => {
		const root = await makeRoot();
		const first = spawnUpdateWorker(root, "first");
		const second = spawnUpdateWorker(root, "second");
		try {
			const firstReady = waitForChildMessage(first, "ready");
			const secondReady = waitForChildMessage(second, "ready");
			await Promise.all([firstReady, secondReady]);

			const firstEntered = waitForChildMessage(first, "entered");
			first.send({ type: "go" });
			await firstEntered;

			const secondStarted = waitForChildMessage(second, "started");
			const firstDone = waitForChildMessage(first, "done");
			const secondDone = waitForChildMessage(second, "done");
			second.send({ type: "go" });
			await secondStarted;
			first.send({ type: "release" });
			await Promise.all([firstDone, secondDone]);
			await Promise.all([waitForChildExit(first), waitForChildExit(second)]);
		} finally {
			if (first.exitCode === null) first.kill("SIGKILL");
			if (second.exitCode === null) second.kill("SIGKILL");
		}

		const final = await loadMemoryConfig(memoryConfigPath(root));
		assert.deepEqual(final.config.projects, {
			"sha256:first": { mode: "read-only" },
			"sha256:second": { mode: "read-write" },
		});
		assert.deepEqual(await readdir(root), ["config.json"]);
	});
});
