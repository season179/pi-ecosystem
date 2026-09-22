import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import herdrExtension from "../src/extensions/herdr.js";

const fixture = fileURLToPath(
	new URL("./fixtures/fake-herdr.mjs", import.meta.url),
);
const ENV_KEYS = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"PI_HERDR_ORCHESTRATOR",
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_COMMAND",
	"FAKE_HERDR_BEHAVIOR",
	"FAKE_HERDR_DELAY_MS",
	"FAKE_HERDR_NOTIFICATION_LOG",
	"FAKE_HERDR_NOTIFICATION_DELAY_MS",
	"FAKE_HERDR_NOTIFICATION_EXIT_CODE",
] as const;

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

interface FakeEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	readonly commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
	readonly messages: Array<{ message: any; options: any }> = [];
	readonly statuses: Array<string | undefined> = [];
	readonly notices: Array<{ message: string; level: string }> = [];
	/** Simulated persisted session entries (what pi.appendEntry writes). */
	entries: FakeEntry[] = [];
	sessionId = "session-a";
	parentSession: string | undefined;
	private activeTools: string[] = [];

	readonly ctx = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				this.statuses.push(value);
			},
			notify: (message: string, level = "info") => {
				this.notices.push({ message, level });
			},
		},
		sessionManager: {
			getSessionId: () => this.sessionId,
			getHeader: () => ({ parentSession: this.parentSession }),
			getBranch: () => [...this.entries],
			getEntries: () => [...this.entries],
		},
	} as unknown as ExtensionContext;

	on(event: string, handler: Handler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, command: { handler: (...args: any[]) => Promise<void> }): void {
		this.commands.set(name, command);
	}

	registerMessageRenderer(): void {}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	setActiveTools(names: string[]): void {
		this.activeTools = [...names];
	}

	sendMessage(message: any, options: any): void {
		this.messages.push({ message, options });
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: "custom", customType, data });
	}

	async emit(event: string, fields: Record<string, unknown> = {}): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...fields }, this.ctx));
		}
		return results;
	}

	async execute(name: string, params: Record<string, unknown> = {}): Promise<any> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`missing tool ${name}`);
		return tool.execute("call-1", params, undefined, undefined, this.ctx);
	}

	orchestrationEntries(): Array<{ active: boolean; sessionId: string; source: string }> {
		return this.entries
			.filter((entry) => entry.customType === "pi-herdr-orchestration")
			.map((entry) => entry.data as { active: boolean; sessionId: string; source: string });
	}
}

interface Harness {
	pi: FakePi;
	dir: string;
	telemetryPath: string;
	notificationPath: string;
}

let originals = new Map<string, string | undefined>();
let harness: Harness | undefined;

