import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, link, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

export const TELEMETRY_KINDS = ["session", "pass", "request", "summary", "recall", "restore", "mode", "feedback", "error"] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];
export const TELEMETRY_REASONS = [
  "threshold", "manual", "overflow", "recent", "pinned", "instruction", "incomplete", "ambiguous",
  "multimodal", "provider_atomic", "unmapped", "unsupported", "secret", "budget", "headroom",
  "no_candidates", "disabled", "not_configured", "stale", "cancelled", "timeout", "rate_limit",
  "network", "invalid_response", "storage", "unknown_accounting", "insufficient_reduction",
  "duplicate_observation", "error", "user_request", "bad_prune", "other",
] as const;
export type ReasonCode = (typeof TELEMETRY_REASONS)[number];
const OUTCOMES = ["started", "ended", "completed", "committed", "skipped", "cancelled", "failed", "enabled", "disabled", "bad_prune", "helpful", "neutral"] as const;
const MEASURES = [
  "turn", "candidates", "eligible", "kept", "dropped", "replaced", "excluded",
  "contextBeforeTokensEstimate", "contextAfterTokensEstimate", "contextTokensMeasured",
  "contextFractionMeasured", "latencyMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
] as const;
type Measure = (typeof MEASURES)[number];
export type TelemetryMeasures = Partial<Record<Measure, number>>;
const RATE_KEYS = ["inputPerMillionUsd", "outputPerMillionUsd", "cacheReadPerMillionUsd", "cacheWritePerMillionUsd"] as const;
export type TelemetryPrices = Partial<Record<(typeof RATE_KEYS)[number], number>> & {
  source: "provider_api_rates" | "configured_api_rates";
};
export interface TelemetryCandidate {
  id: string;
  decision: "keep" | "drop" | "replace" | "exclude";
  reason?: ReasonCode;
  estimatedTokens?: number;
  callProbability?: number;
  resultProbability?: number;
}
export interface TelemetryInput {
  kind: TelemetryKind;
  /** A stable opaque, branch-specific ID, never a session path. */
  sessionId: string;
  timestamp?: number;
  passId?: string;
  model?: string;
  modelVersion?: string;
  provider?: string;
  configFingerprint?: string;
  /** Numeric CalVer, for example 26.9.0. */
  version?: string;
  mode?: "on" | "off";
  outcome?: (typeof OUTCOMES)[number];
  role?: "coding" | "scoring";
  reason?: ReasonCode;
  reasons?: Partial<Record<ReasonCode, number>>;
  fallback?: boolean;
  measures?: TelemetryMeasures;
  prices?: TelemetryPrices;
  candidates?: TelemetryCandidate[];
}
export interface TelemetryOptions {
  retentionDays?: number;
  maxBytes?: number;
  maxEvents?: number;
  now?: () => number;
}
export interface TelemetryExportResult {
  available: boolean;
  exportedEvents: number;
  reason?: "storage_unavailable" | "destination_unavailable";
}
interface StoredEvent extends TelemetryInput {
  schema: 1;
  eventId: string;
  timestamp: number;
}
type Bag = Record<string, unknown>;
type Identity = { dev: number; ino: number };
interface OwnedFile { name: string; timestamp: number; size: number; pending: boolean }
interface Snapshot { events: StoredEvent[]; skipped: number; trimmed: number }
const DAY = 86_400_000;
const MAX_EVENT_BYTES = 16_384;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const EVENT_FILE = new RegExp(`^(\\d{13})-(${UUID})\\.jsonl$`);
const PENDING_FILE = new RegExp(`^\\.(${UUID})\\.pending$`);
const HASH = /^h_[0-9a-f]{64}$/;
const ID_KEYS = ["passId", "model", "modelVersion", "provider", "configFingerprint"] as const;
const bag = (value: unknown): Bag => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Bag : {};
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function number(value: unknown, max = 1e12, integer = false): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max && (!integer || Number.isSafeInteger(value));
}
function limit(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}
function label(value: unknown, domain: string, stored: boolean): string | undefined {
  if (typeof value !== "string") return;
  if (stored) return HASH.test(value) ? value : undefined;
  // Only bounded identifier-shaped input is accepted, and even that is never persisted verbatim.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,255}$/.test(value)) return;
  return `h_${createHash("sha256").update(`pi-compaction:${domain}:`).update(value).digest("hex")}`;
}

