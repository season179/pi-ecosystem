import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, it } from "vitest";
import { storeLockPath, withDirLock, type LockOwner } from "../src/lock.js";

const temporaryDirectories = new Set<string>();

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-lock-"));
	temporaryDirectories.add(root);
	return root;
}

async function captureRealOwner(lockPath: string): Promise<LockOwner> {
	let owner: LockOwner | undefined;
	await withDirLock(lockPath, async () => {
		owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as LockOwner;
	});
	assert.ok(owner, "lock callback did not observe owner metadata");
	return owner;
}

async function seedLock(lockPath: string, owner?: LockOwner, ageMs = 60_000): Promise<void> {
	await mkdir(lockPath);
	if (owner) await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
	const old = new Date(Date.now() - ageMs);
	await utimes(lockPath, old, old);
}

async function expectCode(
	promise: Promise<unknown>,
	code: "BUSY" | "LOCK_UNSAFE",
): Promise<Error & { code: string; committed?: boolean | "unknown" }> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error, `expected ${code} error`);
	assert.equal((caught as { code?: unknown }).code, code);
	return caught as Error & { code: string; committed?: boolean | "unknown" };
}

function virtualTimeout(probeProcess: (pid: number) => void = () => undefined) {
	let now = 0;
	return {
		timeoutMs: 100,
		monotonicNow: () => now,
		sleep: async (ms: number) => {
			now += ms;
		},
		random: () => 0,
		probeProcess,
	};
}

function esrch(): NodeJS.ErrnoException {
	return Object.assign(new Error("process does not exist"), { code: "ESRCH" });
}

afterEach(async () => {
	await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryDirectories.clear();
});

