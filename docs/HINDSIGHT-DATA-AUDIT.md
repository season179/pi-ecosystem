# Hindsight stage 1: data audit, backups and defect evidence

Completed 2026-09-26. This is a sanitized execution record for [stage 1 of the replacement plan](PI-HINDSIGHT-PLAN.md#1-back-up-audit-sources-and-reproduce-the-upstream-defect), not authorization for migration or implementation.

## Outcome

- Inventoried legacy file memories, the existing Hindsight bank, relevant configuration and host-session availability.
- Created a private local backup and successfully restored its database into an isolated, disposable PostgreSQL cluster.
- Reproduced the pinned official Pi adapter's history-replacement defect with synthetic data at the adapter-to-client boundary.
- No migration, integration fix, installation, source-permission/configuration change or live-service restart was performed. Existing automatic writers continued independently.

## Snapshot inventory

The database snapshot was exported at **2026-09-26 09:07:50 UTC**. File capture ran at **09:08:56–09:08:57 UTC**. These are historical counts, not the current live state.

| Source | Captured state |
| --- | --- |
| Legacy pi-memory files | 35 memories across 10 stores; 15 `always`, 20 on-demand |
| Hindsight | One bank, `pi-memory`; 297 documents and 847 memory units |
| Memory-unit types | 401 world facts, 156 experience facts, 290 observations |
| Curation | No invalidated units; initial inventory found no edited units |
| Mental models / Knowledge Pages | None at capture |
| Pi transcripts | 486 JSONL files |
| Claude transcripts | 243 JSONL files, including 213 top-level sessions |
| Source-session availability | All 16 bank-referenced Pi session IDs matched a backed-up file |

Matching session IDs confirms file availability only—not complete transcripts, original span coverage, safe replay or correct attribution. Those require content-level migration checks. Bank documents contain selected spans, not complete conversations; filesystem stores and the bank also cover different project sets. No Claude-origin memories were found in the bank during the audit.

The verified service is Hindsight **0.10.1**, using pg0-managed PostgreSQL **18.1** at port **5433**, separate from Homebrew PostgreSQL on **5432**. Extraction/consolidation uses an external LLM provider; a loopback API does not imply local inference.

## Private backup and integrity

Location: `~/.hindsight/backups/20260926T090722Z/` (approximately **702 MB**).

**Contains credentials and private conversations. Keep it local; do not upload, sync, commit or paste backup contents.** Directories are 0700, files 0600, with no symlinks or group/other permission bits detected.

- Custom-format dump of the intended `hindsight` database, using the matching pg0 PostgreSQL 18.1 tools. Live PGDATA and the unrelated Homebrew database were not copied.
- A read-only repeatable-read keeper transaction exported a snapshot. `pg_dump --snapshot` and the source count/schema queries used that same snapshot.
- Separate roles dump with no role passwords; role capture is not atomic with the database snapshot.
- Allowlisted legacy stores, Pi/Claude sessions, relevant settings, instruction files, Hindsight profile/service configuration and database-instance configuration.
- **997 copied files** passed source-before, copy, destination and source-after hash comparisons. A post-copy rescan found no new/deleted/changed files during that window.
- All **731 JSONL captures** ended at a complete newline; no incomplete tails were dropped.
- The coordinator independently verified **all 1,004 entries** in `manifests/SHA256SUMS`.

Copies used fixed capture lengths, no-follow opens and exclusive destinations. Stability during capture does not imply the sources stopped changing afterwards. Database, roles and files are separate points in time; the database snapshot contained one processing operation, and later live counts increased. This is not an atomic snapshot across all media.

The backup's private `REPORT.md`, manifests, scripts and restore logs provide detailed local evidence and offline inspection instructions. Live restoration is a separate, potentially destructive operation requiring review; this stage did not perform it.

## Restore verification

- Created a temporary PostgreSQL 18.1 cluster with a private Unix socket, **no TCP listener**, and no Hindsight API attached.
- Restored roles and the database with error-stop behavior.
- Matched **all 24 table counts**, schema fingerprint, 229 columns, migration version, extensions, bank/fact-type counts, operation statuses and maximum write timestamps against the exported source snapshot: **25,149 rows total**.
- Stopped the owned temporary cluster and removed only its disposable data directory. Live service listener PIDs were unchanged; private validation logs were preserved.

This demonstrates database archive restorability in that isolated environment. It does not establish safe live cutover, application-level replay compatibility or correctness of memory content.

## Official Pi adapter defect: executable evidence

Baseline: official integration **0.7.0**, Pi and agent-core **0.87.1**. Published and installed Pi bundles matched byte-for-byte. The local source baseline was commit `0c0869b7321c836d4f902d1f6ef8b5c8b432a2c4`; no online latest-version claim is made.

The offline fixture executes the installed agent loop and actual upstream hook/runtime/cursor/session-writing logic against strict mocks. It verifies:

- The second run sees earlier context, but `agent_end.messages` contains only that run's two messages.
- Two runs in the same session produce replacement-path submissions for the same conversation document; the second payload omits the first run.
- Cumulative-input, unchanged-replay, append-disabled and new-session controls behave as expected.
- Source, published-bundle and installed-bundle baselines all expose the expected cumulative-history invariant failure.

The coordinator reran both modes: the diagnostic suite passed (**exit 0**); asserting the desired history invariant failed deliberately (**exit 1**). No adapter fix was applied.

**Coverage boundary:** real host registration/dispatch and HTTP serialization remain source-inspected; server replacement storage is modeled. This is an executable adapter-boundary reproduction, not a live-server extraction/deletion test. Resume, compaction, concurrency and cancellation require separate implementation regression coverage.

The original private fixture is `/tmp/hindsight-retain-repro/`; the durable backup's evidence section preserves the fixture and provenance. Rerunning it requires its hash-pinned source/installed artifact paths; the archive is not claimed to be a standalone portable test package.

## Findings requiring later decisions

1. The source pg0 `instance.json` contains a database superuser password and is **0644 under traversable directories**. It remains unchanged. Recommend owner-only permissions under a separately approved repair.
2. Claude's transcript cleanup setting is unset, leaving its 30-day default. **17 older Claude JSONL files are now backed up**, but future cleanup policy remains undecided.
3. The official Claude integration still has automatic history ingestion, codebase survey, bank/page management and runtime-update defaults. Review their scope, privacy and cost before normal-session testing. The audit worker used Claude safe mode with auto permission review to avoid hook side effects.
4. Global/cross-project routing, source-content completeness, redaction before replay and migration reconciliation remain open. No migration or replacement implementation has begun.
