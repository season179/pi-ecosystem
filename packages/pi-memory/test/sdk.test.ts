import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { memoryConfigPath, type MemoryMode } from "../src/config.js";
import { resolveProjectIdentity, type AvailableProjectIdentity } from "../src/identity.js";
import { serializeDetails, serializeIndex, type Memory } from "../src/store.js";
import {
	createSdkHarness,
	toolCall,
	type ProviderCapture,
	type SdkHarness,
	type SdkHarnessOptions,
} from "./helpers/sdk-harness.js";

const CATALOG_MARKER = '<pi_memory advisory="untrusted" scope="project"';
const CATALOG_CUSTOM_TYPE = "pi-memory-catalog";
const SEED_TITLE = "SDK seed catalog entry";
const SEED_BODY_CANARY = "SDK_BODY_MUST_NOT_ENTER_CATALOG_74f6d2";
const CREATED_TITLE = "SDK mutation refreshed entry";
const THRESHOLD_TITLE = "SDK threshold-compaction current entry";
const NEW_SESSION_TITLE = "SDK new-session current entry";
const FORK_TITLE = "SDK fork current entry";
const RESUME_TARGET_TITLE = "SDK resume original-project entry";
const RESUME_SOURCE_TITLE = "SDK resume replacement-project entry";

interface Sandbox {
	root: string;
	cwd: string;
	agentDir: string;
}

interface ProjectSetup {
	identity: AvailableProjectIdentity;
	memoryRoot: string;
	projectDirectory: string;
}

const sandboxes = new Set<string>();
const harnesses = new Set<SdkHarness>();

async function sandbox(): Promise<Sandbox> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-sdk-"));
	sandboxes.add(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([
		mkdir(cwd, { recursive: true, mode: 0o700 }),
		mkdir(agentDir, { recursive: true, mode: 0o700 }),
	]);
	return { root, cwd, agentDir };
}

function seedMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "m_aaaaaaaaaa",
		title: SEED_TITLE,
		cue: "Use when verifying automatic SDK catalog injection",
		body: SEED_BODY_CANARY,
		tags: ["sdk", "catalog"],
		updated: "2026-08-23T00:00:00.000Z",
		...overrides,
	};
}

