import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { MemoryError } from "./errors.js";

export const STORE_LOCK_NAME = ".pi-memory-mutation.lock";
export const CONFIG_LOCK_NAME = ".pi-memory-config.lock";

const OWNER_FILE = "owner.json";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_GRACE_MS = 2_000;
const RELEASE_RETRY_MS = 1_000;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

const processInstanceToken = randomBytes(16).toString("hex");
const processStartedAt = new Date(performance.timeOrigin).toISOString();

export function storeLockPath(storeDirectory: string): string {
	return join(storeDirectory, STORE_LOCK_NAME);
}

export function configLockPath(memoryRoot: string): string {
	return join(memoryRoot, CONFIG_LOCK_NAME);
}

/** v1 owner.json shape. Ownership is proven by tokens, never by pid. */
export interface LockOwner {
	version: 1;
	ownerToken: string;
	processInstanceToken: string;
	pid: number;
	hostname: string;
	platform: string;
	node: string;
	processStartedAt: string;
	acquiredAt: string;
}

export interface DirLockOptions {
	/** Bounded wait for acquisition, measured with the monotonic clock. Default 5000. */
	timeoutMs?: number;
	/** Grace for a lock whose owner.json is not yet published, from lock dir mtime. Default 2000. */
	graceMs?: number;
	signal?: AbortSignal;
	/** Test seams; production defaults are the real clock, timer, RNG, and process probe. */
	monotonicNow?: () => number;
	wallNow?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
	/** Must behave like process.kill(pid, 0): throw ESRCH only when the pid does not exist. */
	probeProcess?: (pid: number) => void;
	hostname?: string;
	/** Test seam: overrides the release rename (the release point). */
	releaseRename?: (from: string, to: string) => Promise<void>;
	/** Test seam: overrides removal of the renamed release/quarantine residue. */
	releaseRemove?: (path: string) => Promise<void>;
	/**
	 * Observes a failed release of a successfully completed callback instead of
	 * letting withDirLock throw LOCK_UNSAFE. Callers that already committed
	 * irreversible work (e.g. a details.md rename) use this to keep reporting
	 * success while surfacing the unsafe lock as a warning.
	 */
	onReleaseFailure?: (failure: MemoryError, outcome: LockReleaseFailure) => void;
}

/** Why a lock release did not complete. The lock may still block later work. */
export interface LockReleaseFailure {
	released: false;
	/**
	 * ownership-lost: owner.json is gone or belongs to someone else; the foreign
	 * lock was left untouched. ownership-unreadable: owner.json could not be
	 * read, so ownership is unverifiable. rename-failed: the release rename
	 * failed permanently; this process may still hold the lock and wedge it.
	 */
	reason: "ownership-lost" | "ownership-unreadable" | "rename-failed";
	cause?: unknown;
}

export type LockReleaseOutcome =
	| {
			released: true;
			/** Set when the post-release residue removal failed; recovered later. */
			residuePath?: string;
	  }
	| LockReleaseFailure;

export interface DirLockHandle {
	readonly lockPath: string;
	readonly owner: LockOwner;
	/** Re-reads owner.json and reports whether this acquisition still owns the lock. */
	isOwned(): Promise<boolean>;
	/** Like isOwned() but throws LOCK_UNSAFE on any mismatch. */
	assertOwned(): Promise<void>;
}

interface LockTiming {
	timeoutMs: number;
	graceMs: number;
	signal?: AbortSignal;
	monotonicNow: () => number;
	wallNow: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	random: () => number;
	probeProcess: (pid: number) => void;
	hostname: string;
	releaseRename: (from: string, to: string) => Promise<void>;
	releaseRemove: (path: string) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolveSleep) => {
		if (signal?.aborted) {
			resolveSleep();
			return;
		}
		const finish = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolveSleep();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

function resolveTiming(options: DirLockOptions): LockTiming {
	return {
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
		signal: options.signal,
		monotonicNow: options.monotonicNow ?? (() => performance.now()),
		wallNow: options.wallNow ?? Date.now,
		sleep: options.sleep ?? defaultSleep,
		random: options.random ?? Math.random,
		probeProcess: options.probeProcess ?? ((pid) => process.kill(pid, 0)),
		hostname: options.hostname ?? osHostname(),
		releaseRename: options.releaseRename ?? ((from, to) => rename(from, to)),
		releaseRemove: options.releaseRemove ?? ((path) => rm(path, { recursive: true, force: true })),
	};
}

function errnoCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return String((error as NodeJS.ErrnoException).code);
}

async function readOwnerFile(path: string): Promise<LockOwner | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	return parseOwnerFile(raw);
}

