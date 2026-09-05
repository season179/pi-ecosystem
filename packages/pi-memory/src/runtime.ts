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
	getInjectionBlockTag,
	getInjectionMessageTag,
	MEMORY_INJECTION_BUDGETS,
	PI_MEMORY_OWNER,
	PI_MEMORY_TAG_KEY,
	renderAlwaysBlock,
	tagInjectionBlock,
	type AlwaysRender,
	type InjectionBlockTag,
	type InjectionMessageTag,
	type InjectionScope,
	type TaggedTextBlock,
} from "./injection.js";
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
	memoryInjectionOf,
	readMemorySnapshot,
	searchMemories,
	type Memory,
	type MemoryGeneration,
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
// Injection cache (one per scope): read-only, stat-signature + mode keyed,
// synchronously invalidated after this process's own writes to that scope.
// Never serves stale content. The project cache renders the always block and
// the on-demand catalog; the legacy-global cache renders always bodies only
// (no unselected global metadata is ever injected).
// ---------------------------------------------------------------------------

/** One scope's current render: always block (full bodies) and, for project, the on-demand catalog. */
export interface InjectionRender {
	scope: InjectionScope;
	generation: MemoryGeneration;
	always: AlwaysRender | undefined;
	catalog: CatalogRenderResult | undefined;
}

export type InjectionState =
	| { state: "ready"; render: InjectionRender; renderedAtMs: number }
	| { state: "empty" }
	| { state: "error"; message: string };

export interface InjectionCacheStatus {
	cached: boolean;
	state: InjectionState["state"] | "stale";
	render?: InjectionRender;
}

interface InjectionCacheEntry {
	signature: string;
	mode: MemoryMode;
	render: InjectionRender | undefined;
	renderedAtMs: number;
}

export class InjectionCache {
	readonly scope: InjectionScope;
	readonly #directory: string;
	readonly #detailsPath: string;
	readonly #indexPath: string;
	readonly #containment: StoreContainment;
	readonly #identity: AvailableProjectIdentity | undefined;
	readonly #now: () => number;
	#entry: InjectionCacheEntry | undefined;
	#dirty = true;
	#epoch = 0;

	constructor(
		scope: InjectionScope,
		store: StorePaths,
		containment: StoreContainment,
		identity: AvailableProjectIdentity | undefined,
		now: () => number = () => Date.now(),
	) {
		if (scope === "project" && identity === undefined) {
			throw new Error("project injection cache requires an available project identity");
		}
		this.scope = scope;
		this.#directory = store.directory;
		this.#detailsPath = store.details;
		this.#indexPath = store.index;
		this.#containment = containment;
		this.#identity = identity;
		this.#now = now;
	}

	/** Synchronous; called by our own mutations before their result returns. */
	invalidate(): void {
		this.#dirty = true;
		this.#epoch += 1;
	}

	status(): InjectionCacheStatus {
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

	#render(snapshot: MemorySnapshot, mode: MemoryMode): InjectionRender | undefined {
		const always = renderAlwaysBlock(snapshot, { scope: this.scope, mode });
		const catalog = this.scope === "project" ? renderMemoryCatalog(snapshot, { mode }) : undefined;
		if (always === undefined && catalog === undefined) return undefined;
		return { scope: this.scope, generation: snapshot.generation, always, catalog };
	}

