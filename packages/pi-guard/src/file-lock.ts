import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 15_000;
const FORCE_STALE_MS = 10 * 60 * 1000;

interface LockRecord {
	pid: number;
	token: string;
	createdAt: number;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function removeStaleLock(path: string): Promise<void> {
	let raw: string;
	let mtimeMs: number;
	try {
		const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		raw = content;
		mtimeMs = info.mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let record: Partial<LockRecord>;
	try {
		record = JSON.parse(raw) as Partial<LockRecord>;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		// A live owner can be observed between open(wx) and write. If the
		// incomplete record survives beyond that tiny window, its owner crashed.
		if (Date.now() - mtimeMs > 1000) await unlink(path);
		return;
	}
	const oldEnough = Date.now() - mtimeMs > FORCE_STALE_MS;
	const ownerDead =
		typeof record.pid !== "number" ||
		!Number.isInteger(record.pid) ||
		record.pid <= 0 ||
		!processIsAlive(record.pid);
	if (ownerDead || oldEnough) await unlink(path);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cross-process advisory lock with stale-owner recovery and token-safe release. */
export async function withFileLock<T>(
	path: string,
	operation: () => Promise<T>,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const token = randomBytes(16).toString("hex");
	const deadline = Date.now() + timeoutMs;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	for (;;) {
		try {
			const candidate = await open(path, "wx", 0o600);
			try {
				await candidate.writeFile(
					JSON.stringify({ pid: process.pid, token, createdAt: Date.now() } satisfies LockRecord),
				);
				handle = candidate;
				break;
			} catch (error) {
				await candidate.close();
				await unlink(path).catch(() => {});
				throw error;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await removeStaleLock(path);
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for Pi Guard storage lock: ${path}`);
			}
			await sleep(RETRY_MS);
		}
	}

	try {
		return await operation();
	} finally {
		await handle.close();
		try {
			const record = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
			if (record.token === token) await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