/** Construct from scratch, including on read/export. Unknown keys and free text never survive. */
function sanitize(value: unknown, now: number, stored = false): StoredEvent | undefined {
  const input = bag(value);
  if (!member(input.kind, TELEMETRY_KINDS)) return;
  const sessionId = label(input.sessionId, "sessionId", stored);
  if (!sessionId) return;
  const timestamp = input.timestamp === undefined && !stored ? now : input.timestamp;
  if (!number(timestamp, Math.min(9_999_999_999_999, now + 60_000), true)) return;
  if (stored && (input.schema !== 1 || typeof input.eventId !== "string" || !new RegExp(`^${UUID}$`).test(input.eventId))) return;
  const result: StoredEvent = {
    schema: 1, eventId: stored ? input.eventId as string : randomUUID(), kind: input.kind, sessionId, timestamp,
  };
  for (const key of ID_KEYS) {
    const safe = label(input[key], key, stored);
    if (safe) result[key] = safe;
  }
  if (typeof input.version === "string" && /^\d{2}\.(?:[1-9]|1[0-2])\.\d{1,6}$/.test(input.version)) result.version = input.version;
  if (member(input.mode, ["on", "off"])) result.mode = input.mode;
  if (member(input.outcome, OUTCOMES)) result.outcome = input.outcome;
  if (member(input.role, ["coding", "scoring"])) result.role = input.role;
  if (member(input.reason, TELEMETRY_REASONS)) result.reason = input.reason;
  if (typeof input.fallback === "boolean") result.fallback = input.fallback;
  const measures = bag(input.measures);
  for (const key of MEASURES) {
    // Overflow can exceed 1; retain it with a defensive ceiling of 100 model windows.
    const max = key === "contextFractionMeasured" ? 100 : key === "latencyMs" ? DAY : 1e12;
    if (number(measures[key], max, key !== "contextFractionMeasured" && key !== "latencyMs")) {
      (result.measures ??= {})[key] = measures[key] as number;
    }
  }
  const reasons = bag(input.reasons);
  for (const key of TELEMETRY_REASONS) {
    if (number(reasons[key], 1e9, true)) (result.reasons ??= {})[key] = reasons[key] as number;
  }
  const prices = bag(input.prices);
  if (member(prices.source, ["provider_api_rates", "configured_api_rates"])) {
    result.prices = { source: prices.source };
    for (const key of RATE_KEYS) if (number(prices[key], 1e6)) result.prices[key] = prices[key] as number;
  }
  if (Array.isArray(input.candidates)) {
    result.candidates = [];
    // Slice before accessing elements; unbounded caller arrays cannot create unbounded work or records.
    for (const raw of input.candidates.slice(0, 64)) {
      const item = bag(raw);
      const id = label(item.id, "candidate", stored);
      if (!id || !member(item.decision, ["keep", "drop", "replace", "exclude"])) continue;
      const candidate: TelemetryCandidate = { id, decision: item.decision };
      if (member(item.reason, TELEMETRY_REASONS)) candidate.reason = item.reason;
      if (number(item.estimatedTokens, 1e12, true)) candidate.estimatedTokens = item.estimatedTokens;
      for (const key of ["callProbability", "resultProbability"] as const) {
        if (number(item[key], 1)) candidate[key] = item[key] as number;
      }
      result.candidates.push(candidate);
    }
  }
  return result;
}

