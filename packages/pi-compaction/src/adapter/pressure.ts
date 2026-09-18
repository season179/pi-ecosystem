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
		const usage = entry.message.usage;
		if (!usage) continue;
		const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (total > 0) return entry.id;
	}
	return undefined;
}

/** Fingerprint of what a scoring pass would ask about; unchanged input means no fresh evidence. */
export function passFingerprint(candidateIds: readonly string[], configFingerprint: string): string {
	return fingerprint({ candidates: [...candidateIds].sort(), config: configFingerprint });
}
