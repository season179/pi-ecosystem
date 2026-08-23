import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MemoryError, type MemoryOperation } from "./errors.js";
import { configLockPath, withDirLock } from "./lock.js";
import { assertContainedRegularPath, type StoreContainment } from "./paths.js";

export const MEMORY_CONFIG_FILE = "config.json";

export type MemoryMode = "off" | "read-only" | "read-write";
export type MemoryModeSource = "env" | "project" | "default" | "builtin" | "safe-off";

export interface ProjectMemoryConfigV1 {
	mode: MemoryMode;
	[key: string]: unknown;
}

/** Unknown fields are retained so newer config versions can round-trip safely. */
export interface MemoryConfigV1 {
	version: 1;
	defaultMode: MemoryMode;
	projects: Record<string, ProjectMemoryConfigV1>;
	[key: string]: unknown;
}

export interface LoadedMemoryConfig {
	path: string;
	/** A normalized empty config when the file is absent or invalid. */
	config: MemoryConfigV1;
	/** False only when an existing config cannot be read or validated. */
	valid: boolean;
	/** Distinguishes the normal no-config state from an on-disk config. */
	exists: boolean;
	warnings: string[];
}

export interface EffectiveMemoryMode {
	mode: MemoryMode;
	source: MemoryModeSource;
	warnings: string[];
}

export type MemoryConfigUpdater = (
	current: MemoryConfigV1,
) => MemoryConfigV1 | void | Promise<MemoryConfigV1 | void>;

const MODES = new Set<MemoryMode>(["off", "read-only", "read-write"]);
const INVALID_CONFIG_WARNING =
	"[PI_MEMORY_CONFIG_INVALID] config.json is malformed or unreadable; automatic memory is safely off and the file was left unchanged.";

function emptyConfig(): MemoryConfigV1 {
	return { version: 1, defaultMode: "read-write", projects: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryMode(value: unknown): value is MemoryMode {
	return typeof value === "string" && MODES.has(value as MemoryMode);
}

function isMemoryConfig(value: unknown): value is MemoryConfigV1 {
	if (!isRecord(value) || value.version !== 1) return false;
	if (!isMemoryMode(value.defaultMode) || !isRecord(value.projects)) return false;
	for (const project of Object.values(value.projects)) {
		if (!isRecord(project) || !isMemoryMode(project.mode)) return false;
	}
	return true;
}

function preserveUnknownFields(current: MemoryConfigV1, proposed: MemoryConfigV1): MemoryConfigV1 {
	const result = structuredClone(proposed);
	for (const [key, value] of Object.entries(current)) {
		if (key !== "version" && key !== "defaultMode" && key !== "projects" && !(key in result)) {
			result[key] = structuredClone(value);
		}
	}
	for (const [identityHash, project] of Object.entries(result.projects)) {
		const previous = current.projects[identityHash];
		if (previous === undefined) continue;
		for (const [key, value] of Object.entries(previous)) {
			if (key !== "mode" && !(key in project)) project[key] = structuredClone(value);
		}
	}
	return result;
}

function errnoCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return String((error as NodeJS.ErrnoException).code);
}

export function memoryConfigPath(root: string): string {
	return join(root, MEMORY_CONFIG_FILE);
}

async function assertConfigContainment(
	containment: StoreContainment | undefined,
	root: string,
	candidate: string,
	expected: "file" | "directory",
	operation: MemoryOperation = "config",
): Promise<void> {
	if (containment === undefined) return;
	if (containment.memoryRoot !== undefined && resolve(root) !== resolve(containment.memoryRoot)) {
		throw new MemoryError("PATH_UNSAFE", `config root is not the generated memory root: ${root}`, {
			operation,
			path: root,
		});
	}
	await assertContainedRegularPath(containment.root, candidate, expected, operation);
}

/** Lock-free and strictly read-only. An absent config (and absent parent) remains absent. */
export async function loadMemoryConfig(
	path: string,
	containment?: StoreContainment,
): Promise<LoadedMemoryConfig> {
	await assertConfigContainment(containment, dirname(path), path, "file", "read");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			return { path, config: emptyConfig(), valid: true, exists: false, warnings: [] };
		}
		return {
			path,
			config: emptyConfig(),
			valid: false,
			exists: true,
			warnings: [INVALID_CONFIG_WARNING],
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isMemoryConfig(parsed)) throw new Error("invalid v1 config shape");
		return { path, config: parsed, valid: true, exists: true, warnings: [] };
	} catch {
		return {
			path,
			config: emptyConfig(),
			valid: false,
			exists: true,
			warnings: [INVALID_CONFIG_WARNING],
		};
	}
}