const missing = (error: unknown): boolean => bag(error).code === "ENOENT";
const same = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
function privateMode(stat: Stats, directory: boolean): boolean {
  return (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
    (stat.mode & 0o777) === (directory ? 0o700 : 0o600) &&
    (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

/** Reject directory symlinks. Permit only macOS's fixed /tmp and /var system aliases. */
async function safeDirectory(path: string, create: boolean, requirePrivate: boolean): Promise<string> {
  let absolute = resolve(path);
  if (process.platform === "darwin") {
    for (const alias of ["/tmp", "/var"]) {
      if (absolute === alias || absolute.startsWith(`${alias}/`)) {
        const stat = await lstat(alias);
        if (stat.isSymbolicLink() && await realpath(alias) === `/private${alias}`) absolute = `/private${absolute}`;
      }
    }
  }
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (!missing(error) || !create) throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (bag(error).code !== "EEXIST") throw error; }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_directory");
  }
  if (requirePrivate && !privateMode(await lstat(absolute), true)) throw new Error("unsafe_directory");
  return absolute;
}

/**
 * Local immutable event files: concurrent processes never append to the same file.
 * Atomic rename publishes complete records; deterministic oldest-first trimming converges
 * after concurrent writers finish. Active writes can temporarily exceed the configured cap.
 * No lock/database/network. A hostile process with this OS user's privileges is not isolated.
 */
export class TelemetryStore {
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private anchor?: Identity;
  private directory?: string;
  private pending: Promise<void> = Promise.resolve();
  private rejected = 0;
  private failures = 0;
  private trimmed = 0;

  constructor(private readonly requestedDirectory: string, options: TelemetryOptions = {}) {
    this.retentionDays = limit(options.retentionDays, 30, 1, 90);
    this.maxBytes = limit(options.maxBytes, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024);
    this.maxEvents = limit(options.maxEvents, 4096, 1, 10_000);
    this.now = options.now ?? Date.now;
  }

  private time(): number {
    const now = this.now();
    if (!number(now, 9_999_999_999_999, true)) throw new Error("invalid_clock");
    return now;
  }

  private async root(): Promise<string> {
    if (typeof this.requestedDirectory !== "string" || !this.requestedDirectory.trim()) throw new Error("invalid_directory");
    const path = await safeDirectory(this.requestedDirectory, !this.anchor, true);
    const identity = await lstat(path);
    if (this.anchor && (!same(this.anchor, identity) || this.directory !== path)) throw new Error("directory_changed");
    this.anchor = identity;
    this.directory = path;
    return path;
  }

  /** Invalid metadata and I/O failures are swallowed. No raw exception text is retained. */
  async record(input: TelemetryInput): Promise<void> {
    let event: StoredEvent | undefined;
    let data: string;
    try {
      event = sanitize(input, this.time());
      if (!event) { this.rejected++; return; }
      data = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(data) > Math.min(MAX_EVENT_BYTES, this.maxBytes)) { this.rejected++; return; }
    } catch { this.rejected++; return; }
    const accepted = event;
    this.pending = this.pending.then(async () => {
      let temporary: string | undefined;
      try {
        const root = await this.root();
        temporary = join(root, `.${accepted.eventId}.pending`);
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(data, "utf8"); } finally { await file.close(); }
        await this.root();
        await rename(temporary, join(root, `${String(accepted.timestamp).padStart(13, "0")}-${accepted.eventId}.jsonl`));
        temporary = undefined;
        await this.trim(root, this.time());
        await this.root();
      } catch { this.failures++; }
      finally {
        if (temporary) {
          // Only clean up within the original directory, after rechecking its identity.
          try { await this.root(); await unlink(temporary); } catch { /* best effort */ }
        }
      }
    }).catch(() => { this.failures++; });
    await this.pending;
  }

  private async trim(root: string, now: number): Promise<{ files: OwnedFile[]; skipped: number }> {
    const files: OwnedFile[] = [];
    let skipped = 0;
    for (const name of await readdir(root)) {
      const match = EVENT_FILE.exec(name);
      const pending = PENDING_FILE.test(name);
      if (!match && !pending) { skipped++; continue; }
      let stat;
      try { stat = await lstat(join(root, name)); }
      catch (error) { if (missing(error)) continue; throw error; }
      if (!privateMode(stat, false)) { skipped++; continue; }
      // Fresh staging files belong to concurrent writers. Crashed writes expire in five minutes.
      if (pending && stat.mtimeMs > now - 300_000) continue;
      files.push({ name, timestamp: match ? Number(match[1]) : stat.mtimeMs, size: stat.size, pending });
    }
    files.sort((a, b) => a.timestamp - b.timestamp || a.name.localeCompare(b.name));
    const remaining: OwnedFile[] = [];
    let bytes = files.reduce((total, file) => total + file.size, 0);
    let count = files.length;
    for (const file of files) {
      if (file.pending || file.timestamp < now - this.retentionDays * DAY || file.timestamp > now + 60_000 ||
          file.size > MAX_EVENT_BYTES || bytes > this.maxBytes || count > this.maxEvents) {
        try { await unlink(join(root, file.name)); this.trimmed++; }
        catch (error) { if (!missing(error)) throw error; }
        bytes -= file.size;
        count--;
      } else remaining.push(file);
    }
    return { files: remaining, skipped };
  }

  private async snapshot(days: number): Promise<Snapshot> {
    await this.pending;
    const root = await this.root();
    const now = this.time();
    const scan = await this.trim(root, now);
    const events: StoredEvent[] = [];
    let skipped = scan.skipped;
    for (const entry of scan.files) {
      if (entry.timestamp < now - days * DAY) continue;
      let file;
      try {
        file = await open(join(root, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!privateMode(stat, false) || stat.size > MAX_EVENT_BYTES) { skipped++; continue; }
        // Bounded even if another process grows a file after stat().
        const buffer = Buffer.alloc(MAX_EVENT_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const read = await file.read(buffer, size, buffer.length - size, null);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size > MAX_EVENT_BYTES) { skipped++; continue; }
        const event = sanitize(JSON.parse(buffer.subarray(0, size).toString("utf8")), now, true);
        const match = EVENT_FILE.exec(entry.name)!;
        if (!event || event.timestamp !== entry.timestamp || event.eventId !== match[2]) { skipped++; continue; }
        events.push(event);
      } catch (error) {
        if (!missing(error)) skipped++;
      } finally { await file?.close(); }
    }
    await this.root();
    events.sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
    return { events, skipped, trimmed: this.trimmed };
  }

  async report(days = 7): Promise<string> {
    const window = limit(days, 7, 1, this.retentionDays);
    try {
      const snapshot = await this.snapshot(window);
      return buildReport(snapshot, window, this.retentionDays, this.rejected, this.failures);
    } catch {
      return `Compaction telemetry (${window}d): unavailable (local storage). Rejected inputs=${this.rejected}; local I/O failures=${this.failures}. No quality or savings conclusion available.`;
    }
  }

  /** Explicit metadata-only export. Existing destinations, including symlinks, are never replaced. */
  async exportMetadata(path: string, days = 7): Promise<TelemetryExportResult> {
    const window = limit(days, 7, 1, this.retentionDays);
    let snapshot: Snapshot;
    let data: string;
    try {
      snapshot = await this.snapshot(window);
      data = `${JSON.stringify({ schema: 1, generatedAt: this.time(), windowDays: window,
        retentionDays: this.retentionDays, maxBytes: this.maxBytes, maxEvents: this.maxEvents,
        skippedFiles: snapshot.skipped, scope: "retained_metadata_only", events: snapshot.events })}\n`;
      if (Buffer.byteLength(data) > this.maxBytes + 4096) throw new Error("export_capacity");
    } catch { return { available: false, exportedEvents: 0, reason: "storage_unavailable" }; }
    let temporary: string | undefined;
    let parent: string | undefined;
    let identity: Identity | undefined;
    try {
      if (typeof path !== "string" || !path.trim()) throw new Error("invalid_destination");
      const destination = resolve(path);
      parent = await safeDirectory(dirname(destination), false, false);
      identity = await lstat(parent);
      temporary = join(parent, `.pi-compaction-export-${randomUUID()}.tmp`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(data, "utf8"); } finally { await file.close(); }
      if (!same(identity, await lstat(await safeDirectory(parent, false, false)))) throw new Error("directory_changed");
      // link() is an atomic no-overwrite publish, unlike rename().
      await link(temporary, join(parent, parse(destination).base));
      return { available: true, exportedEvents: snapshot.events.length };
    } catch { return { available: false, exportedEvents: 0, reason: "destination_unavailable" }; }
    finally {
      if (temporary && parent && identity) {
        try {
          if (same(identity, await lstat(await safeDirectory(parent, false, false)))) await unlink(temporary);
        } catch { /* Do not follow a changed export parent to clean up. */ }
      }
    }
  }
}

