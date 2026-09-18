import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { AutomaticReview } from "../src/extensions/automatic-review.js";
import { WatchdogCoordinator } from "../src/extensions/watchdog-coordinator-core.js";

function messageEntry(id: string, content: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-18T00:00:00.000Z",
		message: { role: "user", content },
	} as any;
}

function concernResult(headline = "A regression is possible") {
	return {
		answer: "",
		activity: ["read src/example.ts"],
		rounds: 1,
		transcriptTokens: 10,
		watchdogVerdict: {
			decision: "concern",
			headline,
			advisory: "Keep the compatibility test.",
			evidence: ["src/example.ts:10"],
		},
	};
}

function revalidationResult(decision: "confirm" | "resolved") {
	return decision === "resolved"
		? {
				answer: "",
				activity: [],
				rounds: 1,
				transcriptTokens: 10,
				watchdogVerdict: { decision: "resolved" },
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
}

interface Harness {
	review: AutomaticReview;
	ctx: any;
	sent: Array<{ message: any; options: any }>;
	commits: any[];
	candidates: any[];
	inserted: any[];
	calls: any[];
	widgets: Array<[string, string[] | undefined]>;
	setRunId: (runId: string | undefined) => void;
}

function harness(
	respond: (request: any, calls: any[]) => any,
	overrides: Record<string, unknown> = {},
): Harness {
	const sent: Array<{ message: any; options: any }> = [];
	const commits: any[] = [];
	const candidates: any[] = [];
	const inserted: any[] = [];
	const calls: any[] = [];
	const widgets: Array<[string, string[] | undefined]> = [];
	let runId: string | undefined = "run-1";
	const branch = [messageEntry("entry-1", "Please check the implementation")];
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: () => undefined,
			setWidget: (key: string, content: string[] | undefined) => {
				widgets.push([key, content]);
			},
		},
	} as any;
	const review = new AutomaticReview({
		host: {
			sendMessage(message: any, options: any) {
				sent.push({ message, options });
			},
		} as any,
		consultation: {
			run: async (request: any) => {
				calls.push(request);
				const result = await respond(request, calls);
				request.outcomeOf?.(result);
				return result;
			},
		} as any,
		tools: [],
		revalidationTools: [],
		getWatchdogThreshold: () => 2,
		isEnabled: () => true,
		reviewMessageType: "buddy-review",
		backgroundStatusKey: "buddy-bg",
		runEndReviewMinTurns: 2,
		getTelemetryContext: () => ({ sessionId: "s1", runId }),
		id: () => "wd-test",
		nowIso: () => "2026-07-18T10:30:00.000Z",
		recordCommit: async (record) => {
			commits.push(record);
		},
		recordCandidate: async (record) => {
			candidates.push(record);
		},
		recordInserted: async (record) => {
			inserted.push(record);
		},
		...overrides,
	});
	review.restoreSession(branch, ctx);
	return {
		review,
		ctx,
		sent,
		commits,
		candidates,
		inserted,
		calls,
		widgets,
		setRunId: (next) => {
			runId = next;
		},
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Two turns reach the threshold; wait for the detached review to finish. */
async function runToStagedCandidate(h: Harness): Promise<void> {
	h.review.agentStarted(h.ctx);
	await h.review.turnEnded(h.ctx);
	await h.review.turnEnded(h.ctx);
	await vi.waitFor(() => assert.equal(h.calls.length, 1));
	await flush();
}

const revalidations = (h: Harness) =>
	h.calls.filter((c) => c.stance === "watchdog-revalidation");

describe("AutomaticReview", () => {
	it("owns launch, revalidation, publication, and Concern recording", async () => {
		const reviewTools: any[] = [];
		const revalidationTools: any[] = [];
		const h = harness(
			(request) =>
				request.stance === "watchdog" ? concernResult() : revalidationResult("confirm"),
			{ tools: reviewTools, revalidationTools },
		);

		// The initial investigation finishes while the run is still active: the
		// ordinary path revalidates at the next stable turn boundary, not
		// immediately at staging.
		await runToStagedCandidate(h);
		assert.equal(h.sent.length, 0);
		await h.review.turnEnded(h.ctx);

		assert.equal(h.sent.length, 1);
		assert.equal(h.calls.length, 2);
		assert.equal(h.calls[0].stance, "watchdog");
		assert.equal(h.calls[0].telemetryContext.runId, "run-1");
		assert.equal(h.calls[1].stance, "watchdog-revalidation");
		assert.equal(h.calls[0].extraTools, reviewTools);
		assert.equal(h.calls[1].extraTools, revalidationTools);
		assert.doesNotMatch(h.calls[1].requestText, /Carried candidate/);
		assert.equal(h.sent[0].message.customType, "buddy-review");
		assert.equal(h.sent[0].message.details.concernId, "wd-test");
		assert.equal(h.sent[0].message.details.revalidationCount, 1);
		assert.equal(h.sent[0].message.details.originRunId, "run-1");
		assert.equal(h.sent[0].message.details.deliveryRunId, "run-1");
		assert.deepEqual(h.sent[0].options, { deliverAs: "steer" });
		assert.equal(h.commits[0].outcome, "delivered");
		assert.equal(h.candidates.length, 0);
		assert.match(h.review.context().concernDigest ?? "", /wd-test/);

		// Insertion is observed only for a newly handed-off Concern.
		h.review.messageEnded({ role: "custom", customType: "other", details: {} });
		h.review.messageEnded({
			role: "custom",
			customType: "buddy-review",
			details: { concernId: "wd-test" },
		});
		h.review.messageEnded({
			role: "custom",
			customType: "buddy-review",
			details: { concernId: "wd-test" },
		});
		await flush();
		assert.equal(h.inserted.length, 1);
		assert.equal(h.inserted[0].concernId, "wd-test");
		assert.equal(h.inserted[0].deliveryRunId, "run-1");
		assert.equal(h.inserted[0].handedOffAt, "2026-07-18T10:30:00.000Z");

		const disposition = h.review.markConcern({
			id: "wd-test",
			disposition: "fixed",
			reason: "The compatibility test now covers it",
		});
		assert.equal(disposition.ok, true);
		assert.equal(h.review.context().fixedConcerns, 1);
	});

	it("holds an idle candidate without revalidation, then delivers once in the next run", async () => {
		const h = harness((request) =>
			request.stance === "watchdog" ? concernResult() : revalidationResult("confirm"),
		);

		// Run 1: the review finishes while the session is idle.
		await runToStagedCandidate(h);
		h.review.agentEnded(h.ctx);
		await h.review.agentSettled(h.ctx);
		// Still nothing delivered; candidate is held with a provisional widget.
		assert.equal(h.sent.length, 0);
		assert.equal(h.calls.length, 1);
		assert.equal(h.candidates.length, 1);
		assert.equal(h.candidates[0].event, "held");
		assert.equal(h.candidates[0].originRunId, "run-1");
		assert.deepEqual(h.widgets.at(-1), [
			"buddy-hold",
			["Buddy: unvalidated candidate pending — A regression is possible"],
		]);
		assert.equal(h.review.heldCandidate()?.id, "wd-test");

		// Run 2 opens the single delivery window; no model work at agent_start.
		h.setRunId("run-2");
		h.review.agentStarted(h.ctx);
		assert.equal(h.calls.length, 1);
		await h.review.turnEnded(h.ctx);
		assert.equal(h.calls.length, 2);
		assert.match(h.calls[1].requestText, /Carried candidate/);
		assert.match(h.calls[1].requestText, /Origin run: run-1\. Current run: run-2/);
		assert.match(h.calls[1].requestText, /invocation 1 of 3/);
		assert.equal(h.calls[1].telemetryContext.runId, "run-2");
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.sent[0].options, { deliverAs: "steer" });
		assert.equal(h.sent[0].message.details.originRunId, "run-1");
		assert.equal(h.sent[0].message.details.deliveryRunId, "run-2");
		assert.equal(h.sent[0].message.details.windowRunId, "run-2");
		assert.equal(h.commits[0].outcome, "delivered");
		assert.equal(h.commits[0].originRunId, "run-1");
		assert.equal(h.commits[0].windowRunId, "run-2");
		assert.deepEqual(h.widgets.at(-1), ["buddy-hold", undefined]);
		assert.equal(h.review.heldCandidate(), undefined);

		// The carried revalidation counted as consultation: no fresh threshold
		// review at the same boundary and no run-end review for this run.
		h.review.agentEnded(h.ctx);
		await h.review.agentSettled(h.ctx);
		assert.equal(h.calls.length, 2);
	});

	it("expires a carried candidate when its window closes without a stable revalidation", async () => {
		const h = harness((request) =>
			request.stance === "watchdog" ? concernResult() : revalidationResult("confirm"),
		);
		await runToStagedCandidate(h);
		h.review.agentEnded(h.ctx);
		await h.review.agentSettled(h.ctx);
		assert.equal(h.review.heldCandidate()?.id, "wd-test");

		// Delivery window: every revalidation is invalidated by activity.
		h.setRunId("run-2");
		h.review.agentStarted(h.ctx);
		for (let i = 0; i < 3; i++) {
			h.review.toolStarted(`tool-${i}`);
			h.review.toolEnded(`tool-${i}`);
			const before = h.calls.length;
			const commit = h.review.turnEnded(h.ctx);
			h.review.noteActivity();
			await commit;
			assert.equal(h.calls.length, before + 1);
		}
		assert.equal(h.sent.length, 0);
		assert.equal(revalidations(h).length, 3);
		assert.match(revalidations(h)[2].requestText, /invocation 3 of 3/);
		assert.equal(h.commits.filter((c) => c.reason === "activity").length, 3);
		// Third unresolved invocation exhausts the budget; there is no fourth.
		assert.equal(h.review.heldCandidate(), undefined);
		assert.deepEqual(
			h.candidates.map((c) => [c.event, c.reason]),
			[["held", undefined], ["expired", "attempts_exhausted"]],
		);
		// Ordinary fresh checks resume after expiry: the released slot lets the
		// next threshold review launch; finishing idle, it is held (not published).
		await h.review.turnEnded(h.ctx);
		h.review.agentEnded(h.ctx);
		await h.review.agentSettled(h.ctx);
		await flush();
		assert.equal(revalidations(h).length, 3);
		assert.equal(h.calls.filter((c) => c.stance === "watchdog").length, 2);
		assert.equal(h.sent.length, 0);
		assert.deepEqual(
			h.candidates.map((c) => c.event),
			["held", "expired", "held"],
		);
		assert.equal(h.commits[0].sessionId, "s1");

		// A separate hold whose window closes with zero invocations expires too.
		const z = harness((request) =>
			request.stance === "watchdog" ? concernResult() : revalidationResult("confirm"),
		);
		await runToStagedCandidate(z);
		z.review.agentEnded(z.ctx);
		await z.review.agentSettled(z.ctx);
		z.setRunId("run-2");
		z.review.agentStarted(z.ctx);
		z.review.toolStarted("hung-tool");
		await z.review.turnEnded(z.ctx); // protocol deferral: no invocation
		assert.equal(z.calls.length, 1);
		z.review.agentEnded(z.ctx);
		await z.review.agentSettled(z.ctx);
		assert.equal(z.review.heldCandidate(), undefined);
		assert.equal(z.candidates.at(-1).event, "expired");
		assert.equal(z.candidates.at(-1).reason, "window_closed");
		assert.equal(z.candidates.at(-1).windowRunId, "run-2");
		assert.equal(z.sent.length, 0);
	});

	it("cancels the complete protocol when a session is replaced", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness(async () => {
			await gate;
			return {
				answer: "",
				activity: [],
				rounds: 1,
				transcriptTokens: 1,
				watchdogVerdict: { decision: "pass" },
			};
		});

		h.review.agentStarted(h.ctx);
		await h.review.turnEnded(h.ctx);
		await h.review.turnEnded(h.ctx);
		assert.equal(h.calls.length, 1);
		h.review.restoreTree([messageEntry("entry-new", "New branch")], h.ctx);
		release();
		await flush();

		assert.equal(h.sent.length, 0);
		assert.equal(h.review.context().concernDigest, undefined);
	});

	it("a reset during an awaited revalidation cannot count or launch in the new lifecycle", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness(async (request) => {
			if (request.stance === "watchdog") return concernResult();
			await gate;
			return revalidationResult("resolved");
		});
		await runToStagedCandidate(h);
		h.review.agentEnded(h.ctx);
		await h.review.agentSettled(h.ctx);
		h.setRunId("run-2");
		h.review.agentStarted(h.ctx);
		const stale = h.review.turnEnded(h.ctx);
		assert.equal(revalidations(h).length, 1);

		// /buddy off + on while the old provider call hangs, then a fresh run.
		h.review.abort("disabled");
		h.review.agentStarted(h.ctx);
		const widgetsBefore = h.widgets.length;
		release();
		await stale;
		// The stale continuation neither counted a turn, launched, nor cleaned up.
		assert.equal(h.calls.length, 2);
		assert.equal(h.widgets.length, widgetsBefore);
		assert.doesNotMatch(h.review.context().verdictDigest ?? "", /resolved before delivery/);
		// The new lifecycle counts from zero: one turn is below the threshold.
		await h.review.turnEnded(h.ctx);
		assert.equal(h.calls.length, 2);
		await h.review.turnEnded(h.ctx);
		assert.equal(h.calls.length, 3);
	});

	it("never steers idle: a run ending during revalidation defers, then holds", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness(async (request) => {
			if (request.stance === "watchdog") return concernResult();
			await gate;
			return revalidationResult("confirm");
		});
		await runToStagedCandidate(h);
		const commit = h.review.turnEnded(h.ctx);
		assert.equal(revalidations(h).length, 1);
		// The run ends (abort/error/normal) while the revalidation is in flight.
		h.review.agentEnded(h.ctx);
		release();
		await commit;
		assert.equal(h.sent.length, 0);
		assert.equal(h.commits.at(-1)?.outcome, "deferred");
		await h.review.agentSettled(h.ctx);
		assert.equal(h.review.heldCandidate()?.id, "wd-test");
		assert.equal(h.candidates.at(-1).event, "held");
	});

	it("releases a held candidate on disable and records the expiry reason", async () => {
		const h = harness((request) =>
			request.stance === "watchdog" ? concernResult() : revalidationResult("confirm"),
		);
		await runToStagedCandidate(h);
		h.review.agentEnded(h.ctx);
		await h.review.agentSettled(h.ctx);
		assert.equal(h.review.heldCandidate()?.id, "wd-test");

		h.review.abort("disabled");
		assert.equal(h.review.heldCandidate(), undefined);
		assert.deepEqual(h.widgets.at(-1), ["buddy-hold", undefined]);
		assert.equal(h.candidates.at(-1).event, "expired");
		assert.equal(h.candidates.at(-1).reason, "disabled");

		// A later run must not resurrect anything.
		h.setRunId("run-2");
		h.review.agentStarted(h.ctx);
		await h.review.turnEnded(h.ctx);
		assert.equal(h.sent.length, 0);
		assert.equal(revalidations(h).length, 0);
	});

	it("suppresses and records a Concern resolved by current-state revalidation", async () => {
		const h = harness(
			(request) =>
				request.stance === "watchdog"
					? concernResult("Candidate concern")
					: revalidationResult("resolved"),
			{ id: () => "wd-resolved" },
		);

		await runToStagedCandidate(h);
		await h.review.turnEnded(h.ctx);

		assert.equal(h.sent.length, 0);
		assert.equal(h.commits.length, 1);
		assert.equal(h.commits[0].outcome, "resolved");
		assert.equal(h.commits[0].concernId, "wd-resolved");
		assert.equal(h.review.context().openConcerns, 0);
		assert.match(h.review.context().verdictDigest ?? "", /resolved before delivery/);
	});
});

