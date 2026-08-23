import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { loadMemoryConfig, memoryConfigPath, type MemoryMode } from "../src/config.js";
import setup, {
	appendMemoryPolicy,
	createMemoryExtension,
	isCatalogApiSupported,
	parsePiMemoryCommand,
} from "../src/extensions/memory.js";
import {
	initializeProjectSidecar,
	resolveProjectIdentity,
	type AvailableProjectIdentity,
} from "../src/identity.js";
import {
	legacyStorePaths,
	projectStorePaths,
	resolveMemoryRoot,
	storeContainment,
	type MemoryRoot,
	type StorePaths,
} from "../src/paths.js";
import {
	mutateMemoryStore,
	readMemorySnapshot,
	type StoreGuardContext,
} from "../src/store.js";
import {
	ExtensionRegistrationHarness,
	makeExtensionContext,
	type CapturedTool,
	type HarnessContext,
} from "./helpers/extension-harness.js";

const temporaryDirectories = new Set<string>();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalUnsupportedAgentDir = process.env.PI_AGENT_DIR;
const originalMode = process.env.PI_MEMORY_MODE;

interface Rig {
	agentDir: string;
	cwd: string;
	harness: ExtensionRegistrationHarness;
	ctx: HarnessContext;
}

interface RigPaths {
	root: MemoryRoot;
	identity: AvailableProjectIdentity;
	project: StorePaths;
	legacy: StorePaths;
}

async function createRig(mode?: MemoryMode): Promise<Rig> {
	const temporary = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
	temporaryDirectories.add(temporary);
	const agentDir = join(temporary, "agent");
	const cwd = join(temporary, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (mode === undefined) delete process.env.PI_MEMORY_MODE;
	else process.env.PI_MEMORY_MODE = mode;

	const harness = new ExtensionRegistrationHarness();
	await setup(harness.api);
	const ctx = makeExtensionContext(cwd);
	await harness.emit("session_start", { reason: "startup" }, ctx.context);
	return { agentDir, cwd, harness, ctx };
}

async function pathsFor(rig: Rig): Promise<RigPaths> {
	const root = await resolveMemoryRoot(rig.agentDir);
	const resolved = await resolveProjectIdentity(rig.cwd);
	assert.equal(resolved.status, "ok", resolved.status === "unavailable" ? resolved.error : undefined);
	const identity = resolved as AvailableProjectIdentity;
	return {
		root,
		identity,
		project: projectStorePaths(root, identity.directoryName),
		legacy: legacyStorePaths(root),
	};
}

async function execute(tool: CapturedTool, params: Record<string, unknown>, ctx: HarnessContext): Promise<any> {
	return tool.execute("extension-test", params, undefined, undefined, ctx.context);
}

async function createMemory(
	directory: string,
	id: string,
	updated: string,
	title: string,
	body: string,
	options: Parameters<typeof mutateMemoryStore>[2] = {},
): Promise<void> {
	await mutateMemoryStore(
		directory,
		{ action: "create", title, cue: `Cue for ${title}`, body, tags: [title.toLowerCase()] },
		{ ...options, now: updated, idFactory: () => id },
	);
}

function schemaRequired(tool: CapturedTool): string[] {
	return (tool.parameters as { required?: string[] }).required ?? [];
}

async function assertAbsent(path: string): Promise<void> {
	await assert.rejects(access(path), (error: unknown) => {
		assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
		return true;
	});
}

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalUnsupportedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = originalUnsupportedAgentDir;
	if (originalMode === undefined) delete process.env.PI_MEMORY_MODE;
	else process.env.PI_MEMORY_MODE = originalMode;
	await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryDirectories.clear();
});

