import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
	mutateMemoryStore,
	parseDetails,
	parseIndex,
	searchMemories,
	serializeDetails,
	serializeIndex,
	type Memory,
} from "../src/store.js";

const memories: Memory[] = [
	{
		id: "m_aaaaaaaaaa",
		title: "Graph | preferences",
		updated: "2026-08-01T10:00:00.000Z",
		tags: ["graph, db", "C:\\notes"],
		cue: "When a graph | database is discussed",
		body: "Prefer Memgraph.\n\n## Notes\nKeep queries concise.\n## m_bbbbbbbbbb — body heading",
	},
];

describe("memory store", () => {
	it("round-trips the details and index formats", () => {
		assert.deepEqual(parseDetails(serializeDetails(memories)), memories);
		assert.deepEqual(parseIndex(serializeIndex(memories)), memories.map(({ body: _body, ...memory }) => memory));
	});

	it("ranks exact matches, word overlap, and recency", () => {
		const candidates: Memory[] = [
			...memories,
			{
				id: "m_cccccccccc",
				title: "Graph cache",
				updated: "2026-08-03T10:00:00.000Z",
				tags: ["cache"],
				cue: "Graph cache tuning",
				body: "newer",
			},
			{
				id: "m_dddddddddd",
				title: "Other",
				updated: "2026-08-04T10:00:00.000Z",
				tags: ["graph"],
				cue: "General lookup",
				body: "newest",
			},
		];
		assert.equal(searchMemories(candidates, "Graph | preferences")[0]?.id, "m_aaaaaaaaaa");
		assert.equal(searchMemories(candidates, "graph cache")[0]?.id, "m_cccccccccc");
		assert.equal(searchMemories(candidates, "")[0]?.id, "m_dddddddddd");
	});

	it("refuses a mutation over the token cap without writing files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
		try {
			await assert.rejects(
				mutateMemoryStore(
					directory,
					{ action: "create", title: "Huge", cue: "Always", body: "x".repeat(17_000) },
					{ now: "2026-08-05T10:00:00.000Z", idFactory: () => "m_aaaaaaaaaa" },
				),
				/current 0, projected .*oldest: m_aaaaaaaaaa.*largest: m_aaaaaaaaaa/,
			);
			await assert.rejects(readFile(join(directory, "details.md"), "utf8"), { code: "ENOENT" });
			await assert.rejects(readFile(join(directory, "index.md"), "utf8"), { code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
