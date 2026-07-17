import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withFileLock } from "./file-lock.js";

export type AuditOutcome = "allowed" | "blocked" | "error" | "restored";

export interface AuditRecord {
	at: string;
	tool: string;
	outcome: AuditOutcome;
	fingerprint?: string;
	summary: string;
	reason?: string;
	snapshotId?: string;
	cwd: string;
}

export class AuditLog {
	readonly path: string;
	private operation = Promise.resolve();

	constructor(
		path = join(getAgentDir(), "pi-guard", "audit.jsonl"),
		private readonly maxBytes = 10 * 1024 * 1024,
		private readonly retainedBytes = 5 * 1024 * 1024,
	) {
		this.path = path;
	}

	private async serialized<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.operation;
		let release!: () => void;
		this.operation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await withFileLock(`${this.path}.lock`, operation);
		} finally {
			release();
		}
	}

	private async compactUnlocked(): Promise<void> {
		let size: number;
		try {
			size = (await stat(this.path)).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (size <= this.maxBytes) return;
		const content = await readFile(this.path);
		let retained = content.subarray(Math.max(0, content.length - this.retainedBytes));
		const firstNewline = retained.indexOf(0x0a);
		if (firstNewline >= 0 && content.length > retained.length) {
			retained = retained.subarray(firstNewline + 1);
		}
		const temporary = `${this.path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
		await writeFile(temporary, retained, { mode: 0o600, flag: "wx" });
		try {
			await rename(temporary, this.path);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}

	async append(record: Omit<AuditRecord, "at"> & { at?: string }): Promise<void> {
		return this.serialized(async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const handle = await open(this.path, "a", 0o600);
			try {
				await handle.appendFile(
					`${JSON.stringify({ ...record, at: record.at ?? new Date().toISOString() })}\n`,
				);
			} finally {
				await handle.close();
			}
			await this.compactUnlocked();
		});
	}

	async tail(limit = 20): Promise<AuditRecord[]> {
		return this.serialized(async () => {
			try {
				const text = await readFile(this.path, "utf8");
				return text
					.trim()
					.split("\n")
					.filter(Boolean)
					.slice(-Math.max(1, limit))
					.map((line) => JSON.parse(line) as AuditRecord);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		});
	}
}
