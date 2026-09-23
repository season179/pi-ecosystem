import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseAccountName } from "./account-store.js";
import { type AccountStorageBackend, FileAccountStorageBackend, OperationQueue } from "./storage.js";

/** Non-secret quota state shared by every Pi session and process using the same agent directory. */
export const QUOTA_STATE_FILE = "pi-accounts-quota.json";
const QUOTA_STATE_VERSION = 1;
const MAX_COOLDOWNS = 1_000;

/** `identity` is a SHA-256 digest of the ChatGPT account ID that was exhausted, never a token. */
export type Cooldown = { [key: string]: unknown; retryAt: number; resetKnown: boolean; identity?: string };
/** Keyed by saved account label; `default` is Pi's built-in login. */
export type Cooldowns = Record<string, Cooldown>;
export type CooldownsRead = { cooldowns: Cooldowns; problem?: string };

type ProviderQuotaState = { [key: string]: unknown; cooldowns: Cooldowns };
type QuotaStateData = { [key: string]: unknown; version: 1; providers: Record<string, ProviderQuotaState> };

export class QuotaStateStore {
  private readonly queue = new OperationQueue();
  private readonly backend: AccountStorageBackend;
  private readonly location: string;

  /** Without a backend, the shared file in the agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
  constructor(backend?: AccountStorageBackend, location?: string) {
    const path = backend ? undefined : join(getAgentDir(), QUOTA_STATE_FILE);
    this.backend = backend ?? new FileAccountStorageBackend(path!);
    this.location = location ?? path ?? QUOTA_STATE_FILE;
  }

  /**
   * Lock-free advisory read. Missing, unreadable, or invalid state yields no cooldowns plus a
   * `problem` message, so a bad shared file can never block requests; the next write self-heals it.
   */
  readCooldowns(providerId: string): CooldownsRead {
    let raw: string | undefined;
    try {
      raw = this.backend.readUnlocked();
    } catch (error) {
      return { cooldowns: emptyCooldowns(), problem: `Shared ChatGPT quota state ${this.location} could not be read (${message(error)}). Cooldowns are ignored until it is fixed or removed; /accounts-auto retry cannot repair an unreadable path.` };
    }
    const parsed = parseQuotaState(raw, this.location);
    if (!parsed.ok) return { cooldowns: emptyCooldowns(), problem: parsed.problem };
    return { cooldowns: cloneCooldowns(parsed.data.providers[providerId]?.cooldowns) };
  }

  /**
   * Locked read-modify-write on the on-disk state, never on a caller snapshot, so concurrent
   * sessions and a global `retry` cannot be undone. Expired cooldowns are pruned before the mutator
   * sees them and again after it, so they can neither be re-introduced nor mask a fresh observation.
   */
  async updateCooldowns(
    providerId: string,
    mutator: (current: Cooldowns) => Cooldowns,
    now: number,
    signal?: AbortSignal,
  ): Promise<Cooldowns> {
    return this.queue.run(
      () =>
        this.backend.withLockAsync(async (raw) => {
          const data = parseForWrite(raw, this.location);
          const provider = data.providers[providerId] ?? { cooldowns: emptyCooldowns() };
          const next = normalizeCooldowns(mutator(prune(provider.cooldowns, now)));
          const pruned = prune(next, now);
          const providers = { ...data.providers };
          define(providers, providerId, { ...provider, cooldowns: pruned });
          return { result: cloneCooldowns(pruned), next: stringify({ ...data, providers }) };
        }, signal),
      signal,
    );
  }

  /** Explicit recovery: clears the provider's cooldowns even when the current file is corrupt. */
  async reset(providerId: string, signal?: AbortSignal): Promise<void> {
    await this.updateCooldowns(providerId, () => emptyCooldowns(), Number.POSITIVE_INFINITY, signal);
  }
}

/** Two sessions confirming the same exhaustion keep the better estimate: a known reset over an unknown one, else the later time. */
export function mergeCooldown(existing: Cooldown | undefined, incoming: Cooldown): Cooldown {
  if (!existing || (existing.identity && incoming.identity && existing.identity !== incoming.identity)) return incoming;
  if (existing.resetKnown !== incoming.resetKnown) return existing.resetKnown ? { ...incoming, ...existing } : incoming;
  return existing.retryAt > incoming.retryAt ? { ...incoming, ...existing } : incoming;
}

