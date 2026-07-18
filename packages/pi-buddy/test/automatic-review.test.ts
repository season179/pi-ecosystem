import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { AutomaticReview } from "../src/extensions/automatic-review.js";

function messageEntry(id: string, content: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-18T00:00:00.000Z",
		message: { role: "user", content },
	} as any;
}

describe("AutomaticReview", () => {
	it("owns launch, revalidation, publication, and Concern recording", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		const commits: any[] = [];
		const calls: any[] = [];
		const branch = [messageEntry("entry-1", "Please check the implementation")];
		const ctx = {
			hasUI: true,
			isIdle: () => true,
			sessionManager: { getBranch: () => branch },
			ui: { notify: () => undefined },
		} as any;
		const consultation = {
			run: async (request: any) => {
				calls.push(request);
				const result =
					request.stance === "watchdog"
						? {
								answer: "",
								activity: ["read src/example.ts"],
								rounds: 1,
								transcriptTokens: 10,
								watchdogVerdict: {
									decision: "concern",
									headline: "A regression is possible",
									advisory: "Keep the compatibility test.",
									evidence: ["src/example.ts:10"],
								},
							}
						: {
								answer: "",
								activity: ["read test/example.test.ts"],
								rounds: 1,
								transcriptTokens: 10,
								watchdogVerdict: {
									decision: "confirm",
									headline: "A regression is possible",
									advisory: "Keep the compatibility test.",
									evidence: ["test/example.test.ts:20"],
								},
							};
				request.outcomeOf?.(result);
				return result;
			},
		} as any;
		const review = new AutomaticReview({
			host: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			} as any,
			consultation,
			tools: [],
			getWatchdogThreshold: () => 1,
			isEnabled: () => true,
			reviewMessageType: "buddy-review",
			backgroundStatusKey: "buddy-bg",
			runEndReviewMinTurns: 2,
			id: () => "wd-test",
			nowIso: () => "2026-07-18T10:30:00.000Z",
			recordCommit: async (record) => {
				commits.push(record);
			},
		});

		review.restoreSession(branch);
		review.agentStarted();
		await review.turnEnded(ctx);
		await vi.waitFor(() => assert.equal(sent.length, 1));

		assert.equal(calls.length, 2);
		assert.equal(calls[0].stance, "watchdog");
		assert.equal(calls[1].stance, "watchdog-revalidation");
		assert.equal(sent[0].message.customType, "buddy-review");
		assert.equal(sent[0].message.details.concernId, "wd-test");
		assert.equal(sent[0].message.details.revalidationCount, 1);
		assert.deepEqual(sent[0].options, { deliverAs: "steer" });
		assert.equal(commits[0].outcome, "delivered");
		assert.match(review.context().concernDigest ?? "", /wd-test/);

		const disposition = review.markConcern({
			id: "wd-test",
			disposition: "fixed",
			reason: "The compatibility test now covers it",
		});
		assert.equal(disposition.ok, true);
		assert.equal(review.context().fixedConcerns, 1);
	});

	it("cancels the complete protocol when a session is replaced", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sent: any[] = [];
		const branch = [messageEntry("entry-old", "Old branch")];
		const ctx = {
			hasUI: true,
			isIdle: () => true,
			sessionManager: { getBranch: () => branch },
			ui: { notify: () => undefined },
		} as any;
		const review = new AutomaticReview({
			host: { sendMessage: (...args: any[]) => sent.push(args) } as any,
			consultation: {
				run: async (request: any) => {
					await gate;
					const result = {
						answer: "",
						activity: [],
						rounds: 1,
						transcriptTokens: 1,
						watchdogVerdict: { decision: "pass" },
					};
					request.outcomeOf?.(result);
					return result;
				},
			} as any,
			tools: [],
			getWatchdogThreshold: () => 1,
			isEnabled: () => true,
			reviewMessageType: "buddy-review",
			backgroundStatusKey: "buddy-bg",
			runEndReviewMinTurns: 2,
			recordCommit: async () => undefined,
		});

		review.restoreSession(branch);
		review.agentStarted();
		await review.turnEnded(ctx);
		review.restoreTree([messageEntry("entry-new", "New branch")]);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(sent.length, 0);
		assert.equal(review.context().concernDigest, undefined);
	});

	it("suppresses and records a Concern resolved by current-state revalidation", async () => {
		const sent: any[] = [];
		const commits: any[] = [];
		const branch = [messageEntry("entry-1", "Please check the implementation")];
		const ctx = {
			hasUI: true,
			isIdle: () => true,
			sessionManager: { getBranch: () => branch },
			ui: { notify: () => undefined },
		} as any;
		const review = new AutomaticReview({
			host: { sendMessage: (...args: any[]) => sent.push(args) } as any,
			consultation: {
				run: async (request: any) => {
					const result =
						request.stance === "watchdog"
							? {
									answer: "",
									activity: [],
									rounds: 1,
									transcriptTokens: 10,
									watchdogVerdict: {
										decision: "concern",
										headline: "Candidate concern",
										advisory: "Recheck current state.",
										evidence: [],
									},
								}
							: {
									answer: "",
									activity: [],
									rounds: 1,
									transcriptTokens: 10,
									watchdogVerdict: { decision: "resolved" },
								};
					request.outcomeOf?.(result);
					return result;
				},
			} as any,
			tools: [],
			getWatchdogThreshold: () => 1,
			isEnabled: () => true,
			reviewMessageType: "buddy-review",
			backgroundStatusKey: "buddy-bg",
			runEndReviewMinTurns: 2,
			id: () => "wd-resolved",
			nowIso: () => "2026-07-18T10:30:00.000Z",
			recordCommit: async (record) => {
				commits.push(record);
			},
		});

		review.restoreSession(branch);
		review.agentStarted();
		await review.turnEnded(ctx);
		await vi.waitFor(() => assert.equal(commits.length, 1));

		assert.equal(sent.length, 0);
		assert.equal(commits[0].outcome, "resolved");
		assert.equal(commits[0].concernId, "wd-resolved");
		assert.equal(review.context().openConcerns, 0);
		assert.match(review.context().verdictDigest ?? "", /resolved before delivery/);
	});
});