async function projectSetup(
	input: Sandbox,
	mode: MemoryMode,
	memories?: readonly Memory[],
): Promise<ProjectSetup> {
	const identity = await resolveProjectIdentity(input.cwd);
	assert.equal(identity.status, "ok", identity.status === "unavailable" ? identity.error : undefined);
	const memoryRoot = join(await realpath(input.agentDir), "pi-memory");
	const projectDirectory = join(memoryRoot, "projects", identity.directoryName);
	await mkdir(memoryRoot, { recursive: true, mode: 0o700 });
	const configPath = memoryConfigPath(memoryRoot);
	let projects: Record<string, { mode: MemoryMode }> = {};
	try {
		const existing = JSON.parse(await readFile(configPath, "utf8")) as {
			projects?: Record<string, { mode: MemoryMode }>;
		};
		projects = existing.projects ?? {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeFile(
		configPath,
		`${JSON.stringify({
			version: 1,
			defaultMode: "off",
			projects: { ...projects, [identity.identityHash]: { mode } },
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);

	if (memories !== undefined) {
		await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
		await writeFile(
			join(projectDirectory, "project.json"),
			`${JSON.stringify({
				version: 1,
				kind: identity.kind,
				canonicalIdentity: identity.canonicalIdentity,
				identityHash: identity.identityHash,
				displayName: identity.displayName,
				directoryName: identity.directoryName,
				createdAt: "2026-08-23T00:00:00.000Z",
			}, null, 2)}\n`,
			{ mode: 0o600 },
		);
		await writeFile(join(projectDirectory, "details.md"), serializeDetails(memories), { mode: 0o600 });
		await writeFile(join(projectDirectory, "index.md"), serializeIndex(memories), { mode: 0o600 });
	}
	return { identity, memoryRoot, projectDirectory };
}

async function replaceProjectMemories(setup: ProjectSetup, memories: readonly Memory[]): Promise<void> {
	await writeFile(join(setup.projectDirectory, "details.md"), serializeDetails(memories), { mode: 0o600 });
	await writeFile(join(setup.projectDirectory, "index.md"), serializeIndex(memories), { mode: 0o600 });
}

async function harness(
	input: Sandbox,
	options: Omit<SdkHarnessOptions, "cwd" | "agentDir">,
): Promise<SdkHarness> {
	const created = await createSdkHarness({ cwd: input.cwd, agentDir: input.agentDir, ...options });
	harnesses.add(created);
	return created;
}

function messageText(message: ProviderCapture["context"]["messages"][number]): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function catalogMessages(capture: ProviderCapture) {
	return capture.context.messages.filter((message) => messageText(message).includes(CATALOG_MARKER));
}

function assertOneCatalog(capture: ProviderCapture): string {
	const catalogs = catalogMessages(capture);
	assert.equal(catalogs.length, 1, `expected one catalog in ${JSON.stringify(capture.context.messages)}`);
	assert.equal(catalogs[0].role, "user", "catalog must be merged into an existing user turn");
	assert.equal(
		messageText(catalogs[0]).split(CATALOG_MARKER).length - 1,
		1,
		"the user turn must contain exactly one catalog block",
	);
	const text = messageText(catalogs[0]);
	return text.slice(text.indexOf(CATALOG_MARKER));
}

function assertNoCatalog(capture: ProviderCapture): void {
	assert.equal(catalogMessages(capture).length, 0);
	assert.doesNotMatch(JSON.stringify(capture.context), /pi-memory-catalog|<pi_memory advisory=/u);
}

function assertCatalogNotPersisted(subject: SdkHarness): void {
	const state = JSON.stringify(subject.session.messages);
	const entries = JSON.stringify(subject.entries());
	const rebuilt = JSON.stringify(subject.sessionManager.buildSessionContext().messages);
	for (const serialized of [state, entries, rebuilt]) {
		assert.doesNotMatch(serialized, /<pi_memory advisory=|pi-memory-catalog/u);
	}
	assert.equal(
		subject.entries().some(
			(entry) => entry.type === "custom_message" && entry.customType === CATALOG_CUSTOM_TYPE,
		),
		false,
	);
}

async function assertJsonlHasNoCatalog(path: string, canaries: readonly string[]): Promise<void> {
	const jsonl = await readFile(path, "utf8");
	assert.doesNotMatch(jsonl, /<pi_memory advisory=|pi-memory-catalog/u);
	for (const canary of canaries) {
		assert.equal(jsonl.includes(canary), false, `catalog canary persisted in ${path}: ${canary}`);
	}
}

async function assertNoCatalogPersistence(subject: SdkHarness, canaries: readonly string[]): Promise<void> {
	assertCatalogNotPersisted(subject);
	const path = subject.session.sessionFile;
	assert.ok(path, "matrix lifecycle tests must exercise real session JSONL");
	await assertJsonlHasNoCatalog(path, canaries);
}

async function directorySnapshot(path: string): Promise<unknown> {
	let metadata;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
		throw error;
	}
	if (metadata.isDirectory()) {
		const entries = await readdir(path);
		const children: Record<string, unknown> = {};
		for (const name of entries.sort()) children[name] = await directorySnapshot(join(path, name));
		return { type: "directory", mode: metadata.mode & 0o777, children };
	}
	if (metadata.isFile()) {
		return {
			type: "file",
			mode: metadata.mode & 0o777,
			bytes: (await readFile(path)).toString("base64"),
		};
	}
	return { type: "other", mode: metadata.mode & 0o777 };
}

function catalogGeneration(content: string): string {
	const match = content.match(/generation="(sha256:[0-9a-f]{64})"/u);
	assert.ok(match, "catalog must carry its details generation");
	return match[1];
}

async function makeWritable(path: string): Promise<void> {
	let metadata;
	try {
		metadata = await lstat(path);
	} catch {
		return;
	}
	if (metadata.isDirectory()) {
		await chmod(path, 0o700).catch(() => undefined);
		for (const name of await readdir(path).catch(() => [])) await makeWritable(join(path, name));
	} else if (metadata.isFile()) {
		await chmod(path, 0o600).catch(() => undefined);
	}
}

afterEach(async () => {
	for (const subject of harnesses) await subject.dispose();
	harnesses.clear();
	for (const root of sandboxes) {
		await makeWritable(root);
		await rm(root, { recursive: true, force: true });
	}
	sandboxes.clear();
});

describe("Pi SDK automatic memory lifecycle", () => {
	it("injects exactly one merged catalog initially and refreshes it after a remember tool call", async () => {
		const input = await sandbox();
		await projectSetup(input, "read-write", [seedMemory()]);
		const subject = await harness(input, {
			responses: [
				{
					kind: "tools",
					calls: [
						toolCall("remember-1", "remember", {
							action: "create",
							scope: "project",
							title: CREATED_TITLE,
							cue: "Use after a successful SDK mutation",
							body: "The mutation body remains out of the automatic catalog.",
							tags: ["sdk", "mutation"],
						}),
					],
				},
				{ kind: "text", text: "mutation completed" },
			],
		});

		await subject.prompt("Create one project memory, then finish.");

		assert.equal(subject.captures.length, 2, "tool use must cause one post-tool provider call");
		const initialCatalog = assertOneCatalog(subject.captures[0]);
		const postToolCatalog = assertOneCatalog(subject.captures[1]);
		assert.match(initialCatalog, new RegExp(SEED_TITLE));
		assert.doesNotMatch(initialCatalog, new RegExp(CREATED_TITLE));
		assert.match(postToolCatalog, new RegExp(SEED_TITLE));
		assert.match(postToolCatalog, new RegExp(CREATED_TITLE));
		assert.notEqual(catalogGeneration(initialCatalog), catalogGeneration(postToolCatalog));
		assert.equal(subject.captures[1].context.messages.at(-1)?.role, "toolResult");
		assert.doesNotMatch(initialCatalog, new RegExp(SEED_BODY_CANARY));
		assert.doesNotMatch(postToolCatalog, /The mutation body remains out/u);
		assertCatalogNotPersisted(subject);
	});

	it("stops injection when another process disables the project mode", async () => {
		const input = await sandbox();
		const setup = await projectSetup(input, "read-only", [seedMemory()]);
		const subject = await harness(input, {
			responses: [
				{ kind: "text", text: "before external disable" },
				{ kind: "text", text: "after external disable" },
			],
		});

		await subject.prompt("Read memory before another process disables it.");
		assertOneCatalog(subject.captures[0]);
		const configPath = memoryConfigPath(setup.memoryRoot);
		const config = JSON.parse(await readFile(configPath, "utf8")) as {
			projects: Record<string, { mode: MemoryMode }>;
		};
		config.projects[setup.identity.identityHash] = { mode: "off" };
		await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

		await subject.prompt("Continue after external disable.");
		assertNoCatalog(subject.captures[1]);
		assertCatalogNotPersisted(subject);
	});

	it("drops a cached catalog when project identity sidecar changes", async () => {
		const input = await sandbox();
		const setup = await projectSetup(input, "read-only", [seedMemory()]);
		const subject = await harness(input, {
			responses: [
				{ kind: "text", text: "before sidecar change" },
				{ kind: "text", text: "after sidecar change" },
			],
		});

		await subject.prompt("Read the valid project catalog.");
		assertOneCatalog(subject.captures[0]);
		const sidecarPath = join(setup.projectDirectory, "project.json");
		const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
		sidecar.identityHash = `sha256:${"0".repeat(64)}`;
		await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

		await subject.prompt("Continue after the identity changed.");
		assertNoCatalog(subject.captures[1]);
		assertCatalogNotPersisted(subject);
	});

	it("keeps the transient catalog out of real session JSONL and rebuilt context", async () => {
		const input = await sandbox();
		await projectSetup(input, "read-only", [seedMemory()]);
		const subject = await harness(input, {
			persistSession: true,
			responses: [{ kind: "text", text: "persisted ordinary answer" }],
		});

		await subject.prompt("Persist this ordinary user turn.");

		assertOneCatalog(subject.captures[0]);
		assertCatalogNotPersisted(subject);
		const jsonl = await subject.readJsonl();
		assert.ok(jsonl);
		assert.match(jsonl, /Persist this ordinary user turn/u);
		assert.match(jsonl, /persisted ordinary answer/u);
		assert.doesNotMatch(jsonl, /<pi_memory advisory=|pi-memory-catalog|SDK seed catalog entry/u);
	});

	it("injects no catalog or proactive policy when mode is off", async () => {
		const input = await sandbox();
		await projectSetup(input, "off", [seedMemory()]);
		const subject = await harness(input, { responses: [{ kind: "text", text: "off answer" }] });
		await subject.prompt("Run with automatic memory off.");
		assert.equal(subject.captures.length, 1);
		assertNoCatalog(subject.captures[0]);
		assert.equal(subject.captures[0].context.systemPrompt, subject.baseSystemPrompt);
		assertCatalogNotPersisted(subject);
	});

	it("uses before_agent_start only for distinct read-only and read-write system policies", async () => {
		const systems = new Map<MemoryMode, { base: string; provider: string }>();
		for (const mode of ["read-only", "read-write"] as const) {
			const input = await sandbox();
			await projectSetup(input, mode);
			const subject = await harness(input, { responses: [{ kind: "text", text: `${mode} answer` }] });
			await subject.prompt(`Run in ${mode} mode.`);
			assertNoCatalog(subject.captures[0]);
			assertCatalogNotPersisted(subject);
			assert.equal(
				subject.entries().some((entry) => entry.type === "custom_message"),
				false,
				"policy must not be returned as a persistent before_agent_start message",
			);
			systems.set(mode, { base: subject.baseSystemPrompt, provider: subject.captures[0].context.systemPrompt ?? "" });
		}
		const readOnly = systems.get("read-only")!;
		const readWrite = systems.get("read-write")!;
		assert.ok(readOnly.provider.startsWith(readOnly.base));
		assert.ok(readWrite.provider.startsWith(readWrite.base));
		assert.notEqual(readOnly.provider, readOnly.base);
		assert.notEqual(readWrite.provider, readWrite.base);
		assert.notEqual(readOnly.provider.slice(readOnly.base.length), readWrite.provider.slice(readWrite.base.length));
		assert.doesNotMatch(readOnly.provider, /<pi_memory advisory=|sha256:[0-9a-f]{64}/u);
		assert.doesNotMatch(readWrite.provider, /<pi_memory advisory=|sha256:[0-9a-f]{64}/u);
	});

	it("performs zero context-hook writes when the project store is absent", async () => {
		const input = await sandbox();
		const setup = await projectSetup(input, "read-only");
		const subject = await harness(input, { responses: [{ kind: "text", text: "empty" }] });
		const before = await directorySnapshot(setup.projectDirectory);
		await subject.prompt("Read an absent store.");
		assertNoCatalog(subject.captures[0]);
		assert.deepEqual(await directorySnapshot(setup.projectDirectory), before);
	});

	it("reads a filesystem-read-only store without writing or repairing it", async () => {
		const input = await sandbox();
		const setup = await projectSetup(input, "read-only", [seedMemory()]);
		for (const name of ["project.json", "details.md", "index.md"]) {
			await chmod(join(setup.projectDirectory, name), 0o400);
		}
		await chmod(setup.projectDirectory, 0o500);
		const before = await directorySnapshot(setup.projectDirectory);
		const subject = await harness(input, { responses: [{ kind: "text", text: "read only" }] });
		await subject.prompt("Read a filesystem-read-only store.");
		assertOneCatalog(subject.captures[0]);
		assert.deepEqual(await directorySnapshot(setup.projectDirectory), before);
	});

	it("fails open and performs zero writes for malformed authoritative details", async () => {
		const input = await sandbox();
		const setup = await projectSetup(input, "read-only", [seedMemory()]);
		await writeFile(join(setup.projectDirectory, "details.md"), "# malformed details\nDO_NOT_REPAIR\n");
		await writeFile(join(setup.projectDirectory, "index.md"), "# stale index\nDO_NOT_REPAIR\n");
		const before = await directorySnapshot(setup.projectDirectory);
		const subject = await harness(input, { responses: [{ kind: "text", text: "malformed ignored" }] });
		await subject.prompt("Read a malformed store without repairing it.");
		assertNoCatalog(subject.captures[0]);
		assert.deepEqual(await directorySnapshot(setup.projectDirectory), before);
	});

	it("reinjects exactly one current catalog on a public transient-provider retry", async () => {
		const input = await sandbox();
		await projectSetup(input, "read-only", [seedMemory()]);
		const transientError = "503 Service Unavailable: please retry your request";
		const subject = await harness(input, {
			persistSession: true,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			responses: [
				{ kind: "error", message: transientError },
				{ kind: "text", text: "transient retry succeeded" },
			],
		});

		await subject.prompt("Retry this ordinary provider turn deterministically.");

		assert.equal(subject.captures.length, 2, "one transient failure must produce exactly one retry");
		const failedCatalog = assertOneCatalog(subject.captures[0]);
		const retryCatalog = assertOneCatalog(subject.captures[1]);
		assert.equal(retryCatalog, failedCatalog, "an unchanged store must stay current across retry");
		assert.doesNotMatch(JSON.stringify(subject.captures[1].context), new RegExp(transientError));
		assert.match(JSON.stringify(subject.entries()), new RegExp(transientError));
		await assertNoCatalogPersistence(subject, [SEED_TITLE, SEED_BODY_CANARY]);
	});

	it("excludes the catalog from manual-compaction input and reinjects it on the next prompt", async () => {
		const input = await sandbox();
		await projectSetup(input, "read-only", [seedMemory()]);
		const subject = await harness(input, {
			compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 250 },
			responses: [
				{ kind: "text", text: "first answer" },
				{ kind: "text", text: "second answer" },
				{ kind: "text", text: "third answer" },
				{ kind: "text", text: "manual summary without transient memory" },
				{ kind: "text", text: "answer after manual compaction" },
			],
		});
		for (let index = 0; index < 3; index += 1) {
			await subject.prompt(`Long turn ${index}: ${"context ".repeat(80)}`);
		}

		await subject.session.compact("Summarize the durable conversation only.");
		await subject.prompt("Continue after manual compaction.");

		assert.equal(subject.captures.length, 5);
		for (const index of [0, 1, 2, 4]) assertOneCatalog(subject.captures[index]);
		assertNoCatalog(subject.captures[3]);
		assert.doesNotMatch(JSON.stringify(subject.captures[3].context), new RegExp(SEED_TITLE));
		assertCatalogNotPersisted(subject);
	});

	it("excludes the catalog from automatic threshold-compaction input and injects current state afterward", async () => {
		const input = await sandbox();
		const setup = await projectSetup(input, "read-only", [seedMemory()]);
		const subject = await harness(input, {
			persistSession: true,
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 250 },
			responses: [
				{ kind: "text", text: "threshold history one", inputTokens: 100 },
				{ kind: "text", text: "threshold history two", inputTokens: 200 },
				{ kind: "text", text: "threshold reached", inputTokens: 32_000 },
				{ kind: "text", text: "threshold summary without transient memory" },
				{ kind: "text", text: "answer after threshold compaction" },
			],
		});
		for (let index = 0; index < 3; index += 1) {
			await subject.prompt(`Threshold turn ${index}: ${"context ".repeat(80)}`);
		}

		assert.equal(subject.captures.length, 4, "threshold crossing must run one automatic summary call");
		for (const index of [0, 1, 2]) assertOneCatalog(subject.captures[index]);
		assertNoCatalog(subject.captures[3]);
		assert.doesNotMatch(JSON.stringify(subject.captures[3].context), new RegExp(SEED_TITLE));
		assert.equal(subject.entries().filter((entry) => entry.type === "compaction").length, 1);

		await replaceProjectMemories(setup, [
			seedMemory({ title: THRESHOLD_TITLE, updated: "2026-08-23T00:01:00.000Z" }),
		]);
		await subject.prompt("Continue with the current store after threshold compaction.");

		assert.equal(subject.captures.length, 5);
		const currentCatalog = assertOneCatalog(subject.captures[4]);
		assert.match(currentCatalog, new RegExp(THRESHOLD_TITLE));
		assert.doesNotMatch(currentCatalog, new RegExp(SEED_TITLE));
		await assertNoCatalogPersistence(subject, [SEED_TITLE, THRESHOLD_TITLE, SEED_BODY_CANARY]);
	});

	it("reinitializes cleanly on public session reload without duplicating or losing the catalog", async () => {
		const input = await sandbox();
		await projectSetup(input, "read-only", [seedMemory()]);
		const subject = await harness(input, {
			responses: [
				{ kind: "text", text: "before reload" },
				{ kind: "text", text: "after reload" },
			],
		});
		await subject.prompt("Before reload.");
		await subject.reload();
		await subject.prompt("After reload.");

		assert.equal(subject.captures.length, 2);
		const before = assertOneCatalog(subject.captures[0]);
		const after = assertOneCatalog(subject.captures[1]);
		assert.equal(after, before, "unchanged store must render byte-stably after reload");
		assertCatalogNotPersisted(subject);
	});

	it("replaces lifecycle state on public newSession and injects the current project catalog once", async () => {
		const input = await sandbox();
		const setup = await projectSetup(input, "read-only", [seedMemory()]);
		const subject = await harness(input, {
			persistSession: true,
			responses: [
				{ kind: "text", text: "answer before new session" },
				{ kind: "text", text: "answer in new session" },
			],
		});
		await subject.prompt("Prompt before public newSession replacement.");
		const initialSession = subject.session;
		const initialPath = subject.session.sessionFile;
		assert.ok(initialPath);
		const before = assertOneCatalog(subject.captures[0]);
		assert.match(before, new RegExp(SEED_TITLE));

		await replaceProjectMemories(setup, [
			seedMemory({ title: NEW_SESSION_TITLE, updated: "2026-08-23T00:02:00.000Z" }),
		]);
		await subject.newSession();
		assert.notEqual(subject.session, initialSession, "newSession must replace the AgentSession");
		assert.equal(subject.cwd, input.cwd);
		assert.equal(subject.entries().some((entry) => entry.type === "message"), false);
		await subject.prompt("Prompt after public newSession replacement.");

		assert.equal(subject.captures.length, 2);
		const after = assertOneCatalog(subject.captures[1]);
		assert.match(after, new RegExp(NEW_SESSION_TITLE));
		assert.doesNotMatch(after, new RegExp(SEED_TITLE));
		assert.notEqual(catalogGeneration(after), catalogGeneration(before));
		assert.notEqual(subject.session.sessionFile, initialPath);
		await assertJsonlHasNoCatalog(initialPath, [SEED_TITLE, NEW_SESSION_TITLE, SEED_BODY_CANARY]);
		await assertNoCatalogPersistence(subject, [SEED_TITLE, NEW_SESSION_TITLE, SEED_BODY_CANARY]);
	});

	it("replaces lifecycle state on public fork and injects the current project catalog once", async () => {
		const input = await sandbox();
		const setup = await projectSetup(input, "read-only", [seedMemory()]);
		const subject = await harness(input, {
			persistSession: true,
			responses: [
				{ kind: "text", text: "answer retained by fork" },
				{ kind: "text", text: "answer after fork" },
			],
		});
		await subject.prompt("Prompt retained by public fork replacement.");
		const initialSession = subject.session;
		const initialPath = subject.session.sessionFile;
		assert.ok(initialPath);
		const forkPoint = subject
			.entries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(forkPoint);
		const before = assertOneCatalog(subject.captures[0]);

		await replaceProjectMemories(setup, [
			seedMemory({ title: FORK_TITLE, updated: "2026-08-23T00:03:00.000Z" }),
		]);
		await subject.fork(forkPoint.id, "at");
		assert.notEqual(subject.session, initialSession, "fork must replace the AgentSession");
		assert.equal(subject.cwd, input.cwd);
		assert.match(JSON.stringify(subject.entries()), /answer retained by fork/u);
		await subject.prompt("Prompt after public fork replacement.");

		assert.equal(subject.captures.length, 2);
		const after = assertOneCatalog(subject.captures[1]);
		assert.match(after, new RegExp(FORK_TITLE));
		assert.doesNotMatch(after, new RegExp(SEED_TITLE));
		assert.notEqual(catalogGeneration(after), catalogGeneration(before));
		assert.notEqual(subject.session.sessionFile, initialPath);
		await assertJsonlHasNoCatalog(initialPath, [SEED_TITLE, FORK_TITLE, SEED_BODY_CANARY]);
		await assertNoCatalogPersistence(subject, [SEED_TITLE, FORK_TITLE, SEED_BODY_CANARY]);
	});

	it("resumes through the public runtime into the saved session's project state", async () => {
		const input = await sandbox();
		const resumeInput: Sandbox = { ...input, cwd: join(input.root, "resume-project") };
		await mkdir(resumeInput.cwd, { recursive: true, mode: 0o700 });
		await projectSetup(input, "read-only", [seedMemory({ title: RESUME_TARGET_TITLE })]);
		await projectSetup(resumeInput, "read-only", [
			seedMemory({
				id: "m_bbbbbbbbbb",
				title: RESUME_SOURCE_TITLE,
				body: "SDK_RESUME_SOURCE_BODY_MUST_NOT_PERSIST_91b7",
			}),
		]);
		const source = await harness(resumeInput, {
			persistSession: true,
			responses: [{ kind: "text", text: "saved replacement-project answer" }],
		});
		await source.prompt("Create the saved session in the replacement project.");
		const sourcePath = source.session.sessionFile;
		assert.ok(sourcePath);
		assert.match(assertOneCatalog(source.captures[0]), new RegExp(RESUME_SOURCE_TITLE));

		const subject = await harness(input, {
			persistSession: true,
			responses: [
				{ kind: "text", text: "answer before resume" },
				{ kind: "text", text: "answer after resume" },
			],
		});
		await subject.prompt("Prompt in the original project before resume.");
		const initialSession = subject.session;
		const initialPath = subject.session.sessionFile;
		assert.ok(initialPath);
		const before = assertOneCatalog(subject.captures[0]);
		assert.match(before, new RegExp(RESUME_TARGET_TITLE));
		assert.doesNotMatch(before, new RegExp(RESUME_SOURCE_TITLE));

		await subject.resume(sourcePath);
		assert.notEqual(subject.session, initialSession, "resume must replace the AgentSession");
		assert.equal(subject.cwd, resumeInput.cwd);
		assert.match(JSON.stringify(subject.entries()), /saved replacement-project answer/u);
		await subject.prompt("Prompt after public resume replacement.");

		assert.equal(subject.captures.length, 2);
		const after = assertOneCatalog(subject.captures[1]);
		assert.match(after, new RegExp(RESUME_SOURCE_TITLE));
		assert.doesNotMatch(after, new RegExp(RESUME_TARGET_TITLE));
		assert.notEqual(catalogGeneration(after), catalogGeneration(before));
		await assertJsonlHasNoCatalog(initialPath, [RESUME_TARGET_TITLE, RESUME_SOURCE_TITLE]);
		await assertNoCatalogPersistence(subject, [
			RESUME_TARGET_TITLE,
			RESUME_SOURCE_TITLE,
			SEED_BODY_CANARY,
			"SDK_RESUME_SOURCE_BODY_MUST_NOT_PERSIST_91b7",
		]);
		await assertNoCatalogPersistence(source, [RESUME_SOURCE_TITLE, "SDK_RESUME_SOURCE_BODY_MUST_NOT_PERSIST_91b7"]);
	});

	it("reinjects once after public overflow compaction while excluding the failed assistant and catalog from retry state", async () => {
		const input = await sandbox();
		await projectSetup(input, "read-only", [seedMemory()]);
		const overflowMessage = "Prompt is too long for this model's context window";
		const subject = await harness(input, {
			compaction: { enabled: true, reserveTokens: 64, keepRecentTokens: 250 },
			responses: [
				{ kind: "text", text: "history one" },
				{ kind: "text", text: "history two" },
				{ kind: "error", message: overflowMessage },
				{ kind: "text", text: "overflow summary without transient memory" },
				{ kind: "text", text: "overflow retry succeeded" },
			],
		});
		await subject.prompt(`History one ${"context ".repeat(80)}`);
		await subject.prompt(`History two ${"context ".repeat(80)}`);
		await subject.prompt(`Overflow turn ${"context ".repeat(80)}`);

		assert.equal(subject.captures.length, 5);
		for (const index of [0, 1, 2, 4]) assertOneCatalog(subject.captures[index]);
		assertNoCatalog(subject.captures[3]);
		assert.doesNotMatch(JSON.stringify(subject.captures[3].context), new RegExp(SEED_TITLE));
		assert.doesNotMatch(JSON.stringify(subject.captures[4].context), new RegExp(overflowMessage));
		assert.match(JSON.stringify(subject.entries()), new RegExp(overflowMessage));
		assertCatalogNotPersisted(subject);
	});
});