function parseOwnerFile(raw: string): LockOwner | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<LockOwner> | null;
		if (parsed === null || typeof parsed !== "object") return undefined;
		if (parsed.version !== 1) return undefined;
		if (typeof parsed.ownerToken !== "string" || !TOKEN_PATTERN.test(parsed.ownerToken)) return undefined;
		if (typeof parsed.processInstanceToken !== "string" || !TOKEN_PATTERN.test(parsed.processInstanceToken)) {
			return undefined;
		}
		if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
		if (typeof parsed.hostname !== "string" || parsed.hostname === "") return undefined;
		return parsed as LockOwner;
	} catch {
		return undefined;
	}
}

async function publishOwner(lockPath: string, timing: LockTiming): Promise<LockOwner> {
	const owner: LockOwner = {
		version: 1,
		ownerToken: randomBytes(16).toString("hex"),
		processInstanceToken,
		pid: process.pid,
		hostname: timing.hostname,
		platform: process.platform,
		node: process.version,
		processStartedAt,
		acquiredAt: new Date(timing.wallNow()).toISOString(),
	};
	const temporaryPath = join(lockPath, `.owner.${owner.ownerToken}.tmp`);
	try {
		const handle = await open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, join(lockPath, OWNER_FILE));
		return owner;
	} catch (error) {
		// Acquisition is incomplete until owner.json is published; give the lock back.
		await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
		throw new MemoryError("IO", `failed to publish lock owner for ${lockPath}`, {
			operation: "lock",
			path: lockPath,
			cause: error,
		});
	}
}

function abortedError(lockPath: string): MemoryError {
	return new MemoryError("BUSY", `lock acquisition aborted for ${lockPath}`, {
		operation: "lock",
		path: lockPath,
		retryable: true,
	});
}

async function acquireDirLock(lockPath: string, timing: LockTiming): Promise<LockOwner> {
	const startedAt = timing.monotonicNow();
	const deadline = startedAt + timing.timeoutMs;
	let attempt = 0;
	let lastObservation: "busy" | "unverifiable" = "busy";
	let lastOwnerDiagnostic = "no owner observed";

	for (;;) {
		if (timing.signal?.aborted) throw abortedError(lockPath);

		try {
			await mkdir(lockPath, { mode: 0o700 });
			return await publishOwner(lockPath, timing);
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") {
				throw new MemoryError("IO", `cannot create lock directory ${lockPath}`, {
					operation: "lock",
					path: lockPath,
					cause: error,
				});
			}
		}

		const stats = await lstat(lockPath).catch((error: unknown) => {
			if (errnoCode(error) === "ENOENT") return undefined;
			throw new MemoryError("IO", `cannot inspect lock ${lockPath}`, {
				operation: "lock",
				path: lockPath,
				cause: error,
			});
		});
		if (stats !== undefined) {
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				throw new MemoryError("PATH_UNSAFE", `lock path is not a real directory: ${lockPath}`, {
					operation: "lock",
					path: lockPath,
				});
			}

			const owner = await readOwnerFile(join(lockPath, OWNER_FILE));
			if (owner === undefined) {
				const age = timing.wallNow() - stats.mtimeMs;
				lastObservation = age > timing.graceMs ? "unverifiable" : "busy";
				lastOwnerDiagnostic =
					age > timing.graceMs
						? "owner.json missing or invalid past the initialization grace"
						: "owner.json not yet published (within initialization grace)";
				// Never remove an unverifiable lock; keep waiting.
			} else {
				lastObservation = "busy";
				lastOwnerDiagnostic = `owner pid ${owner.pid} on ${owner.hostname}, acquired ${owner.acquiredAt}`;
				if (owner.hostname === timing.hostname) {
					let ownerDead = false;
					try {
						timing.probeProcess(owner.pid);
					} catch (probeError) {
						// Only ESRCH proves absence; EPERM and anything else means live/unknown.
						ownerDead = errnoCode(probeError) === "ESRCH";
					}
					if (ownerDead) {
						const confirmed = await readOwnerFile(join(lockPath, OWNER_FILE));
						if (confirmed !== undefined && confirmed.ownerToken === owner.ownerToken) {
							try {
								await rename(lockPath, `${lockPath}.orphaned.${owner.ownerToken}`);
								// Quarantined; retry mkdir immediately. The retained quarantine
								// directory fences late contenders for this same dead owner.
								continue;
							} catch {
								// Someone else recovered or reacquired; fall through and wait.
							}
						} else {
							continue; // Owner changed under us; re-evaluate immediately.
						}
					}
				}
			}
		}

		if (timing.monotonicNow() >= deadline) {
			// One final attempt at the deadline.
			try {
				await mkdir(lockPath, { mode: 0o700 });
				return await publishOwner(lockPath, timing);
			} catch (error) {
				if (errnoCode(error) !== "EEXIST") {
					throw new MemoryError("IO", `cannot create lock directory ${lockPath}`, {
						operation: "lock",
						path: lockPath,
						cause: error,
					});
				}
			}
			const elapsed = Math.round(timing.monotonicNow() - startedAt);
			if (lastObservation === "unverifiable") {
				throw new MemoryError(
					"LOCK_UNSAFE",
					`lock ${lockPath} has no verifiable owner after ${elapsed}ms (${lastOwnerDiagnostic})`,
					{ operation: "lock", path: lockPath, retryable: false },
				);
			}
			throw new MemoryError(
				"BUSY",
				`timed out after ${elapsed}ms waiting for lock ${lockPath} (${lastOwnerDiagnostic})`,
				{ operation: "lock", path: lockPath, retryable: true },
			);
		}

		const cap = Math.min(250, 20 * 2 ** attempt);
		attempt += 1;
		const jittered = cap / 2 + timing.random() * (cap / 2);
		const remaining = Math.max(0, deadline - timing.monotonicNow());
		await timing.sleep(Math.min(jittered, remaining), timing.signal);
	}
}

