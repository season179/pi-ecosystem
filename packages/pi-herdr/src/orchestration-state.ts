/**
 * Session-owned orchestration activation for pi-herdr.
 *
 * Activation is persisted as a custom session entry so `/reload` and
 * `/resume` of the same session restore the role, while `/fork` and `/clone`
 * (which copy the parent's entries under a new session id) start inactive.
 * The role belongs to the whole conversation, so the decision is read from
 * every entry in the session (append order) rather than the active `/tree`
 * branch; navigating the tree never silently changes it.
 * Verified against Pi 0.85.1 on 2026-09-17; see docs/DESIGN.md.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ORCHESTRATION_ENTRY_TYPE = "pi-herdr-orchestration";

export type ActivationSource = "command" | "tool" | "env";

export interface OrchestrationEntry {
	active: boolean;
	sessionId: string;
	source: ActivationSource;
	at: string;
}

export interface OrchestrationState {
	/** Whether this conversation's latest activation decision is active. */
	active: boolean;
	/** Latest entry belonging to this session, if any. */
	own?: OrchestrationEntry;
	/** True when entries were copied from a different session (fork/clone). */
	inherited: boolean;
}

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(data: unknown): OrchestrationEntry | undefined {
	if (!isRecord(data)) return undefined;
	if (typeof data.active !== "boolean" || typeof data.sessionId !== "string") {
		return undefined;
	}
	const source: ActivationSource =
		data.source === "command" || data.source === "tool" || data.source === "env"
			? data.source
			: "command";
	return {
		active: data.active,
		sessionId: data.sessionId,
		source,
		at: typeof data.at === "string" ? data.at : "",
	};
}

/**
 * Derive activation from the session's entries in append order. The latest
 * entry owned by `sessionId` wins; entries copied from another session
 * (fork/clone) only mark `inherited`.
 */
export function readOrchestrationState(
	entries: readonly EntryLike[],
	sessionId: string,
): OrchestrationState {
	let own: OrchestrationEntry | undefined;
	let inherited = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ORCHESTRATION_ENTRY_TYPE) {
			continue;
		}
		const parsed = parseEntry(entry.data);
		if (parsed === undefined) continue;
		if (parsed.sessionId === sessionId) own = parsed;
		else inherited = true;
	}
	return { active: own?.active ?? false, inherited, ...(own ? { own } : {}) };
}

export type OrchestrateArgs =
	| { kind: "on" }
	| { kind: "off" }
	| { kind: "unknown"; argument: string };

/** `/orchestrate` accepts no argument or exactly `off`; anything else is rejected. */
export function parseOrchestrateArgs(args: string): OrchestrateArgs {
	const trimmed = args.trim();
	if (trimmed.length === 0) return { kind: "on" };
	if (trimmed.toLowerCase() === "off") return { kind: "off" };
	return { kind: "unknown", argument: trimmed };
}

/** Resolves from both `src/` and `dist/` to the package's bundled skill. */
export const ORCHESTRATION_SKILL_URL = new URL(
	"../skills/orchestration/SKILL.md",
	import.meta.url,
);

/** Strip YAML frontmatter so only the skill body is injected. */
export function stripFrontmatter(markdown: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(markdown);
	return (match ? markdown.slice(match[0].length) : markdown).trim();
}

export function loadOrchestrationSkill(
	url: URL = ORCHESTRATION_SKILL_URL,
): { body: string; directory: string } | { error: string } {
	try {
		const body = stripFrontmatter(readFileSync(fileURLToPath(url), "utf8"));
		if (body.length === 0) {
			return { error: `bundled orchestration skill is empty: ${fileURLToPath(url)}` };
		}
		// Injected guidance has no skill-file context. Supply its base directory
		// without eagerly loading reference files (progressive disclosure).
		return { body, directory: fileURLToPath(new URL(".", url)) };
	} catch (error) {
		return {
			error: `could not read bundled orchestration skill ${fileURLToPath(url)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}
