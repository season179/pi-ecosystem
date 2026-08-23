import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatMemoryError, isMemoryError } from "../errors.js";
import { appendMemoryPolicy } from "../policy.js";
import {
	buildContextResult,
	gatherMemoryStatus,
	MemoryRuntime,
	parsePiMemoryCommand,
	projectSidecarGuard,
	readScopedSnapshot,
	recallScoped,
	renderMemoryShow,
	renderMemoryStatus,
	setProjectMode,
	PI_MEMORY_USAGE,
	type MemoryScope,
	type MemorySessionState,
	type ScopedMemory,
} from "../runtime.js";
import { type Memory, type MemoryMutation, type MutateMemoryStoreOptions, mutateMemoryStore } from "../store.js";

export {
	buildContextResult,
	parsePiMemoryCommand,
	recallScoped,
	renderMemoryShow,
	renderMemoryStatus,
	MemoryRuntime,
	PI_MEMORY_CATALOG_TYPE,
} from "../runtime.js";
export { appendMemoryPolicy, memoryPolicyBlock, PI_MEMORY_POLICY_MARKER } from "../policy.js";

const SCOPE_DESCRIPTION =
	"Store to act on. Use project unless the user explicitly asks for cross-project global memory; legacy-global is the pre-scope global store.";

/** APIs verified to accept the trailing catalog's additional user turn. */
const CATALOG_SAFE_APIS: ReadonlySet<string> = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

/** Unknown means no provider request can yet be serialized, so retain the catalog. */
export function isCatalogApiSupported(api: string | undefined): boolean {
	return api === undefined || CATALOG_SAFE_APIS.has(api);
}

