import process from "node:process";
import { pathToFileURL } from "node:url";

function fail(error) {
	const failure = error instanceof Error
		? { name: error.name, message: error.message, stack: error.stack }
		: { name: "Error", message: String(error) };
	if (process.connected) {
		process.send?.({ type: "failed", error: failure }, () => process.disconnect());
	}
	process.exitCode = 1;
}

const [storeModulePath, directory, workerNumberText, idsJson] = process.argv.slice(2);
if (!storeModulePath || !directory || !workerNumberText || !idsJson || typeof process.send !== "function") {
	fail(new Error("concurrent-create-worker requires an IPC channel and module, directory, worker number, and ids"));
} else {
	try {
		const store = await import(pathToFileURL(storeModulePath).href);
		const { mutateMemoryStore, readMemorySnapshot } = store;
		if (typeof mutateMemoryStore !== "function" || typeof readMemorySnapshot !== "function") {
			throw new Error(
				"built store module does not expose the hardened mutation/snapshot API; run the pi-memory build before this test",
			);
		}
		const workerNumber = Number(workerNumberText);
		const ids = JSON.parse(idsJson);
		if (!Number.isInteger(workerNumber) || !Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
			throw new Error("invalid worker arguments");
		}

		process.send({ type: "ready", workerNumber });
		await new Promise((resolve, reject) => {
			const onMessage = (message) => {
				if (message?.type !== "go") return;
				process.off("message", onMessage);
				process.off("disconnect", onDisconnect);
				resolve();
			};
			const onDisconnect = () => {
				process.off("message", onMessage);
				reject(new Error("parent disconnected before barrier release"));
			};
			process.on("message", onMessage);
			process.once("disconnect", onDisconnect);
		});

		const acknowledged = [];
		for (let createNumber = 0; createNumber < ids.length; createNumber += 1) {
			const expectedId = ids[createNumber];
			const result = await mutateMemoryStore(
				directory,
				{
					action: "create",
					title: `worker ${workerNumber} create ${createNumber}`,
					cue: `concurrency-${workerNumber}-${createNumber}`,
					body: `acknowledged by worker ${workerNumber}, create ${createNumber}`,
					tags: ["concurrency", `worker:${workerNumber}`],
				},
				{
					now: new Date(Date.UTC(2026, 0, 1, 0, workerNumber, createNumber)).toISOString(),
					idFactory: () => expectedId,
				},
			);
			const actualId = result.memory?.id;
			if (actualId !== expectedId) {
				throw new Error(`create returned ${String(actualId)}; expected ${expectedId}`);
			}
			acknowledged.push(actualId);
		}
		await new Promise((resolve, reject) => {
			process.send({ type: "done", workerNumber, acknowledged }, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
		process.disconnect();
	} catch (error) {
		fail(error);
	}
}
