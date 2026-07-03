import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

/**
 * Append Pi's native Agent Skills catalog to a Buddy system prompt.
 *
 * This deliberately reuses Pi's standard progressive-disclosure prompt format:
 * skill name + description + SKILL.md location, with instructions to use the
 * read tool for full skill content. Buddy already has read-only `read`, so it
 * does not need a parallel skill registry or custom read_buddy_skill tool.
 */
export function appendSkillsToBuddyPrompt(
	prompt: string,
	skills: readonly Skill[] | undefined,
): string {
	if (!skills || skills.length === 0) return prompt;
	const skillPrompt = formatSkillsForPrompt([...skills]);
	return skillPrompt ? `${prompt}${skillPrompt}` : prompt;
}
