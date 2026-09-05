import assert from "node:assert/strict";
import type { SdkHarness } from "./sdk-harness.js";
import { toolCall } from "./sdk-harness.js";
import { saveInjectionEvidence } from "./injection-harness.js";

/** Real SDK overflow compaction splits a tool turn, then retries without a new user prompt. */
export async function splitTurnRequest(subject: SdkHarness, scenario: string) {
	const before = subject.captures.length;
	subject.enqueueResponses(
		{ kind: "tools", calls: [toolCall("split-turn-recall", "recall", { scope: "project", query: "NO_MATCH_SPLIT_TURN", includeDetails: false })], inputTokens: 100 },
		{ kind: "error", message: "Prompt is too long for this model's context window" },
		{ kind: "text", text: "Synthetic split-turn summary: the user requested analysis; the lookup is complete. Continue with the retained tool result." },
		{ kind: "text", text: "Post-compaction continuation complete." },
	);
	try { await subject.prompt(`Analyze this synthetic retrospective without changing project files. ${"Earlier synthetic context. ".repeat(100)}`); }
	finally { await saveInjectionEvidence(scenario, "postcompact", subject); }
	assert.equal(subject.captures.length, before + 4, "one tool request, one overflow, one real summarizer request, one automatic continuation");
	const ordinary = subject.contextInputs.filter((input) => input.captureIndex >= before);
	assert.equal(ordinary.length, 3, "summarizer must not go through the ordinary memory context hook");
	const post = ordinary[2];
	assert.equal(post.captureIndex, before + 3);
	assert.equal(post.messages.some((message) => message.role === "user"), false, "split-turn retained context must have NO literal user AgentMessage");
	assert.ok(post.messages.some((message) => message.role === "compactionSummary"));
	assert.deepEqual(post.messages.map((message) => message.role), ["compactionSummary", "assistant", "toolResult"]);
	assert.ok(subject.entries().some((entry) => entry.type === "compaction"), "compaction must be committed by the real session");
	assert.equal((subject.session.messages.at(-1) as { stopReason?: string }).stopReason, "stop");
	return { fresh: subject.captures[before], summarizer: subject.captures[before + 2], postcompact: subject.captures[before + 3], preConversion: post };
}
