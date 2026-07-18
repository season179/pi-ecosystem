export interface WatchdogEntry {
	id?: string;
}

export interface WatchdogSnapshot<TEntry extends WatchdogEntry> {
	generation: number;
	revision: number;
	leafId?: string;
	entries: readonly TEntry[];
}

export type WatchdogRevalidation<T> =
	| { decision: "resolved" }
	| { decision: "confirm"; candidate: T }
	| { decision: "replace"; candidate: T };

export type WatchdogCommitResult<T, TEntry extends WatchdogEntry> =
	| { status: "none" }
	| { status: "deferred"; reason: "activity" | "tool_in_flight" | "commit_in_flight" }
	| {
		status: "suppressed";
		reason: "resolved";
		snapshot: WatchdogSnapshot<TEntry>;
		revalidationCount: number;
	  }
	| {
		status: "deliver";
		candidate: T;
		snapshot: WatchdogSnapshot<TEntry>;
		revalidationCount: number;
	  };

interface PendingCandidate<T, TEntry extends WatchdogEntry> {
	snapshot: WatchdogSnapshot<TEntry>;
	candidate: T;
	revalidationCount: number;
}

/**
 * Framework-neutral coordination of detached review and current-state publication.
 * Candidates never leave this module without a current-state commit check.
 */
export class WatchdogCoordinator<
	T,
	TEntry extends WatchdogEntry,
> {
	private generation = 0;
	private revision = 0;
	private pending?: PendingCandidate<T, TEntry>;
	private readonly inFlightTools = new Set<string>();
	private committing = false;

	get hasPending(): boolean {
		return this.pending !== undefined;
	}

	capture(entries: readonly TEntry[]): WatchdogSnapshot<TEntry> {
		return {
			generation: this.generation,
			revision: this.revision,
			leafId: entries.at(-1)?.id,
			entries: [...entries],
		};
	}

	stage(snapshot: WatchdogSnapshot<TEntry>, candidate: T): boolean {
		if (
			snapshot.generation !== this.generation ||
			this.pending !== undefined ||
			this.committing
		) {
			return false;
		}
		this.pending = { snapshot, candidate, revalidationCount: 0 };
		return true;
	}

	noteActivity(): void {
		this.revision += 1;
	}

	toolStarted(toolCallId: string): void {
		this.inFlightTools.add(toolCallId);
		this.noteActivity();
	}

	toolEnded(toolCallId: string): void {
		this.inFlightTools.delete(toolCallId);
		this.noteActivity();
	}

	invalidate(): void {
		this.generation += 1;
		this.revision += 1;
		this.pending = undefined;
		this.inFlightTools.clear();
	}

	async commit(
		entries: readonly TEntry[],
		revalidate: (
			candidate: T,
			snapshot: WatchdogSnapshot<TEntry>,
			revalidationCount: number,
		) => Promise<WatchdogRevalidation<T>>,
		publish?: (
			candidate: T,
			snapshot: WatchdogSnapshot<TEntry>,
			revalidationCount: number,
		) => void,
	): Promise<WatchdogCommitResult<T, TEntry>> {
		const pending = this.pending;
		if (!pending) return { status: "none" };
		if (this.committing) {
			return { status: "deferred", reason: "commit_in_flight" };
		}
		if (this.inFlightTools.size > 0) {
			return { status: "deferred", reason: "tool_in_flight" };
		}

		const snapshot = this.capture(entries);
		pending.revalidationCount += 1;
		const revalidationCount = pending.revalidationCount;
		this.committing = true;
		try {
			const verdict = await revalidate(
				pending.candidate,
				snapshot,
				revalidationCount,
			);
			if (
				this.generation !== snapshot.generation ||
				this.revision !== snapshot.revision
			) {
				return { status: "deferred", reason: "activity" };
			}
			if (verdict.decision === "resolved") {
				this.pending = undefined;
				return {
					status: "suppressed",
					reason: "resolved",
					snapshot,
					revalidationCount,
				};
			}
			// Publication runs in the same synchronous continuation as the final
			// revision check. Callers must not await before their send boundary.
			publish?.(verdict.candidate, snapshot, revalidationCount);
			this.pending = undefined;
			return {
				status: "deliver",
				candidate: verdict.candidate,
				snapshot,
				revalidationCount,
			};
		} finally {
			this.committing = false;
		}
	}
}
