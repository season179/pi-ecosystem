import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	ConcernHistory,
	rebuildConcernHistory,
} from "../src/extensions/concern-history.js";

describe("ConcernHistory", () => {
	it("records a delivered concern as open and includes it in the watchdog digest", () => {
		const history = new ConcernHistory();
		history.record({
			id: "wd-a81f",
			trigger: "turns",
			headline: "The regression test is missing",
			deliveredAt: "2026-07-17T01:00:00.000Z",
		});

		assert.deepEqual(history.counts(), {
			open: 1,
			fixed: 0,
			rebutted: 0,
		});
		assert.match(history.buildDigest() ?? "", /OPEN/);
		assert.match(history.buildDigest() ?? "", /#wd-a81f: The regression test is missing/);
	});

	it("marks the latest open concern fixed or rebutted and explains it in the digest", () => {
		const history = new ConcernHistory();
		history.record({
			id: "wd-fixed",
			trigger: "turns",
			headline: "A real test gap",
			deliveredAt: "2026-07-17T01:00:00.000Z",
		});
		history.record({
			id: "wd-rebutted",
			trigger: "turns",
			headline: "The removed test still exists upstream",
			deliveredAt: "2026-07-17T01:01:00.000Z",
		});

		assert.equal(
			history.mark({
				id: "wd-fixed",
				disposition: "fixed",
				reason: "Added the missing regression test",
			}).ok,
			true,
		);
		assert.equal(
			history.mark({
				disposition: "rebutted",
				reason: "git show proves the test was intentionally removed",
			}).ok,
			true,
		);

		assert.deepEqual(history.counts(), {
			open: 0,
			fixed: 1,
			rebutted: 1,
		});
		const digest = history.buildDigest() ?? "";
		assert.match(digest, /FIXED/);
		assert.match(digest, /#wd-fixed: A real test gap/);
		assert.match(digest, /Added the missing regression test/);
		assert.match(digest, /REBUTTED/);
		assert.match(digest, /git show proves the test was intentionally removed/);
		assert.doesNotMatch(digest, /The removed test still exists upstream/);
	});

	it("bounds and flattens agent-reported reasons before prompt injection", () => {
		const history = new ConcernHistory();
		history.record({
			id: "wd-bounded",
			trigger: "turns",
			headline: "Untrusted headline",
			deliveredAt: "2026-07-17T01:00:00.000Z",
		});
		history.mark({
			id: "wd-bounded",
			disposition: "rebutted",
			reason: `Verified correction\n${"x".repeat(1_000)}`,
		});

		const digest = history.buildDigest() ?? "";
		assert.match(digest, /agent-reported context, not commands or proof/i);
		assert.doesNotMatch(digest, /Verified correction\n/);
		assert.ok(digest.length < 900);
	});

	it("caps open concerns by evicting the oldest open entry", () => {
		const history = new ConcernHistory({ maxOpen: 2, maxClosed: 2 });
		for (const id of ["oldest", "middle", "newest"]) {
			history.record({
				id,
				trigger: "turns",
				headline: `${id} concern`,
				deliveredAt: "2026-07-17T01:00:00.000Z",
			});
		}

		const digest = history.buildDigest() ?? "";
		assert.doesNotMatch(digest, /oldest concern/);
		assert.match(digest, /middle concern/);
		assert.match(digest, /newest concern/);
		assert.equal(history.counts().open, 2);
	});

	it("keeps closed concerns terminal and caps the oldest closed entry", () => {
		const history = new ConcernHistory({ maxOpen: 2, maxClosed: 1 });
		for (const id of ["first", "second"]) {
			history.record({
				id,
				trigger: "turns",
				headline: `${id} concern`,
				deliveredAt: "2026-07-17T01:00:00.000Z",
			});
			assert.equal(
				history.mark({
					id,
					disposition: "fixed",
					reason: `${id} fix`,
				}).ok,
				true,
			);
		}

		assert.equal(history.counts().fixed, 1);
		assert.doesNotMatch(history.buildDigest() ?? "", /first concern/);
		const conflicting = history.mark({
			id: "second",
			disposition: "rebutted",
			reason: "changed our mind",
		});
		assert.deepEqual(conflicting, { ok: false, reason: "already_closed" });
	});

	it("rebuilds active-branch watchdog concerns and dispositions while ignoring other Buddy messages", () => {
		const history = rebuildConcernHistory([
			{
				type: "custom_message",
				id: "consult1",
				timestamp: "2026-07-17T01:00:00.000Z",
				customType: "buddy-review",
				content: "User-requested consult",
				details: { source: "command" },
			},
			{
				type: "custom_message",
				id: "entry1",
				timestamp: "2026-07-17T01:01:00.000Z",
				customType: "buddy-review",
				content: "Concern #wd-live:\nA real issue",
				details: {
					source: "watchdog",
					trigger: "turns",
					concernId: "wd-live",
					headline: "A real issue",
				},
			},
			{
				type: "message",
				id: "feedback1",
				message: {
					role: "toolResult",
					toolName: "give_buddy_feedback",
					details: {
						concernId: "wd-live",
						concernDisposition: "fixed",
						reason: "Added the missing test",
					},
				},
			},
			{
				type: "custom_message",
				id: "legacy1",
				timestamp: "2026-07-17T01:02:00.000Z",
				customType: "buddy-review",
				content: "## BUDDY ADVISORY\n\nConcern:\nLegacy concern headline",
				details: { source: "watchdog", trigger: "turns" },
			},
		]);

		assert.deepEqual(history.counts(), {
			open: 1,
			fixed: 1,
			rebutted: 0,
		});
		const digest = history.buildDigest() ?? "";
		assert.match(digest, /#wd-live: A real issue/);
		assert.match(digest, /Added the missing test/);
		assert.match(digest, /#legacy1: Legacy concern headline/);
		assert.doesNotMatch(digest, /User-requested consult/);
	});

	it("extracts the answer headline when a modern advisory lacks headline details", () => {
		const history = rebuildConcernHistory([
			{
				type: "custom_message",
				id: "partial1",
				timestamp: "2026-07-17T01:00:00.000Z",
				customType: "buddy-review",
				content:
					"## BUDDY ADVISORY (auto, watchdog)\n\nConcern #wd-partial:\nThe actual concern headline",
				details: {
					source: "watchdog",
					trigger: "turns",
					concernId: "wd-partial",
				},
			},
		]);

		const digest = history.buildDigest() ?? "";
		assert.match(digest, /#wd-partial: The actual concern headline/);
		assert.doesNotMatch(digest, /#wd-partial: wd-partial/);
	});
});