const RememberParams = Type.Object({
	action: StringEnum(["create", "update", "delete"] as const, {
		description: "Create, update, or delete a persistent memory",
	}),
	scope: StringEnum(["project", "legacy-global"] as const, { description: SCOPE_DESCRIPTION }),
	id: Type.Optional(Type.String({ description: "Immutable memory id required for update and delete" })),
	title: Type.Optional(Type.String({ description: "Short memory title" })),
	cue: Type.Optional(Type.String({ description: "When this memory is useful" })),
	body: Type.Optional(Type.String({ description: "Full memory details" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Searchable tags" })),
});

const RecallParams = Type.Object({
	scope: StringEnum(["project", "legacy-global", "all"] as const, {
		description: `${SCOPE_DESCRIPTION} Use all to search both stores through one merged ranking.`,
	}),
	query: Type.String({
		description: "Words, exact title, or exact memory id to search; use an empty string for the most recent memories",
	}),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
	includeDetails: Type.Optional(Type.Boolean({ default: true, description: "Include memory bodies in the result" })),
});

/**
 * Compatibility shim shared by both tools; runs on every call and is
 * idempotent. Historical (26.8.0) calls carried no scope and always targeted
 * the global store, so an omitted scope maps to legacy-global — never to
 * project, which would silently reinterpret persisted history.
 */
function prepareScopeArguments<T>(args: unknown): T {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args as T;
	const input = args as Record<string, unknown>;
	return (input.scope === undefined ? { ...input, scope: "legacy-global" } : args) as T;
}

function requireId(id: string | undefined, action: "update" | "delete"): string {
	if (id === undefined) throw new Error(`${action} requires id`);
	return id;
}

function toMutation(params: {
	action: "create" | "update" | "delete";
	id?: string;
	title?: string;
	cue?: string;
	body?: string;
	tags?: string[];
}): MemoryMutation {
	if (params.action === "create") {
		if (params.title === undefined || params.cue === undefined || params.body === undefined) {
			throw new Error("create requires title, cue, and body");
		}
		return { action: "create", title: params.title, cue: params.cue, body: params.body, tags: params.tags };
	}
	if (params.action === "delete") return { action: "delete", id: requireId(params.id, "delete") };
	return {
		action: "update",
		id: requireId(params.id, "update"),
		title: params.title,
		cue: params.cue,
		body: params.body,
		tags: params.tags,
	};
}

function inline(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function renderMemory(scoped: ScopedMemory, includeDetails: boolean): string {
	const { scope, memory } = scoped;
	const metadata = [
		`## ${memory.id} — ${inline(memory.title)}`,
		`Scope: ${scope}`,
		`Updated: ${memory.updated}`,
		`Tags: ${memory.tags.length > 0 ? memory.tags.map(inline).join(", ") : "(none)"}`,
		`Cue: ${inline(memory.cue)}`,
	];
	if (includeDetails) metadata.push("", memory.body);
	return metadata.join("\n");
}

function structuredMemory(
	scoped: ScopedMemory,
	includeDetails: boolean,
): Omit<Memory, "body"> & { scope: MemoryScope; body?: string } {
	const { scope, memory } = scoped;
	const summary = {
		scope,
		id: memory.id,
		title: memory.title,
		updated: memory.updated,
		tags: [...memory.tags],
		cue: memory.cue,
	};
	return includeDetails ? { ...summary, body: memory.body } : summary;
}

function scopeLabel(scope: MemoryScope): string {
	return scope === "project" ? "project" : "legacy-global";
}

function toToolError(error: unknown, context?: { scope: MemoryScope; id?: string }): Error {
	if (isMemoryError(error)) {
		if (error.code === "NOT_FOUND" && context?.id !== undefined) {
			return new Error(
				`[PI_MEMORY_NOT_FOUND] Memory ${context.id} was not found in ${scopeLabel(context.scope)} memory; the other store was not searched. Use recall (scope=${context.scope}) to list current ids in this store.`,
			);
		}
		return new Error(formatMemoryError(error));
	}
	return error instanceof Error ? error : new Error(String(error));
}

function projectUnavailableError(state: MemorySessionState): Error {
	const reason = state.identity.status === "ok" ? (state.rootError ?? "memory root unavailable") : state.identity.error;
	return new Error(
		`[PI_MEMORY_PROJECT_UNAVAILABLE] project identity could not be resolved (${reason}); project memory is unavailable this session. Use scope legacy-global, or fix the repository state and start a new session.`,
	);
}

interface MutationTarget {
	directory: string;
	guardOptions: Pick<MutateMemoryStoreOptions, "guard">;
}

function resolveMutationTarget(state: MemorySessionState, scope: MemoryScope): MutationTarget {
	if (state.root === undefined || state.containment === undefined || state.legacyStore === undefined) {
		throw new Error(state.rootError ?? "[PI_MEMORY_IO] the memory root is unavailable");
	}
	if (scope === "legacy-global") {
		// Explicit legacy-global writes work in every mode.
		return { directory: state.legacyStore.directory, guardOptions: {} };
	}
	if (state.identity.status !== "ok" || state.projectStore === undefined) {
		throw projectUnavailableError(state);
	}
	if (state.effectiveMode.mode === "read-only") {
		throw new Error(
			`[PI_MEMORY_READ_ONLY] project memory is read-only in this session (mode source: ${state.effectiveMode.source}). Project memory is read-only in this mode; switch to read-write to mutate it.`,
		);
	}
	return {
		directory: state.projectStore.directory,
		guardOptions: { guard: projectSidecarGuard(state.identity, state.containment) },
	};
}

function emitCommandOutput(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	// TUI/RPC get one notify block; print mode writes to stderr (stdout belongs
	// to Pi); JSON mode is documented as silent for this command. Command output
	// never enters model context or the session file.
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
		return;
	}
	if (ctx.mode === "print") process.stderr.write(`${text}\n`);
}

function warnOnce(state: MemorySessionState, ctx: ExtensionContext, key: string, message: string): void {
	if (state.emittedDiagnostics.has(key)) return;
	state.emittedDiagnostics.add(key);
	emitCommandOutput(ctx, message, "warning");
}

function registerMemoryExtension(pi: ExtensionAPI, agentDir: string): void {
	const runtime = new MemoryRuntime({ agentDir });

	// Session lifecycle: every start reason (startup/reload/new/resume/fork)
	// replaces the state promise synchronously, orphaning in-flight stale
	// initialization; shutdown drops it entirely.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const state = await runtime.begin(ctx.cwd);
			const diagnostics = [
				...state.config.warnings,
				...state.effectiveMode.warnings,
				...(state.rootError === undefined ? [] : [state.rootError]),
				...(state.identity.status === "unavailable"
					? [`[PI_MEMORY_PROJECT_UNAVAILABLE] ${state.identity.error}`]
					: []),
			];
			if (diagnostics.length > 0) {
				warnOnce(state, ctx, "session-diagnostics", `pi-memory: ${[...new Set(diagnostics)].join(" ")}`);
			}
		} catch {
			// Memory initialization must never fail the Pi session.
		}
	});
	pi.on("session_shutdown", () => {
		runtime.shutdown();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let state: MemorySessionState;
		try {
			state = await runtime.state(ctx.cwd);
			await runtime.refreshMode(state);
		} catch {
			return undefined;
		}
		// New user run: reset the committed-mutation cap.
		state.commits.used = 0;
		if (state.identity.status !== "ok" || state.projectStore === undefined) return undefined;
		const appended = appendMemoryPolicy(event.systemPrompt, state.effectiveMode.mode);
		return appended === undefined ? undefined : { systemPrompt: appended };
	});

	// Transient trailing catalog on every ordinary provider request. Strictly
	// read-only and fail-open: memory trouble may cost the catalog, never the task.
	pi.on("context", async (event, ctx) => {
		try {
			const state = await runtime.state(ctx.cwd);
			await runtime.refreshMode(state);
			if (state.effectiveMode.warnings.length > 0) {
				warnOnce(
					state,
					ctx,
					"session-diagnostics",
					`pi-memory: ${[...new Set(state.effectiveMode.warnings)].join(" ")}`,
				);
			}
			if (state.effectiveMode.mode === "off") return undefined;
			if (state.identity.status !== "ok" || state.catalog === undefined) return undefined;
			const api = typeof ctx.model?.api === "string" ? ctx.model.api : undefined;
			if (!isCatalogApiSupported(api)) {
				warnOnce(
					state,
					ctx,
					`catalog-api-${api}`,
					`pi-memory: catalog omitted for ${api} requests — this API is not verified to accept a trailing user turn.`,
				);
				return undefined;
			}
			const catalog = await state.catalog.get();
			if (catalog.state === "error") {
				warnOnce(state, ctx, "catalog-error", `pi-memory: catalog omitted for this request — ${catalog.message}`);
				return undefined;
			}
			if (catalog.state !== "ready") return undefined;
			return buildContextResult(event.messages, {
				content: catalog.render.content,
				renderedAtMs: catalog.renderedAtMs,
			});
		} catch {
			return undefined;
		}
	});

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Create, update, or delete a durable memory shared across Pi sessions. scope selects the store: project (this repository) or legacy-global (explicit cross-project). Use recall first when an existing memory id is needed; update and delete act only on the named scope. IDs are generated on create and never change. Storage is capped at an estimated 4,000 tokens per rendered file; at most 3 committed mutations per run.",
		promptSnippet: "Create, update, or delete durable memories across Pi sessions",
		parameters: RememberParams,
		executionMode: "sequential",
		prepareArguments: prepareScopeArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope = params.scope;
			try {
				const state = await runtime.state(ctx.cwd);
				const mutation = toMutation(params);
				const target = resolveMutationTarget(state, scope);
				// Cap check strictly before any I/O; never thrown after a commit.
				if (state.commits.used >= state.commits.limit) {
					throw new Error(
						`[PI_MEMORY_RUN_LIMIT] reached the per-run limit of ${state.commits.limit} committed memory mutations; make further memory changes in a later run or when the user asks again.`,
					);
				}
				const options: MutateMemoryStoreOptions = {
					containment: state.containment,
					...(signal !== undefined ? { signal } : {}),
					...target.guardOptions,
				};
				let result;
				try {
					result = await mutateMemoryStore(target.directory, mutation, options);
				} catch (error) {
					// COMMIT_STATE_UNKNOWN may have committed: count it and refresh.
					if (isMemoryError(error) && error.committed !== false) {
						state.commits.used += 1;
						if (scope === "project") state.catalog?.invalidate();
					}
					throw error;
				}
				state.commits.used += 1;
				// Synchronous invalidation before the result returns.
				if (scope === "project") state.catalog?.invalidate();

				const subject = result.memory ?? result.deleted;
				const verb = params.action === "create" ? "Created" : params.action === "update" ? "Updated" : "Deleted";
				const warningLines = result.warnings.map((warning) => `Warning [${warning.code}]: ${warning.message}`);
				return {
					content: [
						{
							type: "text",
							text: [`${verb} memory ${subject?.id} in ${scopeLabel(scope)} memory.`, ...warningLines].join("\n"),
						},
					],
					details: {
						action: params.action,
						scope,
						memory: subject,
						tokens: result.tokens,
						generation: result.generation,
						warnings: result.warnings,
					},
				};
			} catch (error) {
				throw toToolError(error, { scope, ...(params.id !== undefined ? { id: params.id } : {}) });
			}
		},
	});

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search durable memories by exact id/title or case-insensitive word overlap across title, tags, and cue. scope selects project, legacy-global, or all (both stores merged through one ranking and one limit); every result is labeled with its scope. Exact matches rank first, then overlap and recency. An empty query returns the most recently updated memories.",
		promptSnippet: "Search durable memories from prior Pi sessions",
		parameters: RecallParams,
		prepareArguments: prepareScopeArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const state = await runtime.state(ctx.cwd);
				const includeDetails = params.includeDetails ?? true;
				const candidates: ScopedMemory[] = [];
				const notes: string[] = [];

				if (params.scope === "project" || params.scope === "all") {
					if (state.identity.status !== "ok" || state.projectStore === undefined) {
						if (params.scope === "project") throw projectUnavailableError(state);
						notes.push(`Note: project memory is unavailable this session (${projectUnavailableError(state).message}).`);
					} else {
						const snapshot = await readScopedSnapshot(state, "project");
						for (const memory of snapshot.memories) candidates.push({ scope: "project", memory });
					}
				}
				if (params.scope === "legacy-global" || params.scope === "all") {
					const snapshot = await readScopedSnapshot(state, "legacy-global");
					for (const memory of snapshot.memories) candidates.push({ scope: "legacy-global", memory });
				}

				const matches = recallScoped(candidates, params.query, params.limit ?? 5);
				const body =
					matches.length === 0
						? "No memories found."
						: matches.map((match) => renderMemory(match, includeDetails)).join("\n\n");
				return {
					content: [{ type: "text", text: [body, ...notes].join("\n\n") }],
					details: {
						scope: params.scope,
						matches: matches.map((match) => structuredMemory(match, includeDetails)),
						...(notes.length > 0 ? { notes } : {}),
					},
				};
			} catch (error) {
				throw toToolError(error);
			}
		},
	});

	pi.registerCommand("pi-memory", {
		description:
			"Durable memory: status | show [project|legacy-global] [<id>] [--details] | enable [read-only|read-write] | disable (no output in JSON mode)",
		getArgumentCompletions(argumentPrefix) {
			const trimmed = argumentPrefix.trimStart();
			const complete = (items: Array<{ value: string; description: string }>, word: string) =>
				items
					.filter((item) => item.value.startsWith(word))
					.map((item) => ({ value: item.value, label: item.value, description: item.description }));
			if (!/\s/.test(trimmed)) {
				return complete(
					[
						{ value: "status", description: "Mode, identity, stores, and injection status" },
						{ value: "show", description: "List memories in a store" },
						{ value: "enable", description: "Save a project memory mode (default read-only)" },
						{ value: "disable", description: "Set this project's memory mode to off" },
					],
					trimmed,
				);
			}
			const [subcommand, ...rest] = trimmed.split(/\s+/);
			const lastWord = rest[rest.length - 1] ?? "";
			const partial = trimmed.endsWith(" ") ? "" : lastWord;
			if (subcommand === "show") {
				return complete(
					[
						{ value: "project", description: "This repository's store" },
						{ value: "legacy-global", description: "The pre-scope global store" },
						{ value: "--details", description: "Include memory bodies" },
					],
					partial,
				);
			}
			if (subcommand === "enable") {
				return complete(
					[
						{ value: "read-only", description: "Inject the catalog; reject project writes" },
						{ value: "read-write", description: "Inject the catalog; allow project writes" },
					],
					partial,
				);
			}
			return null;
		},
		async handler(args, ctx) {
			const command = parsePiMemoryCommand(args);
			if (command.kind === "error") {
				const usage = command.message.includes(PI_MEMORY_USAGE) ? "" : `\n${PI_MEMORY_USAGE}`;
				emitCommandOutput(ctx, `pi-memory: ${command.message}${usage}`, "error");
				return;
			}
			try {
				const state = await runtime.state(ctx.cwd);

				if (command.kind === "status") {
					emitCommandOutput(ctx, renderMemoryStatus(await gatherMemoryStatus(state)));
					return;
				}

				if (command.kind === "show") {
					const scope: MemoryScope =
						command.scope ?? (state.identity.status === "ok" ? "project" : "legacy-global");
					const snapshot = await readScopedSnapshot(state, scope);
					const directory =
						scope === "project"
							? (state.projectStore?.directory ?? "(unavailable)")
							: (state.legacyStore?.directory ?? "(unavailable)");
					emitCommandOutput(ctx, renderMemoryShow(scope, directory, snapshot.memories, command.id, command.details));
					return;
				}

				// enable/disable: persist under the config lock, then refresh the
				// effective mode and invalidate caches without a /reload.
				const savedMode = command.kind === "enable" ? command.mode : "off";
				await setProjectMode(state, savedMode);
				const effective = await runtime.refreshMode(state);
				const lines = [`pi-memory: saved project mode ${savedMode}.`];
				if (effective.source === "env") {
					lines.push(
						`PI_MEMORY_MODE currently overrides the saved value; effective mode stays ${effective.mode} until it is unset.`,
					);
				} else {
					lines.push(`Effective mode now: ${effective.mode} (source: ${effective.source}).`);
				}
				emitCommandOutput(ctx, lines.join("\n"));
			} catch (error) {
				const message = isMemoryError(error)
					? formatMemoryError(error)
					: error instanceof Error
						? error.message
						: String(error);
				emitCommandOutput(ctx, `pi-memory: ${message}`, "error");
			}
		},
	});
}

/** Factory for SDK embeddings whose session uses a non-process-global agentDir. */
export function createMemoryExtension(options: { agentDir: string }): (pi: ExtensionAPI) => void {
	return (pi) => registerMemoryExtension(pi, options.agentDir);
}

/** Standard Pi package entrypoint, bound to Pi's documented agent directory. */
export default function setup(pi: ExtensionAPI): void {
	registerMemoryExtension(pi, getAgentDir());
}
