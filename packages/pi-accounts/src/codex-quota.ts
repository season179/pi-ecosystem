import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** `identity` is a SHA-256 digest of the checked ChatGPT account ID, used to detect replaced accounts. */
export type CodexQuota = { exhausted: boolean; resetAt?: number; identity?: string };
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only explicit subscription exhaustion counts; missing/contradictory data is unknown. */
export function parseCodexQuota(payload: unknown, now = Date.now()): CodexQuota {
  const root = record(payload);
  const rate = record(root?.rate_limit) ?? root;
  if (!rate || typeof rate.allowed !== "boolean" || typeof rate.limit_reached !== "boolean" ||
      rate.allowed === rate.limit_reached) throw new Error("Unrecognized ChatGPT quota response.");
  if (rate.allowed) return { exhausted: false };
  const resets: number[] = [];
  let unknownReset = false;
  for (const value of [rate.primary_window, rate.secondary_window]) {
    const window = record(value);
    if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) continue;
    if (window.used_percent < 100) continue;
    const absolute = window.reset_at;
    const delay = window.reset_after_seconds;
    const reset = typeof absolute === "number" && Number.isFinite(absolute) && absolute > 0
      ? absolute * 1000
      : typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? now + delay * 1000 : undefined;
    // Reject milliseconds-as-seconds or other implausible timestamps, rather than
    // disabling an account for centuries if this undocumented endpoint changes.
    if (reset !== undefined && Number.isFinite(reset) && reset <= now + 366 * 24 * 60 * 60_000) resets.push(reset);
    else unknownReset = true;
  }
  // Both windows must recover: the later exhausted window governs availability.
  return { exhausted: true, resetAt: !unknownReset && resets.length ? Math.max(...resets) : undefined };
}

function codexAccountId(accessToken: string): string | undefined {
  try {
    const payload = record(JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")));
    const accountId = record(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/** Local, non-reversible account fingerprint from a stored OAuth access token; undefined when undecodable. */
export function codexAccountIdentity(accessToken: string): string | undefined {
  const accountId = codexAccountId(accessToken);
  return accountId === undefined ? undefined : createHash("sha256").update(accountId).digest("hex");
}

/** Uses this session's effective OAuth token, never the Codex CLI or another account's login. */
export async function checkCodexQuota(
  ctx: ExtensionContext,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexQuota> {
  try {
    if (ctx.model?.provider !== "openai-codex") throw new Error();
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) throw new Error();
    const accountId = codexAccountId(auth.apiKey);
    if (accountId === undefined) throw new Error();
    const response = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${auth.apiKey}`, "ChatGPT-Account-ID": accountId, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (!response.ok) throw new Error();
    return { ...parseCodexQuota(await response.json()), identity: createHash("sha256").update(accountId).digest("hex") };
  } catch {
    // Header/transport failures can contain tokens. Do not forward original errors or bodies.
    throw new Error("Could not verify this account's ChatGPT quota; automatic switching was skipped.");
  }
}
