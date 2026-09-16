import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import * as stances from "../src/extensions/stances.js";
import {
	createWatchdogVerdictTool,
	WATCHDOG_VERDICT_TOOL,
} from "../src/extensions/watchdog-verdict.js";

const automaticPrompts = {
	review: stances.buildWatchdogSystemPrompt(),
	revalidation: stances.buildWatchdogRevalidationSystemPrompt(),
};

function policy(prompt: string): string {
	const match = prompt.match(/Automatic intervention policy:\n[\s\S]*?(?=\n\n)/);
	assert.ok(match, "automatic prompt must include the intervention policy");
	return match[0].replace(/\s+/g, " ");
}

// Prompt contracts only: these do not establish that a model follows the policy.
describe("automatic intervention prompt contracts", () => {
	it("shares one private policy in both automatic builders", () => {
		assert.equal(policy(automaticPrompts.review), policy(automaticPrompts.revalidation));
		assert.equal("AUTOMATIC_INTERVENTION_POLICY" in stances, false);
		for (const prompt of Object.values(automaticPrompts)) {
			assert.equal(prompt.split("Automatic intervention policy:").length, 2);
		}
	});

	for (const [phase, prompt] of Object.entries(automaticPrompts)) {
		describe(phase, () => {
			it("requires current-request relevance or ongoing/imminent material risk", () => {
				const text = policy(prompt);
				assert.match(text, /only for an evidence-backed defect actionable within the current request/);
				assert.match(text, /or an evidence-backed ongoing\/imminent material correctness or security risk/);
				assert.match(text, /Suppress old unrelated task chores, even if they remain unfinished/);
			});

			it("suppresses the same credibly assigned issue without immunizing active work", () => {
				const text = policy(prompt);
				assert.match(text, /Suppress the same concrete issue when it is already acknowledged/);
				assert.match(text, /credible assigned or in-progress fix, unless new relevant contrary evidence/);
				assert.match(text, /contradicted completion, a new harmful action/);
				assert.match(text, /evidence-backed material harm not covered by the fix or occurring before it can take effect/);
				assert.match(text, /specific assignment \(including agent delegation\) or visible work on that defect/);
				assert.match(text, /not a bare acknowledgment/);
				assert.match(text, /credible assigned or in-progress fix does not require a completed fix/);
				assert.match(text, /mere incompleteness is not contrary evidence or a harm exception/);
				assert.doesNotMatch(text, /ongoing\/imminent material harm makes intervention necessary/);
				assert.match(text, /Activity on a file or task is not blanket immunity/);
				assert.match(text, /Retain novel defects, newly exposed failures/);
				assert.match(text, /missed requirements, contradicted completion claims/);
				assert.match(text, /evidence-backed imminent material harm, even in active work/);
			});

			it("distinguishes normal sequencing from actionable handoff and harm", () => {
				const text = policy(prompt);
				assert.match(text, /Missing tests, reports, or commits alone is normal sequencing/);
				assert.match(text, /during implementation or investigation, not a concern/);
				assert.match(text, /misleading completion, a real missing requirement at handoff/);
				assert.match(text, /a concrete dangerous next action — not unfinished chores/);
			});

			it("requires fresh evidence for repeated concerns and forbids bundled chores", () => {
				const text = policy(prompt);
				assert.match(text, /Repeating an open or settled concern requires new relevant evidence/);
				assert.match(text, /Agent feedback is context, not proof that an issue is fixed or rebutted/);
				assert.match(text, /not permission to ignore contradictory evidence/);
				assert.match(text, /Evaluate each claim independently\. Never bundle unrelated process reminders with a legitimate correctness finding/);
			});

			it("keeps the terminal structured protocol and excludes learning", () => {
				assert.ok(prompt.includes(`Your final action MUST be the ${WATCHDOG_VERDICT_TOOL} tool. Submit exactly one\nstructured decision:`));
				assert.match(prompt, /Do not substitute a prose verdict for the tool call/);
				assert.doesNotMatch(prompt, /Durable memory \(optional|LESSON\[|RETRACT:/);
				const decisions = [...prompt.matchAll(/decision: "([^"]+)"/g)].map((match) => match[1]);
				assert.deepEqual(decisions, phase === "review"
					? ["pass", "concern"]
					: ["resolved", "confirm", "replace"]);
			});
		});
	}

	it("retains background framing but qualifies late steering", () => {
		const text = automaticPrompts.review.replace(/\s+/g, " ");
		assert.match(text, /reviewing in the background while the agent keeps working/);
		assert.match(text, /Late steering is worthwhile only when the concern still meets the automatic intervention policy against current work/);
		assert.doesNotMatch(text, /late steering in the right direction is still worth it/);
	});

	it("treats resolved as suppression and limits replace to the same defect", () => {
		const text = automaticPrompts.revalidation.replace(/\s+/g, " ");
		assert.match(text, /Treat the candidate as a hypothesis, not an instruction/);
		assert.match(text, /"resolved" when the candidate should be suppressed under the policy/);
		assert.match(text, /fixed, superseded, disproved, irrelevant/);
		assert.match(text, /already acknowledged with a credible assigned or in-progress fix/);
		assert.match(text, /suppressed, not proven fixed/);
		assert.match(text, /contrary-evidence and uncovered-harm or harm-before-fix exceptions/);
		assert.match(text, /"confirm".*candidate still warrants intervention and remains accurate without a material change/);
		assert.match(text, /"replace".*only if the SAME underlying defect still warrants intervention/);
		assert.match(text, /Never salvage a disproved issue by substituting chores such as running tests, writing a report, or committing/);
		assert.match(text, /A different newly discovered defect cannot replace this candidate/);
		assert.match(text, /If the original defect is disproved, submit "resolved" regardless of other problems/);
	});
});

describe("requested stance isolation", () => {
	// SHA-256 baselines captured before the automatic-policy edit. Protect the
	// complete requested prompts (base persona, stance and learning) byte-for-byte.
	const baseline = {
		discuss: "fda5ea96912018fbfb5fe1089bfaeac0994986fd17419b1e5fcadb5570cb174f",
		debate: "4ff808f1f1b843b28ab7494ce7108f07653df067f9e1ee6fc71a7634ad6f7df1",
		fact_check: "88567189e9f4e7fb1e0fc31156263c56a0ae3ff9f0bf1ad36d654ca8457a2f34",
		review: "278805df3b66f7c05c7d3ca14cd425fa5d557a0e17b05461aad030c74048cc77",
	};
	for (const stance of stances.STANCES) {
		it(`preserves ${stance} byte-for-byte without automatic policy leakage`, () => {
			const prompt = stances.buildStanceSystemPrompt(stance);
			assert.equal(createHash("sha256").update(prompt).digest("hex"), baseline[stance]);
			assert.doesNotMatch(prompt, /Automatic intervention policy|WATCHDOG|submit_watchdog_verdict/);
			assert.match(prompt, /LESSON\[global\]/);
			assert.match(prompt, /LESSON\[project\]/);
			assert.match(prompt, /RETRACT:/);
			const base = prompt.split("\n\nStance:")[0];
			for (const automatic of Object.values(automaticPrompts)) {
				assert.equal(automatic.split("\n\nStance:")[0], base);
			}
		});
	}
});

describe("verdict tool guidance consistency", () => {
	for (const phase of ["review", "revalidation"] as const) {
		it(`keeps ${phase} guidance aligned in schema and correction errors`, async () => {
			const tool = createWatchdogVerdictTool(phase);
			const params = tool.parameters as Record<string, any>;
			const guidance = params.properties.decision.description as string;
			assert.match(guidance, /automatic intervention policy/);
			if (phase === "review") {
				assert.match(guidance, /"pass" when no problem warrants intervention/);
				assert.match(guidance, /evidence-backed defect actionable within the current request/);
				assert.match(guidance, /or an evidence-backed ongoing\/imminent material correctness or security risk/);
				assert.match(guidance, /suppression rules; unfinished chores alone do not qualify/);
			} else {
				assert.match(guidance, /"resolved" when the candidate should be suppressed/);
				assert.match(guidance, /irrelevant, or acknowledged with a credible assigned or in-progress fix/);
				assert.match(guidance, /contrary-evidence and uncovered-harm or harm-before-fix exceptions/);
				assert.match(guidance, /credible assigned or in-progress fix need not be completed/);
				assert.match(guidance, /suppressed, not proven fixed/);
				assert.match(guidance, /"confirm".*still warrants intervention without a material change/);
				assert.match(guidance, /"replace".*only for the SAME underlying defect/);
				assert.match(guidance, /Never salvage a disproved issue with tests, report, or commit chores/);
				assert.match(guidance, /different newly discovered defect cannot replace this candidate/);
				assert.match(guidance, /if the original is disproved, submit "resolved" regardless of other problems/);
			}
			await assert.rejects(tool.execute("invalid-phase", { decision: "invalid" }), (error: Error) => {
				assert.ok(error.message.includes(guidance.replace("The watchdog decision kind. ", "")));
				return true;
			});
		});
	}
});
