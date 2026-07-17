import { createHash } from "node:crypto";
import type { SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

export const GUARDED_TOOL_NAMES = new Set([
	"bash",
	"write",
	"edit",
	"read",
	"grep",
	"find",
	"ls",
]);

export interface ActionDescriptor {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	source?: Pick<SourceInfo, "path" | "source" | "baseDir">;
}

const SENSITIVE_KEY = /(?:password|passwd|token|secret|api[_-]?key|private[_-]?key|access[_-]?key|credential|authorization|cookie)/i;

export function redactSensitiveValues(value: unknown, key?: string, depth = 0): unknown {
	if (key && SENSITIVE_KEY.test(key)) return "<redacted>";
	if (key === "content" && typeof value === "string") return `<${value.length} characters omitted>`;
	if (key === "command" && typeof value === "string") return redactShellSummary(value);
	if (depth > 12) return "<max-depth>";
	if (Array.isArray(value)) {
		return value.map((item) => redactSensitiveValues(item, undefined, depth + 1));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
				entryKey,
				redactSensitiveValues(entryValue, entryKey, depth + 1),
			]),
		);
	}
	return value;
}

export function boundedReviewInput(
	input: Record<string, unknown>,
	maxChars = 12_000,
): { input: unknown; truncated: boolean } {
	const redacted = redactSensitiveValues(input);
	const serialized = JSON.stringify(redacted);
	if (serialized.length <= maxChars) return { input: redacted, truncated: false };
	return {
		input: {
			preview: serialized.slice(0, maxChars),
			originalCharacters: serialized.length,
		},
		truncated: true,
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export function actionFingerprint(action: ActionDescriptor): string {
	return createHash("sha256")
		.update(
			canonicalJson({
				toolName: action.toolName,
				cwd: action.cwd,
				input: action.input,
				source: action.source,
			}),
		)
		.digest("hex");
}

function redactShellSummary(command: string): string {
	return command
		.replace(/\b(password|passwd|token|secret|api[_-]?key)\s*=\s*(?:'[^']*'|"[^"]*"|[^\s;]+)/gi, "$1=<redacted>")
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>");
}

export function summarizeAction(action: ActionDescriptor): string {
	if (action.toolName === "bash") {
		return `bash ${redactShellSummary(String(action.input.command ?? "")).slice(0, 300)}`;
	}
	if (typeof action.input.path === "string") {
		return `${action.toolName} ${action.input.path}`;
	}
	return `${action.toolName} ${canonicalJson(redactSensitiveValues(action.input)).slice(0, 300)}`;
}

export function classifyTool(options: {
	toolName: string;
	tool?: ToolInfo;
	isGuardSource: (source: SourceInfo) => boolean;
}): { allowed: boolean; hard: boolean; reason?: string } {
	const { toolName, tool, isGuardSource } = options;
	if (!tool) {
		return { allowed: false, hard: true, reason: `Tool ${toolName} is not registered` };
	}
	if (GUARDED_TOOL_NAMES.has(toolName)) {
		return isGuardSource(tool.sourceInfo)
			? { allowed: true, hard: true }
			: {
					allowed: false,
					hard: true,
					reason: `Guarded tool ${toolName} was replaced by ${tool.sourceInfo.path}`,
				};
	}
	return { allowed: false, hard: false };
}

export interface DeniedAction {
	fingerprint: string;
	summary: string;
	reason: string;
	eligibleForOneShot: boolean;
	at: string;
}

export class OneShotApprovals {
	private readonly approved = new Set<string>();
	private lastDeniedAction: DeniedAction | undefined;

	recordDenial(action: ActionDescriptor, reason: string, eligibleForOneShot: boolean): DeniedAction {
		const denied = {
			fingerprint: actionFingerprint(action),
			summary: summarizeAction(action),
			reason,
			eligibleForOneShot,
			at: new Date().toISOString(),
		};
		this.lastDeniedAction = denied;
		return denied;
	}

	lastDenied(): DeniedAction | undefined {
		return this.lastDeniedAction;
	}

	approveLast(): DeniedAction {
		const denied = this.lastDeniedAction;
		if (!denied) throw new Error("There is no denied action to approve");
		if (!denied.eligibleForOneShot) {
			throw new Error(`This hard denial cannot be overridden: ${denied.reason}`);
		}
		this.approved.add(denied.fingerprint);
		return denied;
	}

	consume(action: ActionDescriptor): boolean {
		const fingerprint = actionFingerprint(action);
		if (!this.approved.delete(fingerprint)) return false;
		return true;
	}

	clear(): void {
		this.approved.clear();
		this.lastDeniedAction = undefined;
	}
}
