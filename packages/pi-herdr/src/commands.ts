/**
 * `/watches` slash command: an interactive picker over the watch list for
 * Season (the human). The model-facing equivalent is the `herdr_watches`
 * tool; this command adds a kill picker on top.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatWatchLine } from "./render.js";
import type { WatchRecordPublic } from "./types.js";

export interface WatchCommandDeps {
	list(): WatchRecordPublic[];
	stop(id: number | "all"): Promise<WatchRecordPublic[]>;
}

const STOP_ALL_ROW = "stop ALL armed watches";
const CLOSE_ROW = "close";

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerWatchesCommand(pi: ExtensionAPI, deps: WatchCommandDeps): void {
	pi.registerCommand("watches", {
		description: "List and manage herdr watches",
		handler: async (_args, ctx) => {
			// No UI surface in print mode — nothing to select (mirrors pi-buddy).
			if (!ctx.hasUI) return;
			const records = deps.list();
			if (records.length === 0) {
				ctx.ui.notify("no herdr watches", "info");
				return;
			}
			const now = Date.now();
			const rows = records.map((record) => formatWatchLine(record, now));
			const choice = await ctx.ui.select("herdr watches:", [
				...rows,
				STOP_ALL_ROW,
				CLOSE_ROW,
			]);
			if (!choice || choice === CLOSE_ROW) return;
			if (choice === STOP_ALL_ROW) {
				const ok = await ctx.ui.confirm(
					"Stop all watches?",
					"This kills every armed herdr watch.",
				);
				if (!ok) return;
				try {
					const stopped = await deps.stop("all");
					ctx.ui.notify(
						`stopped ${stopped.length} watch${stopped.length === 1 ? "" : "es"}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`failed to stop watches: ${errorToString(error)}`, "error");
				}
				return;
			}
			const index = rows.indexOf(choice);
			const record = index >= 0 ? records[index] : undefined;
			if (!record) return;
			if (record.status !== "armed") {
				// History peek: fired/stopped rows just echo their line.
				ctx.ui.notify(choice, "info");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Stop watch?",
				`Kill watch #${record.id} ("${record.spec.target}")?`,
			);
			if (!ok) return;
			try {
				await deps.stop(record.id);
				ctx.ui.notify(`stopped watch #${record.id}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`failed to stop watch #${record.id}: ${errorToString(error)}`,
					"error",
				);
			}
		},
	});
}
