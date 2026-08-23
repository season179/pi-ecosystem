import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { MemoryError, type MemoryOperation } from "./errors.js";
import { storeLockPath } from "./lock.js";

/** <slug>-<hash16>: slug is lowercase [a-z0-9-] (max 48), suffix is 16 hex chars. */
const PROJECT_DIRECTORY_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}-[0-9a-f]{16}$/;

export interface MemoryRoot {
	/** Canonical (realpath'd) agent directory. */
	agentDir: string;
	/** Canonical memory root: <agentDir>/pi-memory. May not exist yet. */
	root: string;
}

export interface StorePaths {
	directory: string;
	details: string;
	index: string;
	lock: string;
}

/**
 * Canonical containment contract for guarded store operations. `root` must be
 * canonical (realpath(root) === root, e.g. MemoryRoot.agentDir); guarded store
 * operations reject root/store/intermediate symlinks before creating anything
 * and revalidate the whole chain before every commit rename. The legacy string
 * store API without this contract only proves transaction files stay inside
 * the resolved store directory itself — it makes no claim about agentDir.
 */
export interface StoreContainment {
	/** Canonical containment root; every guarded path must be strictly inside it. */
	root: string;
	/** Exact generated memory root when known; legacy callers may omit it. */
	memoryRoot?: string;
}

/** Containment contract binding stores to the canonical agent and memory roots. */
export function storeContainment(root: MemoryRoot): StoreContainment {
	return { root: root.agentDir, memoryRoot: root.root };
}

/**
 * Assert the containment root is exactly its own realpath and a real
 * directory. Guarded operations run this before trusting any containment walk.
 */
export async function assertCanonicalContainmentRoot(
	root: string,
	operation: MemoryOperation = "read",
): Promise<void> {
	let canonical: string;
	try {
		canonical = await realpath(root);
	} catch (error) {
		if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") {
			throw new MemoryError("PATH_UNSAFE", `containment root is not accessible: ${root}`, {
				operation,
				path: root,
				cause: error,
			});
		}
		throw new MemoryError("IO", `cannot resolve containment root: ${root}`, {
			operation,
			path: root,
			cause: error,
		});
	}
	if (canonical !== root) {
		throw new MemoryError("PATH_UNSAFE", `containment root is not canonical: ${root} resolves to ${canonical}`, {
			operation,
			path: root,
		});
	}
	const stats = await lstat(root).catch(() => undefined);
	if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new MemoryError("PATH_UNSAFE", `containment root is not a real directory: ${root}`, {
			operation,
			path: root,
		});
	}
}

function errnoCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return String((error as NodeJS.ErrnoException).code);
}

/**
 * Canonicalize the agent directory and derive the memory root beneath it.
 * Creates nothing; an absent root stays absent.
 */
export async function resolveMemoryRoot(agentDir: string): Promise<MemoryRoot> {
	let canonicalAgentDir: string;
	try {
		canonicalAgentDir = await realpath(agentDir);
	} catch (error) {
		throw new MemoryError("IO", `agent directory is not accessible: ${agentDir}`, {
			operation: "read",
			path: agentDir,
			cause: error,
		});
	}
	const root = join(canonicalAgentDir, "pi-memory");
	try {
		const stats = await lstat(root);
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new MemoryError("PATH_UNSAFE", `memory root is not a real directory: ${root}`, {
				operation: "read",
				path: root,
			});
		}
	} catch (error) {
		if (error instanceof MemoryError) throw error;
		if (errnoCode(error) !== "ENOENT") {
			throw new MemoryError("IO", `cannot inspect memory root: ${root}`, {
				operation: "read",
				path: root,
				cause: error,
			});
		}
	}
	return { agentDir: canonicalAgentDir, root };
}

function storePaths(directory: string): StorePaths {
	return {
		directory,
		details: join(directory, "details.md"),
		index: join(directory, "index.md"),
		lock: storeLockPath(directory),
	};
}

/** The legacy-global store lives directly in the memory root; bytes untouched. */
export function legacyStorePaths(root: MemoryRoot): StorePaths {
	return storePaths(root.root);
}

/** A project store under <root>/projects/<slug>-<hash16>. The name is package-generated. */
export function projectStorePaths(root: MemoryRoot, directoryName: string): StorePaths {
	if (!PROJECT_DIRECTORY_PATTERN.test(directoryName)) {
		throw new MemoryError(
			"PATH_UNSAFE",
			`invalid project store directory name: ${JSON.stringify(directoryName)}`,
			{ operation: "read" },
		);
	}
	return storePaths(join(root.root, "projects", directoryName));
}

/**
 * Assert candidate is strictly inside root (relative-path containment, never
 * string prefixes), and that every existing component on the way down is a
 * real directory — no symlinks anywhere. The final component must be absent
 * or match the expected type. Re-run this immediately before lock creation,
 * temp creation, and each rename; it is TOCTOU-reducing, not race-proof.
 */
export async function assertContainedRegularPath(
	root: string,
	candidate: string,
	expected: "file" | "directory" = "file",
	operation: MemoryOperation = "read",
): Promise<void> {
	const relativePath = relative(root, candidate);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath) ||
		relativePath.includes("\u0000")
	) {
		throw new MemoryError("PATH_UNSAFE", `path escapes the memory root: ${candidate}`, {
			operation,
			path: candidate,
		});
	}

	// The root itself is re-checked every time: replacing it with a symlink
	// would silently redirect every containment conclusion below it.
	let rootStats;
	try {
		rootStats = await lstat(root);
	} catch (error) {
		if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") {
			throw new MemoryError("PATH_UNSAFE", `containment root is not accessible: ${root}`, {
				operation,
				path: root,
				cause: error,
			});
		}
		throw new MemoryError("IO", `cannot inspect containment root: ${root}`, {
			operation,
			path: root,
			cause: error,
		});
	}
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		throw new MemoryError("PATH_UNSAFE", `containment root is not a real directory: ${root}`, {
			operation,
			path: root,
		});
	}

	const segments = relativePath.split(sep);
	let current = root;
	for (let index = 0; index < segments.length; index += 1) {
		current = join(current, segments[index]);
		let stats;
		try {
			stats = await lstat(current);
		} catch (error) {
			const code = errnoCode(error);
			if (code === "ENOENT") return; // Absent from here down is acceptable.
			if (code === "ENOTDIR") {
				throw new MemoryError("PATH_UNSAFE", `path component is not a directory: ${current}`, {
					operation,
					path: current,
				});
			}
			throw new MemoryError("IO", `cannot inspect path component: ${current}`, {
				operation,
				path: current,
				cause: error,
			});
		}
		if (stats.isSymbolicLink()) {
			throw new MemoryError("PATH_UNSAFE", `symbolic link rejected: ${current}`, {
				operation,
				path: current,
			});
		}
		const isFinal = index === segments.length - 1;
		if (!isFinal && !stats.isDirectory()) {
			throw new MemoryError("PATH_UNSAFE", `path component is not a directory: ${current}`, {
				operation,
				path: current,
			});
		}
		if (isFinal) {
			if (expected === "file" && !stats.isFile()) {
				throw new MemoryError("PATH_UNSAFE", `expected a regular file: ${current}`, {
					operation,
					path: current,
				});
			}
			if (expected === "directory" && !stats.isDirectory()) {
				throw new MemoryError("PATH_UNSAFE", `expected a directory: ${current}`, {
					operation,
					path: current,
				});
			}
		}
	}
}
