import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import {
	initializeProjectSidecar,
	resolveProjectIdentity,
	verifyProjectSidecar,
	type AvailableProjectIdentity,
	type GitIdentityRunner,
	type ProjectSidecarInitializationHooks,
	type ProjectSidecarV1,
} from "../src/identity.js";
import { formatMemoryError, MemoryError } from "../src/errors.js";
import { storeLockPath, withDirLock } from "../src/lock.js";
import { projectStorePaths } from "../src/paths.js";

const execFileAsync = promisify(execFile);
const notRepository: GitIdentityRunner = async () => {
	throw Object.assign(new Error("git exited with status 128"), {
		code: 128,
		stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
	});
};

async function temporaryDirectory(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

async function git(args: string[]): Promise<void> {
	await execFileAsync("git", args, { encoding: "utf8", timeout: 10_000 });
}

async function initializeUnderLock(
	projectDirectory: string,
	identity: AvailableProjectIdentity,
	createdAt: string,
	hooks: ProjectSidecarInitializationHooks = {},
): Promise<ProjectSidecarV1> {
	return withDirLock(storeLockPath(projectDirectory), (lock) =>
		initializeProjectSidecar(projectDirectory, identity, lock, createdAt, hooks),
	);
}

const gitAvailable = await (async () => {
	try {
		await execFileAsync("git", ["--version"], { timeout: 2_000 });
		return true;
	} catch {
		return false;
	}
})();

function requireAvailable(
	identity: Awaited<ReturnType<typeof resolveProjectIdentity>>,
): AvailableProjectIdentity {
	assert.equal(identity.status, "ok", identity.status === "unavailable" ? identity.error : undefined);
	return identity;
}

describe.skipIf(!gitAvailable)("project identity with real Git repositories", () => {
	it("shares one identity across the repository, subdirectories, and linked worktrees", async () => {
		const root = await temporaryDirectory("pi-memory-identity-git-");
		try {
			const repository = join(root, "primary");
			const subdirectory = join(repository, "src", "nested");
			const worktreeOne = join(root, "worktree-one");
			const worktreeTwo = join(root, "worktree-two");
			await mkdir(subdirectory, { recursive: true });
			await git(["init", "--quiet", repository]);
			await writeFile(join(repository, "README.md"), "identity fixture\n", "utf8");
			await git(["-C", repository, "add", "README.md"]);
			await git([
				"-C",
				repository,
				"-c",
				"user.name=Pi Memory Test",
				"-c",
				"user.email=pi-memory@example.invalid",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			]);
			await git(["-C", repository, "worktree", "add", "--quiet", "--detach", worktreeOne, "HEAD"]);
			await git(["-C", repository, "worktree", "add", "--quiet", "--detach", worktreeTwo, "HEAD"]);

			const identities = await Promise.all(
				[repository, subdirectory, worktreeOne, worktreeTwo].map((cwd) => resolveProjectIdentity(cwd)),
			);
			const available = identities.map(requireAvailable);
			assert.equal(available[0].kind, "git-common-dir");
			assert.equal(available[0].canonicalIdentity, await realpath(join(repository, ".git")));
			for (const identity of available.slice(1)) {
				assert.equal(identity.canonicalIdentity, available[0].canonicalIdentity);
				assert.equal(identity.identityHash, available[0].identityHash);
				assert.equal(identity.directoryName, available[0].directoryName);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps separate clones distinct", async () => {
		const root = await temporaryDirectory("pi-memory-identity-clones-");
		try {
			const source = join(root, "source");
			const cloneOne = join(root, "clone-one");
			const cloneTwo = join(root, "clone-two");
			await git(["init", "--quiet", source]);
			await writeFile(join(source, "file.txt"), "clone fixture\n", "utf8");
			await git(["-C", source, "add", "file.txt"]);
			await git([
				"-C",
				source,
				"-c",
				"user.name=Pi Memory Test",
				"-c",
				"user.email=pi-memory@example.invalid",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			]);
			await git(["clone", "--quiet", source, cloneOne]);
			await git(["clone", "--quiet", source, cloneTwo]);

			const first = requireAvailable(await resolveProjectIdentity(cloneOne));
			const second = requireAvailable(await resolveProjectIdentity(cloneTwo));
			assert.equal(first.kind, "git-common-dir");
			assert.equal(second.kind, "git-common-dir");
			assert.notEqual(first.canonicalIdentity, second.canonicalIdentity);
			assert.notEqual(first.identityHash, second.identityHash);
			assert.notEqual(first.directoryName, second.directoryName);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("routes a submodule separately from its superproject", async () => {
		const root = await temporaryDirectory("pi-memory-identity-submodule-");
		try {
			const source = join(root, "source");
			const repository = join(root, "superproject");
			const submodule = join(repository, "vendor", "child");
			await git(["init", "--quiet", source]);
			await writeFile(join(source, "fixture.txt"), "submodule fixture\n", "utf8");
			await git(["-C", source, "add", "fixture.txt"]);
			await git([
				"-C",
				source,
				"-c",
				"user.name=Pi Memory Test",
				"-c",
				"user.email=pi-memory@example.invalid",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			]);
			await git(["init", "--quiet", repository]);
			await git([
				"-c",
				"protocol.file.allow=always",
				"-C",
				repository,
				"submodule",
				"add",
				"--quiet",
				source,
				"vendor/child",
			]);

			const parentIdentity = requireAvailable(await resolveProjectIdentity(repository));
			const submoduleIdentity = requireAvailable(await resolveProjectIdentity(submodule));
			assert.equal(parentIdentity.kind, "git-common-dir");
			assert.equal(submoduleIdentity.kind, "git-common-dir");
			assert.equal(
				submoduleIdentity.canonicalIdentity,
				await realpath(join(repository, ".git", "modules", "vendor", "child")),
			);
			assert.notEqual(submoduleIdentity.identityHash, parentIdentity.identityHash);
			assert.notEqual(submoduleIdentity.directoryName, parentIdentity.directoryName);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses a bare repository common directory as its identity", async () => {
		const root = await temporaryDirectory("pi-memory-identity-bare-");
		try {
			const repository = join(root, "bare-project.git");
			await git(["init", "--quiet", "--bare", repository]);
			const identity = requireAvailable(await resolveProjectIdentity(repository));
			assert.equal(identity.kind, "git-common-dir");
			assert.equal(identity.canonicalIdentity, await realpath(repository));
			assert.equal(identity.displayName, "bare-project.git");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to the canonical cwd outside a repository", async () => {
		const root = await temporaryDirectory("pi-memory-identity-nongit-");
		try {
			const identity = requireAvailable(await resolveProjectIdentity(root));
			assert.equal(identity.kind, "directory");
			assert.equal(identity.canonicalIdentity, await realpath(root));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("project identity failure classification", () => {
	it("uses the directory fallback when the Git executable is absent", async () => {
		const root = await temporaryDirectory("pi-memory-identity-absent-");
		try {
			const runGit: GitIdentityRunner = async () => {
				throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
			};
			const identity = requireAvailable(await resolveProjectIdentity(root, { runGit }));
			assert.equal(identity.kind, "directory");
			assert.equal(identity.canonicalIdentity, await realpath(root));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not mint a routable cwd identity on timeout, malformed output, or other failures", async () => {
		const root = await temporaryDirectory("pi-memory-identity-unavailable-");
		try {
			const failures: GitIdentityRunner[] = [
				async () => {
					throw Object.assign(new Error("command timed out"), { killed: true, signal: "SIGTERM" });
				},
				async () => ({ stdout: "relative/path\n", stderr: "" }),
				async () => ({ stdout: "\n", stderr: "" }),
				async () => ({ stdout: `${join(root, "one")}\n${join(root, "two")}\n`, stderr: "" }),
				async () => ({ stdout: `${join(root, "nul")}\0suffix\n`, stderr: "" }),
				async () => ({ stdout: `${join(root, "missing-common-dir")}\n`, stderr: "" }),
				async () => {
					throw Object.assign(new Error("permission denied"), { code: "EACCES" });
				},
			];
			for (const runGit of failures) {
				const identity = await resolveProjectIdentity(root, { gitTimeoutMs: 5, runGit });
				assert.equal(identity.status, "unavailable");
				assert.equal("identityHash" in identity, false);
				assert.equal("directoryName" in identity, false);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not treat every Git exit 128 as a non-repository", async () => {
		const root = await temporaryDirectory("pi-memory-identity-git-128-");
		try {
			const runGit: GitIdentityRunner = async () => {
				throw Object.assign(new Error("git exited with status 128"), {
					code: 128,
					stderr: "fatal: detected dubious ownership in repository\n",
				});
			};
			const identity = await resolveProjectIdentity(root, { runGit });
			assert.equal(identity.status, "unavailable");
			assert.equal("identityHash" in identity, false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("project identity hashing and routing name", () => {
	it("uses the full deterministic hash and a bounded safe slug plus hash16", async () => {
		const root = await temporaryDirectory("pi-memory-identity-hash-");
		try {
			const displayName = "Hello, Café___Project With A Very Very Very Long Name 123456789";
			const cwd = join(root, displayName);
			await mkdir(cwd);
			const first = requireAvailable(await resolveProjectIdentity(cwd, { runGit: notRepository }));
			const second = requireAvailable(await resolveProjectIdentity(cwd, { runGit: notRepository }));
			const canonicalCwd = await realpath(cwd);
			const hashHex = createHash("sha256")
				.update(`directory\0${canonicalCwd}`, "utf8")
				.digest("hex");

			assert.equal(first.identityHash, `sha256:${hashHex}`);
			assert.equal(first.identityHash.length, "sha256:".length + 64);
			assert.equal(
				first.directoryName,
				`hello-caf-project-with-a-very-very-very-long-nam-${hashHex.slice(0, 16)}`,
			);
			assert.match(first.directoryName, /^[a-z0-9-]+-[0-9a-f]{16}$/);
			assert.equal(first.directoryName.length, 48 + 1 + 16);
			assert.equal(
				projectStorePaths({ agentDir: root, root: join(root, "pi-memory") }, first.directoryName).directory,
				join(root, "pi-memory", "projects", first.directoryName),
			);
			assert.deepEqual(second, first);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("canonicalizes a symlinked cwd to the same identity", async () => {
		const root = await temporaryDirectory("pi-memory-identity-symlink-");
		try {
			const cwd = join(root, "project");
			const linkedCwd = join(root, "linked-project");
			await mkdir(cwd);
			await symlink(cwd, linkedCwd, "dir");
			const direct = requireAvailable(await resolveProjectIdentity(cwd, { runGit: notRepository }));
			const linked = requireAvailable(await resolveProjectIdentity(linkedCwd, { runGit: notRepository }));
			assert.deepEqual(linked, direct);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses the project slug fallback when the display name has no ASCII slug characters", async () => {
		const root = await temporaryDirectory("pi-memory-identity-slug-");
		try {
			const cwd = join(root, "项目");
			await mkdir(cwd);
			const identity = requireAvailable(await resolveProjectIdentity(cwd, { runGit: notRepository }));
			assert.match(identity.directoryName, /^project-[0-9a-f]{16}$/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("project identity sidecar", () => {
	it("verifies and initializes without creating directories on read paths", async () => {
		const root = await temporaryDirectory("pi-memory-sidecar-");
		try {
			const cwd = join(root, "repository");
			const stores = join(root, "stores");
			await mkdir(cwd);
			await mkdir(stores);
			const identity = requireAvailable(await resolveProjectIdentity(cwd, { runGit: notRepository }));
			const projectDirectory = join(stores, identity.directoryName);

			assert.equal(await verifyProjectSidecar(projectDirectory, identity), "missing-empty");
			assert.deepEqual(await readdir(stores), []);

			const occupiedDirectory = join(root, "occupied", identity.directoryName);
			await mkdir(occupiedDirectory, { recursive: true });
			await writeFile(join(occupiedDirectory, "details.md"), "existing store\n", "utf8");
			await assert.rejects(verifyProjectSidecar(occupiedDirectory, identity), {
				code: "IDENTITY_MISMATCH",
			});

			await mkdir(projectDirectory, { mode: 0o700 });
			const checkpoints: string[] = [];
			const initialized = await initializeUnderLock(
				projectDirectory,
				identity,
				"2026-08-23T00:00:00.000Z",
				{
					async checkpoint(name, temporaryPath) {
						checkpoints.push(name);
						assert.equal(dirname(temporaryPath), storeLockPath(projectDirectory));
						if (name === "before-rename") {
							const temporaryContents = await readFile(temporaryPath, "utf8");
							assert.doesNotThrow(() => JSON.parse(temporaryContents));
							await assert.rejects(readFile(join(projectDirectory, "project.json"), "utf8"), {
								code: "ENOENT",
							});
						} else {
							const publishedContents = await readFile(join(projectDirectory, "project.json"), "utf8");
							assert.doesNotThrow(() => JSON.parse(publishedContents));
						}
					},
				},
			);
			assert.deepEqual(checkpoints, ["before-rename", "after-rename"]);
			assert.equal(initialized.createdAt, "2026-08-23T00:00:00.000Z");
			assert.equal(await verifyProjectSidecar(projectDirectory, identity), "matched");
			const path = join(projectDirectory, "project.json");
			const firstBytes = await readFile(path, "utf8");
			const onDisk = JSON.parse(firstBytes);
			assert.equal(onDisk.status, undefined);
			assert.equal(onDisk.identityHash, identity.identityHash);
			assert.equal(onDisk.directoryName, basename(projectDirectory));

			const repeated = await initializeUnderLock(
				projectDirectory,
				identity,
				"2027-01-01T00:00:00.000Z",
			);
			assert.deepEqual(repeated, initialized);
			assert.equal(await readFile(path, "utf8"), firstBytes);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("leaves no partial final sidecar or temp when writing fails", async () => {
		const root = await temporaryDirectory("pi-memory-sidecar-write-failure-");
		try {
			const cwd = join(root, "repository");
			await mkdir(cwd);
			const identity = requireAvailable(await resolveProjectIdentity(cwd, { runGit: notRepository }));
			const projectDirectory = join(root, identity.directoryName);
			await mkdir(projectDirectory, { mode: 0o700 });
			const injectedFailure = Object.assign(new Error("injected sidecar write failure"), { code: "EIO" });

			await withDirLock(storeLockPath(projectDirectory), async (lock) => {
				await assert.rejects(
					initializeProjectSidecar(
						projectDirectory,
						identity,
						lock,
						"2026-08-23T00:00:00.000Z",
						{
							async writeFile(handle, contents) {
								const stats = await handle.stat();
								assert.equal(Number(stats.mode & 0o777), 0o600);
								await handle.writeFile(contents.slice(0, 12), "utf8");
								throw injectedFailure;
							},
						},
					),
					(error: unknown) => error === injectedFailure,
				);
				await assert.rejects(readFile(join(projectDirectory, "project.json"), "utf8"), { code: "ENOENT" });
				assert.equal(await verifyProjectSidecar(projectDirectory, identity), "missing-empty");
				assert.deepEqual((await readdir(lock.lockPath)).sort(), ["owner.json"]);
			});
			assert.deepEqual(await readdir(projectDirectory), []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed on a full-hash sidecar mismatch with the shared error contract", async () => {
		const root = await temporaryDirectory("pi-memory-sidecar-mismatch-");
		try {
			const cwd = join(root, "repository");
			await mkdir(cwd);
			const identity = requireAvailable(await resolveProjectIdentity(cwd, { runGit: notRepository }));
			const projectDirectory = join(root, identity.directoryName);
			await mkdir(projectDirectory);
			await initializeUnderLock(projectDirectory, identity, "2026-08-23T00:00:00.000Z");
			const path = join(projectDirectory, "project.json");
			const sidecar = JSON.parse(await readFile(path, "utf8"));
			sidecar.identityHash = `sha256:${"0".repeat(64)}`;
			await writeFile(path, `${JSON.stringify(sidecar)}\n`, "utf8");

			await assert.rejects(verifyProjectSidecar(projectDirectory, identity), (error: unknown) => {
				assert.ok(error instanceof MemoryError);
				assert.equal(error.code, "IDENTITY_MISMATCH");
				assert.equal(error.operation, "read");
				assert.equal(error.path, path);
				assert.match(formatMemoryError(error), /^\[PI_MEMORY_IDENTITY_MISMATCH\] /);
				assert.doesNotMatch(formatMemoryError(error), /\[PI_MEMORY_IO\]/);
				return true;
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
