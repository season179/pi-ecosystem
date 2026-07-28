import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	formatDuration,
	formatStatusChip,
	formatWatchCard,
	formatWatchLine,
} from "../src/render.js";
import type {
	CommandWatchSpec,
	WatchOutcome,
	WatchRecordPublic,
	WatchSpec,
} from "../src/types.js";

function record(overrides: {
	id?: number;
	spec?: Record<string, unknown>;
	startedAt?: number;
	status?: WatchRecordPublic["status"];
} = {}): WatchRecordPublic {
	return {
		id: overrides.id ?? 2,
		spec: {
			target: "reviewer",
			mode: "agent",
			wake: true,
			...overrides.spec,
		} as WatchSpec,
		startedAt: overrides.startedAt ?? 0,
		status: overrides.status ?? "fired",
	};
}

function commandRecord(overrides: {
	id?: number;
	spec?: Partial<CommandWatchSpec>;
	startedAt?: number;
	status?: WatchRecordPublic["status"];
} = {}): WatchRecordPublic {
	return {
		id: overrides.id ?? 9,
		spec: {
			mode: "command",
			command: "gh run watch 303 --exit-status",
			timeoutMs: 3_600_000,
			wake: true,
			...overrides.spec,
		},
		startedAt: overrides.startedAt ?? 0,
		status: overrides.status ?? "fired",
	};
}

function outcome(overrides: Partial<WatchOutcome> = {}): WatchOutcome {
	return {
		kind: "fired",
		exitCode: 0,
		durationMs: 221000,
		stdout: "",
		stderr: "",
		...overrides,
	};
}

describe("formatDuration", () => {
	it("renders boundary values", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(41000), "41s");
		assert.equal(formatDuration(59999), "59s");
		assert.equal(formatDuration(60000), "1m00s");
		assert.equal(formatDuration(221000), "3m41s");
		assert.equal(formatDuration(3599999), "59m59s");
		assert.equal(formatDuration(3600000), "1h00m");
		assert.equal(formatDuration(3720000), "1h02m");
	});

	it("clamps negative durations to zero", () => {
		assert.equal(formatDuration(-5), "0s");
	});
});

describe("formatWatchCard", () => {
	it("renders a fired agent-mode card with state, note and tail", () => {
		const card = formatWatchCard(
			record({
				spec: { note: "reviewing auth diff, expect questions about session.ts" },
			}),
			outcome({ json: { result: { agent: { agent_status: "blocked" } } } }),
			"line one\nline two",
		);
		assert.equal(
			card,
			[
				'watch #2 "reviewer" fired: agent settled (blocked) after 3m41s',
				"note: reviewing auth diff, expect questions about session.ts",
				"last lines:",
				"  line one",
				"  line two",
			].join("\n"),
		);
	});

	it("omits the state when the JSON shape is missing", () => {
		const card = formatWatchCard(record(), outcome({ json: { unexpected: true } }));
		assert.equal(card, 'watch #2 "reviewer" fired: agent settled after 3m41s');
	});

	it("renders a fired output-mode card without note or tail", () => {
		const card = formatWatchCard(
			record({ id: 7, spec: { target: "w1:p3", mode: "output", match: "BUILD OK" } }),
			outcome({ durationMs: 41000, json: { result: { text: "BUILD OK in 12ms" } } }),
		);
		assert.equal(
			card,
			['watch #7 "w1:p3" fired: output matched after 41s', "match: BUILD OK in 12ms"].join(
				"\n",
			),
		);
	});

	it("falls back to the raw stdout tail for the matched text", () => {
		const card = formatWatchCard(
			record({ id: 7, spec: { target: "w1:p3", mode: "output", match: "done" } }),
			outcome({ durationMs: 1000, stdout: "compiling...\nall done\n" }),
		);
		assert.equal(
			card,
			['watch #7 "w1:p3" fired: output matched after 1s', "match: all done"].join("\n"),
		);
	});

	it("renders command completion with a prominent non-zero exit code", () => {
		const card = formatWatchCard(
			commandRecord({
				spec: { command: "  gh   run\nwatch 303 --exit-status  " },
			}),
			outcome({ exitCode: 3, durationMs: 41000 }),
		);
		assert.equal(
			card,
			[
				"watch #9 command completed (exit 3) after 41s",
				"command: gh run watch 303 --exit-status",
			].join("\n"),
		);
	});

	it("renders the command on timeout and stopped cards", () => {
		assert.equal(
			formatWatchCard(
				commandRecord(),
				outcome({ kind: "timeout", exitCode: null, durationMs: 60000 }),
			),
			[
				"watch #9 command timed out after 1m00s",
				"command: gh run watch 303 --exit-status",
			].join("\n"),
		);
		assert.equal(
			formatWatchCard(
				commandRecord(),
				outcome({ kind: "killed", exitCode: null, durationMs: 8000 }),
			),
			[
				"watch #9 command stopped after 8s",
				"command: gh run watch 303 --exit-status",
			].join("\n"),
		);
	});

	it("renders a timeout card", () => {
		const card = formatWatchCard(
			record({ id: 3, spec: { target: "builder" } }),
			outcome({ kind: "timeout", exitCode: null, durationMs: 600000 }),
		);
		assert.equal(card, 'watch #3 "builder" timed out after 10m00s');
	});

	it("renders an error card with a two-line stderr excerpt", () => {
		const card = formatWatchCard(
			record({ id: 4, spec: { target: "builder" } }),
			outcome({
				kind: "error",
				exitCode: 1,
				durationMs: 12000,
				stderr: "herdr: no such agent\nsee herdr --help\nextra line dropped",
			}),
		);
		assert.equal(
			card,
			[
				'watch #4 "builder" failed (exit 1) after 12s',
				"  herdr: no such agent",
				"  see herdr --help",
			].join("\n"),
		);
	});

	it("renders a killed card", () => {
		const card = formatWatchCard(
			record({ id: 5, spec: { target: "builder" } }),
			outcome({ kind: "killed", exitCode: null, durationMs: 8000 }),
		);
		assert.equal(card, 'watch #5 "builder" stopped after 8s');
	});

	it("keeps only the last 20 tail lines", () => {
		const tail = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
		const card = formatWatchCard(record(), outcome(), tail);
		const lines = card.split("\n");
		assert.equal(lines.length, 1 + 1 + 20);
		assert.equal(lines[2], "  line 6");
		assert.equal(lines[21], "  line 25");
	});
});

