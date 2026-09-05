import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryConfigPath, type MemoryMode } from "../../src/config.js";
import { resolveProjectIdentity } from "../../src/identity.js";
import { readMemorySnapshot, serializeDetails, serializeIndex, type Memory } from "../../src/store.js";
import { createSdkHarness, toolCall, type ProviderCapture, type SdkHarness, type SdkHarnessOptions } from "./sdk-harness.js";

export const SEED_ID = "m_aaaaaaaaaa";
export const CORRECTION_BODY = "ALWAYS_FULL_BODY_BEGIN_f17ab4\nWhen asked for a retrospective, limit the work to analysis. Do not write tests or project instructions unless the current user request explicitly asks for them.\n\nALWAYS_FULL_BODY_MIDDLE_61a193\nSynthetic multilingual note: café 漢字 😀.\nALWAYS_FULL_BODY_END_8cd905";
export const RESEARCH_BODY = "ON_DEMAND_REFERENCE_BODY_BEGIN_204acf\nSynthetic research: compare hash-index lookup with sequential scans using a fixed generated dataset. Record dataset size, query distribution, median latency, and p95 latency before selecting an index. ON_DEMAND_REFERENCE_MIDDLE_b53c92: This research is a reference, not a standing behavioral correction.\nON_DEMAND_REFERENCE_BODY_END_3bee8c";
export type InjectionPolicy = "always" | "on-demand";
export type InjectionMemory = Memory & { injection?: InjectionPolicy };

export function legacyMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: SEED_ID,
		title: "Injection regression legacy entry",
		cue: "Use during injection regression tests",
		body: "LEGACY_ON_DEMAND_BODY_693fb1",
		tags: ["type:reference", "regression"],
		injection: "on-demand",
		updated: "2026-08-23T00:00:00.000Z",
		...overrides,
	};
}

export interface InjectionRig {
	root: string;
	cwd: string;
	agentDir: string;
	memoryRoot: string;
	projectDirectory: string;
	projectHash: string;
	start(options?: Partial<Omit<SdkHarnessOptions, "cwd" | "agentDir">>): Promise<SdkHarness>;
	setMode(mode: MemoryMode): Promise<void>;
	seedLegacy(memories: readonly Memory[], scope?: "project" | "legacy-global"): Promise<void>;
	memories(scope?: "project" | "legacy-global"): Promise<InjectionMemory[]>;
	bytes(scope?: "project" | "legacy-global"): Promise<{ details: string; index: string }>;
	dispose(): Promise<void>;
}

