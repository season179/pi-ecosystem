import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { open, readdir, readFile, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { MemoryError, type MemoryOperation } from "./errors.js";
import { storeLockPath, type DirLockHandle } from "./lock.js";

export type ProjectIdentityKind = "git-common-dir" | "directory";
export type IdentityHash = `sha256:${string}`;

export interface AvailableProjectIdentity {
	status: "ok";
	kind: ProjectIdentityKind;
	canonicalIdentity: string;
	identityHash: IdentityHash;
	displayName: string;
	directoryName: string;
}

export interface UnavailableProjectIdentity {
	status: "unavailable";
	/** Canonical cwd when resolving it succeeded; diagnostic only, never a store key. */
	canonicalCwd?: string;
	error: string;
}

export type ProjectIdentity = AvailableProjectIdentity | UnavailableProjectIdentity;

export interface ProjectSidecarV1 {
	version: 1;
	kind: ProjectIdentityKind;
	canonicalIdentity: string;
	identityHash: IdentityHash;
	displayName: string;
	directoryName: string;
	createdAt: string;
}

interface GitResult {
	stdout: string;
	stderr: string;
}

export type GitIdentityRunner = (canonicalCwd: string, timeoutMs: number) => Promise<GitResult>;

export interface ResolveProjectIdentityOptions {
	gitTimeoutMs?: number;
	/** Test seam. Production resolution always uses execFile without a shell. */
	runGit?: GitIdentityRunner;
}

export type ProjectSidecarVerification = "missing-empty" | "matched";

export type ProjectSidecarInitializationCheckpoint = "before-rename" | "after-rename";

/** Fault-injection seams for sidecar publication tests; unused in production. */
export interface ProjectSidecarInitializationHooks {
	writeFile?: (handle: FileHandle, contents: string) => Promise<void>;
	checkpoint?: (
		name: ProjectSidecarInitializationCheckpoint,
		temporaryPath: string,
	) => void | Promise<void>;
}

const PROJECT_SIDECAR = "project.json";
const HASH_PREFIX = "sha256:";
const HASH_HEX_PATTERN = /^[0-9a-f]{64}$/;
const LOCK_ENTRY_PATTERN = /^\.pi-memory-mutation\.lock(?:\.|$)/;

function runGit(canonicalCwd: string, timeoutMs: number): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-C", canonicalCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ encoding: "utf8", maxBuffer: 64 * 1024, timeout: timeoutMs },
			(error, stdout, stderr) => {
				if (error) {
					Object.assign(error, { stdout, stderr });
					reject(error);
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

function errorCode(error: unknown): string | number | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function errorStderr(error: unknown): string {
	if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
	const stderr = (error as { stderr?: unknown }).stderr;
	return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
}

function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const stderr = errorStderr(error).trim();
	return (stderr || message || "unknown Git failure").slice(0, 1_000);
}

function isGitAbsent(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function isClearlyNotRepository(error: unknown): boolean {
	const code = errorCode(error);
	return (code === 128 || code === "128") && /not a git repository/i.test(errorStderr(error));
}

function identityHash(kind: ProjectIdentityKind, canonicalIdentity: string): IdentityHash {
	const hex = createHash("sha256").update(`${kind}\0${canonicalIdentity}`, "utf8").digest("hex");
	return `${HASH_PREFIX}${hex}`;
}

function safeSlug(displayName: string): string {
	const slug = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || "project";
}

function availableIdentity(kind: ProjectIdentityKind, canonicalIdentity: string): AvailableProjectIdentity {
	const displayName =
		kind === "git-common-dir" && basename(canonicalIdentity) === ".git"
			? basename(dirname(canonicalIdentity))
			: basename(canonicalIdentity);
	const hash = identityHash(kind, canonicalIdentity);
	return {
		status: "ok",
		kind,
		canonicalIdentity,
		identityHash: hash,
		displayName,
		directoryName: `${safeSlug(displayName)}-${hash.slice(HASH_PREFIX.length, HASH_PREFIX.length + 16)}`,
	};
}

function directoryFallback(canonicalCwd: string): AvailableProjectIdentity {
	return availableIdentity("directory", canonicalCwd);
}

/**
 * Resolve the stable identity used to route project memory.
 *
 * Unavailable results intentionally contain no identity hash or directory name,
 * so timeout, malformed output, and ambiguous Git failures cannot route writes
 * to a cwd-derived store by accident.
 */
export async function resolveProjectIdentity(
	cwd: string,
	options: ResolveProjectIdentityOptions = {},
): Promise<ProjectIdentity> {
	let canonicalCwd: string;
	try {
		canonicalCwd = await realpath(cwd);
	} catch (error) {
		return { status: "unavailable", error: `Cannot canonicalize cwd: ${describeError(error)}` };
	}

	const gitTimeoutMs = options.gitTimeoutMs ?? 3_000;
	if (!Number.isSafeInteger(gitTimeoutMs) || gitTimeoutMs < 1) {
		return {
			status: "unavailable",
			canonicalCwd,
			error: `Invalid Git timeout: ${String(gitTimeoutMs)}`,
		};
	}

	let result: GitResult;
	try {
		result = await (options.runGit ?? runGit)(canonicalCwd, gitTimeoutMs);
	} catch (error) {
		if (isGitAbsent(error) || isClearlyNotRepository(error)) return directoryFallback(canonicalCwd);
		return { status: "unavailable", canonicalCwd, error: describeError(error) };
	}

	if (typeof result.stdout !== "string") {
		return { status: "unavailable", canonicalCwd, error: "Git returned non-text output" };
	}
	const commonDirOutput = result.stdout.replace(/\r?\n$/, "");
	if (
		commonDirOutput.length === 0 ||
		commonDirOutput.includes("\n") ||
		commonDirOutput.includes("\r") ||
		commonDirOutput.includes("\0") ||
		!isAbsolute(commonDirOutput)
	) {
		return { status: "unavailable", canonicalCwd, error: "Git returned a malformed common directory" };
	}

	try {
		return availableIdentity("git-common-dir", await realpath(commonDirOutput));
	} catch (error) {
		return {
			status: "unavailable",
			canonicalCwd,
			error: `Cannot canonicalize Git common directory: ${describeError(error)}`,
		};
	}
}

function mismatch(message: string, path: string, operation: MemoryOperation): MemoryError {
	return new MemoryError("IDENTITY_MISMATCH", message, { operation, path });
}

function parseSidecar(
	contents: string,
	path: string,
	operation: MemoryOperation,
): ProjectSidecarV1 {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		throw mismatch(`${path} is not valid JSON`, path, operation);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw mismatch(`${path} is not a project identity object`, path, operation);
	}
	const sidecar = value as Partial<ProjectSidecarV1>;
	if (
		sidecar.version !== 1 ||
		(sidecar.kind !== "git-common-dir" && sidecar.kind !== "directory") ||
		typeof sidecar.canonicalIdentity !== "string" ||
		typeof sidecar.identityHash !== "string" ||
		!sidecar.identityHash.startsWith(HASH_PREFIX) ||
		!HASH_HEX_PATTERN.test(sidecar.identityHash.slice(HASH_PREFIX.length)) ||
		typeof sidecar.displayName !== "string" ||
		typeof sidecar.directoryName !== "string" ||
		typeof sidecar.createdAt !== "string" ||
		!Number.isFinite(Date.parse(sidecar.createdAt))
	) {
		throw mismatch(`${path} has an invalid project identity schema`, path, operation);
	}
	return sidecar as ProjectSidecarV1;
}

function assertSidecarMatches(
	sidecar: ProjectSidecarV1,
	path: string,
	identity: AvailableProjectIdentity,
	operation: MemoryOperation,
): void {
	if (
		sidecar.kind !== identity.kind ||
		sidecar.canonicalIdentity !== identity.canonicalIdentity ||
		sidecar.identityHash !== identity.identityHash ||
		sidecar.directoryName !== identity.directoryName
	) {
		throw mismatch(`${path} does not match the resolved project identity`, path, operation);
	}
}

async function missingSidecarState(
	projectDirectory: string,
	operation: MemoryOperation,
): Promise<ProjectSidecarVerification> {
	let entries: string[];
	try {
		entries = await readdir(projectDirectory);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "missing-empty";
		throw error;
	}
	const storeEntries = entries.filter(
		(entry) => entry !== PROJECT_SIDECAR && !LOCK_ENTRY_PATTERN.test(entry),
	);
	if (storeEntries.length === 0) return "missing-empty";
	const path = join(projectDirectory, PROJECT_SIDECAR);
	throw mismatch(`${path} is missing from a non-empty project store`, path, operation);
}

/** Verify a sidecar without creating the project directory or any file. */
export async function verifyProjectSidecar(
	projectDirectory: string,
	identity: AvailableProjectIdentity,
	operation: MemoryOperation = "read",
): Promise<ProjectSidecarVerification> {
	if (basename(projectDirectory) !== identity.directoryName) {
		throw mismatch(
			`Project directory name does not match ${identity.directoryName}`,
			projectDirectory,
			operation,
		);
	}

	const path = join(projectDirectory, PROJECT_SIDECAR);
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return missingSidecarState(projectDirectory, operation);
		throw error;
	}
	const sidecar = parseSidecar(contents, path, operation);
	assertSidecarMatches(sidecar, path, identity, operation);
	return "matched";
}

function assertProjectStoreLock(projectDirectory: string, lock: DirLockHandle): void {
	const expectedLockPath = resolve(storeLockPath(projectDirectory));
	if (resolve(lock.lockPath) !== expectedLockPath) {
		throw new MemoryError("LOCK_UNSAFE", `wrong store lock supplied for ${projectDirectory}`, {
			operation: "lock",
			path: lock.lockPath,
			retryable: false,
		});
	}
}

/**
 * Atomically initialize project.json in an existing project directory.
 * The caller-supplied project lock must be held for the entire call.
 */
export async function initializeProjectSidecar(
	projectDirectory: string,
	identity: AvailableProjectIdentity,
	lock: DirLockHandle,
	createdAt = new Date().toISOString(),
	hooks: ProjectSidecarInitializationHooks = {},
): Promise<ProjectSidecarV1> {
	assertProjectStoreLock(projectDirectory, lock);
	await lock.assertOwned();

	const path = join(projectDirectory, PROJECT_SIDECAR);
	const verification = await verifyProjectSidecar(projectDirectory, identity, "mutate");
	if (verification === "matched") {
		const matched = parseSidecar(await readFile(path, "utf8"), path, "mutate");
		assertSidecarMatches(matched, path, identity, "mutate");
		return matched;
	}
	if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError(`Invalid sidecar timestamp: ${createdAt}`);

	const sidecar: ProjectSidecarV1 = {
		version: 1,
		kind: identity.kind,
		canonicalIdentity: identity.canonicalIdentity,
		identityHash: identity.identityHash,
		displayName: identity.displayName,
		directoryName: identity.directoryName,
		createdAt,
	};
	const contents = `${JSON.stringify(sidecar, null, 2)}\n`;
	const temporaryPath = join(
		lock.lockPath,
		`.project.${lock.owner.ownerToken}.${randomBytes(8).toString("hex")}.tmp`,
	);
	let handle: FileHandle | undefined;
	let published = false;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await (hooks.writeFile ?? ((file, value) => file.writeFile(value, "utf8")))(handle, contents);
		await handle.sync();
		await handle.close();
		handle = undefined;

		await lock.assertOwned();
		await hooks.checkpoint?.("before-rename", temporaryPath);
		await rename(temporaryPath, path);
		published = true;
		await hooks.checkpoint?.("after-rename", temporaryPath);

		const initialized = parseSidecar(await readFile(path, "utf8"), path, "mutate");
		assertSidecarMatches(initialized, path, identity, "mutate");
		return initialized;
	} finally {
		await handle?.close().catch(() => undefined);
		if (!published) await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}
