/**
 * Skills Status Extension
 *
 * Shows skills used in the current Pi session as a compact footer status.
 * Tracks explicit /skill:name invocations and model reads of loaded skill files.
 */

import * as os from "node:os";
import * as path from "node:path";

interface ExtensionAPI {
	on: (event: string, handler: (...args: any[]) => unknown) => void;
	registerCommand: (
		name: string,
		command: {
			description: string;
			handler: (...args: any[]) => unknown;
		},
	) => void;
}

interface ExtensionContext {
	cwd: string;
	sessionManager: {
		getBranch: () => Array<{
			type: string;
			message?: {
				role: string;
				content: unknown;
			};
		}>;
	};
	ui: {
		theme: {
			fg: (style: string, text: string) => string;
		};
		setStatus: (key: string, value: string | undefined) => void;
		notify: (message: string, level: "info" | "warning" | "error") => void;
	};
}

interface Skill {
	name: string;
	filePath: string;
}

interface ParsedSkillBlock {
	name: string;
}

interface SkillUse {
	name: string;
	lastUsedAt: number;
	source: "invoked" | "read";
}

const STATUS_KEY = "skills.status";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function expandPath(input: string, cwd: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function extractText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
	}
	return parts.join("\n").trim();
}

function getReadInputPath(input: Record<string, unknown>): string | undefined {
	if (typeof input.path === "string") return input.path;
	if (typeof input.file_path === "string") return input.file_path;
	return undefined;
}

function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(
		/^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n[\s\S]+)?$/,
	);
	if (!match) return null;
	return { name: match[1] };
}

export default function skillsStatusExtension(pi: ExtensionAPI) {
	const skillsByFile = new Map<string, Skill>();
	const usedSkills = new Map<string, SkillUse>();

	function resetSessionState(): void {
		skillsByFile.clear();
		usedSkills.clear();
	}

	function rememberLoadedSkills(skills: Skill[] | undefined): void {
		if (!skills) return;
		for (const skill of skills) {
			skillsByFile.set(path.resolve(skill.filePath), skill);
		}
	}

	function recordSkill(name: string, source: SkillUse["source"]): void {
		const key = name.trim();
		if (!key) return;

		const previous = usedSkills.get(key);
		usedSkills.set(key, {
			name: key,
			lastUsedAt: Date.now(),
			source: previous?.source === "invoked" ? previous.source : source,
		});
	}

	function recordSkillBlock(text: string): void {
		const skillBlock = parseSkillBlock(text);
		if (skillBlock) {
			recordSkill(skillBlock.name, "invoked");
		}
	}

	function getRecentSkills(): SkillUse[] {
		return Array.from(usedSkills.values()).sort(
			(a, b) => b.lastUsedAt - a.lastUsedAt,
		);
	}

	function inferSkillFromRead(rawPath: string, cwd: string): string | undefined {
		const absolutePath = expandPath(rawPath, cwd);
		const normalized = path.resolve(absolutePath);
		const known = skillsByFile.get(normalized);
		if (known) return known.name;

		if (path.basename(normalized) === "SKILL.md") {
			return path.basename(path.dirname(normalized));
		}

		return undefined;
	}

	function renderStatus(ctx: ExtensionContext): void {
		const skills = getRecentSkills();

		if (skills.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const shown = skills.slice(0, 3);
		const label = shown.map((skill) => skill.name).join(", ");
		const suffix = skills.length > shown.length ? ` +${skills.length - shown.length}` : "";
		ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `skills: ${label}${suffix}`));
	}

	function scanBranchForSkillInvocations(ctx: ExtensionContext): void {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			if (!entry.message) continue;
			if (entry.message.role !== "user") continue;
			recordSkillBlock(extractText(entry.message));
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		resetSessionState();
		scanBranchForSkillInvocations(ctx);
		renderStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		rememberLoadedSkills(event.systemPromptOptions.skills);
		recordSkillBlock(event.prompt);
		renderStatus(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;

		const rawPath = getReadInputPath(event.input);
		if (!rawPath) return;

		const skillName = inferSkillFromRead(rawPath, ctx.cwd);
		if (!skillName) return;

		recordSkill(skillName, "read");
		renderStatus(ctx);
	});

	pi.registerCommand("skills-status", {
		description: "Show the skills used in this session",
		handler: async (_args, ctx) => {
			renderStatus(ctx);
			const names = getRecentSkills().map((skill) => skill.name);
			ctx.ui.notify(
				names.length > 0 ? `Skills used: ${names.join(", ")}` : "No skills used yet",
				"info",
			);
		},
	});
}
