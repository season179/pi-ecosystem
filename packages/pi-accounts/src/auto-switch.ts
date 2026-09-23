import type {
  AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionCommandContext, ExtensionContext, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { AccountStore, getOwnCredential, parseAccountName, type ProviderAccountsData } from "./account-store.js";
import { checkCodexQuota, type CodexQuota } from "./codex-quota.js";

const PROVIDER = "openai-codex";
const STATE_ENTRY = "pi-accounts-auto-switch";
const UNKNOWN_RESET_RETRY_MS = 5 * 60_000;
export type AutoSwitchConfig = { primary: string; fallback: string };
type Cooldown = { retryAt: number; resetKnown: boolean };
type Session = ExtensionContext["sessionManager"] & { appendCustomEntry(type: string, data: unknown): string };
export type AutoSwitchAccess = {
  session: Session;
  sessionId: string;
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
  if (value === undefined) return undefined;
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

/** One owner per Pi session. No polling, independent OAuth refreshes, or synthetic user prompts. */
export class CodexAutoSwitch {
  private cooldowns = new Map<string, Cooldown>();
  private stateError = false;
  private attempted = new Set<string>();
  private requestAccount?: string;
  private failure?: { account: string; message: string; entryId: string };

  constructor(
    private readonly store: AccountStore,
    private readonly access: AutoSwitchAccess,
    private readonly quota: QuotaChecker = checkCodexQuota,
    private readonly now: () => number = Date.now,
  ) {
    for (const entry of access.session.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY || !record(entry.data) ||
          entry.data.sessionId !== access.sessionId) continue;
      const value = entry.data;
      if (value.version !== 1 || !record(value.cooldowns)) { this.stateError = true; continue; }
      const restored = new Map<string, Cooldown>();
      let invalid = false;
      for (const [name, cooldown] of Object.entries(value.cooldowns)) {
        if (!validName(name) || !record(cooldown) || typeof cooldown.retryAt !== "number" ||
            !Number.isFinite(cooldown.retryAt) || cooldown.retryAt < 0 || typeof cooldown.resetKnown !== "boolean") {
          invalid = true;
          break;
        }
        restored.set(name, { retryAt: cooldown.retryAt, resetKnown: cooldown.resetKnown });
      }
      this.stateError = invalid;
      if (!invalid) this.cooldowns = restored;
    }
  }

  beginPrompt(): void {
    this.attempted.clear();
    this.failure = undefined;
    this.requestAccount = undefined;
  }

  private selected(): string { return this.access.selected() ?? "default"; }
  private async config(): Promise<AutoSwitchConfig | undefined> {
    return autoSwitchConfig(await this.store.readProviderAsync(PROVIDER, this.access.signal));
  }
  private participating(config: AutoSwitchConfig): boolean {
    return [config.primary, config.fallback].includes(this.selected());
  }
  private available(name: string): boolean {
    return (this.cooldowns.get(name)?.retryAt ?? 0) <= this.now();
  }
  private persist(): void {
    if (!this.access.isCurrent()) return;
    this.access.session.appendCustomEntry(STATE_ENTRY, {
      version: 1, sessionId: this.access.sessionId, cooldowns: Object.fromEntries(this.cooldowns),
    });
  }
  private exhaustedMessage(config: AutoSwitchConfig): string {
    return `Both ChatGPT accounts are exhausted. ${[config.primary, config.fallback].map(name => {
      const limit = this.cooldowns.get(name);
      return `${name}: ${limit ? `${limit.resetKnown ? "reset" : "reset unknown; retry"} ${new Date(limit.retryAt).toISOString()}` : "already tried"}`;
    }).join("; ")}.`;
  }

  /** Called at turn_start, after the previous response/tool batch has ended. */
  async prepare(ctx: ExtensionContext): Promise<boolean> {
    this.failure = undefined;
    this.requestAccount = undefined;
    const config = await this.config();
    if (!this.access.isCurrent() || ctx.signal?.aborted) return false;
    if (!config || !this.participating(config)) return true;
    if (this.stateError) throw new Error("Invalid saved ChatGPT quota state. Use /accounts-auto retry to reset it.");
    const next = [config.primary, config.fallback].find(name => this.available(name));
    if (!next) {
      ctx.ui.notify(this.exhaustedMessage(config), "error");
      return false;
    }
    if (next !== this.selected()) {
      if (!await this.access.activate(next) || !this.access.isCurrent()) return false;
      ctx.ui.notify(`ChatGPT account: ${next}${next === config.primary ? " (primary; retrying after quota reset)" : " (fallback)"}.`, "info");
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
    const config = await this.config();
    if (!config || !this.participating(config) || !this.access.isCurrent()) return;
    const signal = ctx.signal ? AbortSignal.any([this.access.signal, ctx.signal]) : this.access.signal;
    const quota = await this.quota(ctx, signal);
    if (!this.access.isCurrent() || signal.aborted || failure.account !== this.selected()) return;
    if (!quota.exhausted) return;
    this.cooldowns.set(failure.account, {
      retryAt: quota.resetAt === undefined ? this.now() + UNKNOWN_RESET_RETRY_MS : Math.max(this.now() + 1_000, quota.resetAt + 1_000),
      resetKnown: quota.resetAt !== undefined,
    });
    this.persist(); // Persist before changing identity; never loop if a session write fails.
    this.attempted.add(failure.account);
    const next = [config.primary, config.fallback].find(name => this.available(name) && !this.attempted.has(name));
    if (!next) {
      ctx.ui.notify(this.exhaustedMessage(config), "error");
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
      const config = await this.config();
      if (!this.access.isCurrent()) return;
      ctx.ui.notify(config
        ? `ChatGPT auto-switch: ${config.primary} → ${config.fallback}. Current: ${this.selected()}${this.participating(config) ? "" : " (automatic switching paused for this selection)"}.\n${[...this.cooldowns].map(([name, limit]) => `${name}: ${limit.resetKnown ? "reset" : "retry (reset unknown)"} ${new Date(limit.retryAt).toISOString()}`).join("\n")}`
        : "ChatGPT automatic switching is off.", "info");
      return;
    }
    if (action === "off") {
      await this.store.updateProvider(PROVIDER, state => {
        if (!this.access.isCurrent()) return state;
        const next = { ...state };
        delete next.autoSwitch;
        return next;
      });
      if (this.access.isCurrent()) ctx.ui.notify("ChatGPT automatic switching disabled. Current account unchanged.", "info");
      return;
    }
    if (action === "retry") {
      this.cooldowns.clear();
      this.stateError = false;
      this.beginPrompt();
      this.persist();
      ctx.ui.notify("Saved quota cooldowns cleared for this session. The next request will retry the primary if automatic switching is enabled.", "info");
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
    this.cooldowns.clear();
    this.stateError = false;
    this.beginPrompt();
    this.persist();
    if (!await this.access.activate(primary) || !this.access.isCurrent()) {
      ctx.ui.notify("Automatic account settings saved, but primary authentication failed. Fix it through /accounts before continuing.", "error");
      return;
    }
    ctx.ui.notify(`ChatGPT automatic switching enabled: ${primary} → ${fallback}. Primary is also the default for new sessions. Use /accounts-auto off before pinning a different account.`, "info");
  }
}
