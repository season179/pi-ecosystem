import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import {
	estimateTokens,
	mutateMemoryStore,
	parseDetails,
	parseIndex,
	readMemorySnapshot,
	searchMemories,
	serializeDetails,
	serializeIndex,
	type Memory,
} from "../src/store.js";
import { assertContainedRegularPath, resolveMemoryRoot } from "../src/paths.js";

const fixtureRoot = fileURLToPath(new URL("fixtures/v1/", import.meta.url));
const compatibilityFixture = fileURLToPath(new URL("helpers/v26_8-api-compat.ts", import.meta.url));
const tscPath = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url));
const execFileAsync = promisify(execFile);
const fixedNow = "2026-08-05T10:00:00.000Z";

const memories: Memory[] = [
	{
		id: "m_aaaaaaaaaa",
		title: "Graph | preferences",
		updated: "2026-08-01T10:00:00.000Z",
		tags: ["graph, db", "C:\\notes"],
		cue: "When a graph | database is discussed",
		body: "Prefer Memgraph.\n\n## Notes\nKeep queries concise.\n## m_bbbbbbbbbb — body heading",
	},
];

interface FixtureManifest {
	version: number;
	files: Array<{ path: string; bytes: number; sha256: string }>;
}

async function fixtureText(name: string, file = "details.md"): Promise<string> {
	return readFile(join(fixtureRoot, name, file), "utf8");
}

async function copyFixture(name: string): Promise<{ base: string; directory: string }> {
	const base = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
	const directory = join(base, "store");
	await cp(join(fixtureRoot, name), directory, { recursive: true });
	return { base, directory };
}

async function listFiles(directory: string, relative = ""): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
		const path = join(relative, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(directory, path)));
		else files.push(path);
	}
	return files.sort();
}

async function storeFingerprint(directory: string): Promise<Array<Record<string, string | number>>> {
	const entries: Array<Record<string, string | number>> = [];
	async function visit(relative: string): Promise<void> {
		for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
			const path = join(relative, entry.name);
			const metadata = await stat(join(directory, path), { bigint: true });
			if (entry.isDirectory()) {
				entries.push({ path, type: "directory", mode: Number(metadata.mode & 0o777n) });
				await visit(path);
			} else {
				const bytes = await readFile(join(directory, path));
				entries.push({
					path,
					type: "file",
					mode: Number(metadata.mode & 0o777n),
					size: Number(metadata.size),
					mtimeNs: metadata.mtimeNs.toString(),
					sha256: createHash("sha256").update(bytes).digest("hex"),
				});
			}
		}
	}
	await visit("");
	return entries.sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

type CodedError = Error & {
	code: string;
	retryable?: boolean;
	committed?: boolean | "unknown";
};

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<CodedError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error, `expected ${code} error`);
	assert.equal((caught as CodedError).code, code);
	return caught as CodedError;
}

async function captureRejection(promise: Promise<unknown>): Promise<CodedError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error, "expected operation to reject");
	return caught as CodedError;
}

function errno(code: string, message = code): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

