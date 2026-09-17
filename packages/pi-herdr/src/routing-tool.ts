import { randomUUID } from "node:crypto";
import { getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	loadRoutingConfig,
	selectRoute,
	type RouteAvailability,
	type RoutingConfig,
	type RoutingProfile,
	type RouteSelection,
} from "./routing.js";

const ASSIGNMENT_TYPE = "pi-herdr-assignment";
const Difficulty = StringEnum(["easy", "general", "hardest"] as const);
const Protection = StringEnum(["standard", "claude-auto", "codex-approve-for-me"] as const);
const Profile = Type.Object({
	id: Type.String(), harness: StringEnum(["pi", "claude", "codex"] as const),
	provider: Type.Optional(Type.String()), model: Type.String(), family: Type.String(),
	enabled: Type.Boolean(), capabilities: Type.Array(Type.String()),
	suitability: Type.Object({ easy: Type.Optional(Type.Number()), general: Type.Optional(Type.Number()), hardest: Type.Optional(Type.Number()) }),
	preference: Type.Number(), protection: Protection, fallbacks: Type.Array(Type.String()),
});
const Params = Type.Object({
	action: StringEnum(["select", "record"] as const),
	difficulty: Type.Optional(Difficulty),
	requiredCapabilities: Type.Optional(Type.Array(Type.String())),
	risky: Type.Optional(Type.Boolean()),
	profileId: Type.Optional(Type.String()),
	override: Type.Optional(Profile),
	allowFallback: Type.Optional(Type.Boolean()),
	externalChecks: Type.Optional(Type.Array(Type.Object({
		harness: StringEnum(["claude", "codex"] as const),
		model: Type.String(),
		available: Type.Boolean(), authenticated: Type.Boolean(),
		capabilities: Type.Array(Type.String()), protection: Protection,
		bypassPermissions: Type.Boolean(),
		evidence: Type.String({ minLength: 1, maxLength: 1000, description: "Non-secret evidence from current native help/auth/model checks; verify protection on the worker after launch." }),
	}))),
	selectionId: Type.Optional(Type.String()),
	target: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

interface Assignment {
	sessionId: string;
	selectionId: string;
	profileId: string;
	family: string;
	target: string;
	fallbackOf?: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Assignment history belongs to the conversation, not a fork or another pane. */
export function readAssignments(ctx: ExtensionContext): Assignment[] {
	const sessionId = ctx.sessionManager.getSessionId();
	const assignments: Assignment[] = [];
	const seen = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== ASSIGNMENT_TYPE) continue;
		const data: unknown = entry.data;
		if (!record(data) || data.sessionId !== sessionId || typeof data.selectionId !== "string" || seen.has(data.selectionId)) continue;
		if (typeof data.profileId !== "string" || typeof data.family !== "string" || typeof data.target !== "string") continue;
		seen.add(data.selectionId);
		assignments.push(data as unknown as Assignment);
	}
	return assignments;
}

export function routingGuidance(agentDir: string): string {
	try {
		const config = loadRoutingConfig(agentDir);
		return `Routing ready: ${config.profiles.filter((p) => p.enabled).length} enabled profiles; call herdr_route before each dispatch. Policy: ${agentDir}/herdr-routing.json. Shares are soft over the last ${config.historyWindow} recorded assignments; quota is unknown unless checked.`;
	} catch (error) {
		return `Routing setup required: ${error instanceof Error ? error.message : String(error)} Explicit one-off user routes remain possible with herdr_route override and verified availability; do not invent defaults.`;
	}
}

/** Fixed native flags, not executable templates supplied by policy. Verify installed help first. */
export function launchArguments(profile: RoutingProfile): string[] {
	if (profile.harness === "pi") {
		if (!profile.provider) throw new Error("Pi routes require an exact provider and model ID; bare model matching is not reproducible.");
		return ["--provider", profile.provider, "--model", profile.model];
	}
	if (profile.harness === "claude") return ["--model", profile.model, "--permission-mode", profile.protection === "claude-auto" ? "auto" : "manual"];
	return profile.protection === "codex-approve-for-me"
		? ["--model", profile.model, "--approve-for-me"]
		: ["--model", profile.model, "--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
}

export async function piAvailability(ctx: ExtensionContext, profiles: readonly RoutingProfile[]): Promise<RouteAvailability[]> {
	const available = ctx.modelRegistry.getAvailable();
	const results: RouteAvailability[] = [];
	const seen = new Set<string>();
	for (const profile of profiles.filter((p) => p.harness === "pi")) {
		const key = JSON.stringify([profile.provider, profile.model]);
		if (seen.has(key)) continue;
		seen.add(key);
		const model = profile.provider ? ctx.modelRegistry.find(profile.provider, profile.model) : undefined;
		const configured = model !== undefined && available.some((m) => m.provider === profile.provider && m.id === profile.model);
		let authenticated = false;
		if (configured && model) {
			try {
				// Resolve through Pi, never persist or expose the returned credential material.
				authenticated = (await ctx.modelRegistry.getApiKeyAndHeaders(model)).ok;
			} catch { /* An unresolved credential is unavailable, not permission to substitute. */ }
		}
		results.push({
			harness: "pi", provider: profile.provider, model: profile.model,
			available: configured, authenticated, capabilities: model ? [...model.input] : [],
			protection: "standard", bypassPermissions: false,
			...(!authenticated ? { reason: "Exact Pi model or resolved authentication unavailable; check /model and /login." } : {}),
		});
	}
	return results;
}

export function registerRoutingTool(pi: ExtensionAPI, options: { isActive: () => boolean }): void {
	// Selections are previews, not assignments. Runtime reset deliberately invalidates them.
	const pending = new Map<string, { sessionId: string; selection: RouteSelection }>();
	pi.on("session_shutdown", () => { pending.clear(); });
	pi.registerTool({
		name: "herdr_route",
		label: "Herdr Route",
		description: "Select a worker profile from freshly read herdr-routing.json; never launches a worker. Call before EVERY dispatch. Pi model/auth/input support is checked through Pi. For Claude/Codex supply externalChecks from current native model/auth/help evidence (no credentials); unknown checks block. Required capabilities use input names text/image. Explicit user overrides may work without policy. After a successful dispatch, record the returned selectionId and target to count the assignment; previews and failed starts do not count. Native launchArgs are argument arrays, not shell commands: quote each argument and verify permission mode on the worker. No automatic ownership or watch recovery.",
		parameters: Params,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!options.isActive()) throw new Error("Activate orchestration explicitly before routing workers.");
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.action === "record") {
				if (!params.selectionId || !params.target?.trim()) throw new Error("record requires selectionId and the successfully dispatched worker target.");
				const existing = readAssignments(ctx).find((a) => a.selectionId === params.selectionId);
				if (existing) {
					if (existing.target !== params.target) throw new Error("Selection already recorded for another target; select again for a new assignment.");
					return { content: [{ type: "text", text: "Assignment already recorded (not counted twice)." }], details: existing };
				}
				const selected = pending.get(params.selectionId);
				if (!selected || selected.sessionId !== sessionId) throw new Error("Unknown or expired selection. Select before dispatch; do not reconstruct ownership from another session.");
				const { profile, fallbackOf } = selected.selection;
				const assignment: Assignment = { sessionId, selectionId: params.selectionId, profileId: profile.id, family: profile.family, target: params.target, ...(fallbackOf ? { fallbackOf } : {}) };
				pi.appendEntry(ASSIGNMENT_TYPE, assignment);
				pending.delete(params.selectionId);
				return { content: [{ type: "text", text: `Recorded ${profile.id} (${profile.family}) → ${params.target}. This records your dispatch report, not verified completion or ownership.` }], details: assignment };
			}
			if (!params.difficulty) throw new Error("select requires difficulty: easy, general, or hardest.");
			let config: RoutingConfig | undefined;
			let configWarning: string | undefined;
			try { config = loadRoutingConfig(getAgentDir()); }
			catch (error) {
				if (!params.override) throw error;
				configWarning = error instanceof Error ? error.message : String(error);
			}
			const profiles = [...(config?.profiles ?? []), ...(params.override ? [params.override] : [])];
			const availability = await piAvailability(ctx, profiles);
			for (const check of params.externalChecks ?? []) {
				availability.push({ ...check, reason: `Agent-observed native evidence: ${check.evidence}` });
			}
			const selection = selectRoute(config, {
				difficulty: params.difficulty,
				...(params.requiredCapabilities ? { requiredCapabilities: params.requiredCapabilities } : {}),
				...(params.risky === undefined ? {} : { risky: params.risky }),
				...(params.profileId ? { profileId: params.profileId } : {}),
				...(params.override ? { override: params.override } : {}),
				...(params.allowFallback === undefined ? {} : { allowFallback: params.allowFallback }),
			}, availability, readAssignments(ctx));
			const selectionId = randomUUID();
			// A bounded preview cache, not a persistent task ledger.
			if (pending.size >= 100) pending.delete(pending.keys().next().value!);
			pending.set(selectionId, { sessionId, selection });
			const details = { selectionId, ...selection, launchArgs: launchArguments(selection.profile), ...(configWarning ? { configWarning } : {}) };
			const output = truncateHead(JSON.stringify(details, null, 2), { maxBytes: 16_000, maxLines: 300 });
			return {
				content: [{ type: "text", text: output.content + (output.truncated ? `\n[Profile output truncated; full policy: ${getAgentDir()}/herdr-routing.json]` : "") + "\nNo worker launched. Verify native options/protection and worker environment (PI_HERDR_ORCHESTRATOR unset or 0), then dispatch without --wait, record selectionId + target, and arm herdr_watch. External evidence is agent-reported; selection does not prove a live worker's settings." }],
				details,
			};
		},
	});
}
