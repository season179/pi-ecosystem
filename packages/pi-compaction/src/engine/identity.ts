import { createHash, randomBytes } from "node:crypto";

/** Stable short hash of any JSON-serializable value, for fingerprints and opaque ids. */
export function fingerprint(value: unknown, length = 16): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, length);
}

export function newPassId(): string {
	return `p${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
