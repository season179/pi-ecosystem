import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withFileLock } from "./file-lock.js";

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface SnapshotPolicy {
	maxFileBytes: number;
	maxProjectBytes: number;
	maxTotalBytes: number;
	maxTotalEntries: number;
	maxEntries: number;
	maxEntriesPerFile: number;
	maxAgeMs: number;
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
	maxFileBytes: 5 * 1024 * 1024,
	maxProjectBytes: 50 * 1024 * 1024,
	maxTotalBytes: 500 * 1024 * 1024,
	maxTotalEntries: 2000,
	maxEntries: 200,
	maxEntriesPerFile: 20,
	maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

export type SnapshotStorage = "blob" | "git" | "absence";

export interface SnapshotMetadata {
	id: string;
	createdAt: string;
	cwd: string;
	path: string;
	relativePath: string;
	tool: "write" | "edit";
	existed: boolean;
	mode?: number;
	storage: SnapshotStorage;
	blobHash?: string;
	originalBytes?: number;
	storedBytes?: number;
	gitRoot?: string;
	gitCommit?: string;
	gitPath?: string;
}

export interface SnapshotUsage {
	entries: number;
	blobs: number;
	storedBytes: number;
}

function projectKey(cwd: string): string {
	return createHash("sha256").update(resolve(cwd)).digest("hex");
}

function mergePolicy(overrides: Partial<SnapshotPolicy>): SnapshotPolicy {
	return { ...DEFAULT_SNAPSHOT_POLICY, ...overrides };
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
	try {
		await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
		return true;
	} catch {
		return false;
	}
}

async function restoreGitReference(
	metadata: SnapshotMetadata,
	target: string,
): Promise<void> {
	if (!metadata.gitRoot || !metadata.gitCommit || !metadata.gitPath) {
		throw new Error("Git snapshot metadata is incomplete");
	}
	await mkdir(dirname(target), { recursive: true });
	const temporary = join(
		dirname(target),
		`.pi-guard-restore-${randomBytes(6).toString("hex")}.tmp`,
	);
	const child = spawn(
		"git",
		[
			"-C",
			metadata.gitRoot,
			"cat-file",
			"--filters",
			`--path=${metadata.gitPath}`,
			`${metadata.gitCommit}:${metadata.gitPath}`,
		],
		{ shell: false, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		if (stderr.length < 8192) stderr += chunk.toString();
	});
	const exited = new Promise<void>((resolveExit, rejectExit) => {
		child.on("error", rejectExit);
		child.on("close", (code) => {
			if (code === 0) resolveExit();
			else rejectExit(new Error(`git snapshot restore failed (${code}): ${stderr.trim()}`));
		});
	});
	try {
		if (!child.stdout) throw new Error("git snapshot restore produced no output stream");
		await Promise.all([
			pipeline(child.stdout, createWriteStream(temporary, { flags: "wx", mode: 0o600 })),
			exited,
		]);
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

async function gitReference(
	cwd: string,
	path: string,
): Promise<{ root: string; commit: string; path: string } | undefined> {
	try {
		const rootResult = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		const root = await realpath(resolve(rootResult.stdout.trim()));
		const rel = relative(root, await realpath(resolve(path)));
		if (!rel || rel === ".." || rel.startsWith("../")) return undefined;
		const tracked = await commandSucceeds("git", [
			"-C",
			root,
			"ls-files",
			"--error-unmatch",
			"--",
			rel,
		]);
		if (!tracked) return undefined;
		const worktreeClean = await commandSucceeds("git", [
			"-C",
			root,
			"diff",
			"--quiet",
			"--",
			rel,
		]);
		const indexClean = await commandSucceeds("git", [
			"-C",
			root,
			"diff",
			"--cached",
			"--quiet",
			"--",
			rel,
		]);
		if (!worktreeClean || !indexClean) return undefined;
		const commitResult = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		return { root, commit: commitResult.stdout.trim(), path: rel };
	} catch {
		return undefined;
	}
}

export class SnapshotStore {
	private readonly policy: SnapshotPolicy;
	private operation = Promise.resolve();

	constructor(
		private readonly root = join(getAgentDir(), "pi-guard", "snapshots"),
		policy: Partial<SnapshotPolicy> = {},
	) {
		this.policy = mergePolicy(policy);
	}

	private projectDir(cwd: string): string {
		return join(this.root, projectKey(cwd));
	}

	private metadataDir(cwd: string): string {
		return join(this.projectDir(cwd), "metadata");
	}

	private blobsDir(cwd: string): string {
		return join(this.projectDir(cwd), "blobs");
	}

	private async serialized<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.operation;
		let release!: () => void;
		this.operation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await withFileLock(join(this.root, ".lock"), operation);
		} finally {
			release();
		}
	}

	async create(options: {
		cwd: string;
		path: string;
		relativePath: string;
		tool: "write" | "edit";
	}): Promise<SnapshotMetadata> {
		return this.serialized(async () => {
			const createdAt = new Date().toISOString();
			const id = `${createdAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
			const metadataDir = this.metadataDir(options.cwd);
			const blobsDir = this.blobsDir(options.cwd);
			await mkdir(metadataDir, { recursive: true, mode: 0o700 });
			await mkdir(blobsDir, { recursive: true, mode: 0o700 });

			let metadata: SnapshotMetadata;
			try {
				const current = await stat(options.path);
				if (!current.isFile()) {
					throw new Error(`Snapshot target is not a regular file: ${options.path}`);
				}
				const git = await gitReference(options.cwd, options.path);
				if (git) {
					metadata = {
						id,
						createdAt,
						cwd: resolve(options.cwd),
						path: resolve(options.path),
						relativePath: options.relativePath,
						tool: options.tool,
						existed: true,
						mode: current.mode & 0o777,
						storage: "git",
						originalBytes: current.size,
						storedBytes: 0,
						gitRoot: git.root,
						gitCommit: git.commit,
						gitPath: git.path,
					};
				} else {
					if (current.size > this.policy.maxFileBytes) {
						throw new Error(
							`Pi Guard cannot safely snapshot ${options.relativePath}: ` +
							`${current.size} bytes exceeds the ${this.policy.maxFileBytes}-byte per-file limit`,
						);
					}
					const content = await readFile(options.path);
					const blobHash = createHash("sha256").update(content).digest("hex");
					const blobPath = join(blobsDir, `${blobHash}.gz`);
					let storedBytes: number;
					try {
						storedBytes = (await stat(blobPath)).size;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						const compressed = await gzipAsync(content, { level: 9 });
						if (
							compressed.length > this.policy.maxProjectBytes ||
							compressed.length > this.policy.maxTotalBytes
						) {
							throw new Error(
								`Pi Guard cannot safely snapshot ${options.relativePath}: compressed snapshot exceeds the project quota`,
							);
						}
						const temporary = join(blobsDir, `.${blobHash}-${randomBytes(4).toString("hex")}.tmp`);
						await writeFile(temporary, compressed, { mode: 0o600, flag: "wx" });
						try {
							await rename(temporary, blobPath);
						} catch (renameError) {
							await rm(temporary, { force: true });
							try {
								storedBytes = (await stat(blobPath)).size;
							} catch {
								throw renameError;
							}
						}
						storedBytes = compressed.length;
					}
					metadata = {
						id,
						createdAt,
						cwd: resolve(options.cwd),
						path: resolve(options.path),
						relativePath: options.relativePath,
						tool: options.tool,
						existed: true,
						mode: current.mode & 0o777,
						storage: "blob",
						blobHash,
						originalBytes: content.length,
						storedBytes,
					};
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				metadata = {
					id,
					createdAt,
					cwd: resolve(options.cwd),
					path: resolve(options.path),
					relativePath: options.relativePath,
					tool: options.tool,
					existed: false,
					storage: "absence",
					originalBytes: 0,
					storedBytes: 0,
				};
			}

			const metadataPath = join(metadataDir, `${id}.json`);
			await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			await this.pruneUnlocked(options.cwd, metadataPath);
			await this.pruneGlobalUnlocked(metadataPath);
			return metadata;
		});
	}

	private async metadataUnlocked(cwd: string): Promise<Array<{ path: string; value: SnapshotMetadata }>> {
		let files: string[];
		try {
			files = await readdir(this.metadataDir(cwd));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const records: Array<{ path: string; value: SnapshotMetadata }> = [];
		for (const file of files.filter((name) => name.endsWith(".json"))) {
			const path = join(this.metadataDir(cwd), file);
			try {
				records.push({ path, value: JSON.parse(await readFile(path, "utf8")) as SnapshotMetadata });
			} catch {
				// Ignore malformed metadata here; restore will still surface it directly.
			}
		}
		return records.sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));
	}

	private async pruneGlobalUnlocked(protectedMetadataPath: string): Promise<void> {
		let projects: Array<{ name: string; isDirectory(): boolean }> = [];
		try {
			projects = await readdir(this.root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const projectDirs = projects
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(this.root, entry.name));
		const records: Array<{
			projectDir: string;
			path: string;
			value: SnapshotMetadata;
		}> = [];
		for (const projectDir of projectDirs) {
			const metadataDir = join(projectDir, "metadata");
			let files: string[] = [];
			try {
				files = await readdir(metadataDir);
			} catch {
				continue;
			}
			for (const file of files.filter((name) => name.endsWith(".json"))) {
				const path = join(metadataDir, file);
				try {
					records.push({
						projectDir,
						path,
						value: JSON.parse(await readFile(path, "utf8")) as SnapshotMetadata,
					});
				} catch {
					// Malformed records are ignored, never trusted for blob retention.
				}
			}
		}
		records.sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));
		const remove = new Set<string>();
		const cutoff = Date.now() - this.policy.maxAgeMs;
		for (const record of records) {
			if (
				record.path !== protectedMetadataPath &&
				Date.parse(record.value.createdAt) < cutoff
			) {
				remove.add(record.path);
			}
		}
		let retained = records.filter((record) => !remove.has(record.path));
		let excessEntries = Math.max(0, retained.length - this.policy.maxTotalEntries);
		for (const record of retained) {
			if (excessEntries === 0) break;
			if (record.path === protectedMetadataPath) continue;
			remove.add(record.path);
			excessEntries -= 1;
		}
		retained = records.filter((record) => !remove.has(record.path));
		const totalBlobBytes = () => {
			const blobs = new Map<string, number>();
			for (const record of retained) {
				if (record.value.storage === "blob" && record.value.blobHash) {
					blobs.set(
						`${record.projectDir}:${record.value.blobHash}`,
						record.value.storedBytes ?? 0,
					);
				}
			}
			return [...blobs.values()].reduce((sum, bytes) => sum + bytes, 0);
		};
		while (totalBlobBytes() > this.policy.maxTotalBytes) {
			const index = retained.findIndex((record) => record.path !== protectedMetadataPath);
			if (index < 0) {
				throw new Error(
					"Pi Guard cannot enforce the global snapshot quota without deleting the newest snapshot",
				);
			}
			const [oldest] = retained.splice(index, 1);
			if (oldest) remove.add(oldest.path);
		}
		await Promise.all([...remove].map((path) => rm(path, { force: true })));
		retained = records.filter((record) => !remove.has(record.path));

		for (const projectDir of projectDirs) {
			const referenced = new Set(
				retained
					.filter((record) => record.projectDir === projectDir)
					.map((record) => record.value.blobHash)
					.filter((hash): hash is string => typeof hash === "string"),
			);
			let blobs: string[] = [];
			try {
				blobs = await readdir(join(projectDir, "blobs"));
			} catch {
				continue;
			}
			await Promise.all(
				blobs
					.filter((file) => file.endsWith(".gz") && !referenced.has(file.slice(0, -3)))
					.map((file) => rm(join(projectDir, "blobs", file), { force: true })),
			);
		}
	}

	private async pruneUnlocked(cwd: string, protectedMetadataPath: string): Promise<void> {
		const records = await this.metadataUnlocked(cwd);
		const remove = new Set<string>();
		const cutoff = Date.now() - this.policy.maxAgeMs;
		for (const record of records) {
			if (
				record.path !== protectedMetadataPath &&
				Date.parse(record.value.createdAt) < cutoff
			) {
				remove.add(record.path);
			}
		}

		const perFile = new Map<string, Array<{ path: string; value: SnapshotMetadata }>>();
		for (const record of records) {
			if (remove.has(record.path)) continue;
			const group = perFile.get(record.value.path) ?? [];
			group.push(record);
			perFile.set(record.value.path, group);
		}
		for (const group of perFile.values()) {
			let excess = Math.max(0, group.length - this.policy.maxEntriesPerFile);
			for (const record of group) {
				if (excess === 0) break;
				if (record.path === protectedMetadataPath) continue;
				remove.add(record.path);
				excess -= 1;
			}
		}

		let retained = records.filter((record) => !remove.has(record.path));
		let excessEntries = Math.max(0, retained.length - this.policy.maxEntries);
		for (const record of retained) {
			if (excessEntries === 0) break;
			if (record.path === protectedMetadataPath) continue;
			remove.add(record.path);
			excessEntries -= 1;
		}
		retained = records.filter((record) => !remove.has(record.path));

		const uniqueBlobBytes = () => {
			const blobs = new Map<string, number>();
			for (const record of retained) {
				if (record.value.storage === "blob" && record.value.blobHash) {
					blobs.set(record.value.blobHash, record.value.storedBytes ?? 0);
				}
			}
			return [...blobs.values()].reduce((sum, bytes) => sum + bytes, 0);
		};
		while (uniqueBlobBytes() > this.policy.maxProjectBytes) {
			const index = retained.findIndex((record) => record.path !== protectedMetadataPath);
			if (index < 0) {
				throw new Error(
					"Pi Guard cannot enforce the project snapshot quota without deleting the newest snapshot",
				);
			}
			const [oldest] = retained.splice(index, 1);
			if (oldest) remove.add(oldest.path);
		}

		await Promise.all([...remove].map((path) => rm(path, { force: true })));
		retained = records.filter((record) => !remove.has(record.path));
		const referenced = new Set(
			retained
				.map((record) => record.value.blobHash)
				.filter((hash): hash is string => typeof hash === "string"),
		);
		let blobs: string[] = [];
		try {
			blobs = await readdir(this.blobsDir(cwd));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await Promise.all(
			blobs
				.filter((file) => file.endsWith(".gz") && !referenced.has(file.slice(0, -3)))
				.map((file) => rm(join(this.blobsDir(cwd), file), { force: true })),
		);
	}

	async read(cwd: string, id: string): Promise<SnapshotMetadata> {
		if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid snapshot id");
		const path = join(this.metadataDir(cwd), `${id}.json`);
		let metadata: SnapshotMetadata;
		try {
			metadata = JSON.parse(await readFile(path, "utf8")) as SnapshotMetadata;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(`Snapshot ${id} was not found or has expired`);
			}
			throw error;
		}
		if (metadata.id !== id || resolve(metadata.cwd) !== resolve(cwd)) {
			throw new Error("Snapshot metadata does not match this workspace");
		}
		return metadata;
	}

	async restore(cwd: string, id: string): Promise<SnapshotMetadata> {
		return this.serialized(async () => {
			const metadata = await this.read(cwd, id);
			const projectRoot = resolve(cwd);
			const target = resolve(metadata.path);
			const rel = relative(projectRoot, target);
			if (rel === ".." || rel.startsWith("../")) {
				throw new Error("Snapshot target is outside this workspace");
			}
			if (metadata.storage === "absence") {
				try {
					await unlink(target);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				return metadata;
			}

			if (metadata.storage === "git") {
				await restoreGitReference(metadata, target);
			} else {
				if (!metadata.blobHash || basename(metadata.blobHash) !== metadata.blobHash) {
					throw new Error("Snapshot blob hash is invalid");
				}
				const compressed = await readFile(join(this.blobsDir(cwd), `${metadata.blobHash}.gz`));
				const content = await gunzipAsync(compressed);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content);
			}
			if (metadata.mode !== undefined) await chmod(target, metadata.mode);
			return metadata;
		});
	}

	async usage(cwd: string): Promise<SnapshotUsage> {
		return this.serialized(async () => {
			const records = await this.metadataUnlocked(cwd);
			const blobs = new Map<string, number>();
			for (const record of records) {
				if (record.value.storage === "blob" && record.value.blobHash) {
					blobs.set(record.value.blobHash, record.value.storedBytes ?? 0);
				}
			}
			return {
				entries: records.length,
				blobs: blobs.size,
				storedBytes: [...blobs.values()].reduce((sum, bytes) => sum + bytes, 0),
			};
		});
	}
}
