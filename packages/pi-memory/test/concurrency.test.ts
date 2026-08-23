import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import { parseDetails, serializeIndex } from "../src/store.js";

const WORKER_COUNT = 10;
const CREATES_PER_WORKER = 5;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const workerPath = fileURLToPath(new URL("./helpers/concurrent-create-worker.mjs", import.meta.url));
const builtStorePath = fileURLToPath(new URL("../dist/store.js", import.meta.url));

function memoryId(number: number): string {
	let value = number;
	let suffix = "";
	for (let index = 0; index < 10; index += 1) {
		suffix = BASE32[value & 31] + suffix;
		value = Math.floor(value / 32);
	}
	return `m_${suffix}`;
}

interface WorkerState {
	child: ChildProcess;
	workerNumber: number;
	ids: string[];
	ready: boolean;
	done: boolean;
	exited: boolean;
	acknowledged: string[];
	output: string;
}

function diagnostics(states: readonly WorkerState[]): string {
	return states
		.map(
			(state) =>
				`worker ${state.workerNumber}: ready=${state.ready} done=${state.done} exited=${state.exited} exit=${String(state.child.exitCode)} signal=${String(state.child.signalCode)}\n${state.output}`,
		)
		.join("\n");
}

async function runBarrierCreates(directory: string): Promise<string[]> {
	const states: WorkerState[] = [];
	const allReady = Promise.withResolvers<void>();
	const allDone = Promise.withResolvers<void>();
	// Both promises may be rejected before the harness reaches the corresponding await.
	void allReady.promise.catch(() => undefined);
	void allDone.promise.catch(() => undefined);
	let settled = false;

	const reject = (error: unknown) => {
		if (settled) return;
		settled = true;
		const detail = diagnostics(states);
		const wrapped = error instanceof Error ? error : new Error(String(error));
		wrapped.message = `${wrapped.message}\n${detail}`;
		allReady.reject(wrapped);
		allDone.reject(wrapped);
	};

	for (let workerNumber = 0; workerNumber < WORKER_COUNT; workerNumber += 1) {
		const ids = Array.from({ length: CREATES_PER_WORKER }, (_, createNumber) =>
			memoryId(workerNumber * CREATES_PER_WORKER + createNumber),
		);
		const child = fork(workerPath, [builtStorePath, directory, String(workerNumber), JSON.stringify(ids)], {
			execArgv: [],
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		const state: WorkerState = {
			child,
			workerNumber,
			ids,
			ready: false,
			done: false,
			exited: false,
			acknowledged: [],
			output: "",
		};
		states.push(state);
		child.stdout?.on("data", (chunk) => (state.output += String(chunk)));
		child.stderr?.on("data", (chunk) => (state.output += String(chunk)));
		child.on("error", reject);
		child.on("message", (message: unknown) => {
			if (!message || typeof message !== "object") return;
			const event = message as { type?: string; acknowledged?: unknown; error?: { message?: string; stack?: string } };
			if (event.type === "failed") {
				reject(new Error(event.error?.stack ?? event.error?.message ?? `worker ${workerNumber} failed`));
				return;
			}
			if (event.type === "ready") {
				state.ready = true;
				if (states.length === WORKER_COUNT && states.every((candidate) => candidate.ready)) allReady.resolve();
				return;
			}
			if (event.type === "done") {
				if (!Array.isArray(event.acknowledged) || event.acknowledged.some((id) => typeof id !== "string")) {
					reject(new Error(`worker ${workerNumber} returned invalid acknowledgements`));
					return;
				}
				state.acknowledged = event.acknowledged as string[];
				state.done = true;
				if (states.every((candidate) => candidate.done)) allDone.resolve();
			}
		});
		child.on("exit", (code, signal) => {
			state.exited = true;
			if (!state.done || code !== 0) {
				reject(new Error(`worker ${workerNumber} exited before acknowledging all creates (code ${String(code)}, signal ${String(signal)})`));
			}
		});
	}

	const timeout = setTimeout(() => reject(new Error("multiprocess create barrier exceeded 30 seconds")), 30_000);
	try {
		await allReady.promise;
		for (const state of states) state.child.send({ type: "go" });
		await allDone.promise;
		settled = true;
		await Promise.all(
			states.map(
				(state) =>
					new Promise<void>((resolve, rejectExit) => {
						if (state.exited) {
							state.child.exitCode === 0 ? resolve() : rejectExit(new Error(`worker ${state.workerNumber} exited ${state.child.exitCode}`));
							return;
						}
						state.child.once("exit", (code, signal) =>
							code === 0 ? resolve() : rejectExit(new Error(`worker ${state.workerNumber} exited ${String(code)} (${String(signal)})`)),
						);
					}),
			),
		);
		return states.flatMap((state) => state.acknowledged);
	} finally {
		clearTimeout(timeout);
		for (const state of states) {
			if (!state.exited) state.child.kill("SIGKILL");
		}
		await Promise.all(
			states.map((state) =>
				state.exited ? Promise.resolve() : new Promise<void>((resolve) => state.child.once("exit", () => resolve())),
			),
		);
	}
}

const temporaryDirectories = new Set<string>();

afterEach(async () => {
	await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryDirectories.clear();
});

describe("memory store multiprocess concurrency", () => {
	it(
		"does not lose acknowledged creates and leaves the exact derived index",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-memory-concurrency-"));
			temporaryDirectories.add(root);
			const directory = join(root, "store");

			const acknowledged = await runBarrierCreates(directory);
			const expectedIds = Array.from({ length: WORKER_COUNT * CREATES_PER_WORKER }, (_, index) => memoryId(index));
			assert.equal(acknowledged.length, expectedIds.length);
			assert.deepEqual([...new Set(acknowledged)].sort(), [...expectedIds].sort());

			const details = await readFile(join(directory, "details.md"), "utf8");
			const memories = parseDetails(details);
			assert.equal(memories.length, expectedIds.length);
			assert.deepEqual(
				memories.map((memory) => memory.id).sort(),
				[...expectedIds].sort(),
			);
			assert.equal(await readFile(join(directory, "index.md"), "utf8"), serializeIndex(memories));

			const entries = await readdir(directory);
			assert.equal(entries.includes(".pi-memory-mutation.lock"), false, `live lock leaked: ${entries.join(", ")}`);
			assert.deepEqual(
				entries.filter((entry) => entry.endsWith(".tmp") || entry.includes(".released.")),
				[],
				`transaction residue leaked: ${entries.join(", ")}`,
			);
		},
		40_000,
	);
});