describe("formatWatchLine", () => {
	it("shows elapsed time for armed watches", () => {
		const line = formatWatchLine(
			record({
				startedAt: 0,
				status: "armed",
				spec: { note: "reviewing auth diff" },
			}),
			221000,
		);
		assert.equal(
			line,
			"#2 armed  agent reviewer (until idle|done|blocked)  3m41s  — reviewing auth diff",
		);
	});

	it("shows a dash for non-armed watches", () => {
		const line = formatWatchLine(
			record({ startedAt: 0, status: "fired", spec: { note: "reviewing auth diff" } }),
			221000,
		);
		assert.equal(
			line,
			"#2 fired  agent reviewer (until idle|done|blocked)  -  — reviewing auth diff",
		);
	});

	it("uses explicit until states when present", () => {
		const line = formatWatchLine(
			record({ status: "armed", spec: { until: ["done"] } }),
			1000,
		);
		assert.equal(line, "#2 armed  agent reviewer (until done)  1s");
	});

	it("summarizes output-mode conditions", () => {
		const matchLine = formatWatchLine(
			record({ id: 3, status: "armed", spec: { target: "w1:p3", mode: "output", match: "BUILD OK" } }),
			41000,
		);
		assert.equal(matchLine, '#3 armed  output w1:p3 (match "BUILD OK")  41s');
		const regexLine = formatWatchLine(
			record({ id: 4, status: "armed", spec: { target: "w1:p3", mode: "output", regex: "err(or)?" } }),
			41000,
		);
		assert.equal(regexLine, "#4 armed  output w1:p3 (regex /err(or)?/)  41s");
	});

	it("summarizes and normalizes command-mode rows without a target", () => {
		const line = formatWatchLine(
			commandRecord({
				status: "armed",
				spec: { command: "  gh   run\nwatch 303 --exit-status  " },
			}),
			41000,
		);
		assert.equal(
			line,
			'#9 armed  command "gh run watch 303 --exit-status"  41s',
		);
		assert.doesNotMatch(line, /undefined/u);
	});

	it("truncates long notes to 40 chars", () => {
		const note = "a".repeat(50);
		const line = formatWatchLine(record({ status: "armed", spec: { note } }), 0);
		assert.ok(line.endsWith(`  — ${"a".repeat(39)}…`));
	});
});

describe("formatStatusChip", () => {
	it("is undefined when nothing is armed", () => {
		assert.equal(formatStatusChip(0), undefined);
	});

	it("singularizes one watch", () => {
		assert.equal(formatStatusChip(1), "herdr: 1 watch");
	});

	it("pluralizes several watches", () => {
		assert.equal(formatStatusChip(3), "herdr: 3 watches");
	});
});