function samples(events: StoredEvent[], key: Measure): number[] {
  return events.flatMap(event => event.measures?.[key] === undefined ? [] : [event.measures[key]!]);
}
function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
function distribution(values: number[], unit = ""): string {
  if (!values.length) return "unavailable (n=0)";
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return `median=${format(median)}${unit}, p95=${format(sorted[Math.ceil(sorted.length * 0.95) - 1])}${unit} (n=${sorted.length})`;
}
function total(events: StoredEvent[], key: Measure): string {
  const values = samples(events, key);
  return values.length ? `${format(values.reduce((sum, value) => sum + value, 0))} (n=${values.length})` : "unavailable (n=0)";
}
function histogram(events: StoredEvent[], includeCounts = false): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (includeCounts) {
      for (const reason of TELEMETRY_REASONS) {
        const count = event.reasons?.[reason];
        if (count !== undefined) counts.set(reason, (counts.get(reason) ?? 0) + count);
      }
    } else counts.set(event.reason ?? "unspecified", (counts.get(event.reason ?? "unspecified") ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => `${reason}=${count}`).join(", ") || (events.length && includeCounts ? "unavailable" : "none");
}
const passKey = (event: StoredEvent): string | undefined => event.passId ? `${event.sessionId}:${event.passId}` : undefined;
function cost(events: StoredEvent[]): string {
  let complete = 0;
  let sum = 0;
  const tokenKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  for (const event of events) {
    if (!event.prices) continue;
    let amount = 0;
    let known = true;
    for (let i = 0; i < tokenKeys.length; i++) {
      const tokens = event.measures?.[tokenKeys[i]];
      const rate = event.prices[RATE_KEYS[i]];
      if (tokens === undefined || (tokens > 0 && rate === undefined)) { known = false; break; }
      amount += tokens * (rate ?? 0) / 1_000_000;
    }
    if (known) { sum += amount; complete++; }
  }
  return complete ? `$${sum.toFixed(6)} (priced n=${complete}/${events.length}; API estimate, not invoice)` : `unavailable (priced n=0/${events.length})`;
}

