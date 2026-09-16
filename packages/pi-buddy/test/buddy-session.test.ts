import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { BuddySession } from "../src/extensions/buddy-session.js";
import { MemoryStore } from "../src/extensions/memory.js";

const emptyReview = {
	openConcerns: 0,
	fixedConcerns: 0,
	rebuttedConcerns: 0,
};

function createSession(): BuddySession {
	return new BuddySession(
		new MemoryStore(mkdtempSync(join(tmpdir(), "buddy-session-memory-"))),
	);
}

describe("BuddySession", () => {
	it("owns sticky enablement and restores the exact active tool state", () => {
		const session = createSession();
		assert.equal(session.seedEnablement(true), false);
		assert.equal(session.seedEnablement(false), false);
		assert.deepEqual(
			session.activeToolsFor(false, [
				"read",
				"consult_buddy",
				"give_buddy_feedback",
			]),
			["read"],
		);
		assert.equal(session.setEnabled(true), true);
		assert.deepEqual(session.activeToolsFor(true, ["read"]), [
			"read",
			"consult_buddy",
			"give_buddy_feedback",
		]);
	});

	it("owns calibration, injection context, warning locality, and resource flags", () => {
		const session = createSession();
		assert.equal(session.initialCadence(), 3);
		const feedback = session.applyFeedback("less", "Wait for material concerns");
		assert.equal(feedback.newLevel, -1);
		assert.equal(session.watchdogThreshold(), 6);
		assert.equal(session.initialCadence(), 3);
		const injection = session.buildInjection("project", false, {
			...emptyReview,
			verdictDigest: "# Recent verdicts\nPASS",
			concernDigest: "# Concern history\nNone",
		});
		assert.match(injection.block ?? "", /less frequent automatic advisories/);
		assert.match(injection.block ?? "", /Recent verdicts/);
		assert.match(injection.block ?? "", /Concern history/);

		assert.deepEqual(session.configWarningsToShow(["bad config", "bad config"]), [
			"bad config",
		]);
		assert.deepEqual(session.configWarningsToShow(["bad config", "new warning"]), [
			"new warning",
		]);
		session.markBrowserUsed();
		assert.equal(session.shouldCloseBrowser, true);
		session.markBrowserClosed();
		assert.equal(session.shouldCloseBrowser, false);

		session.resetForSession();
		assert.equal(session.watchdogThreshold(), 3);
		assert.equal(session.initialCadence(), 3);
		assert.equal(
			session.buildInjection("project", false, emptyReview).block,
			undefined,
		);
		assert.deepEqual(session.configWarningsToShow(["bad config"]), ["bad config"]);
	});

	it("seeds the existing cadence table without inventing feedback and keeps feedback relative", () => {
		const session = createSession();
		for (const [cadence, level] of [[2, 1], [3, 0], [6, -1], [12, -2], [24, -3]]) {
			session.applyFeedback("less", "Previous session feedback");
			session.resetForSession(cadence);
			assert.equal(session.initialCadence(), cadence);
			assert.equal(session.watchdogThreshold(), cadence);
			assert.equal(session.applyFeedback("same").newLevel, level);
			assert.equal(session.buildInjection("project", false, emptyReview).block, undefined);
		}

		session.resetForSession(6);
		for (const cadence of [3, 2, 2]) {
			assert.equal(session.applyFeedback("more").watchdogThreshold, cadence);
			assert.equal(session.watchdogThreshold(), cadence);
			assert.equal(session.initialCadence(), 6);
		}
		session.resetForSession(6);
		for (const cadence of [12, 24, 24]) {
			assert.equal(session.applyFeedback("less").watchdogThreshold, cadence);
			assert.equal(session.watchdogThreshold(), cadence);
			assert.equal(session.initialCadence(), 6);
		}

		for (const cadence of [undefined, 5]) {
			session.resetForSession(cadence);
			assert.equal(session.initialCadence(), 3);
			assert.equal(session.watchdogThreshold(), 3);
			assert.equal(session.buildInjection("project", false, emptyReview).block, undefined);
		}
	});

	it("curates memory once per session and retries after a session reset", () => {
		let curations = 0;
		let reads = 0;
		const session = new BuddySession({
			curate: () => {
				curations += 1;
				return true;
			},
			readForInjection: () => {
				reads += 1;
				return "- [2026-07-18] Keep behavior stable.";
			},
		} as any);

		session.buildInjection("project", true, emptyReview);
		session.buildInjection("project", true, emptyReview);
		assert.equal(curations, 1);
		assert.equal(reads, 2);

		session.resetForSession();
		session.buildInjection("project", true, emptyReview);
		assert.equal(curations, 2);
	});
});
