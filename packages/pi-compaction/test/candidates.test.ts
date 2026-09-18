import { describe, expect, it } from "vitest";
import { collectCandidates, isInstructionCall } from "../src/engine/candidates.js";
import { assistant, imageResult, singleTaskTranscript, toolResult, user, withIds } from "./helpers/messages.js";

const base = { pinned: new Set<string>(), decided: new Set<string>(), protectedTools: new Set<string>(["compaction_recall"]) };

describe("collectCandidates", () => {
	it("makes older tool groups of a single long user task eligible and protects only the newest groups", () => {
		const entries = withIds(singleTaskTranscript(10));
		const { candidates, excluded, turns } = collectCandidates(entries, { ...base, protectRecentGroups: 3 });
		expect(turns).toBe(1);
		expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(["call-0", "call-1", "call-2", "call-3", "call-4", "call-5", "call-6"]);
		expect(excluded.filter((item) => item.reason === "recent").map((item) => item.toolCallId)).toEqual(["call-7", "call-8", "call-9"]);
		expect(excluded.some((item) => item.reason === "instruction")).toBe(false);
		expect(candidates[0]).toMatchObject({ toolCallId: "call-0", resultEntryId: "e2", callEntryId: "e1", shortId: "t1", toolName: "read", turnIndex: 0 });
		expect(candidates[0].resultChars).toBeGreaterThan(1_000);
	});

	it("yields no candidates while the task is still short", () => {
		const entries = withIds(singleTaskTranscript(3));
		const { candidates, excluded } = collectCandidates(entries, { ...base, protectRecentGroups: 4 });
		expect(candidates).toEqual([]);
		expect(excluded.every((item) => item.reason === "recent")).toBe(true);
	});

	it("counts groups per assistant message, not per tool call", () => {
		const messages = [
			user("go"),
			assistant({ calls: [{ id: "a", name: "read", arguments: { path: "a.ts" } }, { id: "b", name: "read", arguments: { path: "b.ts" } }] }),
			toolResult("a", "read", "A".repeat(500)),
			toolResult("b", "read", "B".repeat(500)),
			assistant({ calls: [{ id: "c", name: "read", arguments: { path: "c.ts" } }] }),
			toolResult("c", "read", "C".repeat(500)),
			assistant({ text: "done" }),
		];
		const { candidates, excluded } = collectCandidates(withIds(messages), { ...base, protectRecentGroups: 1 });
		expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(["a", "b"]);
		expect(excluded).toEqual([{ toolCallId: "c", reason: "recent" }]);
	});

	it("protects instruction and plan file reads explicitly, wherever they occur", () => {
		const messages = [
			user("go"),
			assistant({ calls: [{ id: "agents", name: "read", arguments: { path: "/repo/AGENTS.md" } }] }),
			toolResult("agents", "read", "# Rules"),
			assistant({ calls: [{ id: "plan", name: "read", arguments: { path: "docs/COMPACTION-PLAN.md" } }] }),
			toolResult("plan", "read", "# Plan"),
			assistant({ calls: [{ id: "src", name: "read", arguments: { path: "src/index.ts" } }] }),
			toolResult("src", "read", "export {}"),
			assistant({ calls: [{ id: "skill", name: "bash", arguments: { command: "cat .pi/skills/deploy/SKILL.md" } }] }),
			toolResult("skill", "bash", "steps"),
			assistant({ calls: [{ id: "last", name: "read", arguments: { path: "src/last.ts" } }] }),
			toolResult("last", "read", "x"),
			assistant({ text: "done" }),
		];
		const { candidates, excluded } = collectCandidates(withIds(messages), { ...base, protectRecentGroups: 1 });
		expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(["src"]);
		expect(excluded).toEqual(
			expect.arrayContaining([
				{ toolCallId: "agents", reason: "instruction" },
				{ toolCallId: "plan", reason: "instruction" },
				{ toolCallId: "skill", reason: "instruction" },
				{ toolCallId: "last", reason: "recent" },
			]),
		);
	});

	it("excludes incomplete, duplicate, multimodal, pinned, protected-tool and unmapped pairs", () => {
		const messages = [
			user("go"),
			assistant({ calls: [{ id: "dup", name: "read" }] }),
			toolResult("dup", "read", "one"),
			assistant({ calls: [{ id: "dup", name: "read" }] }),
			toolResult("dup", "read", "two"),
			assistant({ calls: [{ id: "img", name: "read" }] }),
			imageResult("img", "read"),
			assistant({ calls: [{ id: "pinned", name: "read" }] }),
			toolResult("pinned", "read", "p"),
			assistant({ calls: [{ id: "recall", name: "compaction_recall" }] }),
			toolResult("recall", "compaction_recall", "r"),
			assistant({ calls: [{ id: "decided", name: "read" }] }),
			toolResult("decided", "read", "d"),
			assistant({ calls: [{ id: "ok", name: "read" }] }),
			toolResult("ok", "read", "fine"),
			assistant({ calls: [{ id: "unmapped", name: "read" }] }),
			toolResult("unmapped", "read", "u"),
			assistant({ calls: [{ id: "pending", name: "read" }] }),
		];
		const entries = withIds(messages);
		entries[16] = { message: entries[16].message }; // result without an entry id
		const { candidates, excluded } = collectCandidates(entries, { protectRecentGroups: 0, pinned: new Set(["pinned"]), decided: new Set(["decided"]), protectedTools: new Set(["compaction_recall"]) });
		expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(["ok"]);
		const reasons = Object.fromEntries(excluded.map((item) => [item.toolCallId, item.reason]));
		expect(reasons).toEqual({ dup: "ambiguous", img: "multimodal", pinned: "pinned", recall: "pinned", unmapped: "unmapped", pending: "incomplete" });
	});

	it("never treats user messages as candidates", () => {
		const entries = withIds([user("a"), user("b"), assistant({ text: "c" })]);
		expect(collectCandidates(entries, { ...base, protectRecentGroups: 0 })).toEqual({ candidates: [], excluded: [], turns: 2 });
	});
});

describe("isInstructionCall", () => {
	it("recognises instruction material by basename or directory", () => {
		expect(isInstructionCall({ path: "CLAUDE.md" })).toBe(true);
		expect(isInstructionCall({ path: "/a/b/.pi/settings.json" })).toBe(true);
		expect(isInstructionCall({ path: "notes/release-plan.md" })).toBe(true);
		expect(isInstructionCall({ command: "cat README" })).toBe(true);
		expect(isInstructionCall({ path: "src/planner.ts" })).toBe(false);
		expect(isInstructionCall({ path: "src/components/Button.tsx" })).toBe(false);
		expect(isInstructionCall({})).toBe(false);
	});
});
