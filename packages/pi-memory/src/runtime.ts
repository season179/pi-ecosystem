import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { renderMemoryCatalog, type CatalogRenderResult } from "./catalog.js";
import {
	loadMemoryConfig,
	memoryConfigPath,
	resolveEffectiveMode,
	updateMemoryConfig,
	type EffectiveMemoryMode,
	type LoadedMemoryConfig,
	type MemoryMode,
} from "./config.js";
import { formatMemoryError, MemoryError } from "./errors.js";
import {
	initializeProjectSidecar,
	resolveProjectIdentity,
	verifyProjectSidecar,
	type AvailableProjectIdentity,
	type GitIdentityRunner,
	type ProjectIdentity,
} from "./identity.js";
import {
	legacyStorePaths,
	assertContainedRegularPath,
	projectStorePaths,
	resolveMemoryRoot,
	storeContainment,
	type MemoryRoot,
	type StoreContainment,
	type StorePaths,
} from "./paths.js";
import {
	readMemorySnapshot,
	searchMemories,
	type Memory,
	type MemorySnapshot,
	type StoreGuard,
} from "./store.js";

export type MemoryScope = "project" | "legacy-global";
export type RecallScope = MemoryScope | "all";

export const PI_MEMORY_CATALOG_TYPE = "pi-memory-catalog";
export const MEMORY_RUN_COMMIT_LIMIT = 3;

export interface ScopedMemory {
	scope: MemoryScope;
	memory: Memory;
}

// ---------------------------------------------------------------------------
// Catalog cache: read-only, stat-signature keyed, synchronously invalidated
// after this process's own project writes. Never serves stale content.
// ---------------------------------------------------------------------------

export type CatalogState =
	| { state: "ready"; render: CatalogRenderResult; renderedAtMs: number }
	| { state: "empty" }
	| { state: "error"; message: string };

export interface CatalogCacheStatus {
	cached: boolean;
	state: CatalogState["state"] | "stale";
	render?: CatalogRenderResult;
}

interface CatalogCacheEntry {
	signature: string;
	render: CatalogRenderResult | undefined;
	renderedAtMs: number;
}

export class ProjectCatalogCache {
	readonly #directory: string;
	readonly #detailsPath: string;
	readonly #containment: StoreContainment;
	readonly #identity: AvailableProjectIdentity;
	readonly #now: () => number;
	#entry: CatalogCacheEntry | undefined;
	#dirty = true;
	#epoch = 0;

	constructor(
		store: StorePaths,
		containment: StoreContainment,
		identity: AvailableProjectIdentity,
		now: () => number = () => Date.now(),
	) {
		this.#directory = store.directory;
		this.#detailsPath = store.details;
		this.#containment = containment;
		this.#identity = identity;
		this.#now = now;
	}

	/** Synchronous; called by our own mutations before their result returns. */
	invalidate(): void {
		this.#dirty = true;
		this.#epoch += 1;
	}