describe("directory lock", () => {
	it("publishes owner metadata while held and releases only its lock", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		assert.equal(lockPath, join(root, ".pi-memory-mutation.lock"));

		let observed: LockOwner | undefined;
		const result = await withDirLock(lockPath, async () => {
			observed = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as LockOwner;
			assert.equal(observed.version, 1);
			assert.equal(observed.pid, process.pid);
			assert.match(observed.ownerToken, /^[a-f0-9]{32}$/);
			assert.match(observed.processInstanceToken, /^[a-f0-9]{32}$/);
			return "held";
		});

		assert.equal(result, "held");
		await assert.rejects(readFile(join(lockPath, "owner.json"), "utf8"), { code: "ENOENT" });
		assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".released.")), []);
	});

	it("never steals an old lock from a live owner", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		const owner = await captureRealOwner(lockPath);
		owner.ownerToken = "1".repeat(32);
		owner.acquiredAt = "2000-01-01T00:00:00.000Z";
		await seedLock(lockPath, owner, 24 * 60 * 60 * 1_000);

		await expectCode(withDirLock(lockPath, async () => undefined, virtualTimeout()), "BUSY");
		const retained = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as LockOwner;
		assert.equal(retained.ownerToken, owner.ownerToken);
		assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".orphaned.")), []);
	});

	it("times out for foreign, pid-reused, and unverifiable process owners without quarantining", async () => {
		const root = await makeRoot();
		const templatePath = storeLockPath(root);
		const owner = await captureRealOwner(templatePath);
		const eperm = () => {
			throw Object.assign(new Error("probe not permitted"), { code: "EPERM" });
		};
		let foreignProbeCount = 0;
		const cases: Array<{
			name: string;
			change?: (candidate: LockOwner) => void;
			probe: (pid: number) => void;
		}> = [
			{
				name: "foreign",
				change: (candidate) => (candidate.hostname = `${candidate.hostname}.foreign`),
				probe: () => {
					foreignProbeCount += 1;
				},
			},
			{ name: "live-or-reused-pid", probe: () => undefined },
			{ name: "probe-unknown", probe: eperm },
		];

		for (const [index, testCase] of cases.entries()) {
			const lockPath = join(root, `${testCase.name}.lock`);
			const candidate = structuredClone(owner);
			candidate.ownerToken = String(index + 2).repeat(32);
			testCase.change?.(candidate);
			await seedLock(lockPath, candidate);
			await expectCode(
				withDirLock(lockPath, async () => undefined, virtualTimeout(testCase.probe)),
				"BUSY",
			);
			assert.equal(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).ownerToken, candidate.ownerToken);
		}
		assert.equal(foreignProbeCount, 0);
		assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".orphaned.")), []);
	});

	it("quarantines a verified dead same-host owner before acquiring", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		const owner = await captureRealOwner(lockPath);
		owner.ownerToken = "4".repeat(32);
		await seedLock(lockPath, owner);

		let entered = false;
		await withDirLock(
			lockPath,
			async () => {
				entered = true;
			},
			{ ...virtualTimeout(() => { throw esrch(); }), timeoutMs: 1_000 },
		);
		assert.equal(entered, true);
		assert.ok((await readdir(root)).includes(`.pi-memory-mutation.lock.orphaned.${owner.ownerToken}`));
		await assert.rejects(readFile(join(lockPath, "owner.json"), "utf8"), { code: "ENOENT" });
	});

	it("fails closed for an old lock whose owner cannot be verified", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		await seedLock(lockPath, undefined, 60_000);

		await expectCode(withDirLock(lockPath, async () => undefined, { timeoutMs: 0 }), "LOCK_UNSAFE");
		assert.ok((await readdir(root)).includes(".pi-memory-mutation.lock"));
		assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".orphaned.")), []);
	});

	it("does not remove a lock after its owner token changes", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		const replacementToken = "5".repeat(32);

		await expectCode(
			withDirLock(lockPath, async (lock) => {
				const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as LockOwner;
				await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ ...owner, ownerToken: replacementToken })}\n`);
				assert.equal(await lock.isOwned(), false);
				await lock.assertOwned();
			}),
			"LOCK_UNSAFE",
		);
		assert.equal(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).ownerToken, replacementToken);
	});

	it("fences two contenders recovering the same dead owner", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		const owner = await captureRealOwner(lockPath);
		owner.ownerToken = "6".repeat(32);
		const deadPid = 2_147_483_647;
		owner.pid = deadPid;
		await seedLock(lockPath, owner);

		let active = 0;
		let maximumActive = 0;
		const visits: string[] = [];
		const contend = (name: string) =>
			withDirLock(
				lockPath,
				async () => {
					active += 1;
					maximumActive = Math.max(maximumActive, active);
					visits.push(name);
					await Promise.resolve();
					active -= 1;
				},
				{
					timeoutMs: 5_000,
					probeProcess: (pid) => {
						if (pid === deadPid) throw esrch();
					},
				},
			);
		await Promise.all([contend("a"), contend("b")]);

		assert.equal(maximumActive, 1);
		assert.deepEqual(visits.sort(), ["a", "b"]);
		assert.deepEqual(
			(await readdir(root)).filter((entry) => entry === `.pi-memory-mutation.lock.orphaned.${owner.ownerToken}`),
			[`.pi-memory-mutation.lock.orphaned.${owner.ownerToken}`],
		);
	});

	it("honors abort while waiting without entering the contender callback", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		let contenderEntered = false;
		await withDirLock(lockPath, async () => {
			const controller = new AbortController();
			const contender = withDirLock(
				lockPath,
				async () => {
					contenderEntered = true;
				},
				{ timeoutMs: 5_000, signal: controller.signal },
			);
			setTimeout(() => controller.abort(), 10);
			await expectCode(contender, "BUSY");
		});
		assert.equal(contenderEntered, false);
		await assert.rejects(readFile(join(lockPath, "owner.json"), "utf8"), { code: "ENOENT" });
	});

	it("honors abort after owner publication but before invoking the callback", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		const controller = new AbortController();
		let entered = false;
		await expectCode(
			withDirLock(
				lockPath,
				async () => {
					entered = true;
				},
				{
					signal: controller.signal,
					wallNow: () => {
						controller.abort();
						return Date.now();
					},
				},
			),
			"BUSY",
		);
		assert.equal(entered, false);
		await assert.rejects(readFile(join(lockPath, "owner.json"), "utf8"), { code: "ENOENT" });
	});

	it("surfaces a permanent release-rename failure and leaves ownership untouched", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		let ownerToken = "";
		await expectCode(
			withDirLock(
				lockPath,
				async (lock) => {
					ownerToken = lock.owner.ownerToken;
					return "callback completed";
				},
				{ releaseRename: async () => { throw Object.assign(new Error("permanent release fault"), { code: "EIO" }); } },
			),
			"LOCK_UNSAFE",
		);
		assert.equal(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).ownerToken, ownerToken);
		assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".released.")), []);
	});

	it("retries a transient release failure and returns only after the lock is released", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		let renameCalls = 0;
		let sleepCalls = 0;
		const result = await withDirLock(
			lockPath,
			async () => "released",
			{
				releaseRename: async (from, to) => {
					renameCalls += 1;
					if (renameCalls === 1) {
						throw Object.assign(new Error("transient release fault"), { code: "EACCES" });
					}
					await rename(from, to);
				},
				sleep: async () => { sleepCalls += 1; },
			},
		);
		assert.equal(result, "released");
		assert.equal(renameCalls, 2);
		assert.equal(sleepCalls, 1);
		await assert.rejects(readFile(join(lockPath, "owner.json"), "utf8"), { code: "ENOENT" });
	});

	it("treats the rename as release even when residue removal fails", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		let releasedPath = "";
		const result = await withDirLock(
			lockPath,
			async (lock) => {
				releasedPath = `${lockPath}.released.${lock.owner.ownerToken}`;
				return "released";
			},
			{ releaseRemove: async () => { throw Object.assign(new Error("cleanup fault"), { code: "EIO" }); } },
		);
		assert.equal(result, "released");
		await assert.rejects(readFile(join(lockPath, "owner.json"), "utf8"), { code: "ENOENT" });
		assert.ok((await readdir(root)).includes(releasedPath.slice(root.length + 1)));
		await withDirLock(lockPath, async () => undefined);
	});

	it("surfaces token mismatch discovered during release without touching the foreign lock", async () => {
		const root = await makeRoot();
		const lockPath = storeLockPath(root);
		const replacementToken = "7".repeat(32);
		await expectCode(
			withDirLock(lockPath, async () => {
				const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as LockOwner;
				await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ ...owner, ownerToken: replacementToken })}\n`);
				return "callback completed";
			}),
			"LOCK_UNSAFE",
		);
		assert.equal(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).ownerToken, replacementToken);
	});
});