function buildReport(snapshot: Snapshot, days: number, retention: number, rejected: number, failures: number): string {
  const { events } = snapshot;
  const passes = events.filter(e => e.kind === "pass");
  const commits = new Map<string, StoredEvent>();
  let missingPassIds = 0;
  for (const event of passes.filter(e => e.outcome === "committed")) {
    const key = passKey(event);
    if (!key) missingPassIds++;
    else if (!commits.has(key)) commits.set(key, event);
  }
  const summaries = events.filter(e => e.kind === "summary" && e.outcome === "completed");
  const requests = events.filter(e => e.kind === "request" && e.outcome === "completed");
  const coding = requests.filter(e => e.role === "coding");
  const scoring = events.filter(e => e.kind === "request" && e.role === "scoring");
  const pruned = [...commits.values()].filter(e => (e.measures?.dropped ?? 0) + (e.measures?.replaced ?? 0) > 0);
  const reductions = pruned.flatMap(e => {
    const before = e.measures?.contextBeforeTokensEstimate, after = e.measures?.contextAfterTokensEstimate;
    return before === undefined || after === undefined ? [] : [before - after];
  });
  const discrepancy: number[] = [];
  const linkedMeasurements: StoredEvent[] = [];
  const waitMinutes: number[] = [], waitTurns: number[] = [], censoredMinutes: number[] = [], censoredTurns: number[] = [];
  let observed = 0, censored = 0;
  for (const pass of pruned) {
    const subsequent = events.filter(e => e.sessionId === pass.sessionId && e.timestamp >= pass.timestamp);
    // Equal wall-clock times alone do not prove which event happened first.
    const summary = subsequent.find(e => e.kind === "summary" && e.outcome === "completed" &&
      (e.timestamp > pass.timestamp || e.passId === pass.passId ||
        (e.measures?.turn !== undefined && pass.measures?.turn !== undefined && e.measures.turn > pass.measures.turn)));
    const end = summary ?? subsequent[subsequent.length - 1] ?? pass;
    const minutes = (end.timestamp - pass.timestamp) / 60_000;
    (summary ? waitMinutes : censoredMinutes).push(minutes);
    if (summary) observed++; else censored++;
    const from = pass.measures?.turn, to = end.measures?.turn;
    if (from !== undefined && to !== undefined && to >= from) (summary ? waitTurns : censoredTurns).push(to - from);
    const measurement = subsequent.find(e => e.kind === "request" && e.role === "coding" && e.outcome === "completed" &&
      e.passId === pass.passId && e.measures?.contextTokensMeasured !== undefined && (!summary || e.timestamp < summary.timestamp));
    if (measurement) linkedMeasurements.push(measurement);
    const estimate = pass.measures?.contextAfterTokensEstimate;
    if (estimate !== undefined && measurement) discrepancy.push(measurement.measures!.contextTokensMeasured! - estimate);
  }
  const counts = TELEMETRY_KINDS.map(kind => `${kind}=${events.filter(e => e.kind === kind).length}`).join(", ");
  const lines = [
    `Compaction telemetry — last ${days}d (retained observations; retention ≤${retention}d)`,
    `Storage: available; skipped/corrupt files=${snapshot.skipped}; trimmed this instance=${snapshot.trimmed}; rejected inputs=${rejected}; local I/O failures=${failures}.`,
    `Events=${events.length}; sessions=${new Set(events.map(e => e.sessionId)).size}. ${counts}.`,
    events.length ? `Observed timestamps: ${new Date(events[0].timestamp).toISOString()} → ${new Date(events[events.length - 1].timestamp).toISOString()}; gaps/eviction possible, not continuous coverage.` : "Observed timestamps: unavailable (no retained events).",
    `Committed passes=${commits.size}; commits without pass ID=${missingPassIds}; pruned passes=${pruned.length}; completed summaries=${summaries.length}.`,
    `Threshold cancellation checks=${events.filter(e => e.kind === "summary" && e.outcome === "cancelled" && e.reason === "threshold").length}; not summaries avoided.`,
    "On/off observations (sessions can overlap; unequal workloads; no causal savings/quality conclusion):",
  ];
  for (const mode of ["on", "off", undefined] as const) {
    const subset = events.filter(e => e.mode === mode);
    const subsetRequests = requests.filter(e => e.mode === mode);
    lines.push(`  ${mode ?? "unknown"}: sessions=${new Set(subset.map(e => e.sessionId)).size}, events=${subset.length}, completed requests=${subsetRequests.length}, summaries=${summaries.filter(e => e.mode === mode).length}, input=${total(subsetRequests, "inputTokens")}, cost=${cost(subsetRequests)}.`);
  }
  lines.push(
    `Candidate aggregates (reported pass events n=${passes.length}): candidates=${total(passes, "candidates")}; eligible=${total(passes, "eligible")}; keep=${total(passes, "kept")}; drop=${total(passes, "dropped")}; replace=${total(passes, "replaced")}; excluded=${total(passes, "excluded")}.`,
    `Candidate/exclusion reasons: ${histogram(passes, true)}. Candidate details are bounded samples, not totals.`,
    `Estimated reduction tokens: ${distribution(reductions)}.`,
    `Measured coding context tokens: ${distribution(samples(coding, "contextTokensMeasured"))}; context fraction: ${distribution(samples(coding, "contextFractionMeasured"))}.`,
    `Linked first post-prune measurement before next summary: context tokens ${distribution(samples(linkedMeasurements, "contextTokensMeasured"))}; context fraction ${distribution(samples(linkedMeasurements, "contextFractionMeasured"))}.`,
    `Linked first measured context minus post-prune estimate: ${distribution(discrepancy)}; includes intervening context changes.`,
    `Scoring requests=${scoring.length} (completed=${scoring.filter(e => e.outcome === "completed").length}); request latency ${distribution(samples(scoring, "latencyMs"), "ms")}; pass latency ${distribution(samples(passes, "latencyMs"), "ms")}.`,
  );
  for (const role of ["coding", "scoring", undefined] as const) {
    const subset = requests.filter(e => e.role === role);
    lines.push(`Measured ${role ?? "unknown-role"} usage (completed requests n=${subset.length}): uncached input=${total(subset, "inputTokens")}; output=${total(subset, "outputTokens")}; cache read=${total(subset, "cacheReadTokens")}; cache write=${total(subset, "cacheWriteTokens")}; cost=${cost(subset)}.`);
  }
  lines.push(
    `Prune → next completed summary: eligible passes=${pruned.length}, observed=${observed}, right-censored=${censored}; time ${distribution(waitMinutes, "min")}; turns ${distribution(waitTurns)}.`,
    `Censored observation through last same-session event: time ${distribution(censoredMinutes, "min")}; turns ${distribution(censoredTurns)}. Passes sharing a summary are correlated; missing history/IDs or unordered same-time summaries limit linkage.`,
    `Errors (event samples): ${histogram(events.filter(e => e.kind === "error" || e.outcome === "failed"))}; fallbacks: ${histogram(events.filter(e => e.fallback === true))}.`,
  );
  for (const kind of ["recall", "restore", "off", "bad-prune"] as const) {
    const subset = events.filter(e => kind === "off" ? e.kind === "mode" && (e.outcome === "disabled" || e.mode === "off") :
      kind === "bad-prune" ? e.kind === "feedback" && e.outcome === "bad_prune" : e.kind === kind);
    const linked = subset.filter(e => {
      const pass = commits.get(passKey(e) ?? "");
      return pass !== undefined && pass.timestamp <= e.timestamp;
    });
    lines.push(`${kind}: events=${subset.length}, linked=${linked.length}, unlinked=${subset.length - linked.length}, distinct passes=${new Set(linked.map(e => passKey(e))).size}.`);
  }
  const cohorts = new Map<string, number>();
  for (const e of events) {
    const key = `v=${e.version ?? "?"}/model=${e.model?.slice(2, 14) ?? "?"}/modelVersion=${e.modelVersion?.slice(2, 14) ?? "?"}/provider=${e.provider?.slice(2, 14) ?? "?"}/config=${e.configFingerprint?.slice(2, 14) ?? "?"}`;
    cohorts.set(key, (cohorts.get(key) ?? 0) + 1);
  }
  lines.push(`Diagnostic cohorts=${cohorts.size} (hashed labels; top 8): ${[...cohorts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => `${key}:n=${count}`).join("; ") || "none"}.`,
    "Recall/restore/off are not bad-prune feedback. Low recall does not establish quality. Unavailable is not zero. Costs are API estimates only; no subscription invoice or avoided-summary claim.");
  return lines.join("\n");
}