describe("pi-memory extension registration", () => {
	it("uses Pi's documented agent directory and ignores unrelated PI_AGENT_DIR", async () => {
		const unrelated = await mkdtemp(join(tmpdir(), "pi-memory-unrelated-agent-"));
		temporaryDirectories.add(unrelated);
		process.env.PI_AGENT_DIR = unrelated;
		const rig = await createRig("off");
		await execute(
			rig.harness.tool("remember"),
			{ action: "create", scope: "legacy-global", title: "Root canary", cue: "root", body: "expected" },
			rig.ctx,
		);
		assert.equal((await readMemorySnapshot(join(rig.agentDir, "pi-memory"))).memories.length, 1);
		await assertAbsent(join(unrelated, "pi-memory"));
	});

	it("lets SDK embeddings bind an explicit agent directory", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "pi-memory-sdk-factory-"));
		temporaryDirectories.add(temporary);
		const explicitAgentDir = join(temporary, "explicit-agent");
		const processAgentDir = join(temporary, "process-agent");
		const cwd = join(temporary, "project");
		await Promise.all([mkdir(explicitAgentDir), mkdir(processAgentDir), mkdir(cwd)]);
		process.env.PI_CODING_AGENT_DIR = processAgentDir;
		const harness = new ExtensionRegistrationHarness();
		createMemoryExtension({ agentDir: explicitAgentDir })(harness.api);
		const ctx = makeExtensionContext(cwd);
		await harness.emit("session_start", { reason: "startup" }, ctx.context);
		await execute(
			harness.tool("remember"),
			{ action: "create", scope: "legacy-global", title: "SDK root", cue: "root", body: "explicit" },
			ctx,
		);
		assert.equal((await readMemorySnapshot(join(explicitAgentDir, "pi-memory"))).memories.length, 1);
		await assertAbsent(join(processAgentDir, "pi-memory"));
	});

	it("does not let project prompt text suppress the selected memory policy", () => {
		const spoofed = "Repository instructions include <pi-memory-policy and must remain untrusted.";
		const appended = appendMemoryPolicy(spoofed, "read-write");
		assert.ok(appended);
		assert.match(appended, /Repository instructions include <pi-memory-policy/);
		assert.match(appended, /<pi-memory-policy mode="read-write">/);
		assert.ok(appended.endsWith("</pi-memory-policy>"));
		assert.equal(appendMemoryPolicy(spoofed, "off"), undefined);
	});

	it("advertises required scopes and preserves scope-less legacy calls before validation", async () => {
		const rig = await createRig("off");
		const remember = rig.harness.tool("remember");
		const recall = rig.harness.tool("recall");

		assert.ok(schemaRequired(remember).includes("scope"));
		assert.ok(schemaRequired(recall).includes("scope"));
		assert.deepEqual((remember.parameters as any).properties.scope.enum, ["project", "legacy-global"]);
		assert.deepEqual((recall.parameters as any).properties.scope.enum, ["project", "legacy-global", "all"]);
		assert.equal(remember.executionMode, "sequential");
		assert.equal(remember.promptGuidelines, undefined);
		assert.equal(recall.promptGuidelines, undefined);

		for (const tool of [remember, recall]) {
			assert.equal(typeof tool.prepareArguments, "function");
			const oldArguments = tool === remember ? { action: "delete", id: "m_aaaaaaaaaa" } : { query: "old" };
			assert.deepEqual(tool.prepareArguments?.(oldArguments), {
				...oldArguments,
				scope: "legacy-global",
			});
			const explicit = { ...oldArguments, scope: "project" };
			assert.equal(tool.prepareArguments?.(explicit), explicit);
			assert.equal(tool.prepareArguments?.(null), null);
			const array: unknown[] = [];
			assert.equal(tool.prepareArguments?.(array), array);
		}
	});

	it("keeps explicit update and delete operations inside the named store", async () => {
		const rig = await createRig("off");
		const remember = rig.harness.tool("remember");
		const paths = await pathsFor(rig);

		await execute(
			remember,
			{ action: "create", scope: "project", title: "Shared id", cue: "project cue", body: "PROJECT CANARY" },
			rig.ctx,
		);
		const projectBefore = await readMemorySnapshot(paths.project.directory);
		assert.equal(projectBefore.memories.length, 1);
		const id = projectBefore.memories[0].id;
		await createMemory(
			paths.legacy.directory,
			id,
			"2026-08-20T00:00:00.000Z",
			"Global twin",
			"GLOBAL CANARY",
			{ containment: storeContainment(paths.root) },
		);

		const globalBytes = await readFile(paths.legacy.details, "utf8");
		await execute(remember, { action: "update", scope: "project", id, body: "PROJECT UPDATED" }, rig.ctx);
		assert.equal(await readFile(paths.legacy.details, "utf8"), globalBytes);
		assert.equal((await readMemorySnapshot(paths.project.directory)).memories[0].body, "PROJECT UPDATED");

		const projectBytes = await readFile(paths.project.details, "utf8");
		await execute(remember, { action: "delete", scope: "legacy-global", id }, rig.ctx);
		assert.equal(await readFile(paths.project.details, "utf8"), projectBytes);
		assert.equal((await readMemorySnapshot(paths.legacy.directory)).memories.length, 0);
	});

	it("recall all labels both scopes and applies one merged ranking and limit", async () => {
		const rig = await createRig("off");
		const recall = rig.harness.tool("recall");
		const paths = await pathsFor(rig);
		const guard = async ({ directory, lock }: StoreGuardContext) => {
			await initializeProjectSidecar(directory, paths.identity, lock, "2026-08-01T00:00:00.000Z");
		};

		await createMemory(paths.project.directory, "m_aaaaaaaaaa", "2026-08-24T00:00:00.000Z", "P newest", "p4", {
			containment: storeContainment(paths.root),
			guard,
		});
		await createMemory(paths.project.directory, "m_bbbbbbbbbb", "2026-08-22T00:00:00.000Z", "P third", "p2", {
			containment: storeContainment(paths.root),
		});
		await createMemory(paths.legacy.directory, "m_cccccccccc", "2026-08-23T00:00:00.000Z", "G second", "g3", {
			containment: storeContainment(paths.root),
		});
		await createMemory(paths.legacy.directory, "m_dddddddddd", "2026-08-21T00:00:00.000Z", "G fourth", "g1", {
			containment: storeContainment(paths.root),
		});

		const result = await execute(recall, { scope: "all", query: "", limit: 3, includeDetails: false }, rig.ctx);
		assert.equal(result.details.matches.length, 3);
		assert.deepEqual(
			result.details.matches.map((match: { id: string; scope: string }) => [match.id, match.scope]),
			[
				["m_aaaaaaaaaa", "project"],
				["m_cccccccccc", "legacy-global"],
				["m_bbbbbbbbbb", "project"],
			],
		);
		const text = result.content[0].text as string;
		assert.match(text, /Scope: project/);
		assert.match(text, /Scope: legacy-global/);
		assert.ok(text.indexOf("m_aaaaaaaaaa") < text.indexOf("m_cccccccccc"));
		assert.ok(text.indexOf("m_cccccccccc") < text.indexOf("m_bbbbbbbbbb"));
		assert.doesNotMatch(text, /m_dddddddddd/);
	});

	it.skipIf(process.platform === "win32")(
		"rejects a symlinked project directory before reading its external sidecar",
		async () => {
			const rig = await createRig("off");
			const paths = await pathsFor(rig);
			const external = join(rig.agentDir, "external-project-store");
			await mkdir(external);
			await writeFile(join(external, "project.json"), '{"version":999,"external":"canary"}\n');
			await mkdir(join(paths.root.root, "projects"), { recursive: true });
			await symlink(external, paths.project.directory, "dir");

			await assert.rejects(
				execute(rig.harness.tool("recall"), { scope: "project", query: "", limit: 5 }, rig.ctx),
				/PI_MEMORY_PATH_UNSAFE.*symbolic link rejected/i,
			);
		},
	);

	it("works automatically with read-write policy and catalog when no config exists", async () => {
		const rig = await createRig();
		const paths = await pathsFor(rig);
		await execute(
			rig.harness.tool("remember"),
			{
				action: "create",
				scope: "project",
				title: "Automatic memory",
				cue: "Use automatically in a fresh session",
				body: "automatic body",
			},
			rig.ctx,
		);
		await assertAbsent(memoryConfigPath(paths.root.root));

		const [startResult] = await rig.harness.emit(
			"before_agent_start",
			{ systemPrompt: "base prompt" },
			rig.ctx.context,
		);
		assert.match((startResult as { systemPrompt: string }).systemPrompt, /<pi-memory-policy mode="read-write">/u);

		rig.ctx.context.model = { api: "openai-codex-responses" };
		const [contextResult] = await rig.harness.emit(
			"context",
			{ messages: [{ role: "user", content: "fresh session", timestamp: 1 }] },
			rig.ctx.context,
		);
		assert.match(JSON.stringify(contextResult), /Automatic memory/u);
		assert.match(JSON.stringify(contextResult), /<pi_memory advisory/u);
	});

	it("omits catalogs for unverified provider APIs and re-enables them after a safe model switch", async () => {
		const rig = await createRig("read-only");
		const paths = await pathsFor(rig);
		await createMemory(
			paths.project.directory,
			"m_aaaaaaaaaa",
			"2026-08-23T00:00:00.000Z",
			"Provider gate",
			"body excluded",
			{
				containment: storeContainment(paths.root),
				guard: async ({ directory, lock }) => {
					await initializeProjectSidecar(directory, paths.identity, lock);
				},
			},
		);
		const event = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

		assert.equal(isCatalogApiSupported("bedrock-converse-stream"), false);
		rig.ctx.context.model = { api: "bedrock-converse-stream" };
		assert.deepEqual(await rig.harness.emit("context", event, rig.ctx.context), [undefined]);
		assert.equal(rig.ctx.notifications.length, 1);
		assert.match(rig.ctx.notifications[0].message, /omitted for bedrock-converse-stream/u);
		await rig.harness.emit("context", event, rig.ctx.context);
		assert.equal(rig.ctx.notifications.length, 1, "provider warning must be once per API per session");

		assert.equal(isCatalogApiSupported("openai-completions"), true);
		rig.ctx.context.model = { api: "openai-completions" };
		const [safeResult] = await rig.harness.emit("context", event, rig.ctx.context);
		assert.match(JSON.stringify(safeResult), /<pi_memory advisory/u);

		rig.ctx.context.model = { api: "future-unknown-api" };
		assert.deepEqual(await rig.harness.emit("context", event, rig.ctx.context), [undefined]);
		assert.equal(rig.ctx.notifications.length, 2);
		assert.equal(isCatalogApiSupported(undefined), true);
	});

	it("implements off/read-only/read-write for project writes while preserving legacy writes", async () => {
		for (const mode of ["off", "read-only", "read-write"] as const) {
			const rig = await createRig(mode);
			const remember = rig.harness.tool("remember");
			await execute(
				remember,
				{ action: "create", scope: "legacy-global", title: `${mode} legacy`, cue: "legacy", body: "allowed" },
				rig.ctx,
			);

			const projectWrite = () =>
				execute(
					remember,
					{ action: "create", scope: "project", title: `${mode} project`, cue: "project", body: "mode check" },
					rig.ctx,
				);
			if (mode === "read-only") await assert.rejects(projectWrite, /read.only|PI_MEMORY_READ_ONLY/i);
			else await projectWrite();

			const paths = await pathsFor(rig);
			assert.equal((await readMemorySnapshot(paths.legacy.directory)).memories.length, 1);
			assert.equal((await readMemorySnapshot(paths.project.directory)).memories.length, mode === "read-only" ? 0 : 1);
		}
	});

	it("creates no project artifacts on recall, then publishes the first sidecar with the first guarded write", async () => {
		const rig = await createRig("read-write");
		const paths = await pathsFor(rig);
		await execute(rig.harness.tool("recall"), { scope: "project", query: "", limit: 5 }, rig.ctx);
		await assertAbsent(paths.project.directory);

		await execute(
			rig.harness.tool("remember"),
			{ action: "create", scope: "project", title: "First", cue: "first write", body: "sidecar and details" },
			rig.ctx,
		);
		const sidecar = JSON.parse(await readFile(join(paths.project.directory, "project.json"), "utf8"));
		assert.equal(sidecar.identityHash, paths.identity.identityHash);
		assert.equal(sidecar.canonicalIdentity, paths.identity.canonicalIdentity);
		assert.equal(sidecar.directoryName, paths.identity.directoryName);
		assert.equal((await readMemorySnapshot(paths.project.directory)).memories.length, 1);
		await assertAbsent(paths.project.lock);
	});

	it("caps a run at three committed mutations and resets at before_agent_start", async () => {
		const rig = await createRig("read-write");
		const remember = rig.harness.tool("remember");
		await rig.harness.emit("before_agent_start", { prompt: "one", systemPrompt: "base" }, rig.ctx.context);
		await assert.rejects(
			() =>
				execute(
					remember,
					{ action: "update", scope: "project", id: "m_aaaaaaaaaa", body: "not found" },
					rig.ctx,
				),
			/PI_MEMORY_NOT_FOUND/,
		);
		for (let index = 1; index <= 3; index += 1) {
			await execute(
				remember,
				{ action: "create", scope: "project", title: `Commit ${index}`, cue: "cap", body: `body ${index}` },
				rig.ctx,
			);
		}
		await assert.rejects(
			() =>
				execute(
					remember,
					{ action: "create", scope: "project", title: "Commit 4", cue: "cap", body: "must not commit" },
					rig.ctx,
				),
			/PI_MEMORY_RUN_LIMIT|per-run limit/i,
		);
		const paths = await pathsFor(rig);
		assert.equal((await readMemorySnapshot(paths.project.directory)).memories.length, 3);

		await rig.harness.emit("before_agent_start", { prompt: "two", systemPrompt: "base" }, rig.ctx.context);
		await execute(
			remember,
			{ action: "create", scope: "project", title: "Next run", cue: "reset", body: "allowed" },
			rig.ctx,
		);
		assert.equal((await readMemorySnapshot(paths.project.directory)).memories.length, 4);
	});

	it("parses status/enable/disable through the registered command and refreshes project config", async () => {
		assert.deepEqual(parsePiMemoryCommand(""), { kind: "status" });
		assert.deepEqual(parsePiMemoryCommand("status"), { kind: "status" });
		assert.deepEqual(parsePiMemoryCommand("enable"), { kind: "enable", mode: "read-only" });
		assert.deepEqual(parsePiMemoryCommand("enable read-write"), { kind: "enable", mode: "read-write" });
		assert.deepEqual(parsePiMemoryCommand("disable"), { kind: "disable" });
		assert.equal(parsePiMemoryCommand("unknown").kind, "error");

		const rig = await createRig();
		const command = rig.harness.command("pi-memory");
		await command.handler("", rig.ctx.context);
		assert.match(rig.ctx.notifications.at(-1)?.message ?? "", /Mode:\s*read-write/i);

		await command.handler("enable", rig.ctx.context);
		assert.match(rig.ctx.notifications.at(-1)?.message ?? "", /read-only/i);
		const paths = await pathsFor(rig);
		let loaded = await loadMemoryConfig(memoryConfigPath(paths.root.root));
		assert.equal(loaded.config.projects[paths.identity.identityHash]?.mode, "read-only");

		await command.handler("enable read-write", rig.ctx.context);
		loaded = await loadMemoryConfig(memoryConfigPath(paths.root.root));
		assert.equal(loaded.config.projects[paths.identity.identityHash]?.mode, "read-write");

		await command.handler("disable", rig.ctx.context);
		loaded = await loadMemoryConfig(memoryConfigPath(paths.root.root));
		assert.equal(loaded.config.projects[paths.identity.identityHash]?.mode, "off");
		await command.handler("status", rig.ctx.context);
		assert.match(rig.ctx.notifications.at(-1)?.message ?? "", /Mode:\s*off/i);
		await command.handler("unknown", rig.ctx.context);
		assert.match(rig.ctx.notifications.at(-1)?.message ?? "", /unknown|usage/i);
		assert.deepEqual(rig.harness.sentMessages, []);
	});
});
