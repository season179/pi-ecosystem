import assert from "node:assert/strict";
import {
	mkdtempSync,
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

class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	readonly commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
	readonly messages: Array<{ message: any; options: any }> = [];
	readonly statuses: Array<string | undefined> = [];
	private activeTools: string[] = [];

	readonly ctx = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				this.statuses.push(value);
			},
			notify: () => undefined,
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

	async emit(event: string, fields: Record<string, unknown> = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler({ type: event, ...fields }, this.ctx);
		}
	}

	async execute(name: string, params: Record<string, unknown> = {}): Promise<any> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`missing tool ${name}`);
		return tool.execute("call-1", params);
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
	options: { promoted?: boolean; notificationDelayMs?: number } = {},
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
	herdrExtension(pi as unknown as ExtensionAPI);
	await pi.emit("session_start");
	harness = { pi, dir, telemetryPath, notificationPath };
	return harness;
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