/** Resolve only the v1 mode settings. Unknown config fields have no effect. */
export function resolveEffectiveMode(
	loaded: LoadedMemoryConfig,
	identityHash: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): EffectiveMemoryMode {
	const warnings = [...loaded.warnings];
	const environmentMode = env.PI_MEMORY_MODE;
	if (environmentMode !== undefined) {
		if (isMemoryMode(environmentMode)) {
			return { mode: environmentMode, source: "env", warnings };
		}
		warnings.push(
			"[PI_MEMORY_MODE_INVALID] PI_MEMORY_MODE must be off, read-only, or read-write; the invalid value was ignored.",
		);
	}

	if (!loaded.valid) return { mode: "off", source: "safe-off", warnings };
	if (loaded.exists && identityHash !== undefined) {
		const projectMode = loaded.config.projects[identityHash]?.mode;
		if (projectMode !== undefined) return { mode: projectMode, source: "project", warnings };
	}
	if (loaded.exists) {
		return { mode: loaded.config.defaultMode, source: "default", warnings };
	}
	return { mode: "read-write", source: "builtin", warnings };
}

/**
 * Update config.json under the generalized config lock. The file is re-read
 * after acquisition, so concurrent read-modify-write operations cannot lose an
 * acknowledged update. Existing invalid bytes are never replaced.
 */
export async function updateMemoryConfig(
	root: string,
	update: MemoryConfigUpdater,
	containment?: StoreContainment,
): Promise<LoadedMemoryConfig> {
	const lockPath = configLockPath(root);
	await assertConfigContainment(containment, root, root, "directory");
	await assertConfigContainment(containment, root, lockPath, "directory");
	try {
		await mkdir(root, { recursive: true, mode: 0o700 });
	} catch (error) {
		throw new MemoryError("IO", `cannot create memory root ${root}`, {
			operation: "config",
			path: root,
			cause: error,
		});
	}

	await assertConfigContainment(containment, root, root, "directory");
	await assertConfigContainment(containment, root, lockPath, "directory");
	return withDirLock(lockPath, async (lock) => {
		const path = memoryConfigPath(root);
		await assertConfigContainment(containment, root, root, "directory");
		await assertConfigContainment(containment, root, lockPath, "directory");
		await assertConfigContainment(containment, root, path, "file");
		const loaded = await loadMemoryConfig(path, containment);
		if (!loaded.valid) {
			throw new MemoryError("CONFIG_INVALID", `refusing to overwrite invalid config ${path}`, {
				operation: "config",
				path,
			});
		}

		const current = structuredClone(loaded.config);
		const returned = await update(current);
		const proposed: unknown = returned === undefined ? current : returned;
		if (!isMemoryConfig(proposed)) {
			throw new MemoryError("CONFIG_INVALID", "config update produced an invalid v1 config", {
				operation: "config",
				path,
			});
		}
		const next = preserveUnknownFields(loaded.config, proposed);

		const temporaryPath = join(root, `.config.${randomBytes(16).toString("hex")}.tmp`);
		try {
			await assertConfigContainment(containment, root, temporaryPath, "file");
			const handle = await open(temporaryPath, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await assertConfigContainment(containment, root, root, "directory");
			await assertConfigContainment(containment, root, temporaryPath, "file");
			await assertConfigContainment(containment, root, path, "file");
			await assertConfigContainment(containment, root, lockPath, "directory");
			await lock.assertOwned();
			await rename(temporaryPath, path);
		} catch (error) {
			if (error instanceof MemoryError) throw error;
			throw new MemoryError("IO", `failed to replace memory config ${path}`, {
				operation: "config",
				path,
				cause: error,
			});
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}

		return { path, config: next, valid: true, exists: true, warnings: [] };
	});
}