describe("Jev stable candidate routing", () => {
	it("candidate triage cancellation consumes no held invocation budget or run consultation", async () => {
		let release!: (value: any) => void;
		const rows: any[] = [];
		const h = harness(() => concernResult(), {
			jev: { decide: async (input: any) => input.candidate
				? new Promise((resolve) => { release = resolve; })
				: { outcome: "review", totalMs: 0 } },
			recordJev: async (record: any) => { rows.push(record); },
		});
		await runToStagedCandidate(h);
		h.review.agentEnded(h.ctx); await h.review.agentSettled(h.ctx);
		h.review.agentStarted(h.ctx);
		const checking = h.review.turnEnded(h.ctx);
		await vi.waitFor(() => assert.equal(typeof release, "function"));
		h.review.noteActivity();
		release({ outcome: "suppress", totalMs: 0 }); await checking;
		assert.equal(h.review.heldCandidate()?.hold?.window?.invocations, 0);
		assert.equal(revalidations(h).length, 0);
		assert.equal(h.sent.length, 0);
		assert.equal(rows.at(-1).outcome, "stale");
		// Next turn is deferred by a running tool (no triage/reviewer). At settle,
		// expiry frees the held slot and this unconsulted run is still eligible.
		h.review.toolStarted("busy"); await h.review.turnEnded(h.ctx);
		h.review.agentEnded(h.ctx); await h.review.agentSettled(h.ctx);
		assert.equal(h.calls.at(-1).trigger, "run_end");
	});

	it("activity interleaving after a gate decision cannot launch the reviewer", async () => {
		const h = harness(() => concernResult(), {
			jev: { decide: async () => ({ outcome: "review", totalMs: 0 }) },
			recordJev: async () => {},
		});
		h.ctx.ui.setStatus = (_key: string, text: string) => {
			if (text === "Jev: review") h.review.noteActivity();
		};
		h.review.agentStarted(h.ctx);
		await h.review.turnEnded(h.ctx); await h.review.turnEnded(h.ctx);
		assert.equal(h.calls.length, 0);
	});
});

