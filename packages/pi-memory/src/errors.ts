export type MemoryErrorCode =
	| "BUSY"
	| "LOCK_UNSAFE"
	| "STORE_CORRUPT"
	| "DUPLICATE_ID"
	| "ID_EXHAUSTED"
	| "CAP_EXCEEDED"
	| "INJECTION_BUDGET_EXCEEDED"
	| "NOT_FOUND"
	| "INVALID_ARGUMENT"
	| "READ_ONLY"
	| "PATH_UNSAFE"
	| "IDENTITY_MISMATCH"
	| "CONFIG_INVALID"
	| "COMMIT_STATE_UNKNOWN"
	| "IO";

export type MemoryOperation = "read" | "mutate" | "repair" | "lock" | "config" | "migrate";

export interface MemoryErrorOptions {
	operation: MemoryOperation;
	path?: string;
	retryable?: boolean;
	committed?: boolean | "unknown";
	cause?: unknown;
}

export class MemoryError extends Error {
	readonly code: MemoryErrorCode;
	readonly operation: MemoryOperation;
	readonly path?: string;
	readonly retryable: boolean;
	readonly committed: boolean | "unknown";

	constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "MemoryError";
		this.code = code;
		this.operation = options.operation;
		if (options.path !== undefined) this.path = options.path;
		this.retryable = options.retryable ?? code === "BUSY";
		this.committed = options.committed ?? false;
	}
}

export function isMemoryError(error: unknown): error is MemoryError {
	return error instanceof MemoryError;
}

const NEXT_STEPS: Record<MemoryErrorCode, string> = {
	BUSY: "Another Pi process is using this memory store; retry shortly",
	LOCK_UNSAFE:
		"Inspect the lock directory and its owner.json; stop all Pi processes that may own it before removing anything manually",
	STORE_CORRUPT: "Inspect and repair details.md manually; the store files were left untouched",
	DUPLICATE_ID: "Edit details.md so every memory id appears exactly once, then retry",
	ID_EXHAUSTED: "Retry the create; if it persists, check the id factory or randomness source",
	CAP_EXCEEDED: "Delete or consolidate existing memories, then retry",
	INJECTION_BUDGET_EXCEEDED:
		"Demote memories with remember update injection=on-demand, shrink their bodies, or delete them; run /pi-memory status to see the always block usage",
	NOT_FOUND: "Use recall to list current memory ids in this store",
	INVALID_ARGUMENT: "Fix the arguments and retry",
	READ_ONLY: "Project memory is read-only in this mode; switch to read-write to mutate it",
	PATH_UNSAFE: "Refusing to touch this path; remove the symlink or unexpected file type manually",
	IDENTITY_MISMATCH: "The project sidecar does not match this repository; run /pi-memory status for details",
	CONFIG_INVALID: "Repair config.json by hand; it is never overwritten while invalid",
	COMMIT_STATE_UNKNOWN: "Verify the store with recall before retrying; the mutation may or may not have committed",
	IO: "Check filesystem permissions and free space, then retry",
};

export function formatMemoryError(error: unknown): string {
	const memoryError = isMemoryError(error) ? error : undefined;
	const code = memoryError?.code ?? "IO";
	const rawMessage =
		memoryError?.message ?? (error instanceof Error ? error.message : String(error));
	const cause = rawMessage.replace(/[.\s]+$/, "");
	return `[PI_MEMORY_${code}] ${cause}. ${NEXT_STEPS[code]}.`;
}