function parseForWrite(raw: string | undefined, location: string): QuotaStateData {
  const parsed = parseQuotaState(raw, location);
  if (parsed.ok) return parsed.data;
  if (parsed.newer) {
    throw new Error(`Shared ChatGPT quota state ${location} was written by a newer pi-accounts version and was not changed. Upgrade pi-accounts or remove the file.`);
  }
  return emptyState(); // Invalid advisory state is replaced; nothing recoverable is lost.
}

type ParseResult = { ok: true; data: QuotaStateData } | { ok: false; problem: string; newer?: boolean };

function parseQuotaState(raw: string | undefined, location: string): ParseResult {
  if (raw === undefined) return { ok: true, data: emptyState() };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, problem: describe(location, "is not valid JSON") };
  }
  if (!isRecord(value)) return { ok: false, problem: describe(location, "is invalid") };
  if (typeof value.version === "number" && value.version > QUOTA_STATE_VERSION) {
    return { ok: false, newer: true, problem: `Shared ChatGPT quota state ${location} was written by a newer pi-accounts version; this session ignores it and will not change it. Upgrade pi-accounts to share cooldowns again.` };
  }
  if (value.version !== QUOTA_STATE_VERSION || !isRecord(value.providers)) {
    return { ok: false, problem: describe(location, "is invalid") };
  }
  const providers = Object.create(null) as Record<string, ProviderQuotaState>;
  try {
    for (const [providerId, state] of Object.entries(value.providers)) {
      if (!isRecord(state) || !isRecord(state.cooldowns)) throw new Error();
      define(providers, providerId, { ...state, cooldowns: normalizeCooldowns(state.cooldowns) });
    }
  } catch {
    return { ok: false, problem: describe(location, "is invalid") };
  }
  return { ok: true, data: { ...value, version: QUOTA_STATE_VERSION, providers } };
}

function normalizeCooldowns(value: Record<string, unknown>): Cooldowns {
  const entries = Object.entries(value);
  if (entries.length > MAX_COOLDOWNS) throw new Error("Too many cooldowns.");
  const cooldowns = emptyCooldowns();
  for (const [name, cooldown] of entries) {
    if (!parseAccountName(name).ok || name !== name.trim() || !isRecord(cooldown)) throw new Error("Invalid cooldown.");
    const { retryAt, resetKnown, identity } = cooldown;
    if (typeof retryAt !== "number" || !Number.isFinite(retryAt) || retryAt < 0 || typeof resetKnown !== "boolean") {
      throw new Error("Invalid cooldown.");
    }
    if (identity !== undefined && (typeof identity !== "string" || !/^[0-9a-f]{1,128}$/u.test(identity))) {
      throw new Error("Invalid cooldown.");
    }
    define(cooldowns, name, { ...cooldown, retryAt, resetKnown, ...(identity === undefined ? {} : { identity }) });
  }
  return cooldowns;
}

function describe(location: string, what: string): string {
  return `Shared ChatGPT quota state ${location} ${what}. Cooldowns are ignored until it is rewritten; run /accounts-auto retry to reset it.`;
}

function prune(source: Cooldowns, now: number): Cooldowns {
  const cooldowns = emptyCooldowns();
  for (const [name, cooldown] of Object.entries(source)) if (cooldown.retryAt > now) define(cooldowns, name, { ...cooldown });
  return cooldowns;
}

function stringify(data: QuotaStateData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function emptyState(): QuotaStateData {
  return { version: QUOTA_STATE_VERSION, providers: Object.create(null) as Record<string, ProviderQuotaState> };
}

function emptyCooldowns(): Cooldowns {
  return Object.create(null) as Cooldowns;
}

function cloneCooldowns(source: Cooldowns | undefined): Cooldowns {
  const cooldowns = emptyCooldowns();
  for (const [name, cooldown] of Object.entries(source ?? {})) define(cooldowns, name, { ...cooldown });
  return cooldowns;
}

function define<T>(target: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(target, name, { configurable: true, enumerable: true, value, writable: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