describe("WatchdogCoordinator ownership", () => {
	it("relevance suppression uses the same stable current/active snapshot guard and frees the slot", async () => {
		const coordinator = new WatchdogCoordinator<string, { id?: string }>();
		coordinator.stage(coordinator.capture([]), "candidate");
		let release!: (value: any) => void;
		const attempt = coordinator.commit([], () => new Promise((resolve) => { release = resolve; }));
		coordinator.noteActivity(); release({ decision: "irrelevant" });
		assert.deepEqual(await attempt, { status: "deferred", reason: "activity" });
		assert.equal(coordinator.peekPending(), "candidate");
		const idle = await coordinator.commit([], async () => ({ decision: "irrelevant" }), undefined, () => false);
		assert.deepEqual(idle, { status: "deferred", reason: "activity" });
		assert.equal(coordinator.peekPending(), "candidate");
		const applied = await coordinator.commit([], async () => ({ decision: "irrelevant" }), undefined, () => true);
		assert.equal(applied.status, "suppressed");
		if (applied.status === "suppressed") assert.equal(applied.reason, "irrelevant");
		assert.equal(coordinator.stage(coordinator.capture([]), "fresh"), true);
	});
	it("invalidation releases commit ownership; the old continuation cannot touch new state", async () => {
		const coordinator = new WatchdogCoordinator<{ id: string }, { id?: string }>();
		let releaseOld!: (value: any) => void;
		const oldGate = new Promise<any>((resolve) => {
			releaseOld = resolve;
		});
		assert.equal(coordinator.stage(coordinator.capture([]), { id: "old" }), true);
		const published: string[] = [];
		const oldCommit = coordinator.commit(
			[],
			() => oldGate,
			(candidate) => published.push(candidate.id),
		);

		// Reset while the old provider call hangs: the slot is free immediately.
		coordinator.invalidate();
		assert.equal(coordinator.hasPending, false);
		assert.equal(coordinator.stage(coordinator.capture([]), { id: "new" }), true);
		const newCommit = coordinator.commit(
			[],
			async (candidate) => ({ decision: "confirm", candidate }),
			(candidate) => published.push(candidate.id),
		);

		// The hung call resolving later neither publishes nor clears the new work.
		releaseOld({ decision: "confirm", candidate: { id: "old" } });
		const oldResult = await oldCommit;
		assert.deepEqual(oldResult, { status: "deferred", reason: "activity" });
		const newResult = await newCommit;
		assert.equal(newResult.status, "deliver");
		assert.deepEqual(published, ["new"]);
	});

	it("discardPending releases the slot and turns an in-flight commit into a deferral", async () => {
		const coordinator = new WatchdogCoordinator<{ id: string }, { id?: string }>();
		let release!: (value: any) => void;
		const gate = new Promise<any>((resolve) => {
			release = resolve;
		});
		coordinator.stage(coordinator.capture([]), { id: "held" });
		const commit = coordinator.commit([], () => gate);
		assert.deepEqual(coordinator.discardPending(), { id: "held" });
		assert.equal(coordinator.hasPending, false);
		// The hung commit no longer blocks fresh staging.
		assert.equal(coordinator.stage(coordinator.capture([]), { id: "fresh" }), true);
		release({ decision: "confirm", candidate: { id: "held" } });
		assert.deepEqual(await commit, { status: "deferred", reason: "activity" });
		assert.equal(coordinator.hasPending, true);
	});
});
