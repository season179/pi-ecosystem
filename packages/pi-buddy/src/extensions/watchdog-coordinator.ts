import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	WatchdogCoordinator as CoreWatchdogCoordinator,
	type WatchdogCommitResult as CoreWatchdogCommitResult,
	type WatchdogRevalidation as CoreWatchdogRevalidation,
	type WatchdogSnapshot as CoreWatchdogSnapshot,
} from "./watchdog-coordinator-core.js";

/** Pi-compatible public types retained for existing deep-module consumers. */
export type WatchdogSnapshot = CoreWatchdogSnapshot<SessionEntry>;
export type WatchdogRevalidation<T> = CoreWatchdogRevalidation<T>;
export type WatchdogCommitResult<T> = CoreWatchdogCommitResult<T, SessionEntry>;

/** Binds the framework-neutral coordinator to Pi's SessionEntry contract. */
export class WatchdogCoordinator<T> extends CoreWatchdogCoordinator<
	T,
	SessionEntry
> {}