describe("memory store", () => {
	it("round-trips the details and index formats", () => {
		assert.deepEqual(parseDetails(serializeDetails(memories)), memories.map((memory) => ({ ...memory, injection: memory.injection ?? "on-demand" })));
		assert.deepEqual(parseIndex(serializeIndex(memories)), memories.map(({ body: _body, injection: _injection, ...memory }) => memory));
	});

	it("ranks exact matches, word overlap, and recency", () => {
		const candidates: Memory[] = [
			...memories,
			{
				id: "m_cccccccccc",
				title: "Graph cache",
				updated: "2026-08-03T10:00:00.000Z",
				tags: ["cache"],
				cue: "Graph cache tuning",
				body: "newer",
			},
			{
				id: "m_dddddddddd",
				title: "Other",
				updated: "2026-08-04T10:00:00.000Z",
				tags: ["graph"],
				cue: "General lookup",
				body: "newest",
			},
		];
		assert.equal(searchMemories(candidates, "Graph | preferences")[0]?.id, "m_aaaaaaaaaa");
		assert.equal(searchMemories(candidates, "graph cache")[0]?.id, "m_cccccccccc");
		assert.equal(searchMemories(candidates, "")[0]?.id, "m_dddddddddd");
	});

	it("refuses a mutation over the token cap without writing files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
		try {
			const error = await rejectsWithCode(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "Huge", cue: "Always", body: "x".repeat(17_000) },
					{ now: fixedNow, idFactory: () => "m_aaaaaaaaaa" },
				),
				"CAP_EXCEEDED",
			);
			assert.match(error.message, /current 0, projected .*oldest: m_aaaaaaaaaa.*largest: m_aaaaaaaaaa/);
			await assert.rejects(readFile(join(directory, "details.md"), "utf8"), { code: "ENOENT" });
			await assert.rejects(readFile(join(directory, "index.md"), "utf8"), { code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("immutable v1 fixtures", () => {
	it("match the checked-in byte manifest", async () => {
		const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")) as FixtureManifest;
		assert.equal(manifest.version, 1);
		assert.deepEqual(
			(await listFiles(fixtureRoot)).filter((path) => path !== "manifest.json"),
			manifest.files.map((entry) => entry.path).sort(),
		);
		for (const expected of manifest.files) {
			const bytes = await readFile(join(fixtureRoot, expected.path));
			assert.equal(bytes.length, expected.bytes, expected.path);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, expected.path);
		}
	});

	it.each(["empty", "complex-single", "multi-unicode", "near-cap", "over-cap"])(
		"round-trips canonical %s bytes",
		async (name) => {
			const details = await fixtureText(name);
			const index = await fixtureText(name, "index.md");
			const parsed = parseDetails(details);
			assert.equal(serializeDetails(parsed), details);
			assert.equal(serializeIndex(parsed), index);
			assert.deepEqual(parseIndex(index), parsed.map(({ body: _body, injection: _injection, ...memory }) => memory));
		},
	);

	it("pins the v1 generation to exact authoritative bytes", async () => {
		const snapshot = await readMemorySnapshot(join(fixtureRoot, "complex-single"));
		assert.equal(snapshot.generation, "sha256:151a5c1c2be5ff68a2830cfaf091cf28a41a4f2b777d3a6b2eb658cfe6829f33");
	});

	it("pins the current token-cap boundary", async () => {
		assert.equal(estimateTokens(await fixtureText("near-cap")), 4_000);
		assert.equal(estimateTokens(await fixtureText("over-cap")), 4_001);
	});
});

describe("read-only snapshots", () => {
	it("treats canonical zero-byte details and index as current", async () => {
		const { base, directory } = await copyFixture("empty");
		try {
			const before = await storeFingerprint(directory);
			const snapshot = await readMemorySnapshot(directory);
			assert.deepEqual(snapshot.memories, []);
			assert.equal(snapshot.detailsMarkdown, "");
			assert.equal(snapshot.indexMarkdown, "");
			assert.equal(snapshot.indexState, "current");
			assert.equal(snapshot.generation, "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it.each([
		["complex-single", "current"],
		["missing-index", "missing"],
		["stale-index", "stale"],
		["malformed-index", "malformed"],
	] as const)("classifies a %s index as %s without repairing it", async (name, expectedState) => {
		const { base, directory } = await copyFixture(name);
		try {
			const before = await storeFingerprint(directory);
			const snapshot = await readMemorySnapshot(directory);
			assert.equal(snapshot.indexState, expectedState);
			assert.equal(snapshot.detailsMarkdown, await fixtureText(name));
			assert.equal(snapshot.indexMarkdown, await fixtureText("complex-single", "index.md"));
			assert.equal(snapshot.generation, "sha256:151a5c1c2be5ff68a2830cfaf091cf28a41a4f2b777d3a6b2eb658cfe6829f33");
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("leaves an absent store absent", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
		const directory = join(base, "absent");
		try {
			const snapshot = await readMemorySnapshot(directory);
			assert.deepEqual(snapshot.memories, []);
			assert.equal(snapshot.detailsMarkdown, "");
			assert.equal(snapshot.indexMarkdown, "");
			await assert.rejects(stat(directory), { code: "ENOENT" });
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("reads through a missing index in a read-only directory", async () => {
		const { base, directory } = await copyFixture("missing-index");
		try {
			await chmod(join(directory, "details.md"), 0o444);
			await chmod(directory, 0o555);
			const before = await storeFingerprint(directory);
			const snapshot = await readMemorySnapshot(directory);
			assert.equal(snapshot.indexState, "missing");
			assert.equal(snapshot.indexMarkdown, await fixtureText("complex-single", "index.md"));
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await chmod(directory, 0o755).catch(() => undefined);
			await chmod(join(directory, "details.md"), 0o644).catch(() => undefined);
			await rm(base, { recursive: true, force: true });
		}
	});

	it("rejects an orphan index without erasing it", async () => {
		const { base, directory } = await copyFixture("orphan-index");
		try {
			const before = await storeFingerprint(directory);
			await rejectsWithCode(readMemorySnapshot(directory), "STORE_CORRUPT");
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("fail-closed authority validation", () => {
	it.each(["junk-prefix", "bad-heading", "missing-metadata", "bad-timestamp", "truncated-section", "crlf"])(
		"rejects malformed details (%s) without changing store files",
		async (variant) => {
			const { base, directory } = await copyFixture(`malformed-details/${variant}`);
			try {
				const before = await storeFingerprint(directory);
				await rejectsWithCode(readMemorySnapshot(directory), "STORE_CORRUPT");
				await rejectsWithCode(
					mutateMemoryStore(
						directory,
						{ action: "create", title: "Must fail", cue: "Never salvage", body: "unchanged" },
						{ now: fixedNow, idFactory: () => "m_bbbbbbbbbb" },
					),
					"STORE_CORRUPT",
				);
				assert.deepEqual(await storeFingerprint(directory), before);
			} finally {
				await rm(base, { recursive: true, force: true });
			}
		},
	);

	it("rejects duplicate authoritative IDs before reading or mutating ambiguously", async () => {
		const { base, directory } = await copyFixture("malformed-details/duplicate-id");
		try {
			const before = await storeFingerprint(directory);
			await rejectsWithCode(readMemorySnapshot(directory), "DUPLICATE_ID");
			await rejectsWithCode(
				mutateMemoryStore(directory, { action: "delete", id: "m_aaaaaaaaaa" }, { now: fixedNow }),
				"DUPLICATE_ID",
			);
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("mutation hardening", () => {
	it("retries colliding generated IDs and commits the first free candidate once", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const candidates = ["m_aaaaaaaaaa", "m_aaaaaaaaaa", "m_bbbbbbbbbb"];
		let calls = 0;
		try {
			const result = await mutateMemoryStore(
				directory,
				{ action: "create", title: "Unique", cue: "After collisions", body: "created once" },
				{ now: fixedNow, idFactory: () => candidates[calls++] ?? "m_cccccccccc" },
			);
			assert.equal(calls, 3);
			assert.equal(result.memory?.id, "m_bbbbbbbbbb");
			assert.deepEqual(
				result.memories.map((memory) => memory.id),
				["m_aaaaaaaaaa", "m_bbbbbbbbbb"],
			);
			const details = await readFile(join(directory, "details.md"), "utf8");
			assert.equal(details, serializeDetails(result.memories));
			assert.equal(await readFile(join(directory, "index.md"), "utf8"), serializeIndex(result.memories));
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("fails after exactly 32 generated-ID collisions without committing", async () => {
		const { base, directory } = await copyFixture("complex-single");
		let calls = 0;
		try {
			const before = await storeFingerprint(directory);
			await rejectsWithCode(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "No ID", cue: "All collide", body: "must not commit" },
					{ now: fixedNow, idFactory: () => (calls++, "m_aaaaaaaaaa") },
				),
				"ID_EXHAUSTED",
			);
			assert.equal(calls, 32);
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("always allows deletion to recover an over-cap store", async () => {
		const { base, directory } = await copyFixture("over-cap");
		try {
			const result = await mutateMemoryStore(directory, { action: "delete", id: "m_ffffffffff" }, { now: fixedNow });
			assert.equal(result.deleted?.id, "m_ffffffffff");
			assert.deepEqual(result.memories.map((memory) => memory.id), ["m_eeeeeeeeee"]);
			assert.ok(result.tokens.details < 4_000);
			assert.equal(await readFile(join(directory, "details.md"), "utf8"), serializeDetails(result.memories));
			assert.equal(await readFile(join(directory, "index.md"), "utf8"), serializeIndex(result.memories));
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("allows only monotonic shrinking updates while a store remains over cap", async () => {
		const shrinking = await copyFixture("over-cap");
		try {
			const current = parseDetails(await readFile(join(shrinking.directory, "details.md"), "utf8"));
			const oversized = current.find((memory) => memory.id === "m_eeeeeeeeee");
			assert.ok(oversized);
			const result = await mutateMemoryStore(
				shrinking.directory,
				{ action: "update", id: oversized.id, body: oversized.body.slice(0, -1) },
				{ now: oversized.updated },
			);
			assert.equal(result.tokens.details, 4_001);
			assert.ok(result.warnings.some((warning) => warning.code === "OVER_CAP_REMAINS"));
			assert.equal(await readFile(join(shrinking.directory, "details.md"), "utf8"), serializeDetails(result.memories));
			assert.equal(await readFile(join(shrinking.directory, "index.md"), "utf8"), serializeIndex(result.memories));
		} finally {
			await rm(shrinking.base, { recursive: true, force: true });
		}

		for (const mutation of [
			{ action: "update", id: "m_eeeeeeeeee", bodySuffix: "z" } as const,
			{ action: "create" } as const,
		]) {
			const fixture = await copyFixture("over-cap");
			try {
				const before = await storeFingerprint(fixture.directory);
				const current = parseDetails(await readFile(join(fixture.directory, "details.md"), "utf8"));
				const oversized = current.find((memory) => memory.id === "m_eeeeeeeeee");
				assert.ok(oversized);
				const operation =
					mutation.action === "update"
						? mutateMemoryStore(
								fixture.directory,
								{ action: "update", id: oversized.id, body: oversized.body + mutation.bodySuffix },
								{ now: oversized.updated },
							)
						: mutateMemoryStore(
								fixture.directory,
								{ action: "create", title: "Growth", cue: "Not recovery", body: "x" },
								{ now: fixedNow, idFactory: () => "m_gggggggggg" },
							);
				await rejectsWithCode(operation, "CAP_EXCEEDED");
				assert.deepEqual(await storeFingerprint(fixture.directory), before);
			} finally {
				await rm(fixture.base, { recursive: true, force: true });
			}
		}
	});
});

// Regression gates for the hardened transaction and path contracts. These are
// state-based: injected faults must leave a provable old, new, or unknown state.
describe("authoritative byte validation", () => {
	function invalidDetailsBytes(): Buffer {
		return Buffer.concat([
			Buffer.from(
				"## m_aaaaaaaaaa — Invalid byte\nUpdated: 2026-08-01T10:00:00.000Z\nTags: bytes\nCue: reject invalid UTF-8\n\nbefore-",
			),
			Buffer.from([0xff]),
			Buffer.from("-after\n"),
		]);
	}

	it("rejects invalid UTF-8 snapshots without changing authoritative bytes", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-invalid-utf8-"));
		const directory = join(base, "store");
		const detailsPath = join(directory, "details.md");
		const original = invalidDetailsBytes();
		try {
			await mkdir(directory);
			await writeFile(detailsPath, original);
			await rejectsWithCode(readMemorySnapshot(directory), "STORE_CORRUPT");
			assert.deepEqual(await readFile(detailsPath), original);
			assert.deepEqual(await readdir(directory), ["details.md"]);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("rejects mutation of invalid UTF-8 details without normalizing old bytes", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-invalid-utf8-"));
		const directory = join(base, "store");
		const detailsPath = join(directory, "details.md");
		const original = invalidDetailsBytes();
		try {
			await mkdir(directory);
			await writeFile(detailsPath, original);
			await rejectsWithCode(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "Never", cue: "Never", body: "Never" },
					{ now: fixedNow, idFactory: () => "m_bbbbbbbbbb" },
				),
				"STORE_CORRUPT",
			);
			assert.deepEqual(await readFile(detailsPath), original);
			assert.deepEqual((await readdir(directory)).filter((entry) => entry.endsWith(".tmp")), []);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("classifies invalid UTF-8 in the derived index as malformed and writes nothing", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const indexPath = join(directory, "index.md");
		const invalidIndex = Buffer.concat([Buffer.from("invalid-"), Buffer.from([0xff]), Buffer.from("\n")]);
		try {
			await writeFile(indexPath, invalidIndex);
			const beforeDetails = await readFile(join(directory, "details.md"));
			const snapshot = await readMemorySnapshot(directory);
			assert.equal(snapshot.indexState, "malformed");
			assert.deepEqual(await readFile(indexPath), invalidIndex);
			assert.deepEqual(await readFile(join(directory, "details.md")), beforeDetails);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("mutation commit-point fault matrix", () => {
	it("keeps old bytes and reports uncommitted when the details rename fails", async () => {
		const { base, directory } = await copyFixture("complex-single");
		try {
			const before = await storeFingerprint(directory);
			const error = await rejectsWithCode(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "No commit", cue: "rename fails", body: "old bytes remain" },
					{
						now: fixedNow,
						idFactory: () => "m_bbbbbbbbbb",
						hooks: { renameFile: async () => { throw errno("EIO", "injected details rename failure"); } },
					},
				),
				"IO",
			);
			assert.equal(error.committed, false);
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("recognizes new bytes when rename commits and then reports failure", async () => {
		const { base, directory } = await copyFixture("complex-single");
		try {
			const result = await mutateMemoryStore(
				directory,
				{ action: "create", title: "Committed", cue: "rename outcome", body: "new bytes win" },
				{
					now: fixedNow,
					idFactory: () => "m_bbbbbbbbbb",
					hooks: {
						renameFile: async (from, to) => {
							await rename(from, to);
							if (basename(to) === "details.md") throw errno("EIO", "rename committed before error");
						},
					},
				},
			);
			assert.equal(result.memory?.id, "m_bbbbbbbbbb");
			assert.deepEqual(result.warnings, []);
			assert.equal(await readFile(join(directory, "details.md"), "utf8"), serializeDetails(result.memories));
			assert.equal(await readFile(join(directory, "index.md"), "utf8"), serializeIndex(result.memories));
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("reports unknown when a failed details rename leaves a third generation", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const thirdState = Buffer.from("unrelated third-party bytes\n");
		try {
			const error = await rejectsWithCode(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "Unknown", cue: "third state", body: "must not be acknowledged" },
					{
						now: fixedNow,
						idFactory: () => "m_bbbbbbbbbb",
						hooks: {
							renameFile: async (_from, to) => {
								if (basename(to) === "details.md") await writeFile(to, thirdState);
								throw errno("EIO", "injected ambiguous rename outcome");
							},
						},
					},
				),
				"COMMIT_STATE_UNKNOWN",
			);
			assert.equal(error.committed, "unknown");
			assert.deepEqual(await readFile(join(directory, "details.md")), thirdState);
			assert.deepEqual((await readdir(directory)).filter((entry) => entry.endsWith(".tmp")), []);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0))(
		"does not mistake a verification read failure for a committed last-delete empty state",
		async () => {
			const { base, directory } = await copyFixture("complex-single");
			const detailsPath = join(directory, "details.md");
			const original = await readFile(detailsPath);
			try {
				const error = await rejectsWithCode(
					mutateMemoryStore(
						directory,
						{ action: "delete", id: "m_aaaaaaaaaa" },
						{
							now: fixedNow,
							hooks: {
								renameFile: async (_from, to) => {
									if (basename(to) === "details.md") await chmod(to, 0o000);
									throw errno("EACCES", "verification read denied");
								},
							},
						},
					),
					"COMMIT_STATE_UNKNOWN",
				);
				assert.equal(error.committed, "unknown");
			} finally {
				await chmod(detailsPath, 0o600).catch(() => undefined);
				assert.deepEqual(await readFile(detailsPath), original);
				await rm(base, { recursive: true, force: true });
			}
		},
	);

	it("returns committed success with a repair warning when only the index rename fails", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const oldIndex = await readFile(join(directory, "index.md"));
		try {
			const result = await mutateMemoryStore(
				directory,
				{ action: "create", title: "Details only", cue: "index fault", body: "repair later" },
				{
					now: fixedNow,
					idFactory: () => "m_bbbbbbbbbb",
					hooks: {
						renameFile: async (from, to) => {
							if (basename(to) === "index.md") throw errno("EIO", "injected index rename failure");
							await rename(from, to);
						},
					},
				},
			);
			assert.equal(result.memory?.id, "m_bbbbbbbbbb");
			assert.ok(result.warnings.some((warning) => warning.code === "INDEX_REPAIR_NEEDED"));
			assert.equal(await readFile(join(directory, "details.md"), "utf8"), serializeDetails(result.memories));
			assert.deepEqual(await readFile(join(directory, "index.md")), oldIndex);
			assert.equal((await readMemorySnapshot(directory)).indexState, "stale");
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("reports a release failure as a warning after details have committed", async () => {
		const { base, directory } = await copyFixture("complex-single");
		try {
			const result = await mutateMemoryStore(
				directory,
				{ action: "create", title: "Committed", cue: "release failure", body: "must remain acknowledged" },
				{
					now: fixedNow,
					idFactory: () => "m_bbbbbbbbbb",
					lock: {
						releaseRename: async () => { throw errno("EIO", "injected permanent release failure"); },
					},
				},
			);
			assert.equal(result.memory?.id, "m_bbbbbbbbbb");
			assert.ok(result.warnings.some((warning) => warning.code === "LOCK_UNSAFE"));
			assert.equal(await readFile(join(directory, "details.md"), "utf8"), serializeDetails(result.memories));
			assert.equal(await readFile(join(directory, "index.md"), "utf8"), serializeIndex(result.memories));
			assert.ok((await readdir(directory)).includes(".pi-memory-mutation.lock"));
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("commits details but leaves a foreign token and stale index untouched", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const replacementToken = "8".repeat(32);
		const oldIndex = await readFile(join(directory, "index.md"));
		try {
			const result = await mutateMemoryStore(
				directory,
				{ action: "create", title: "Token lost", cue: "after commit", body: "details stay committed" },
				{
					now: fixedNow,
					idFactory: () => "m_bbbbbbbbbb",
					hooks: {
						async checkpoint(name) {
							if (name !== "after-details-rename") return;
							const ownerPath = join(directory, ".pi-memory-mutation.lock", "owner.json");
							const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
							await writeFile(ownerPath, `${JSON.stringify({ ...owner, ownerToken: replacementToken })}\n`);
						},
					},
				},
			);
			assert.ok(result.warnings.some((warning) => warning.code === "LOCK_UNSAFE"));
			assert.ok(result.warnings.some((warning) => warning.code === "INDEX_REPAIR_NEEDED"));
			assert.equal(await readFile(join(directory, "details.md"), "utf8"), serializeDetails(result.memories));
			assert.deepEqual(await readFile(join(directory, "index.md")), oldIndex);
			assert.equal(
				JSON.parse(await readFile(join(directory, ".pi-memory-mutation.lock", "owner.json"), "utf8")).ownerToken,
				replacementToken,
			);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("cleans synced temps and preserves old bytes on a pre-commit checkpoint failure", async () => {
		const { base, directory } = await copyFixture("complex-single");
		try {
			const before = await storeFingerprint(directory);
			await assert.rejects(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "Never", cue: "checkpoint", body: "never commits" },
					{
						now: fixedNow,
						idFactory: () => "m_bbbbbbbbbb",
						hooks: {
							checkpoint(name) {
								if (name === "after-temps-synced") throw new Error("injected pre-commit failure");
							},
						},
					},
				),
				/injected pre-commit failure/,
			);
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("mutation abort boundaries", () => {
	it("aborts after temp sync but before the commit point without changing bytes", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const controller = new AbortController();
		try {
			const before = await storeFingerprint(directory);
			const error = await rejectsWithCode(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "Aborted", cue: "before commit", body: "must not appear" },
					{
						now: fixedNow,
						idFactory: () => "m_bbbbbbbbbb",
						signal: controller.signal,
						hooks: {
							checkpoint(name) {
								if (name === "after-temps-synced") controller.abort();
							},
						},
					},
				),
				"BUSY",
			);
			assert.equal(error.committed, false);
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("does not retry into a commit after aborting between transient rename attempts", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const controller = new AbortController();
		let now = 0;
		let detailsAttempts = 0;
		try {
			const before = await storeFingerprint(directory);
			const error = await captureRejection(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "Abort retry", cue: "between retries", body: "must not commit" },
					{
						now: fixedNow,
						idFactory: () => "m_bbbbbbbbbb",
						signal: controller.signal,
						lock: {
							monotonicNow: () => now,
							sleep: async (ms) => { now += ms; },
						},
						hooks: {
							renameFile: async (from, to) => {
								if (basename(to) === "details.md") {
									detailsAttempts += 1;
									if (detailsAttempts === 1) {
										controller.abort();
										throw errno("EBUSY", "transient first attempt");
									}
								}
								await rename(from, to);
							},
						},
					},
				),
			);
			assert.equal(error.committed, false);
			assert.equal(detailsAttempts, 1);
			assert.deepEqual(await storeFingerprint(directory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("under-lock store guard", () => {
	it("runs once under ownership before snapshot/temp work", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const canonicalBase = await realpath(base);
		const canonicalDirectory = await realpath(directory);
		const containment = { root: canonicalBase };
		const originalDetails = await readFile(join(canonicalDirectory, "details.md"));
		const events: string[] = [];
		try {
			const result = await mutateMemoryStore(
				canonicalDirectory,
				{ action: "create", title: "Guarded", cue: "ordering", body: "after guard" },
				{
					now: fixedNow,
					idFactory: () => "m_bbbbbbbbbb",
					containment,
					async guard(context) {
						events.push("guard");
						assert.equal(context.operation, "mutate");
						assert.equal(context.directory, canonicalDirectory);
						assert.equal(await context.lock.isOwned(), true);
						assert.deepEqual(await readFile(join(context.directory, "details.md")), originalDetails);
						assert.deepEqual((await readdir(context.directory)).filter((entry) => entry.endsWith(".tmp")), []);
					},
					hooks: {
						checkpoint(name) {
							if (name === "before-details-temp-open") events.push("temps");
						},
					},
				},
			);
			assert.deepEqual(events, ["guard", "temps"]);
			assert.equal(result.memory?.id, "m_bbbbbbbbbb");
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("fails a guard before any transaction bytes are written", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const canonicalBase = await realpath(base);
		const canonicalDirectory = await realpath(directory);
		try {
			const before = await storeFingerprint(canonicalDirectory);
			await assert.rejects(
				mutateMemoryStore(
					canonicalDirectory,
					{ action: "create", title: "Blocked", cue: "guard", body: "never" },
					{
						now: fixedNow,
						idFactory: () => "m_bbbbbbbbbb",
						containment: { root: canonicalBase },
						guard() {
							throw new Error("project sidecar mismatch");
						},
					},
				),
				/project sidecar mismatch/,
			);
			assert.deepEqual(await storeFingerprint(canonicalDirectory), before);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("serializes concurrent first-use initialization inside the mutation lock", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-guard-"));
		const canonicalBase = await realpath(base);
		const directory = join(canonicalBase, "store");
		const sidecarPath = join(directory, "project.json");
		let initializations = 0;
		let activeGuards = 0;
		let maximumActiveGuards = 0;
		const guard = async () => {
			activeGuards += 1;
			maximumActiveGuards = Math.max(maximumActiveGuards, activeGuards);
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				handle = await open(sidecarPath, "wx", 0o600);
				initializations += 1;
				await handle.writeFile("project-v1\n");
				await handle.sync();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				assert.equal(await readFile(sidecarPath, "utf8"), "project-v1\n");
			} finally {
				await handle?.close();
				activeGuards -= 1;
			}
		};
		try {
			const common = { now: fixedNow, containment: { root: canonicalBase }, guard };
			await Promise.all([
				mutateMemoryStore(
					directory,
					{ action: "create", title: "First", cue: "concurrent", body: "one" },
					{ ...common, idFactory: () => "m_aaaaaaaaaa" },
				),
				mutateMemoryStore(
					directory,
					{ action: "create", title: "Second", cue: "concurrent", body: "two" },
					{ ...common, idFactory: () => "m_bbbbbbbbbb" },
				),
			]);
			assert.equal(initializations, 1);
			assert.equal(maximumActiveGuards, 1);
			assert.equal(await readFile(sidecarPath, "utf8"), "project-v1\n");
			assert.deepEqual(
				(await readMemorySnapshot(directory, { containment: { root: canonicalBase } })).memories
					.map((memory) => memory.id)
					.sort(),
				["m_aaaaaaaaaa", "m_bbbbbbbbbb"],
			);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("contained path and symlink guards", () => {
	it("rejects a symlinked memory root before following it", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-containment-"));
		const agentDir = join(base, "agent");
		const outside = join(base, "outside");
		try {
			await mkdir(agentDir);
			await mkdir(outside);
			await writeFile(join(outside, "canary"), "outside\n");
			await symlink(outside, join(agentDir, "pi-memory"), "dir");
			await rejectsWithCode(resolveMemoryRoot(agentDir), "PATH_UNSAFE");
			assert.equal(await readFile(join(outside, "canary"), "utf8"), "outside\n");
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("re-checks the containment root itself instead of following a root symlink", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-containment-"));
		const outside = join(base, "outside");
		const root = join(base, "memory-link");
		try {
			await mkdir(outside);
			await writeFile(join(outside, "details.md"), "outside canary\n");
			await symlink(outside, root, "dir");
			await rejectsWithCode(assertContainedRegularPath(root, join(root, "details.md")), "PATH_UNSAFE");
			assert.equal(await readFile(join(outside, "details.md"), "utf8"), "outside canary\n");
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("rejects a direct store symlink for reads and mutations", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-containment-"));
		const canonicalBase = await realpath(base);
		const outside = join(canonicalBase, "outside");
		const store = join(canonicalBase, "store-link");
		const containment = { root: canonicalBase };
		const canary = Buffer.from("outside canary\n");
		try {
			await mkdir(outside);
			await writeFile(join(outside, "details.md"), canary);
			await symlink(outside, store, "dir");
			await rejectsWithCode(readMemorySnapshot(store, { containment }), "PATH_UNSAFE");
			await rejectsWithCode(
				mutateMemoryStore(
					store,
					{ action: "create", title: "Redirect", cue: "never", body: "never" },
					{ now: fixedNow, idFactory: () => "m_aaaaaaaaaa", containment },
				),
				"PATH_UNSAFE",
			);
			assert.deepEqual(await readFile(join(outside, "details.md")), canary);
			assert.deepEqual(await readdir(outside), ["details.md"]);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("rejects an intermediate store symlink and preserves outside canaries", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-containment-"));
		const canonicalBase = await realpath(base);
		const root = join(canonicalBase, "memory");
		const outside = join(canonicalBase, "outside-projects");
		const store = join(root, "projects", "project-aaaaaaaaaaaaaaaa");
		const containment = { root: canonicalBase };
		try {
			await mkdir(root);
			await mkdir(join(outside, "project-aaaaaaaaaaaaaaaa"), { recursive: true });
			await writeFile(join(outside, "canary"), "outside\n");
			await symlink(outside, join(root, "projects"), "dir");
			await rejectsWithCode(
				mutateMemoryStore(
					store,
					{ action: "create", title: "Redirect", cue: "never", body: "never" },
					{ now: fixedNow, idFactory: () => "m_aaaaaaaaaa", containment },
				),
				"PATH_UNSAFE",
			);
			assert.equal(await readFile(join(outside, "canary"), "utf8"), "outside\n");
			assert.deepEqual(await readdir(join(outside, "project-aaaaaaaaaaaaaaaa")), []);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked derived index and never rewrites its target", async () => {
		const { base, directory } = await copyFixture("complex-single");
		const canonicalBase = await realpath(base);
		const canonicalDirectory = await realpath(directory);
		const containment = { root: canonicalBase };
		const outsideIndex = join(canonicalBase, "outside-index.md");
		const canary = Buffer.from(await fixtureText("complex-single", "index.md"));
		try {
			await rm(join(canonicalDirectory, "index.md"));
			await writeFile(outsideIndex, canary);
			await symlink(outsideIndex, join(canonicalDirectory, "index.md"), "file");
			await rejectsWithCode(readMemorySnapshot(canonicalDirectory, { containment }), "PATH_UNSAFE");
			await rejectsWithCode(
				mutateMemoryStore(
					canonicalDirectory,
					{ action: "create", title: "Never", cue: "index symlink", body: "never" },
					{ now: fixedNow, idFactory: () => "m_bbbbbbbbbb", containment },
				),
				"PATH_UNSAFE",
			);
			assert.deepEqual(await readFile(outsideIndex), canary);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked authoritative data file and never rewrites its target", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-memory-containment-"));
		const canonicalBase = await realpath(base);
		const store = join(canonicalBase, "store");
		const outsideDetails = join(canonicalBase, "outside-details.md");
		const containment = { root: canonicalBase };
		const canary = Buffer.from(await fixtureText("complex-single"));
		try {
			await mkdir(store);
			await writeFile(outsideDetails, canary);
			await symlink(outsideDetails, join(store, "details.md"), "file");
			await rejectsWithCode(readMemorySnapshot(store, { containment }), "PATH_UNSAFE");
			await rejectsWithCode(
				mutateMemoryStore(
					store,
					{ action: "create", title: "Never", cue: "symlink", body: "never" },
					{ now: fixedNow, idFactory: () => "m_bbbbbbbbbb", containment },
				),
				"PATH_UNSAFE",
			);
			assert.deepEqual(await readFile(outsideDetails), canary);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("26.8 public type compatibility", () => {
	it("still compiles a legacy MutationResult object literal", async () => {
		await execFileAsync(process.execPath, [
			tscPath,
			"--noEmit",
			"--strict",
			"--target",
			"ES2022",
			"--module",
			"NodeNext",
			"--moduleResolution",
			"NodeNext",
			"--skipLibCheck",
			compatibilityFixture,
		]);
	});
});
