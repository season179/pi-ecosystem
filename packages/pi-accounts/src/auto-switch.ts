import type {
  AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionCommandContext, ExtensionContext, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { AccountStore, defineOwn, getOwnCredential, parseAccountName, type ProviderAccountsData } from "./account-store.js";
import { checkCodexQuota, codexAccountIdentity, type CodexQuota } from "./codex-quota.js";
import { type Cooldown, type Cooldowns, mergeCooldown, QuotaStateStore } from "./quota-state.js";

const PROVIDER = "openai-codex";
const UNKNOWN_RESET_RETRY_MS = 5 * 60_000;
/** Policy used while `autoSwitch` is absent: this saved account first, Pi's built-in login second. */
export const DEFAULT_PRIMARY = "oc-codex";
export type AutoSwitchConfig = { primary: string; fallback: string };
export type AutoSwitchAccess = {
  signal: AbortSignal;
  isCurrent(): boolean;
  selected(): string | null;
  activate(name: string): Promise<boolean>;
};
export type QuotaChecker = (ctx: ExtensionContext, signal: AbortSignal) => Promise<CodexQuota>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validName(value: unknown): value is string {
  return typeof value === "string" && parseAccountName(value).ok && value === value.trim();
}
export function autoSwitchConfig(state: ProviderAccountsData): AutoSwitchConfig | undefined {
  const value = state.autoSwitch;
  // `false` is an explicit, persistent off; absent means the default policy if its account exists.
  if (value === false) return undefined;
  if (value === undefined) {
    return getOwnCredential(state.accounts, DEFAULT_PRIMARY) ? { primary: DEFAULT_PRIMARY, fallback: "default" } : undefined;
  }
  if (!record(value) || !validName(value.primary) || !validName(value.fallback) || value.primary === value.fallback) {
    throw new Error("Invalid ChatGPT auto-switch settings. Use /accounts-auto off or configure them again.");
  }
  for (const name of [value.primary, value.fallback]) {
    if (name !== "default" && !getOwnCredential(state.accounts, name)) {
      throw new Error(`ChatGPT auto-switch account "${name}" is missing. Reconfigure /accounts-auto.`);
    }
  }
  return { primary: value.primary, fallback: value.fallback };
}

/**
 * A shared cooldown applies to a label only when it was recorded for the same actual account, where that
 * is knowable locally: a saved account's stored token identifies it; Pi's built-in `default` login does not.
 */
export function cooldownFor(cooldowns: Cooldowns, name: string, state: ProviderAccountsData): Cooldown | undefined {
  const cooldown = Object.hasOwn(cooldowns, name) ? cooldowns[name] : undefined;
  if (!cooldown?.identity || name === "default") return cooldown;
  const credential = getOwnCredential(state.accounts, name);
  const identity = credential ? codexAccountIdentity(credential.access) : undefined;
  return identity === undefined || identity === cooldown.identity ? cooldown : undefined;
}

type Policy = { state: ProviderAccountsData; config: AutoSwitchConfig | undefined };

/**
 * One controller per Pi session; quota cooldowns live in the shared quota state file, per-prompt
 * guards here. No polling, independent OAuth refreshes, or synthetic user prompts.
 */
export class CodexAutoSwitch {
  private attempted = new Set<string>();
  private requestAccount?: string;
  private failure?: { account: string; message: string; entryId: string };
  private warnedProblem?: string;

  constructor(
    private readonly store: AccountStore,
    private readonly quotaState: QuotaStateStore,
    private readonly access: AutoSwitchAccess,
    private readonly quota: QuotaChecker = checkCodexQuota,
    private readonly now: () => number = Date.now,
  ) {}

  beginPrompt(): void {
    this.attempted.clear();
    this.failure = undefined;
    this.requestAccount = undefined;
  }

  private selected(): string { return this.access.selected() ?? "default"; }
  private async policy(): Promise<Policy> {
    const state = await this.store.readProviderAsync(PROVIDER, this.access.signal);
    return { state, config: autoSwitchConfig(state) };
  }
  private participating(config: AutoSwitchConfig): boolean {
    return [config.primary, config.fallback].includes(this.selected());
  }
  /** Fresh shared read before every decision; a bad file warns once per problem per session and counts as empty. */
  private cooldowns(ctx: ExtensionContext): Cooldowns {
    const { cooldowns, problem } = this.quotaState.readCooldowns(PROVIDER);
    if (problem && problem !== this.warnedProblem && this.access.isCurrent()) ctx.ui.notify(problem, "warning");
    this.warnedProblem = problem;
    return cooldowns;
  }
  private available(name: string, cooldowns: Cooldowns, state: ProviderAccountsData): boolean {
    return (cooldownFor(cooldowns, name, state)?.retryAt ?? 0) <= this.now();
  }
  private exhaustedMessage(config: AutoSwitchConfig, cooldowns: Cooldowns, state: ProviderAccountsData): string {
    return `Both ChatGPT accounts are exhausted. ${[config.primary, config.fallback].map(name => {
      const limit = cooldownFor(cooldowns, name, state);
      return `${name}: ${limit ? `${limit.resetKnown ? "reset" : "reset unknown; retry"} ${new Date(limit.retryAt).toISOString()}` : "already tried"}`;
    }).join("; ")}.`;
  }

  /** Called at turn_start, after the previous response/tool batch has ended. */
  async prepare(ctx: ExtensionContext): Promise<boolean> {
    this.failure = undefined;
    this.requestAccount = undefined;
    const { state, config } = await this.policy();
    if (!this.access.isCurrent() || ctx.signal?.aborted) return false;
    if (!config || !this.participating(config)) return true;
    const cooldowns = this.cooldowns(ctx);
    const next = [config.primary, config.fallback].find(name => this.available(name, cooldowns, state));
    if (!next) {
      ctx.ui.notify(this.exhaustedMessage(config, cooldowns, state), "error");
      return false;
    }
    if (next !== this.selected()) {
      if (!await this.access.activate(next)) {
        if (this.access.isCurrent()) ctx.ui.notify(`ChatGPT account ${next} could not be used. Fix it through /accounts, or run /accounts-auto off to stop automatic switching.`, "error");
        return false;
      }
      if (!this.access.isCurrent()) return false;
      ctx.ui.notify(`ChatGPT account: ${next}${next !== config.primary ? " (fallback)" : cooldownFor(cooldowns, next, state) ? " (primary; retrying after quota reset)" : " (primary)"}.`, "info");
    }
    this.requestAccount = next;
    this.attempted.add(next);
    return true;
  }

  observe(event: TurnEndEvent): void {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== PROVIDER || !this.requestAccount) return;
    if (message.stopReason === "error" && event.toolResults.length === 0 && !message.content.some(block => block.type === "toolCall")) {
      this.failure = { account: this.requestAccount, message: message.errorMessage ?? "", entryId: event.messageEntryId };
    } else {
      this.failure = undefined;
      this.attempted.clear();
    }
  }

  /** After Pi exhausts its own retries. A quota endpoint confirms ambiguous 429 messages. */
  async recover(event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<AgentBeforeSettleEventResult | undefined> {
    const failure = this.failure;
    this.failure = undefined; // A boundary can consume this failure only once.
    if (event.outcome !== "error" || !failure || ctx.model?.provider !== PROVIDER ||
        failure.account !== this.selected() || !this.access.isCurrent() || ctx.signal?.aborted) return;
    if (!/usage[_ ]limit|rate[_ ]limit|\b429\b|quota/i.test(failure.message) ||
        /\b(?:401|403)\b|unauthori[sz]ed|authentication|context[_ ](?:length|window)|usage_not_included/i.test(failure.message)) return;
    const { state, config } = await this.policy();
    if (!config || !this.participating(config) || !this.access.isCurrent()) return;
    const signal = ctx.signal ? AbortSignal.any([this.access.signal, ctx.signal]) : this.access.signal;
    const quota = await this.quota(ctx, signal);
    if (!this.access.isCurrent() || signal.aborted || failure.account !== this.selected()) return;
    if (!quota.exhausted) return;
    const cooldown: Cooldown = {
      retryAt: quota.resetAt === undefined ? this.now() + UNKNOWN_RESET_RETRY_MS : Math.max(this.now() + 1_000, quota.resetAt + 1_000),
      resetKnown: quota.resetAt !== undefined,
      ...(quota.identity === undefined ? {} : { identity: quota.identity }),
    };
    // Record globally before changing identity, merging into the on-disk state so another session's
    // observation or a concurrent `retry` is not overwritten; never switch if the shared write fails.
    let cooldowns: Cooldowns;
    try {
      cooldowns = await this.quotaState.updateCooldowns(PROVIDER, current =>
        defineOwn(current, failure.account, mergeCooldown(cooldownFor(current, failure.account, state), cooldown)), this.now(), signal);
    } catch (error) {
      if (signal.aborted || !this.access.isCurrent()) return; // An abandoned boundary is not an error.
      throw error;
    }
    if (!this.access.isCurrent() || signal.aborted || failure.account !== this.selected()) return;
    this.attempted.add(failure.account);
    const next = [config.primary, config.fallback].find(name => this.available(name, cooldowns, state) && !this.attempted.has(name));
    if (!next) {
      ctx.ui.notify(this.exhaustedMessage(config, cooldowns, state), "error");
      return;
    }
    if (!await this.access.activate(next) || !this.access.isCurrent() || signal.aborted) return;
    this.attempted.add(next);
    let continuation: AgentBeforeSettleEventResult | undefined;
    if (event.context.canContinue) continuation = { continue: true };
    else {
      // Pi also omits failed recovery attempts with append-only context edits. Do not
      // replay tools or remove another extension's replacement/continuation message.
      const last = event.context.contextEntries.filter(entry => entry.messages.length > 0).at(-1);
      const previous = event.context.llmMessages.at(-2);
      if (last?.sourceEntry.id === failure.entryId && last.messages.length === 1 &&
          last.messages[0].role === "assistant" && last.messages[0].stopReason === "error" &&
          (previous?.role === "user" || previous?.role === "toolResult")) {
        continuation = { entries: [{ type: "context_edit", targetId: failure.entryId, replacement: null }], continue: true };
      }
    }
    ctx.ui.notify(`ChatGPT quota exhausted for ${failure.account}; switched to ${next}.${quota.resetAt === undefined ? " Reset time unknown; quota retry in five minutes." : ""}${continuation ? " Resuming." : " Send another prompt to resume."}`, "warning");
    return continuation;
  }

  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current response to finish before changing account settings.", "warning");
      return;
    }
    let action = args.trim();
    if (!action) {
      if (!ctx.hasUI) { ctx.ui.notify("Use /accounts-auto status, off, retry, or <primary> <fallback> (default = Pi login).", "info"); return; }
      const choice = await ctx.ui.select("ChatGPT automatic accounts", ["Configure primary and fallback", "Status", "Disable", "Retry now"]);
      if (!this.access.isCurrent() || !choice) return;
      action = ({ "Configure primary and fallback": "configure", Status: "status", Disable: "off", "Retry now": "retry" })[choice] ?? "status";
    }
    if (action === "status") {
      const { state, config } = await this.policy();
      if (!this.access.isCurrent()) return;
      const { cooldowns, problem } = this.quotaState.readCooldowns(PROVIDER);
      const active = Object.keys(cooldowns).map(name => [name, cooldownFor(cooldowns, name, state)] as const)
        .filter(([, limit]) => limit !== undefined && limit.retryAt > this.now())
        .map(([name, limit]) => `${name}: ${limit!.resetKnown ? "reset" : "retry (reset unknown)"} ${new Date(limit!.retryAt).toISOString()}`);
      ctx.ui.notify(config
        ? `ChatGPT auto-switch: ${config.primary} → ${config.fallback}${state.autoSwitch === undefined ? " (default policy)" : ""}. Current: ${this.selected()}${this.participating(config) ? "" : " (automatic switching paused for this selection)"}.\nShared quota cooldowns: ${active.length ? `\n${active.join("\n")}` : "none"}${problem ? `\n${problem}` : ""}`
        : "ChatGPT automatic switching is off.", "info");
      return;
    }
    if (action === "off") {
      await this.store.updateProvider(PROVIDER, state => {
        if (!this.access.isCurrent()) return state;
        return { ...state, autoSwitch: false }; // Deleting the field would restore the default policy.
      });
      if (this.access.isCurrent()) ctx.ui.notify("ChatGPT automatic switching disabled. Current account unchanged. Re-enable with /accounts-auto <primary> <fallback>.", "info");
      return;
    }
    if (action === "retry") {
      await this.quotaState.reset(PROVIDER, this.access.signal);
      if (!this.access.isCurrent()) return;
      this.beginPrompt();
      this.warnedProblem = undefined;
      ctx.ui.notify("Shared ChatGPT quota cooldowns cleared for every session using this agent directory. Exhaustion confirmed later is recorded again. The next request retries the primary if automatic switching is enabled.", "info");
      return;
    }
    let names = action.split(/\s+/);
    if (action === "configure") {
      const state = await this.store.readProviderAsync(PROVIDER, this.access.signal);
      if (!this.access.isCurrent()) return;
      const choices = ["default", ...Object.keys(state.accounts).filter(name => name !== "default").sort()];
      const primary = await ctx.ui.select("Primary ChatGPT account (default = Pi built-in login)", choices);
      if (!primary || !this.access.isCurrent()) return;
      const fallback = await ctx.ui.select("Fallback ChatGPT account", choices.filter(name => name !== primary));
      if (!fallback || !this.access.isCurrent()) return;
      names = [primary, fallback];
    }
    if (names.length !== 2) throw new Error("Use /accounts-auto <primary> <fallback>; default means Pi's built-in login.");
    const [primary, fallback] = names;
    await this.store.updateProvider(PROVIDER, state => {
      if (!this.access.isCurrent()) return state;
      const next = { ...state, autoSwitch: { primary, fallback }, active: primary === "default" ? undefined : primary };
      autoSwitchConfig(next);
      return next;
    });
    if (!this.access.isCurrent()) return;
    this.beginPrompt(); // Shared cooldowns stay: configuring a pair does not make an exhausted account usable.
    if (!await this.access.activate(primary) || !this.access.isCurrent()) {
      ctx.ui.notify("Automatic account settings saved, but primary authentication failed. Fix it through /accounts before continuing.", "error");
      return;
    }
    ctx.ui.notify(`ChatGPT automatic switching enabled: ${primary} → ${fallback}. Primary is also the default for new sessions. Use /accounts-auto off before pinning a different account.`, "info");
  }
}
