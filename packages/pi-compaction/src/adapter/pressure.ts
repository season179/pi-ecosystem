import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fingerprint } from "../engine/identity.js";

/**
 * Identity of the provider-usage observation Pi's compaction checks are based on: the
 * newest assistant message on the branch that carries non-zero usage. A pass committed
 * while this observation is current is fresh evidence until a newer observation arrives.
 */
export function currentObservationId(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		// Same rule as Pi's getAssistantUsage: aborted, errored and all-zero usage carry no observation.
		if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") continue;
		const usage = entry.message.usage;
		if (!usage) continue;
		const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (total > 0) return entry.id;
	}
	return undefined;
}

/** Fingerprint of what a scoring pass would ask about; unchanged input means no fresh evidence. */
export function passFingerprint(candidateIds: readonly string[], configFingerprint: string, modelKey: string): string {
	return fingerprint({ candidates: [...candidateIds].sort(), config: configFingerprint, model: modelKey });
}

/** Whether a branch position can still grow into a new sibling: it already has children. */
export function hasChildren(entries: readonly SessionEntry[], entryId: string | null): boolean {
	if (entryId === null) return false;
	return entries.some((entry) => entry.parentId === entryId);
}