export async function createInjectionRig(mode: MemoryMode = "read-write"): Promise<InjectionRig> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-injection-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	const identity = await resolveProjectIdentity(cwd);
	assert.equal(identity.status, "ok");
	const memoryRoot = join(await realpath(agentDir), "pi-memory");
	const projectDirectory = join(memoryRoot, "projects", identity.directoryName);
	await mkdir(memoryRoot, { recursive: true });
	const subjects: SdkHarness[] = [];
	const directory = (scope: "project" | "legacy-global") => scope === "project" ? projectDirectory : memoryRoot;
	const rig: InjectionRig = {
		root, cwd, agentDir, memoryRoot, projectDirectory, projectHash: identity.identityHash,
		async start(options = {}) {
			const subject = await createSdkHarness({ cwd, agentDir, responses: [], ...options });
			subjects.push(subject);
			return subject;
		},
		async setMode(nextMode) {
			const path = memoryConfigPath(memoryRoot);
			let config: Record<string, any> = { version: 1, defaultMode: "off", projects: {} };
			try { config = JSON.parse(await readFile(path, "utf8")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			config.projects[identity.identityHash] = { ...config.projects[identity.identityHash], mode: nextMode };
			await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		},
		async seedLegacy(memories, scope = "project") {
			const target = directory(scope);
			await mkdir(target, { recursive: true, mode: 0o700 });
			if (scope === "project") {
				await writeFile(join(target, "project.json"), `${JSON.stringify({
					version: 1, kind: identity.kind, canonicalIdentity: identity.canonicalIdentity,
					identityHash: identity.identityHash, displayName: identity.displayName,
					directoryName: identity.directoryName, createdAt: "2026-08-23T00:00:00.000Z",
				})}\n`, { mode: 0o600 });
			}
			await writeFile(join(target, "details.md"), serializeDetails(memories), { mode: 0o600 });
			await writeFile(join(target, "index.md"), serializeIndex(memories), { mode: 0o600 });
		},
		async memories(scope = "project") { return (await readMemorySnapshot(directory(scope))).memories; },
		async bytes(scope = "project") {
			const target = directory(scope);
			return { details: await readFile(join(target, "details.md"), "utf8"), index: await readFile(join(target, "index.md"), "utf8") };
		},
		async dispose() {
			try { for (const subject of subjects) await subject.dispose(); }
			finally { await rm(root, { recursive: true, force: true }); }
		},
	};
	await rig.setMode(mode);
	return rig;
}

/** Evidence is the actual Context intercepted by the fake transport, not its placeholder payload. */
export async function saveInjectionEvidence(scenario: string, phase: string, subject: SdkHarness): Promise<void> {
	const root = process.env.PI_MEMORY_EVIDENCE_DIR;
	if (!root) return;
	assert.match(scenario, /^[a-z0-9-]+$/u);
	assert.match(phase, /^[a-z0-9-]+$/u);
	await mkdir(root, { recursive: true, mode: 0o700 });
	await writeFile(join(root, `${scenario}--${phase}.json`), `${JSON.stringify({
		scenario, phase, layer: "real-sdk-assembled-provider-context", network: "fake-provider-no-network",
		captures: subject.captures.map(({ context }, index) => ({ index, context })),
		preMemoryContextInputs: subject.contextInputs,
		sessionMessages: subject.session.messages,
		rebuiltMessages: subject.sessionManager.buildSessionContext().messages,
		entries: subject.entries(),
	}, null, 2)}\n`, { mode: 0o600 });
}

export async function plainPrompt(subject: SdkHarness, scenario: string, phase: string, text = "Continue the regression scenario."): Promise<ProviderCapture> {
	const before = subject.captures.length;
	subject.enqueueResponses({ kind: "text", text: "Regression response complete." });
	try { await subject.prompt(text); }
	finally { await saveInjectionEvidence(scenario, phase, subject); }
	assert.equal(subject.captures.length, before + 1);
	assert.equal(subject.session.messages.at(-1)?.role, "assistant");
	assert.equal((subject.session.messages.at(-1) as { stopReason?: string }).stopReason, "stop");
	return subject.captures[before];
}

export async function callTool(subject: SdkHarness, name: "remember" | "recall", args: Record<string, unknown>, scenario: string, phase: string) {
	const before = subject.captures.length;
	const id = `injection-call-${before}`;
	subject.enqueueResponses(
		{ kind: "tools", calls: [toolCall(id, name, args)] },
		{ kind: "text", text: "Regression tool response complete." },
	);
	try { await subject.prompt(`Execute the next ${name} regression operation, then finish.`); }
	finally { await saveInjectionEvidence(scenario, phase, subject); }
	assert.equal(subject.captures.length, before + 2, "tool must cause exactly one follow-up request");
	const result = subject.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
	assert.ok(result && result.role === "toolResult", "real SDK must execute the requested tool");
	assert.equal((subject.session.messages.at(-1) as { stopReason?: string }).stopReason, "stop");
	return { result, initial: subject.captures[before], followup: subject.captures[before + 1] };
}

export function assertToolSuccess(result: { isError: boolean; content: unknown }): void {
	assert.equal(result.isError, false, JSON.stringify(result.content));
}

export function contextText(capture: ProviderCapture): string { return JSON.stringify(capture.context); }

/** Supplemental post-tool check: ordinary mutation/recall history legitimately carries bodies. */
export function nonToolText(capture: ProviderCapture): string {
	return JSON.stringify({
		systemPrompt: capture.context.systemPrompt,
		messages: capture.context.messages.filter((message) => message.role !== "toolResult").map((message) => ({
			...message,
			content: typeof message.content === "string" ? message.content : message.content.filter((block) => block.type !== "toolCall"),
		})),
	});
}

export function assertBody(text: string, body: string, present = true): void {
	// Compare JSON-escaped text, allowing multiline full-body assertions against serialized Context.
	const encoded = JSON.stringify(body).slice(1, -1);
	if (present) {
		assert.equal(text.includes(encoded), true, `missing full body: ${body}`);
		return;
	}
	// Checking only the complete body misses truncated leaks. Synthetic fixtures
	// carry distinct canaries throughout; every canary must be absent independently.
	const fragments = [body, ...(body.match(/[A-Z][A-Z0-9_]{10,}/gu) ?? [])];
	for (const fragment of new Set(fragments)) {
		assert.equal(text.includes(JSON.stringify(fragment).slice(1, -1)), false, `unexpected body fragment: ${fragment}`);
	}
}

export function assertNoInjectionPersistence(subject: SdkHarness, canaries: readonly string[]): void {
	for (const state of [subject.session.messages, subject.entries(), subject.sessionManager.buildSessionContext().messages]) {
		for (const canary of canaries) assertBody(JSON.stringify(state), canary, false);
	}
}