	/**
	 * Strictly read-only: verifies containment (and, for project, the sidecar)
	 * and reads a snapshot; writes nothing. `mode` is part of the cache key
	 * because the rendered advisory states the current mode.
	 */
	async get(mode: MemoryMode): Promise<InjectionState> {
		try {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const epoch = this.#epoch;
				// Containment (root, directory, details, index; lstat-based, so a
				// symlink swapped in under an unchanged stat signature is rejected)
				// is checked for BOTH scopes before every cache hit; project also
				// re-verifies the sidecar so a sidecar change fails closed even when
				// details.md is unchanged.
				await assertContainedRegularPath(this.#containment.root, this.#directory, "directory", "read");
				await assertContainedRegularPath(this.#containment.root, this.#detailsPath, "file", "read");
				await assertContainedRegularPath(this.#containment.root, this.#indexPath, "file", "read");
				if (this.#identity !== undefined) {
					await assertContainedRegularPath(
						this.#containment.root,
						join(this.#directory, "project.json"),
						"file",
						"read",
					);
					await verifyProjectSidecar(this.#directory, this.#identity, "read");
				}
				const signature = await this.#signature();
				if (
					epoch === this.#epoch &&
					!this.#dirty &&
					this.#entry !== undefined &&
					this.#entry.signature === signature &&
					this.#entry.mode === mode
				) {
					return this.#entry.render === undefined
						? { state: "empty" }
						: { state: "ready", render: this.#entry.render, renderedAtMs: this.#entry.renderedAtMs };
				}

				const snapshot = await readMemorySnapshot(this.#directory, { containment: this.#containment });
				const finalSignature = await this.#signature();
				if (epoch !== this.#epoch || signature !== finalSignature) continue;

				const render = this.#render(snapshot, mode);
				const renderedAtMs = this.#now();
				this.#entry = { signature, mode, render, renderedAtMs };
				this.#dirty = false;
				return render === undefined ? { state: "empty" } : { state: "ready", render, renderedAtMs };
			}
			throw new Error(`${this.scope} memory changed repeatedly while refreshing the injection`);
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
	/** Project always block + on-demand catalog; undefined without identity/root. */
	projectInjection: InjectionCache | undefined;
	/** Legacy-global always bodies; independent of project identity. */
	legacyInjection: InjectionCache | undefined;
	/** What the most recent context hook actually assembled (historical record, not refreshed by status). */
	lastAssembled: AssembledInjection | undefined;
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
	 * /reload. Called before every context hook, every remember, and status, so
	 * tools enforce the current mode even though the system-prompt policy is
	 * fixed per run. Mode is part of the injection cache key, so no explicit
	 * invalidation is needed; the invalidate below only drops a stale entry early.
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
		if (state.effectiveMode.mode !== previousMode) {
			state.projectInjection?.invalidate();
			state.legacyInjection?.invalidate();
		}
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

		const projectInjection =
			projectStore !== undefined && containment !== undefined && identity.status === "ok"
				? new InjectionCache("project", projectStore, containment, identity, this.#options.now)
				: undefined;
		// Legacy-global always bodies are injected even when project identity fails.
		const legacyInjection =
			legacyStore !== undefined && containment !== undefined
				? new InjectionCache("legacy-global", legacyStore, containment, undefined, this.#options.now)
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
			projectInjection,
			legacyInjection,
			lastAssembled: undefined,
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

/** Where the transient blocks were placed in the most recent context result. */
export type InjectionTarget = "user" | `converted:${string}` | "synthetic" | "none";

export interface AssembledBlock {
	kind: InjectionBlockTag["kind"];
	scope: InjectionScope;
	generation: MemoryGeneration;
	/** always: ids whose full bodies are in the block; catalog: ids whose metadata line is in the block. */
	ids: string[];
	/** always: ids excluded by an overflow notice; catalog: ids omitted by the catalog's own limits. */
	excluded: string[];
	state: "ready" | "overflow";
	/** Size of the emitted block (an overflow notice's own size, not the excluded set's). */
	bytes: number;
	estimatedTokens: number;
}

/** Why one scope contributed no block (or fewer blocks) to a request. */
export interface AssembledExclusion {
	scope: InjectionScope;
	reason: "off" | "unavailable" | "error" | "empty";
	/** Diagnostic text for unavailable/error; absent for off/empty. */
	message?: string;
}

/** Historical record of what one context hook actually assembled. */
export interface AssembledInjection {
	atMs: number;
	mode: MemoryMode;
	target: InjectionTarget;
	blocks: AssembledBlock[];
	/** Scopes that contributed nothing, with the reason; never claims success for a failed read. */
	exclusions: AssembledExclusion[];
	/** Extension-owned blocks/messages removed from a re-fed context before assembly. */
	stripped: number;
}

export interface ContextResultOptions {
	/**
	 * Pi's exported convertToLlm. When the context has no literal user message
	 * (split-turn compaction), the most recent message it converts to a user
	 * message (compaction/branch summary, custom, bash execution) is replaced in
	 * place by that conversion plus the blocks. Without it, or when nothing
	 * converts, a tagged synthetic user message is PREPENDED.
	 */
	convertToLlm?: (messages: AgentContextMessage[]) => ReadonlyArray<{ role: string; content: unknown }>;
	now?: () => number;
}

export interface ContextResult {
	messages: AgentContextMessage[];
	target: InjectionTarget;
	stripped: number;
}

function isLegacyPiMemoryCatalogMessage(message: AgentContextMessage): boolean {
	// The only text-free historical form: 26.8.0 persisted custom messages.
	const candidate = message as { role?: unknown; customType?: unknown };
	return candidate.role === "custom" && candidate.customType === PI_MEMORY_CATALOG_TYPE;
}

function normalizeContent(content: unknown): unknown[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? [...content] : [];
}

function tagMessage<T extends object>(message: T, tag: InjectionMessageTag): T {
	return { ...message, [PI_MEMORY_TAG_KEY]: tag };
}

/**
 * Remove every extension-owned block and message from a re-fed context, by
 * structural ownership tag only. User-authored text is never inspected or
 * rewritten, even when it quotes a marker-shaped block verbatim. Earlier
 * turns are included because a new user turn moves our blocks out of the
 * target position without removing them from the re-fed messages.
 */
function stripOwnedContent(messages: readonly AgentContextMessage[]): { messages: AgentContextMessage[]; stripped: number } {
	let stripped = 0;
	const result: AgentContextMessage[] = [];
	for (const message of messages) {
		if (isLegacyPiMemoryCatalogMessage(message)) {
			stripped += 1;
			continue;
		}
		const messageTag = getInjectionMessageTag(message);
		if ((message as { role?: unknown }).role !== "user") {
			result.push(message);
			continue;
		}
		const user = message as AgentContextMessage & { content: unknown };
		if (!Array.isArray(user.content)) {
			// A string body is user-authored by construction: we always emit arrays.
			if (messageTag?.origin === "synthetic") {
				stripped += 1;
				continue;
			}
			result.push(message);
			continue;
		}
		const remaining = user.content.filter((block) => getInjectionBlockTag(block) === undefined);
		const removed = user.content.length - remaining.length;
		if (messageTag?.origin === "synthetic" && remaining.length === 0) {
			// The whole synthetic message goes; count it once.
			stripped += 1;
			continue;
		}
		stripped += removed;
		result.push(removed === 0 ? message : ({ ...user, content: remaining } as AgentContextMessage));
	}
	return { messages: result, stripped };
}

/**
 * Assemble the transient context: strip our previous blocks everywhere, then
 * attach the new tagged blocks to the most recent literal user turn (kept as
 * separate blocks after the user's own content, preserving role alternation).
 * Fallbacks for split-turn compaction: convert the newest convertible message
 * in place, else prepend a tagged synthetic user message. Returns undefined
 * when nothing changed. `blocks` may be empty (mode off: strip only).
 */
export function buildContextResult(
	messages: readonly AgentContextMessage[],
	blocks: readonly TaggedTextBlock[] | { content: string; renderedAtMs: number } | undefined,
	options: ContextResultOptions = {},
): ContextResult | undefined {
	// 26.8.x public shape: one untagged project catalog string. Tag it so the
	// new ownership tracking applies; the generation is unknown to that caller.
	if (blocks === undefined) return undefined;
	if (!Array.isArray(blocks)) {
		const legacy = blocks as { content: string; renderedAtMs: number };
		return buildContextResult(
			messages,
			[
				tagInjectionBlock(legacy.content, {
					owner: PI_MEMORY_OWNER,
					kind: "catalog",
					scope: "project",
					generation: "sha256:unknown",
				}),
			],
			options,
		);
	}
	const { messages: kept, stripped } = stripOwnedContent(messages);
	if (blocks.length === 0) return stripped === 0 ? undefined : { messages: kept, target: "none", stripped };

	const isUser = (message: AgentContextMessage | undefined): boolean =>
		(message as { role?: unknown } | undefined)?.role === "user";

	for (let index = kept.length - 1; index >= 0; index -= 1) {
		const message = kept[index] as AgentContextMessage & { content: unknown };
		if (!isUser(message)) continue;
		const transformed = [...kept];
		transformed[index] = { ...message, content: [...normalizeContent(message.content), ...blocks] } as AgentContextMessage;
		return { messages: transformed, target: "user", stripped };
	}

	if (options.convertToLlm !== undefined) {
		for (let index = kept.length - 1; index >= 0; index -= 1) {
			const original = kept[index] as AgentContextMessage;
			const originalRole = String((original as { role?: unknown }).role);
			let converted: ReadonlyArray<{ role: string; content: unknown }>;
			try {
				converted = options.convertToLlm([original]);
			} catch {
				continue;
			}
			const [candidate] = converted;
			if (converted.length !== 1 || candidate === undefined || candidate.role !== "user") continue;
			const transformed = [...kept];
			transformed[index] = tagMessage(
				{ ...(candidate as object), content: [...normalizeContent(candidate.content), ...blocks] },
				{ owner: PI_MEMORY_OWNER, origin: "converted", convertedFrom: originalRole },
			) as unknown as AgentContextMessage;
			return { messages: transformed, target: `converted:${originalRole}`, stripped };
		}
	}

	const synthetic = tagMessage(
		{ role: "user", content: [...blocks], timestamp: (options.now ?? Date.now)() },
		{ owner: PI_MEMORY_OWNER, origin: "synthetic" },
	) as unknown as AgentContextMessage;
	return { messages: [synthetic, ...kept], target: "synthetic", stripped };
}

/** Summarize a rendered scope for the assembled record and status output. */
export function describeAssembledBlocks(render: InjectionRender): AssembledBlock[] {
	const blocks: AssembledBlock[] = [];
	if (render.always !== undefined) {
		const always = render.always;
		blocks.push({
			kind: "always",
			scope: render.scope,
			generation: always.generation,
			ids: always.state === "ready" ? [...always.ids] : [],
			excluded: always.state === "overflow" ? [...always.ids] : [],
			state: always.state,
			bytes: always.bytes,
			estimatedTokens: always.estimatedTokens,
		});
	}
	if (render.catalog !== undefined) {
		blocks.push({
			kind: "catalog",
			scope: render.scope,
			generation: render.catalog.generation,
			ids: [...render.catalog.includedIds],
			excluded: [...render.catalog.omittedIds],
			state: "ready",
			bytes: render.catalog.bytes,
			estimatedTokens: render.catalog.estimatedTokens,
		});
	}
	return blocks;
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

/** Current (eligible) render for one scope, as the next request would inject it. */
export type ScopeInjectionStatus = InjectionState | { state: "off" } | { state: "unavailable"; reason: string };

export interface MemoryStatusData {
	mode: EffectiveMemoryMode;
	envShadowing: boolean;
	identity: ProjectIdentity;
	project: StoreStatusData;
	legacy: StoreStatusData;
	/** Current eligibility per scope (re-rendered now). */
	injection: { project: ScopeInjectionStatus; legacy: ScopeInjectionStatus };
	/** @deprecated alias of injection.project (26.8.x field). */
	catalog: ScopeInjectionStatus;
	/** What the last context hook actually sent (may lag the current render). */
	lastAssembled: AssembledInjection | undefined;
	configWarnings: string[];
}

export async function gatherMemoryStatus(state: MemorySessionState): Promise<MemoryStatusData> {
	const [project, legacy] = await Promise.all([
		collectStoreStatus(state, "project"),
		collectStoreStatus(state, "legacy-global"),
	]);
	const mode = state.effectiveMode.mode;
	let projectInjection: ScopeInjectionStatus;
	let legacyInjection: ScopeInjectionStatus;
	if (mode === "off") {
		projectInjection = { state: "off" };
		legacyInjection = { state: "off" };
	} else {
		projectInjection =
			state.projectInjection === undefined
				? {
						state: "unavailable",
						reason: state.identity.status === "ok" ? (state.rootError ?? "memory root unavailable") : state.identity.error,
					}
				: await state.projectInjection.get(mode);
		legacyInjection =
			state.legacyInjection === undefined
				? { state: "unavailable", reason: state.rootError ?? "memory root unavailable" }
				: await state.legacyInjection.get(mode);
	}
	return {
		mode: state.effectiveMode,
		envShadowing:
			state.effectiveMode.source === "env" &&
			(state.config.exists || state.identity.status === "ok"),
		identity: state.identity,
		project,
		legacy,
		injection: { project: projectInjection, legacy: legacyInjection },
		catalog: projectInjection,
		lastAssembled: state.lastAssembled,
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
	lines.push("Eligible now (what the next request would carry):");
	lines.push(...scopeInjectionLines("Project", data.injection.project, true).map((line) => `  ${line}`));
	lines.push(...scopeInjectionLines("Legacy-global", data.injection.legacy, false).map((line) => `  ${line}`));
	lines.push(...lastAssembledLines(data.lastAssembled));
	for (const warning of data.configWarnings) lines.push(`Warning: ${warning}`);
	lines.push(
		"Note: while enabled, the project catalog metadata and the full bodies of memories marked always are sent to the model provider on every request; other bodies are sent only after recall.",
	);
	return lines.join("\n");
}

function usageText(bytes: number, estimatedTokens: number): string {
	return `${bytes} bytes, ~${estimatedTokens} tokens`;
}

function scopeInjectionLines(label: string, status: ScopeInjectionStatus, hasCatalog: boolean): string[] {
	const alwaysLabel = `${label} always:`;
	const catalogLabel = `${label} catalog:`;
	if (status.state === "off") {
		return [`${alwaysLabel} not eligible (mode off)`, ...(hasCatalog ? [`${catalogLabel} not eligible (mode off)`] : [])];
	}
	if (status.state === "unavailable") {
		return [
			`${alwaysLabel} not eligible (${status.reason})`,
			...(hasCatalog ? [`${catalogLabel} not eligible (${status.reason})`] : []),
		];
	}
	if (status.state === "error") {
		return [
			`${alwaysLabel} not eligible — read failed: ${status.message}`,
			...(hasCatalog ? [`${catalogLabel} not eligible — read failed: ${status.message}`] : []),
		];
	}
	if (status.state === "empty") {
		return [
			`${alwaysLabel} none (no memories marked always)`,
			...(hasCatalog ? [`${catalogLabel} none (no on-demand memories)`] : []),
		];
	}
	const lines: string[] = [];
	const always = status.render.always;
	if (always === undefined) {
		lines.push(`${alwaysLabel} none (no memories marked always)`);
	} else if (always.state === "ready") {
		lines.push(
			`${alwaysLabel} ready for the next request, ${always.ids.length} full bodies (${usageText(always.bytes, always.estimatedTokens)} of ${MEMORY_INJECTION_BUDGETS[always.scope].maxBytes} bytes / ${MEMORY_INJECTION_BUDGETS[always.scope].maxEstimatedTokens} tokens, ${always.generation})`,
		);
		lines.push(`  ids: ${always.ids.join(", ")}`);
	} else {
		const { usage } = always;
		lines.push(
			`${alwaysLabel} OVER BUDGET — all ${always.ids.length} always bodies excluded; set needs ${usageText(usage.bytes, usage.estimatedTokens)}, budget ${usage.budget.maxBytes} bytes / ${usage.budget.maxEstimatedTokens} tokens (${usage.budget.reservedBytes} bytes / ${usage.budget.reservedEstimatedTokens} tokens reserved); a ${usageText(always.bytes, always.estimatedTokens)} notice is sent instead; ${always.generation}`,
		);
		lines.push(`  excluded ids: ${always.ids.join(", ")}`);
		lines.push(
			"  recovery: shrink or delete them, or demote with remember update injection=on-demand (only strictly shrinking updates are accepted while over budget)",
		);
	}
	if (hasCatalog) {
		const catalog = status.render.catalog;
		if (catalog === undefined) {
			lines.push(`${catalogLabel} none (no on-demand memories)`);
		} else {
			lines.push(
				`${catalogLabel} ready for the next request, ${catalog.included} metadata entries (${usageText(catalog.bytes, catalog.estimatedTokens)}, ${catalog.omitted} omitted by catalog limits, ${catalog.generation})`,
			);
			if (catalog.omittedIds.length > 0) lines.push(`  omitted ids: ${catalog.omittedIds.join(", ")}`);
		}
	}
	return lines;
}

function lastAssembledLines(assembled: AssembledInjection | undefined): string[] {
	if (assembled === undefined) return ["Last assembled request: none yet this session"];
	const lines = [
		`Last assembled request: ${new Date(assembled.atMs).toISOString()}, mode ${assembled.mode}, placement ${assembled.target}, ${assembled.stripped} prior block(s) stripped`,
	];
	if (assembled.blocks.length === 0) lines.push("  blocks: none");
	for (const block of assembled.blocks) {
		const detail =
			block.kind === "catalog"
				? `catalog metadata for ${block.ids.length} ids${block.excluded.length > 0 ? `, omitted ${block.excluded.join(", ")}` : ""}`
				: block.state === "ready"
					? `always bodies ${block.ids.join(", ")}`
					: `always OVERFLOW notice, excluded ${block.excluded.join(", ")}`;
		lines.push(`  ${block.scope} ${block.kind}: ${detail} (${usageText(block.bytes, block.estimatedTokens)}, ${block.generation})`);
	}
	for (const exclusion of assembled.exclusions) {
		lines.push(
			`  ${exclusion.scope}: nothing assembled — ${exclusion.reason}${exclusion.message === undefined ? "" : `: ${exclusion.message}`}`,
		);
	}
	return lines;
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
		lines.push(`  Injection: ${memoryInjectionOf(memory)}`);
		if (details) lines.push(`  Body:`, ...memory.body.split("\n").map((line) => `    ${line}`));
	}
	if (selected.length === 0) lines.push("", "(no memories)");
	return lines.join("\n");
}
