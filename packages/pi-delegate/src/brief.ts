/**
 * Brief → worker prompt construction. The worker sees none of the session
 * history, so everything it needs must be in these two strings.
 */

export interface DelegateBrief {
	task: string;
	context: string;
	files?: string[];
	verify: string;
}

export const WORKER_SYSTEM_PROMPT = [
	"You are a delegated worker implementing a brief from an orchestrating agent.",
	"Rules:",
	"- Implement the brief fully; do not stop at a partial solution.",
	"- Run the brief's verification command yourself before finishing and fix failures it reveals.",
	"- NEVER run `git commit`, `git push`, `git reset`, or any other git command that changes history or the index. Reading git state (status, diff, log) is fine.",
	"- Stay within the brief. If something in it is impossible or contradictory, stop and say so instead of improvising a different scope.",
	"- Your final message must be a concise summary of what you changed and any deviations from the brief.",
].join("\n");

export function buildWorkerPrompt(brief: DelegateBrief): string {
	const sections = [
		"# Delegated task",
		"",
		brief.task.trim(),
		"",
		"# Context from the orchestrator",
		"",
		brief.context.trim(),
	];

	if (brief.files && brief.files.length > 0) {
		sections.push("", "# Files in scope (advisory focus hint, not a sandbox)", "");
		for (const file of brief.files) sections.push(`- ${file}`);
	}

	sections.push(
		"",
		"# Verification",
		"",
		`Your work must make this command exit 0: \`${brief.verify.trim()}\``,
		"Run it yourself before finishing; the orchestrator's harness will run it again.",
	);

	return sections.join("\n");
}