async function releaseDirLock(lockPath: string, owner: LockOwner, timing: LockTiming): Promise<LockReleaseOutcome> {
	const ownerPath = join(lockPath, OWNER_FILE);
	let raw: string;
	try {
		raw = await readFile(ownerPath, "utf8");
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			// The lock (or its owner.json) is gone: quarantined, recovered, or tampered.
			return { released: false, reason: "ownership-lost", cause: error };
		}
		return { released: false, reason: "ownership-unreadable", cause: error };
	}
	const current = parseOwnerFile(raw);
	if (
		current === undefined ||
		current.ownerToken !== owner.ownerToken ||
		current.processInstanceToken !== owner.processInstanceToken
	) {
		return { released: false, reason: "ownership-lost" }; // Never touch a foreign lock.
	}

	const releasedPath = `${lockPath}.released.${owner.ownerToken}`;
	const deadline = timing.monotonicNow() + RELEASE_RETRY_MS;
	for (;;) {
		try {
			// SOLE RELEASE POINT: a resolved rename gives up the lock.
			await timing.releaseRename(lockPath, releasedPath);
			break;
		} catch (error) {
			const code = errnoCode(error);
			if (code === "ENOENT") return { released: false, reason: "ownership-lost", cause: error };
			const transient = code === "EBUSY" || code === "EPERM" || code === "EACCES";
			if (!transient || timing.monotonicNow() >= deadline) {
				return { released: false, reason: "rename-failed", cause: error };
			}
			await timing.sleep(25);
		}
	}
	try {
		await timing.releaseRemove(releasedPath);
	} catch {
		return { released: true, residuePath: releasedPath }; // Residue is recovered later.
	}
	return { released: true };
}

/**
 * Run fn while holding an exclusive cross-process directory lock.
 *
 * Recovery is conservative: a lock is quarantined (renamed, never deleted) only
 * when its published same-host owner process provably does not exist (ESRCH).
 * There is no age-based stealing; a slow live owner is still an owner. Not
 * reentrant: nesting on the same lock path times out with BUSY.
 *
 * An abort observed after acquisition releases the lock and throws BUSY before
 * fn runs. A failed release after a successful fn throws LOCK_UNSAFE unless
 * options.onReleaseFailure observes it; when fn itself threw, fn's error stays
 * primary and the release outcome is not separately reported.
 */
export async function withDirLock<T>(
	lockPath: string,
	fn: (lock: DirLockHandle) => Promise<T>,
	options: DirLockOptions = {},
): Promise<T> {
	const timing = resolveTiming(options);
	const owner = await acquireDirLock(lockPath, timing);
	if (timing.signal?.aborted) {
		await releaseDirLock(lockPath, owner, timing);
		throw abortedError(lockPath);
	}
	const handle: DirLockHandle = {
		lockPath,
		owner,
		async isOwned() {
			const current = await readOwnerFile(join(lockPath, OWNER_FILE));
			return (
				current !== undefined &&
				current.ownerToken === owner.ownerToken &&
				current.processInstanceToken === owner.processInstanceToken
			);
		},
		async assertOwned() {
			if (!(await handle.isOwned())) {
				throw new MemoryError("LOCK_UNSAFE", `lock ownership lost for ${lockPath}`, {
					operation: "lock",
					path: lockPath,
					retryable: false,
				});
			}
		},
	};
	let result: T;
	try {
		result = await fn(handle);
	} catch (error) {
		await releaseDirLock(lockPath, owner, timing);
		throw error;
	}
	const outcome = await releaseDirLock(lockPath, owner, timing);
	if (!outcome.released) {
		const failure = new MemoryError(
			"LOCK_UNSAFE",
			`lock release failed (${outcome.reason}) for ${lockPath}; the lock may block later operations until recovered`,
			{ operation: "lock", path: lockPath, retryable: false, cause: outcome.cause },
		);
		if (options.onReleaseFailure !== undefined) {
			options.onReleaseFailure(failure, outcome);
			return result;
		}
		throw failure;
	}
	return result;
}