function notificationCount(path: string): number {
	try {
		return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out: ${message}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function createHarness(
	wakeBudget: number,
	options: {
		promoted?: boolean;
		notificationDelayMs?: number;
		entries?: FakeEntry[];
		sessionId?: string;
		parentSession?: string;
		reason?: string;
	} = {},
): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-extension-"));
	const telemetryPath = join(dir, "telemetry.jsonl");
	const notificationPath = join(dir, "notifications.jsonl");
	writeFileSync(
		join(dir, "herdr.json"),
		JSON.stringify({
			maxWatches: 20,
			wakeBudget,
			includeTailLines: 0,
			toastOn: [],
			telemetryPath,
		}),
	);
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "w1:p1";
	process.env.PI_HERDR_ORCHESTRATOR = options.promoted === false ? "0" : "1";
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_HERDR_COMMAND = fixture;
	process.env.FAKE_HERDR_BEHAVIOR = "ok";
	delete process.env.FAKE_HERDR_DELAY_MS;
	process.env.FAKE_HERDR_NOTIFICATION_LOG = notificationPath;
	process.env.FAKE_HERDR_NOTIFICATION_DELAY_MS = String(
		options.notificationDelayMs ?? 0,
	);
	delete process.env.FAKE_HERDR_NOTIFICATION_EXIT_CODE;

	const pi = new FakePi();
	if (options.entries) pi.entries = [...options.entries];
	if (options.sessionId) pi.sessionId = options.sessionId;
	pi.parentSession = options.parentSession;
	herdrExtension(pi as unknown as ExtensionAPI);
	await pi.emit("session_start", { reason: options.reason ?? "startup" });
	harness = { pi, dir, telemetryPath, notificationPath };
	return harness;
}

async function injectedPrompt(current: Harness): Promise<string | undefined> {
	const results = (await current.pi.emit("before_agent_start", {
		prompt: "go",
		systemPrompt: "BASE PROMPT",
		systemPromptOptions: { cwd: process.cwd() },
	})) as Array<{ systemPrompt?: string } | undefined>;
	return results.find((result) => result?.systemPrompt !== undefined)?.systemPrompt;
}

const ORCHESTRATOR_TOOLS = [
	"herdr_watch",
	"herdr_unwatch",
	"herdr_watches",
];

function activeOrchestratorTools(current: Harness): string[] {
	return current.pi
		.getActiveTools()
		.filter((name) => ORCHESTRATOR_TOOLS.includes(name))
		.sort();
}

async function arm(
	current: Harness,
	wake = true,
): Promise<{ response: any; message: { message: any; options: any } }> {
	const expectedMessages = current.pi.messages.length + 1;
	const response = await current.pi.execute("herdr_watch", {
		target: `worker-${expectedMessages}`,
		mode: "agent",
		wake,
	});
	await waitFor(
		() => current.pi.messages.length >= expectedMessages,
		`watch delivery ${expectedMessages}`,
	);
	return {
		response,
		message: current.pi.messages[expectedMessages - 1]!,
	};
}

async function watchDetails(current: Harness): Promise<any> {
	return (await current.pi.execute("herdr_watches")).details;
}

beforeEach(() => {
	originals = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
	if (harness) {
		await harness.pi.emit("session_shutdown");
		rmSync(harness.dir, { recursive: true, force: true });
		harness = undefined;
	}
	for (const key of ENV_KEYS) {
		const value = originals.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe.sequential("herdr extension attendance epochs", () => {
	it("resets budget and latch on interactive input, RPC input, and session start", async () => {
		const current = await createHarness(1);
		await arm(current);
		await arm(current);
		await waitFor(
			() => notificationCount(current.notificationPath) === 1,
			"first exhaustion notification",
		);

		await current.pi.emit("input", { source: "interactive", text: "hello" });
		assert.equal((await watchDetails(current)).wakesUsed, 0);
		await arm(current);
		await arm(current);
		await waitFor(
			() => notificationCount(current.notificationPath) === 2,
			"interactive epoch notification",
		);

		await current.pi.emit("input", { source: "rpc", text: "supervise" });
		assert.equal((await watchDetails(current)).wakesUsed, 0);
		await arm(current);
		await arm(current);
		await waitFor(
			() => notificationCount(current.notificationPath) === 3,
			"RPC epoch notification",
		);

		await current.pi.emit("session_start");
		assert.equal((await watchDetails(current)).wakesUsed, 0);
		await arm(current);
		await arm(current);
		await waitFor(
			() => notificationCount(current.notificationPath) === 4,
			"session epoch notification",
		);
	});

	it("extension input resets neither budget nor exhaustion latch", async () => {
		const current = await createHarness(1);
		await arm(current);
		await arm(current);
		await waitFor(
			() => notificationCount(current.notificationPath) === 1,
			"initial notification",
		);

		await current.pi.emit("input", { source: "extension", text: "authored" });
		assert.equal((await watchDetails(current)).wakesUsed, 1);
		await arm(current);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(notificationCount(current.notificationPath), 1);
	});

	it("latches the first idle exhaustion before asynchronous notification work", async () => {
		const current = await createHarness(1, { notificationDelayMs: 300 });
		await arm(current);
		const exhausted = await arm(current);
		assert.equal(exhausted.message.options.triggerTurn, false);
		assert.match(
			exhausted.message.message.content,
			/wake budget exhausted \(1\/1\)/u,
		);
		await waitFor(
			() => notificationCount(current.notificationPath) === 1,
			"delayed notification start",
		);

		await arm(current);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(notificationCount(current.notificationPath), 1);
		const args = JSON.parse(
			readFileSync(current.notificationPath, "utf8").trim(),
		) as string[];
		assert.deepEqual(args, [
			"notification",
			"show",
			"Herdr wake budget exhausted (1/1); watch #2 did not start a turn",
			"--sound",
			"request",
		]);
	});

	it("keeps the exhaustion latch after a notification CLI failure", async () => {
		const current = await createHarness(1);
		process.env.FAKE_HERDR_NOTIFICATION_EXIT_CODE = "3";
		await arm(current);
		await arm(current);
		await waitFor(
			() => notificationCount(current.notificationPath) === 1,
			"failed notification attempt",
		);
		await new Promise((resolve) => setTimeout(resolve, 80));

		await arm(current);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(notificationCount(current.notificationPath), 1);
	});

	it("does not latch a busy exhaustion, then notifies when idle", async () => {
		const current = await createHarness(1);
		await arm(current);
		await current.pi.emit("agent_start");
		await arm(current);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(notificationCount(current.notificationPath), 0);

		await current.pi.emit("agent_settled");
		await arm(current);
		await waitFor(
			() => notificationCount(current.notificationPath) === 1,
			"idle exhaustion after busy delivery",
		);
	});

	it("never reports exhaustion for budget zero or wake:false", async () => {
		const disabled = await createHarness(0);
		const budgetZero = await arm(disabled);
		assert.equal(budgetZero.message.options.triggerTurn, false);
		assert.doesNotMatch(budgetZero.message.message.content, /wake budget/u);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(notificationCount(disabled.notificationPath), 0);
		await disabled.pi.emit("session_shutdown");
		rmSync(disabled.dir, { recursive: true, force: true });
		harness = undefined;

		const optedOut = await createHarness(1);
		await arm(optedOut, true);
		const noWake = await arm(optedOut, false);
		assert.equal(noWake.message.options.triggerTurn, false);
		assert.doesNotMatch(noWake.message.message.content, /wake budget/u);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(notificationCount(optedOut.notificationPath), 0);
	});

	it("uses truthful arming text for wake-enabled and non-waking watches", async () => {
		const current = await createHarness(5);
		const enabled = await arm(current, true);
		const disabled = await arm(current, false);
		assert.match(enabled.response.content[0].text, /you will be woken when it fires/u);
		assert.match(
			disabled.response.content[0].text,
			/report will be delivered without starting a turn$/u,
		);
		assert.doesNotMatch(disabled.response.content[0].text, /you will be woken/u);
	});

	it("reports positive and exhausted wake-budget list states", async () => {
		const current = await createHarness(1);
		const initial = await current.pi.execute("herdr_watches");
		assert.equal(
			initial.content[0].text,
			"wake budget: 0/1 attempted idle wakes since last interactive or RPC input\nno watches",
		);
		assert.deepEqual(initial.details, {
			count: 0,
			wakesUsed: 0,
			wakeBudget: 1,
			exhausted: false,
		});

		await arm(current);
		const exhausted = await current.pi.execute("herdr_watches");
		assert.match(exhausted.content[0].text, /^wake budget: 1\/1 attempted/u);
		assert.equal(exhausted.details.exhausted, true);
		assert.equal(exhausted.details.wakesUsed, 1);
	});

	it("reports disabled wake-budget list state", async () => {
		const current = await createHarness(0);
		const result = await current.pi.execute("herdr_watches");
		assert.equal(result.content[0].text, "wake: off (budget 0)\nno watches");
		assert.deepEqual(result.details, {
			count: 0,
			wakesUsed: 0,
			wakeBudget: 0,
			exhausted: false,
		});
	});

	it("shows footer status only while promoted and clears it on orchestrate off", async () => {
		const current = await createHarness(0, { promoted: false });
		assert.equal(current.pi.statuses.at(-1), undefined);

		await current.pi.execute("herdr_orchestrate");
		assert.equal(current.pi.statuses.at(-1), "herdr: wake off");

		const command = current.pi.commands.get("orchestrate");
		assert.ok(command);
		await command.handler("off", current.pi.ctx);
		assert.equal(current.pi.statuses.at(-1), undefined);
	});

	it("writes the decision snapshot when input resets during notification I/O", async () => {
		const current = await createHarness(1, { notificationDelayMs: 300 });
		await arm(current);
		await arm(current);
		await waitFor(
			() => notificationCount(current.notificationPath) === 1,
			"pending exhaustion notification",
		);

		await current.pi.emit("input", { source: "interactive", text: "reset" });
		assert.equal((await watchDetails(current)).wakesUsed, 0);
		await waitFor(() => {
			try {
				return readFileSync(current.telemetryPath, "utf8")
					.split("\n")
					.filter(Boolean).length >= 2;
			} catch {
				return false;
			}
		}, "telemetry after delayed notification");

		const records = readFileSync(current.telemetryPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const exhausted = records.find(
			(record) => record.deliveryReason === "budget-exhausted",
		);
		assert.ok(exhausted);
		assert.equal(exhausted.wakesUsed, 1);
		assert.equal(exhausted.wakeBudget, 1);
		assert.equal(exhausted.triggerTurn, false);
		assert.equal(exhausted.countsAsWake, false);
	});
});

describe.sequential("herdr orchestration activation lifecycle", () => {
	it("stays inactive when installed without env or a persisted decision", async () => {
		const current = await createHarness(0, { promoted: false });
		assert.deepEqual(activeOrchestratorTools(current), []);
		assert.deepEqual(current.pi.orchestrationEntries(), []);
		assert.equal(await injectedPrompt(current), undefined);
		assert.equal(current.pi.tools.has("herdr_route"), false);
		assert.equal(current.pi.commands.has("limits"), false);
	});

	it("/orchestrate activates once, persists a session-owned entry, and injects the bundled skill", async () => {
		const current = await createHarness(0, { promoted: false });
		const command = current.pi.commands.get("orchestrate");
		assert.ok(command);

		await command.handler("", current.pi.ctx);
		assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
		assert.deepEqual(current.pi.orchestrationEntries(), [
			{ active: true, sessionId: "session-a", source: "command", at: current.pi.orchestrationEntries()[0]!.at },
		] as any);
		assert.match(current.pi.notices.at(-1)!.message, /no workers started/u);
		assert.equal(current.pi.notices.at(-1)!.level, "info");

		const prompt = await injectedPrompt(current);
		assert.ok(prompt?.startsWith("BASE PROMPT\n\n# Herdr orchestration"));
		assert.match(prompt!, /Own the outcome, not every pane/u, "skill body injected");
		assert.ok(prompt!.includes(`Skill directory: ${fileURLToPath(new URL("../skills/orchestration/", import.meta.url))}`));
		assert.match(prompt!, /references\/recovery\.md/);
		assert.doesNotMatch(prompt!, /^# Recovery and handoff/m, "reference bodies stay on demand");
		assert.doesNotMatch(prompt!, /^---\nname:/mu, "frontmatter stripped");
		assert.doesNotMatch(prompt!, /herdr_route|Routing (ready|setup required)|budgetChoice|CodexBar/u);
		assert.match(prompt!, /Armed watches never survive/u);

		await command.handler("  ", current.pi.ctx);
		assert.equal(current.pi.orchestrationEntries().length, 1, "idempotent: no duplicate entry");
		assert.match(current.pi.notices.at(-1)!.message, /already active/u);
	});

	it("herdr_orchestrate uses the same path and returns the workflow immediately", async () => {
		const current = await createHarness(0, { promoted: false });
		const result = await current.pi.execute("herdr_orchestrate");
		assert.equal(result.details.changed, true);
		assert.match(result.content[0].text, /^orchestration activated for this session/u);
		assert.match(result.content[0].text, /Own the outcome, not every pane/u);
		assert.ok(result.content[0].text.includes(`Skill directory: ${fileURLToPath(new URL("../skills/orchestration/", import.meta.url))}`));
		assert.doesNotMatch(result.content[0].text, /^# Routing decisions|^# Recovery and handoff/m);
		assert.match(result.content[0].text, /No workers were started/u);
		assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
		assert.equal(current.pi.orchestrationEntries()[0]?.source, "tool");

		const again = await current.pi.execute("herdr_orchestrate");
		assert.equal(again.details.changed, false);
		assert.match(again.content[0].text, /already active/u);
		assert.equal(current.pi.orchestrationEntries().length, 1);
	});

	it("rejects unknown /orchestrate arguments without changing state", async () => {
		const current = await createHarness(0, { promoted: false });
		const command = current.pi.commands.get("orchestrate")!;
		await command.handler("build the CRM", current.pi.ctx);
		assert.deepEqual(activeOrchestratorTools(current), []);
		assert.deepEqual(current.pi.orchestrationEntries(), []);
		assert.equal(current.pi.notices.at(-1)!.level, "error");
		assert.match(current.pi.notices.at(-1)!.message, /unknown \/orchestrate argument "build the CRM"/u);
		assert.equal(await injectedPrompt(current), undefined);
	});

	it("/orchestrate off stops armed watches, persists off, and discloses that workers keep running", async () => {
		const current = await createHarness(0, { promoted: false });
		const command = current.pi.commands.get("orchestrate")!;
		await command.handler("", current.pi.ctx);
		process.env.FAKE_HERDR_BEHAVIOR = "stall";
		await current.pi.execute("herdr_watch", { target: "worker-x", mode: "agent" });
		assert.equal((await watchDetails(current)).count, 1);

		await command.handler("off", current.pi.ctx);
		assert.deepEqual(activeOrchestratorTools(current), []);
		assert.deepEqual(current.pi.orchestrationEntries().map((entry) => entry.active), [true, false]);
		const notice = current.pi.notices.at(-1)!.message;
		assert.match(notice, /^orchestration off: stopped 1 armed watch \(their child processes were terminated\)/u);
		assert.match(notice, /workers were NOT stopped and conversation history is unchanged/u);
		assert.equal(await injectedPrompt(current), undefined);
		assert.equal(current.pi.tools.has("herdr_route"), false);

		await command.handler("off", current.pi.ctx);
		assert.equal(current.pi.orchestrationEntries().length, 2, "repeated off appends nothing");
		assert.match(current.pi.notices.at(-1)!.message, /already off: no armed watches/u);
	});

	it("PI_HERDR_ORCHESTRATOR=1 activates and persists at session start, but a persisted off wins", async () => {
		const current = await createHarness(0);
		assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
		assert.deepEqual(current.pi.orchestrationEntries().map((entry) => entry.source), ["env"]);
		await current.pi.emit("session_start", { reason: "reload" });
		assert.equal(current.pi.orchestrationEntries().length, 1, "restore does not re-append");

		await current.pi.commands.get("orchestrate")!.handler("off", current.pi.ctx);
		await current.pi.emit("session_start", { reason: "reload" });
		assert.deepEqual(activeOrchestratorTools(current), []);
		assert.equal(current.pi.orchestrationEntries().length, 2);
	});

	it("reads the decision conversation-wide so /tree navigation cannot silently flip it", async () => {
		const current = await createHarness(0, { promoted: false });
		await current.pi.commands.get("orchestrate")!.handler("", current.pi.ctx);
		// Simulate /tree moving the leaf to an earlier point: the entry is no
		// longer on the active branch but remains in the session file.
		(current.pi.ctx as any).sessionManager.getBranch = () => [];
		await current.pi.emit("session_start", { reason: "reload" });
		assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
	});

	it("restores activation on reload/resume of the same session with a truthful watch warning", async () => {
		const current = await createHarness(0, {
			promoted: false,
			reason: "resume",
			sessionId: "session-a",
			entries: [
				{ type: "custom", customType: "pi-herdr-orchestration", data: { active: true, sessionId: "session-a", source: "command", at: "t" } },
			],
		});
		assert.deepEqual(activeOrchestratorTools(current), [...ORCHESTRATOR_TOOLS].sort());
		assert.equal(current.pi.orchestrationEntries().length, 1, "restore appends no entry");
		const warning = current.pi.notices.find((notice) => notice.level === "warning");
		assert.match(warning!.message, /restored for this session \(resume\): armed watches were NOT restored/u);
		const prompt = await injectedPrompt(current);
		assert.match(prompt!, /Orchestration was restored for this session \(resume\)/u);

		const notices = current.pi.notices.length;
		await current.pi.emit("session_start", { reason: "resume" });
		assert.equal(current.pi.notices.length, notices, "duplicate session_start does not re-notify");
	});

	it("CLI fork of an inactive parent suppresses env activation even without copied role entries", async () => {
		const current = await createHarness(0, { promoted: true, reason: "startup", parentSession: "/saved/inactive-parent.jsonl" });
		assert.deepEqual(activeOrchestratorTools(current), []);
		assert.equal(current.pi.orchestrationEntries().length, 0);
		assert.match(current.pi.notices.at(-1)!.message, /ignored for forks/);
	});

	it("a fork/clone carrying the parent's activation starts inactive and says so, even with env set", async () => {
		const current = await createHarness(0, {
			promoted: true,
			reason: "startup",
			sessionId: "session-child",
			entries: [
				{ type: "custom", customType: "pi-herdr-orchestration", data: { active: true, sessionId: "session-parent", source: "command", at: "t" } },
			],
		});
		assert.deepEqual(activeOrchestratorTools(current), []);
		assert.equal(await injectedPrompt(current), undefined);
		assert.match(current.pi.notices.at(-1)!.message, /forked\/cloned session: orchestration is inactive here \(PI_HERDR_ORCHESTRATOR=1 is ignored for forks\)/u);
		assert.equal(current.pi.orchestrationEntries().length, 1, "no entry appended for the child");

		await current.pi.commands.get("orchestrate")!.handler("", current.pi.ctx);
		assert.deepEqual(current.pi.orchestrationEntries().at(-1), {
			active: true, sessionId: "session-child", source: "command", at: current.pi.orchestrationEntries().at(-1)!.at,
		} as any);
	});

	it("ignores legacy routing configuration and exposes only orchestration and watches", async () => {
		const current = await createHarness(1, { promoted: false });
		// Even malformed legacy configuration cannot block activation or trigger reads.
		writeFileSync(join(current.dir, "herdr-routing.json"), "{ invalid legacy policy");
		await current.pi.commands.get("orchestrate")!.handler("", current.pi.ctx);
		assert.deepEqual(
			[...current.pi.tools.keys()].sort(),
			["codex_quota", "herdr_orchestrate", ...ORCHESTRATOR_TOOLS].sort(),
		);
		assert.deepEqual(
			[...current.pi.commands.keys()].sort(),
			["codex-quota", "orchestrate", "watches"],
		);
		assert.equal(current.pi.notices.at(-1)!.level, "info");
		const context = (await current.pi.emit("context", { messages: [] }))[0] as any;
		assert.deepEqual(context.messages, [], "no quota snapshot is injected");
		await current.pi.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "subscription quota exhausted" } });
		assert.deepEqual(current.pi.messages, [], "no quota messages are generated");
		const delivered = await arm(current);
		assert.equal(delivered.message.message.customType, "pi-herdr-watch");
	});
});

describe.sequential("herdr quota context hygiene", () => {
	const WARNING_TEXT =
		"astra: low; preserve orchestration capacity, shift suitable work, and tell the user if alternatives are constrained. Do not buy or enable another provider automatically.";

	/** A history shaped like an old session: persisted steer warnings plus lookalike traffic. */
	function oldHistory(): any[] {
		return [
			{ role: "user", content: WARNING_TEXT, timestamp: 1 },
			{ role: "custom", customType: "pi-herdr-quota-warning", content: `${WARNING_TEXT}\n5% left`, display: false, timestamp: 2 },
			{ role: "custom", customType: "pi-herdr-watch", content: "watch #1 fired", display: true, timestamp: 3 },
			{ role: "custom", customType: "pi-herdr-limits", content: "/limits output", display: true, timestamp: 4 },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "on it" }], timestamp: 5 },
			{ role: "custom", customType: "pi-herdr-quota-context", content: "stale snapshot", display: false, timestamp: 6 },
		];
	}

	const retained = (history: any[]): any[] =>
		history.filter(m => m.customType !== "pi-herdr-quota-warning" && m.customType !== "pi-herdr-quota-context");

	it("scrubs persisted quota messages without appending a snapshot while active", async () => {
		const current = await createHarness(0, { promoted: false });
		await current.pi.commands.get("orchestrate")!.handler("", current.pi.ctx);
		const history = oldHistory();
		const before = JSON.parse(JSON.stringify(history));
		const results = (await current.pi.emit("context", { messages: history })) as Array<{ messages?: any[] } | undefined>;
		const out = results.find(r => r?.messages)?.messages;
		assert.ok(out, "the active hook returns a message list");
		assert.equal(out.filter(m => m.customType === "pi-herdr-quota-warning").length, 0, "persisted warnings are gone");
		assert.equal(out.filter(m => m.customType === "pi-herdr-quota-context").length, 0, "no snapshot is appended");
		assert.deepEqual(out, retained(before), "identical-prose user text, watch and historical /limits messages are retained in order");
		assert.deepEqual(history, before, "the input history is not mutated");
	});

	it("still scrubs persisted quota messages without a snapshot when orchestration is off", async () => {
		const current = await createHarness(0, { promoted: false });
		const history = oldHistory();
		const before = JSON.parse(JSON.stringify(history));
		const results = (await current.pi.emit("context", { messages: history })) as Array<{ messages?: any[] } | undefined>;
		const out = results.find(r => r?.messages)?.messages;
		assert.ok(out, "the off hook filters instead of returning undefined");
		assert.deepEqual(out, retained(before), "warnings and snapshots are dropped; user, watch, /limits and assistant messages stay");
		assert.deepEqual(history, before, "the input history is not mutated");
	});

});

describe("codex_quota tool", () => {
	const QUOTA_BODY = {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 92,
			limit_window_seconds: 604800,
			reset_after_seconds: 158464,
		},
		secondary_window: null,
	};

	it("is registered as an always-available tool", async () => {
		const current = await createHarness(8, { promoted: false });
		assert.ok(current.pi.tools.has("codex_quota"));
		assert.ok(current.pi.tools.has("herdr_orchestrate"));
	});

	it("returns the quota snapshot as text and details", async () => {
		const current = await createHarness(8);
		const originalHome = process.env.HOME;
		const originalFetch = globalThis.fetch;
		mkdirSync(join(current.dir, ".codex"), { recursive: true });
		writeFileSync(
			join(current.dir, ".codex", "auth.json"),
			JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } }),
		);
		process.env.HOME = current.dir;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(QUOTA_BODY), { status: 200 })) as typeof fetch;
		try {
			const response = await current.pi.execute("codex_quota");
			assert.match(response.content[0].text, /^codex: ok — 92% of 7d used/u);
			assert.equal(response.details.allowed, true);
			assert.equal(response.details.primary.usedPercent, 92);
		} finally {
			globalThis.fetch = originalFetch;
			process.env.HOME = originalHome;
		}
	});

	it("surfaces a safe error when Codex CLI is not logged in", async () => {
		const current = await createHarness(8);
		const originalHome = process.env.HOME;
		process.env.HOME = current.dir; // no .codex/auth.json here
		try {
			await assert.rejects(
				() => current.pi.execute("codex_quota"),
				/codex login/u,
			);
		} finally {
			process.env.HOME = originalHome;
		}
	});
});