	status(): CatalogCacheStatus {
		if (this.#entry === undefined) return { cached: false, state: this.#dirty ? "stale" : "empty" };
		return {
			cached: true,
			state: this.#dirty ? "stale" : this.#entry.render === undefined ? "empty" : "ready",
			...(this.#entry.render !== undefined ? { render: this.#entry.render } : {}),
		};
	}

	async #signature(): Promise<string> {
		try {
			const stats = await stat(this.#detailsPath, { bigint: true });
			return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return "absent";
			// Unknown stat state: force a full re-read; the snapshot read decides.
			return `unreadable:${this.#now()}`;
		}
	}

	/** Strictly read-only: verifies the sidecar and reads a snapshot; writes nothing. */
	async get(): Promise<CatalogState> {
		try {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const epoch = this.#epoch;
				// Containment and identity are checked before every cache hit. A
				// sidecar change must fail closed even when details.md is unchanged.
				await assertContainedRegularPath(this.#containment.root, this.#directory, "directory", "read");
				await assertContainedRegularPath(
					this.#containment.root,
					join(this.#directory, "project.json"),
					"file",
					"read",
				);
				await verifyProjectSidecar(this.#directory, this.#identity, "read");
				const signature = await this.#signature();
				if (
					epoch === this.#epoch &&
					!this.#dirty &&
					this.#entry !== undefined &&
					this.#entry.signature === signature
				) {
					return this.#entry.render === undefined
						? { state: "empty" }
						: { state: "ready", render: this.#entry.render, renderedAtMs: this.#entry.renderedAtMs };
				}

				const snapshot = await readMemorySnapshot(this.#directory, { containment: this.#containment });
				const finalSignature = await this.#signature();
				if (epoch !== this.#epoch || signature !== finalSignature) continue;

				const render = renderMemoryCatalog(snapshot);
				const renderedAtMs = this.#now();
				this.#entry = { signature, render, renderedAtMs };
				this.#dirty = false;
				return render === undefined
					? { state: "empty" }
					: { state: "ready", render, renderedAtMs };
			}
			throw new Error("project memory changed repeatedly while refreshing the catalog");
		} catch (error) {
			// Never serve a stale render after containment, identity, or refresh failure.
			this.#entry = undefined;
			this.#dirty = true;
			return { state: "error", message: formatMemoryError(error) };
		}
	}
}

// ---------------------------------------------------------------------------
// Session runtime state
// ---------------------------------------------------------------------------

export interface MemorySessionState {
	agentDir: string;
	cwd: string;
	root: MemoryRoot | undefined;
	/** Formatted error when the memory root could not be resolved. */
	rootError: string | undefined;
	containment: StoreContainment | undefined;
	legacyStore: StorePaths | undefined;
	identity: ProjectIdentity;
	projectStore: StorePaths | undefined;
	config: LoadedMemoryConfig;
	effectiveMode: EffectiveMemoryMode;
	catalog: ProjectCatalogCache | undefined;
	commits: { used: number; limit: number };
	/** Once-per-session diagnostic keys already emitted. */
	emittedDiagnostics: Set<string>;
}

export interface MemoryRuntimeOptions {
	agentDir: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	gitTimeoutMs?: number;
	/** Test seam forwarded to resolveProjectIdentity. */
	runGit?: GitIdentityRunner;
}

function unavailableIdentity(error: string): ProjectIdentity {
	return { status: "unavailable", error };
}

/**
 * Per-session composition state. `begin` replaces the state promise
 * synchronously, so a session replacement (reload/new/resume/fork) orphans any
 * in-flight initialization instead of letting it publish stale state; all
 * mutable per-run fields (commit counter, diagnostics, catalog cache) live on
 * the state object itself and die with it.
 */
export class MemoryRuntime {
	readonly #options: MemoryRuntimeOptions;
	#statePromise: Promise<MemorySessionState> | undefined;
	#epoch = 0;

	constructor(options: MemoryRuntimeOptions) {
		this.#options = options;
	}

	begin(cwd: string): Promise<MemorySessionState> {
		const epoch = ++this.#epoch;
		const promise = this.#initialize(cwd).then((state) => {
			if (epoch !== this.#epoch) throw new Error("stale pi-memory session initialization");
			return state;
		});
		this.#statePromise = promise;
		return promise;
	}

	shutdown(): void {
		this.#epoch += 1;
		this.#statePromise = undefined;
	}

	/** Current session state, reinitializing if Pi changes cwd in-place. */
	async state(cwd: string): Promise<MemorySessionState> {
		const promise = this.#statePromise ?? this.begin(cwd);
		const state = await promise;
		if (this.#statePromise !== promise) throw new Error("stale pi-memory session state");
		if (state.cwd !== cwd) return this.begin(cwd);
		return state;
	}

	/**
	 * Re-resolve config and effective mode after an enable/disable, without a
	 * /reload; invalidates the catalog so the next injection reflects the mode.
	 */
	async refreshMode(state: MemorySessionState): Promise<EffectiveMemoryMode> {
		const previousMode = state.effectiveMode.mode;
		if (state.root !== undefined) {
			const path = memoryConfigPath(state.root.root);
			try {
				state.config = await loadMemoryConfig(path, state.containment);
			} catch (error) {
				state.config = {
					path,
					config: { version: 1, defaultMode: "off", projects: {} },
					valid: false,
					exists: true,
					warnings: [formatMemoryError(error)],
				};
			}
		}
		state.effectiveMode = resolveEffectiveMode(
			state.config,
			state.identity.status === "ok" ? state.identity.identityHash : undefined,
			this.#options.env ?? process.env,
		);
		if (state.effectiveMode.mode !== previousMode) state.catalog?.invalidate();
		return state.effectiveMode;
	}

	async #initialize(cwd: string): Promise<MemorySessionState> {
		const { agentDir } = this.#options;
		let root: MemoryRoot | undefined;
		let rootError: string | undefined;
		try {
			root = await resolveMemoryRoot(agentDir);
		} catch (error) {
			rootError = formatMemoryError(error);
		}

		let identity: ProjectIdentity;
		try {
			identity = await resolveProjectIdentity(cwd, {
				...(this.#options.gitTimeoutMs !== undefined ? { gitTimeoutMs: this.#options.gitTimeoutMs } : {}),
				...(this.#options.runGit !== undefined ? { runGit: this.#options.runGit } : {}),
			});
		} catch (error) {
			identity = unavailableIdentity(error instanceof Error ? error.message : String(error));
		}

		const containment = root === undefined ? undefined : storeContainment(root);
		const legacyStore = root === undefined ? undefined : legacyStorePaths(root);
		const projectStore =
			root !== undefined && identity.status === "ok"
				? projectStorePaths(root, identity.directoryName)
				: undefined;

		let config: LoadedMemoryConfig;
		if (root === undefined) {
			config = {
				path: "",
				config: { version: 1, defaultMode: "read-write", projects: {} },
				valid: true,
				exists: false,
				warnings: rootError === undefined ? [] : [rootError],
			};
		} else {
			const path = memoryConfigPath(root.root);
			try {
				config = await loadMemoryConfig(path, containment);
			} catch (error) {
				config = {
					path,
					config: { version: 1, defaultMode: "off", projects: {} },
					valid: false,
					exists: true,
					warnings: [formatMemoryError(error)],
				};
			}
		}

		const effectiveMode = resolveEffectiveMode(
			config,
			identity.status === "ok" ? identity.identityHash : undefined,
			this.#options.env ?? process.env,
		);

		const catalog =
			projectStore !== undefined && containment !== undefined && identity.status === "ok"
				? new ProjectCatalogCache(projectStore, containment, identity, this.#options.now)
				: undefined;

		return {
			agentDir,
			cwd,
			root,
			rootError,
			containment,
			legacyStore,
			identity,
			projectStore,
			config,
			effectiveMode,
			catalog,
			commits: { used: 0, limit: MEMORY_RUN_COMMIT_LIMIT },
			emittedDiagnostics: new Set(),
		};
	}
}

/** Persist a project mode via the config lock and report env shadowing. */
export async function setProjectMode(
	state: MemorySessionState,
	mode: MemoryMode,
): Promise<LoadedMemoryConfig> {
	if (state.root === undefined || state.containment === undefined) {
		throw new Error(state.rootError ?? "memory root is unavailable");
	}
	if (state.identity.status !== "ok") {
		throw new Error(`project identity is unavailable (${state.identity.error}); cannot save a project mode`);
	}
	const identityHash = state.identity.identityHash;
	return updateMemoryConfig(
		state.root.root,
		(config) => {
			config.projects[identityHash] = { ...config.projects[identityHash], mode };
		},
		state.containment,
	);
}

/**
 * Store guard for project mutations/repairs: verifies project.json under the
 * held store lock, initializing it when the store is empty, before any commit.
 */
export function projectSidecarGuard(
	identity: AvailableProjectIdentity,
	containment?: StoreContainment,
): StoreGuard {
	return async ({ directory, lock }) => {
		const sidecarPath = join(directory, "project.json");
		const assertSafe = async (temporaryPath?: string): Promise<void> => {
			if (containment === undefined) return;
			await assertContainedRegularPath(containment.root, directory, "directory", "mutate");
			await assertContainedRegularPath(containment.root, sidecarPath, "file", "mutate");
			if (temporaryPath !== undefined) {
				await assertContainedRegularPath(containment.root, temporaryPath, "file", "mutate");
			}
		};
		await assertSafe();
		await initializeProjectSidecar(directory, identity, lock, new Date().toISOString(), {
			checkpoint: async (_name, temporaryPath) => assertSafe(temporaryPath),
		});
	};
}

// ---------------------------------------------------------------------------
// Scoped recall: one merged ranking, one limit, labeled results
// ---------------------------------------------------------------------------

/**
 * Rank scoped candidates through the store's single ranking (exact → word
 * overlap → recency → id). Project entries are placed first in the input, so
 * the stable sort makes scope the final tie-break only — after every ranking
 * key, exactly as specified.
 */
export function recallScoped(candidates: readonly ScopedMemory[], query: string, limit = 5): ScopedMemory[] {
	const ordered = [
		...candidates.filter((candidate) => candidate.scope === "project"),
		...candidates.filter((candidate) => candidate.scope === "legacy-global"),
	];
	const scopes = new Map<Memory, MemoryScope>();
	const memories = ordered.map(({ scope, memory }) => {
		scopes.set(memory, scope);
		return memory;
	});
	return searchMemories(memories, query, limit).map((memory) => {
		const scope = scopes.get(memory);
		if (scope === undefined) throw new Error(`unlabeled recall result: ${memory.id}`);
		return { scope, memory };
	});
}

// ---------------------------------------------------------------------------
// Context hook result (pure; unit-testable without a live session)
// ---------------------------------------------------------------------------

type AgentContextMessage = ContextEvent["messages"][number];

function isPiMemoryCatalogMessage(message: AgentContextMessage): boolean {
	const candidate = message as { role?: unknown; customType?: unknown };
	return candidate.role === "custom" && candidate.customType === PI_MEMORY_CATALOG_TYPE;
}

/**
 * Build the context-event result: strip any previous pi-memory catalog block
 * (at-most-one guarantee even against re-fed histories), then append exactly
 * one trailing transient catalog message with the cached render timestamp.
 * Returns undefined (no modification) when there is nothing to inject.
 */
export function buildContextResult(
	messages: readonly AgentContextMessage[],
	catalog: { content: string; renderedAtMs: number } | undefined,
): { messages: AgentContextMessage[] } | undefined {
	if (catalog === undefined) return undefined;
	const kept = messages.filter((message) => !isPiMemoryCatalogMessage(message));
	const catalogMessage = {
		role: "custom",
		customType: PI_MEMORY_CATALOG_TYPE,
		content: catalog.content,
		display: false,
		timestamp: catalog.renderedAtMs,
	} as AgentContextMessage;
	return { messages: [...kept, catalogMessage] };
}

// ---------------------------------------------------------------------------
// /pi-memory command: parser and text builders (pure where possible)
// ---------------------------------------------------------------------------

export type PiMemoryCommand =
	| { kind: "status" }
	| { kind: "show"; scope: MemoryScope | undefined; id: string | undefined; details: boolean }
	| { kind: "enable"; mode: "read-only" | "read-write" }
	| { kind: "disable" }
	| { kind: "error"; message: string };

export const PI_MEMORY_USAGE =
	"usage: /pi-memory [status] | show [project|legacy-global] [<id>] [--details] | enable [read-only|read-write] | disable";

export function parsePiMemoryCommand(args: string): PiMemoryCommand {
	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
	const [subcommand, ...rest] = tokens;
	if (subcommand === undefined || subcommand === "status") {
		return rest.length > 0 && subcommand !== undefined
			? { kind: "error", message: `status takes no arguments. ${PI_MEMORY_USAGE}` }
			: { kind: "status" };
	}
	if (subcommand === "show") {
		let scope: MemoryScope | undefined;
		let id: string | undefined;
		let details = false;
		for (const token of rest) {
			if (token === "project" || token === "legacy-global") {
				if (scope !== undefined) return { kind: "error", message: `duplicate scope. ${PI_MEMORY_USAGE}` };
				scope = token;
			} else if (token === "--details") {
				details = true;
			} else if (/^m_[a-z2-7]{10}$/.test(token)) {
				if (id !== undefined) return { kind: "error", message: `duplicate id. ${PI_MEMORY_USAGE}` };
				id = token;
			} else {
				return { kind: "error", message: `unknown show argument ${JSON.stringify(token)}. ${PI_MEMORY_USAGE}` };
			}
		}
		return { kind: "show", scope, id, details };
	}
	if (subcommand === "enable") {
		const [mode, ...extra] = rest;
		if (extra.length > 0 || (mode !== undefined && mode !== "read-only" && mode !== "read-write")) {
			return { kind: "error", message: `enable takes read-only or read-write. ${PI_MEMORY_USAGE}` };
		}
		return { kind: "enable", mode: mode ?? "read-only" };
	}
	if (subcommand === "disable") {
		return rest.length > 0
			? { kind: "error", message: `disable takes no arguments. ${PI_MEMORY_USAGE}` }
			: { kind: "disable" };
	}
	if (subcommand === "migrate") {
		return { kind: "error", message: "migrate is not available yet in this release." };
	}
	return { kind: "error", message: `unknown subcommand ${JSON.stringify(subcommand)}. ${PI_MEMORY_USAGE}` };
}

export interface StoreStatusData {
	scope: MemoryScope;
	directory: string;
	state: "ok" | "absent" | "error" | "unavailable";
	count?: number;
	estimatedTokens?: number;
	generation?: string;
	error?: string;
}

/** Read-only snapshot of one store for recall/show/status; verifies the project sidecar first. */
export async function readScopedSnapshot(
	state: MemorySessionState,
	scope: MemoryScope,
): Promise<MemorySnapshot> {
	if (state.root === undefined || state.containment === undefined) {
		throw new Error(state.rootError ?? "memory root is unavailable");
	}
	if (scope === "legacy-global") {
		if (state.legacyStore === undefined) throw new Error(state.rootError ?? "memory root is unavailable");
		return readMemorySnapshot(state.legacyStore.directory, { containment: state.containment });
	}
	if (state.identity.status !== "ok" || state.projectStore === undefined) {
		const reason = state.identity.status === "ok" ? "project store unavailable" : state.identity.error;
		throw new Error(
			`[PI_MEMORY_PROJECT_UNAVAILABLE] project identity could not be resolved (${reason}); project memory is unavailable this session. Use scope legacy-global, or fix the repository state and start a new session.`,
		);
	}
	// Reject symlinked project/sidecar paths before verification can follow them.
	await assertContainedRegularPath(state.containment.root, state.projectStore.directory, "directory", "read");
	await assertContainedRegularPath(
		state.containment.root,
		join(state.projectStore.directory, "project.json"),
		"file",
		"read",
	);
	await verifyProjectSidecar(state.projectStore.directory, state.identity, "read");
	return readMemorySnapshot(state.projectStore.directory, { containment: state.containment });
}

export async function collectStoreStatus(state: MemorySessionState, scope: MemoryScope): Promise<StoreStatusData> {
	const directory =
		scope === "project" ? (state.projectStore?.directory ?? "(unavailable)") : (state.legacyStore?.directory ?? "(unavailable)");
	try {
		const snapshot = await readScopedSnapshot(state, scope);
		return {
			scope,
			directory,
			state: snapshot.detailsMarkdown === "" && snapshot.memories.length === 0 ? "absent" : "ok",
			count: snapshot.memories.length,
			estimatedTokens: snapshot.tokens.details,
			generation: snapshot.generation,
		};
	} catch (error) {
		const message = error instanceof MemoryError ? formatMemoryError(error) : error instanceof Error ? error.message : String(error);
		return {
			scope,
			directory,
			state: scope === "project" && state.identity.status !== "ok" ? "unavailable" : "error",
			error: message,
		};
	}
}

export interface MemoryStatusData {
	mode: EffectiveMemoryMode;
	envShadowing: boolean;
	identity: ProjectIdentity;
	project: StoreStatusData;
	legacy: StoreStatusData;
	catalog: CatalogState | { state: "off" } | { state: "unavailable" };
	configWarnings: string[];
}

export async function gatherMemoryStatus(state: MemorySessionState): Promise<MemoryStatusData> {
	const [project, legacy] = await Promise.all([
		collectStoreStatus(state, "project"),
		collectStoreStatus(state, "legacy-global"),
	]);
	let catalog: MemoryStatusData["catalog"];
	if (state.effectiveMode.mode === "off") catalog = { state: "off" };
	else if (state.catalog === undefined) catalog = { state: "unavailable" };
	else catalog = await state.catalog.get();
	return {
		mode: state.effectiveMode,
		envShadowing:
			state.effectiveMode.source === "env" &&
			(state.config.exists || state.identity.status === "ok"),
		identity: state.identity,
		project,
		legacy,
		catalog,
		configWarnings: [...state.config.warnings, ...state.effectiveMode.warnings],
	};
}

function storeStatusLine(status: StoreStatusData): string {
	if (status.state === "unavailable") return `unavailable — ${status.error ?? "no project identity"}`;
	if (status.state === "error") return `error — ${status.error ?? "unknown"}`;
	if (status.state === "absent") return "absent (no memories)";
	return `${status.count} memories, ~${status.estimatedTokens} details tokens, ${status.generation}`;
}

/** Pure renderer for /pi-memory status. */
export function renderMemoryStatus(data: MemoryStatusData): string {
	const lines: string[] = ["pi-memory status"];
	lines.push(`Mode: ${data.mode.mode} (source: ${data.mode.source})`);
	if (data.mode.source === "env") {
		lines.push("  PI_MEMORY_MODE is set; it overrides any saved config until unset.");
	}
	if (data.identity.status === "ok") {
		lines.push(`Identity: ${data.identity.kind} ${data.identity.displayName}`);
		lines.push(`  hash ${data.identity.identityHash}`);
		lines.push(`  store directory ${data.identity.directoryName}`);
	} else {
		lines.push(`Identity: unavailable — ${data.identity.error}`);
		lines.push("  Project memory is safely off for this session; legacy-global tools still work.");
	}
	lines.push(`Project store: ${storeStatusLine(data.project)}`);
	lines.push(`Legacy-global store: ${storeStatusLine(data.legacy)}`);
	if (data.catalog.state === "ready") {
		const render = data.catalog.render;
		lines.push(
			`Catalog: injecting ${render.included} entries (${render.bytes} bytes, ~${render.estimatedTokens} tokens, ${render.omitted} omitted, ${render.generation})`,
		);
	} else if (data.catalog.state === "empty") {
		lines.push("Catalog: nothing to inject (empty project store)");
	} else if (data.catalog.state === "off") {
		lines.push("Catalog: not injected (mode off)");
	} else if (data.catalog.state === "unavailable") {
		lines.push("Catalog: not injected (project identity unavailable)");
	} else {
		lines.push(`Catalog: not injected — ${data.catalog.message}`);
	}
	for (const warning of data.configWarnings) lines.push(`Warning: ${warning}`);
	lines.push(
		"Note: while enabled, the catalog metadata is sent to the model provider on every request; memory bodies are sent only after recall.",
	);
	return lines.join("\n");
}

const SHOW_DETAILS_WARNING =
	"Warning: this command displays plaintext bodies locally; it does not send them to the model. A later recall tool result does.";

function inlineField(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

/** Pure renderer for /pi-memory show. */
export function renderMemoryShow(
	scope: MemoryScope,
	directory: string,
	memories: readonly Memory[],
	id: string | undefined,
	details: boolean,
): string {
	const selected = id === undefined ? memories : memories.filter((memory) => memory.id === id);
	if (id !== undefined && selected.length === 0) {
		return `Memory ${id} was not found in ${scope} memory (${directory}).`;
	}
	const lines: string[] = [
		`${scope} memory — ${selected.length}${id === undefined ? ` of ${memories.length}` : ""} memories (${directory})`,
	];
	if (details) lines.push(SHOW_DETAILS_WARNING);
	for (const memory of selected) {
		lines.push("");
		lines.push(`${memory.id} — ${inlineField(memory.title)}`);
		lines.push(`  Updated: ${memory.updated}`);
		lines.push(`  Tags: ${memory.tags.length > 0 ? memory.tags.map(inlineField).join(", ") : "(none)"}`);
		lines.push(`  Cue: ${inlineField(memory.cue)}`);
		if (details) lines.push(`  Body:`, ...memory.body.split("\n").map((line) => `    ${line}`));
	}
	if (selected.length === 0) lines.push("", "(no memories)");
	return lines.join("\n");
}
