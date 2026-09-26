import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { noul, TypeSafeClient, type Fetch } from '@typesafe-ai/sdk';
import type { CustomMessageEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import { redact, stripMemory, textOf } from './safety.js';

// Automatic pre-run retrieval. Jev only decides WHEN to ask Reflect; it never
// sees, filters or scores the answer and never affects capture. Constants are
// provisional until usefulness is evaluated (plan stage 6).
export const CONTEXT_TYPE = 'pi-hindsight-context';
export const PERIODIC_EVERY = 4;
export const GATE_THRESHOLD = 0.7;
export const GATE_MAX_MS = 2_000;
export const REFLECT_MAX_MS = 6_000;
export const INJECT_CHARS = 4_000;
export const BRANCH_INJECTIONS = 8;
export const REFLECT_ATTEMPTS = 8;
export const GATE_ATTEMPTS = 32;
export const COOLDOWN_MS = 10 * 60_000;
const JEV_URL = 'https://api.typesafe.ai';
const QUERY_CHARS = 4_000, MESSAGE_CHARS = 1_500;

export type Trigger = 'initial' | 'periodic';
export type ContextEntry = CustomMessageEntry<{ hindsight?: { echoTexts?: unknown } }>;

export function injections(branch: SessionEntry[]): ContextEntry[] {
  return branch.filter((e): e is ContextEntry => e.type === 'custom_message' && e.customType === CONTEXT_TYPE);
}
/** Persisted user entries (steering/follow-ups included) plus the prompt now starting. */
export function triggerFor(branch: SessionEntry[]): Trigger | undefined {
  const n = branch.filter(e => e.type === 'message' && e.message.role === 'user').length + 1;
  return n === 1 ? 'initial' : (n - 1) % PERIODIC_EVERY === 0 ? 'periodic' : undefined;
}
export const automaticQuery = (prompt: string) => redact(stripMemory(prompt)).trim().slice(0, QUERY_CHARS);

/** Gate state: redacted visible branch text (context edits honored) and memory already injected. */
export function gateState(branch: SessionEntry[], query: string) {
  const edits = new Map<string, { content: unknown } | null>();
  for (const e of branch) if (e.type === 'context_edit') edits.set(e.targetId, e.replacement);
  const recent: Array<{ role: string; text: string }> = [];
  for (const e of branch) {
    if (e.type !== 'message' || (e.message.role !== 'user' && e.message.role !== 'assistant')) continue;
    const edit = edits.get(e.id);
    if (edit === null) continue;
    const text = redact(stripMemory(textOf(edit ? edit.content : e.message.content))).trim().slice(0, MESSAGE_CHARS);
    if (text) recent.push({ role: e.message.role, text });
  }
  const provided = injections(branch).flatMap(e => e.details?.hindsight?.echoTexts ?? [])
    .filter((t): t is string => typeof t === 'string').slice(-2).map(t => redact(t).slice(0, MESSAGE_CHARS));
  return { current_request: query, recent_messages: recent.slice(-6), memory_already_provided: provided };
}

export type GateConfig = { kind: 'disabled' | 'invalid' } | { kind: 'enabled'; model: string; timeoutMs: number; apiKeyFile?: string };
/** Shared `<agentDir>/typesafe.json`; only the `hindsight` section is owned here. Absent means off. */
export async function loadGate(agentDir: string): Promise<GateConfig> {
  let raw: string;
  try { raw = await readFile(join(agentDir, 'typesafe.json'), 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'disabled' } : { kind: 'invalid' }; }
  try {
    const value = JSON.parse(raw);
    if (!record(value)) throw new Error();
    if (value.hindsight === undefined) return { kind: 'disabled' };
    if (!record(value.hindsight) || (value.hindsight.enabled !== undefined && typeof value.hindsight.enabled !== 'boolean')) throw new Error();
    if (value.hindsight.enabled !== true) return { kind: 'disabled' };
    const model = value.model ?? 'jev-1.13.0', timeoutMs = value.timeoutMs ?? 3000;
    if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(model) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      (value.apiKeyFile !== undefined && (typeof value.apiKeyFile !== 'string' || !value.apiKeyFile.trim()))) throw new Error();
    return { kind: 'enabled', model, timeoutMs: Math.min(timeoutMs, GATE_MAX_MS), apiKeyFile: value.apiKeyFile?.trim() };
  } catch { return { kind: 'invalid' }; }
}
/** Re-read per decision; never logged. */
export async function loadKey(agentDir: string, apiKeyFile?: string): Promise<string | undefined> {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  if (!apiKeyFile) return undefined;
  try { return (await readFile(isAbsolute(apiKeyFile) ? apiKeyFile : join(agentDir, apiKeyFile), 'utf8')).trim() || undefined; }
  catch { return undefined; }
}

const INSTRUCTIONS = 'state.current_request is the newest user request in a coding-agent session; state.recent_messages are the latest earlier messages ' +
  'and state.memory_already_provided is memory from earlier sessions already shown to the agent. Would the agent\'s response to state.current_request ' +
  'likely be improved by retrieving additional memories from earlier sessions of this project, such as prior decisions, user preferences, corrections ' +
  'or findings, that are not already present in state.recent_messages or state.memory_already_provided?';
const CRITERIA = {
  true: 'Earlier-session decisions, preferences, corrections or findings not already present could plausibly change or improve the next response',
  false: 'The request is self-contained, fully specified, small talk, or already covered by the messages and memory shown',
};
export type GateOutcome = { kind: 'decision'; yes: number } | { kind: 'unavailable' } | { kind: 'aborted' };
/** One bounded Noul. The wall race also bounds fetches or body parsing that ignore abort. */
export async function askGate(state: object, options: { model: string; timeoutMs: number; apiKey: string; signal: AbortSignal; fetch?: Fetch }): Promise<GateOutcome> {
  if (options.signal.aborted) return { kind: 'aborted' };
  const controller = new AbortController();
  const wall = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('gate stopped')), { once: true }));
  wall.catch(() => undefined);
  const stop = () => controller.abort();
  const timer = setTimeout(stop, options.timeoutMs);
  options.signal.addEventListener('abort', stop, { once: true });
  try {
    const client = new TypeSafeClient({ apiKey: options.apiKey, baseURL: JEV_URL, defaultModel: options.model, logLevel: 'off',
      retry: { maxRetries: 0 }, timeout: options.timeoutMs, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const request = Promise.resolve(client.systemOne({ state: state as never, questions: { memory: noul(INSTRUCTIONS, CRITERIA) }, model: options.model },
      { signal: controller.signal, timeout: options.timeoutMs, retry: { maxRetries: 0 } }));
    request.catch(() => undefined);
    const result = await Promise.race([request, wall]);
    if (options.signal.aborted) return { kind: 'aborted' };
    const yes = (result as { answers?: { memory?: { type?: unknown; noul?: unknown } } }).answers?.memory;
    return yes?.type === 'noul' && typeof yes.noul === 'number' && yes.noul >= 0 && yes.noul <= 1 ? { kind: 'decision', yes: yes.noul } : { kind: 'unavailable' };
  } catch {
    return options.signal.aborted ? { kind: 'aborted' } : { kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
  }
}
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
