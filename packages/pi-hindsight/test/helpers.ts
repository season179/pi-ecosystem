import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createHindsightExtension, type ExtensionOptions } from '../src/extension.js';

export const BANK = 'coding-agent::test:project';
export const GLOBAL_BANK = 'coding-agent::test:global';
export class Server {
  calls: Array<{ method: string; url: URL; body: any }> = [];
  documents = new Map<string, string>();
  operations = new Map<string, { status: string }>();
  facts = new Map<string, any>();
  pending = false;
  statsPending = [0];
  statsFailed = 0;
  version = '0.10.1';
  reflectText = 'Previously retrieved memory says the old timeout was thirty seconds.';
  globalText = 'Global memory: the user prefers concise answers.';
  recallMemories?: Array<{ id: string; text: string; context?: string }>;
  globalMemories?: Array<{ id: string; text: string; context?: string }>;
  before?: (call: Server['calls'][number]) => void | Promise<void>;
  fetch: typeof fetch = async (url, init) => {
    const call = {
      method: init?.method ?? 'GET',
      url: new URL(String(url)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    this.calls.push(call);
    await this.before?.(call);
    const path = decodeURIComponent(call.url.pathname);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === '/version') return json({ api_version: this.version });
    if (call.method === 'GET' && path.includes('/documents/')) {
      const content = this.documents.get(path.split('/documents/')[1]);
      return content === undefined
        ? json({ detail: 'missing' }, 404)
        : json({ id: path.split('/documents/')[1], bank_id: BANK, original_text: content });
    }
    if (call.method === 'GET' && path.includes('/operations/'))
      return this.operations.has(path.split('/operations/')[1])
        ? json({
            operation_id: path.split('/operations/')[1],
            ...this.operations.get(path.split('/operations/')[1]),
          })
        : json({ operation_id: path.split('/operations/')[1], status: 'not_found' });
    if (call.method === 'POST' && path.endsWith('/memories')) {
      const b = call.body,
        item = b.items[0];
      if (!this.operations.has(b.operation_id)) {
        const prev = this.documents.get(item.document_id);
        this.documents.set(
          item.document_id,
          item.update_mode === 'append' && prev ? `${prev}\n${item.content}` : item.content,
        );
        this.operations.set(b.operation_id, { status: this.pending ? 'pending' : 'completed' });
      }
      return json({ operation_id: b.operation_id });
    }
    if (path.endsWith('/memories/recall')) {
      const global = path.includes(GLOBAL_BANK);
      return json({
        results: (global ? this.globalMemories : this.recallMemories) ?? [
          {
            id: global ? 'global-fact' : 'project-fact',
            text: global ? this.globalText : this.reflectText,
            context: 'Prior session',
          },
        ],
      });
    }
    if (path.endsWith('/reflect'))
      return json({ text: path.includes(GLOBAL_BANK) ? this.globalText : this.reflectText });
    if (call.method === 'GET' && path.endsWith('/stats'))
      return json({
        bank_id: BANK,
        pending_consolidation:
          this.statsPending.length > 1 ? this.statsPending.shift() : this.statsPending[0],
        failed_consolidation: this.statsFailed,
      });
    if (call.method === 'GET' && path.endsWith('/mental-models'))
      return json({ items: [{ id: 'kp-one' }], total: 1 });
    if (call.method === 'POST' && path.endsWith('/refresh'))
      return json({ operation_id: 'refresh-op', status: 'pending' });
    if (path.endsWith('/knowledge-base/search'))
      return json({
        results: [
          {
            id: 'kp-one',
            name: 'Decisions',
            snippet: 'Previously retrieved memory says the old timeout was thirty seconds.',
            score: 1,
          },
        ],
      });
    if (path.endsWith('/knowledge-base/pages/kp-one'))
      return json({
        id: 'kp-one',
        name: 'Decisions',
        body: 'Page content',
        markdown: 'duplicate',
        timestamp: '2026-01-01',
      });
    if (call.method === 'GET' && path.endsWith('/memories/list')) {
      // 0.10.1: state=invalidated lists the archive; the default lists live facts with edited_at.
      const q = call.url.searchParams,
        archive = q.get('state') === 'invalidated';
      const all = [...this.facts.values()].filter(
        (f) =>
          (!q.get('document_id') || f.document_id === q.get('document_id')) &&
          (f.state === 'invalidated') === archive,
      );
      const offset = Number(q.get('offset') ?? 0),
        limit = Number(q.get('limit') ?? 100);
      return json({
        items: all.slice(offset, offset + limit).map((f) => ({ ...f, fact_type: f.type })),
        total: all.length,
        limit,
        offset,
      });
    }
    if (path.includes('/memories/')) {
      const id = path.split('/memories/')[1];
      const fact = this.facts.get(id);
      if (!fact) return json({}, 404);
      if (call.method === 'PATCH')
        this.facts.set(id, {
          ...fact,
          ...call.body,
          ...(call.body.text ? { edited_at: '2026-09-26T13:00:00Z' } : {}),
        });
      return json(this.facts.get(id));
    }
    throw new Error(`Unexpected mocked HTTP: ${call.method} ${path}`);
  };
  get retains() {
    return this.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/memories'));
  }
}
export function config(root: string, extra: Record<string, unknown> = {}): string {
  const path = join(root, 'hindsight.json');
  writeFileSync(
    path,
    JSON.stringify({ apiUrl: 'http://hindsight.invalid', bankId: BANK, ...extra }),
  );
  return path;
}
export function message(text: string, timestamp = 1_800_000_001_000): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'offline-hindsight',
    model: 'fake',
    stopReason: 'stop',
    timestamp,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function persisted(root: string): SessionManager {
  mkdirSync(join(root, 'sessions'), { recursive: true });
  return SessionManager.create(root, join(root, 'sessions'));
}
export function exchange(manager: SessionManager, text: string): void {
  manager.appendMessage({
    role: 'user',
    content: `${text} user qualified: only in development`,
    timestamp: 1_800_000_000_000,
  });
  manager.appendMessage(message(`${text} assistant reply`));
}

/** Small direct fixture, typed with the actual installed SDK event/tool contracts. */
export function extensionFixture(
  manager: SessionManager,
  server: Server,
  options: ExtensionOptions = {},
) {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  const widgets = new Map<string, any>();
  const tools = new Map<string, ToolDefinition>();
  const flags = new Map<string, unknown>();
  let lastStatus = '';
  const pi = {
    on: (name: string, handler: Function) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () =>
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler),
        );
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerFlag: (name: string, value: { default: unknown }) => flags.set(name, value.default),
    getFlag: (name: string) => flags.get(name),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
    appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: manager.getCwd(),
    sessionManager: manager,
    hasUI: false,
    mode: 'tui',
    signal: undefined,
    ui: {
      setWidget: (name: string, value: any) => widgets.set(name, value),
      setStatus: (_name: string, text: string) => {
        lastStatus = text;
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  createHindsightExtension({
    fetch: server.fetch,
    globalConfigPath: join(manager.getCwd(), 'no-global.json'),
    ...options,
  })(pi);
  const toolContext = {
    ...ctx,
    tools: [],
    executeTool: async () => {
      throw new Error('Nested tool calls require the real SDK fixture');
    },
  };
  return {
    ctx,
    tools,
    flags,
    commands,
    renderers,
    widgets,
    get status() {
      return lastStatus ?? '';
    },
    get memoryStatus() {
      const factory = widgets.get('pi-hindsight-memory');
      return typeof factory === 'function'
        ? factory({ requestRender() {} }, { fg: (_color: string, text: string) => text })
            .render(160)
            .join('\n')
            .trim()
        : '';
    },
    emit: async (name: string, event = { type: name }) => {
      let result: any;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
    tool: (name: string, args: any, signal?: AbortSignal) =>
      tools.get(name)!.execute('test-tool', args, signal, undefined, toolContext),
  };
}

export async function sdk(
  root: string,
  server: Server,
  sessionManager: SessionManager,
  replies: AssistantMessage[],
  options: ExtensionOptions = {},
  tools: ToolDefinition[] = [],
  onRequest?: (index: number) => Promise<void>,
) {
  const requests: unknown[] = [];
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const model: Model<Api> = {
    id: 'fake',
    name: 'fake',
    api: 'openai-completions',
    provider: 'offline-hindsight',
    baseUrl: 'https://offline.invalid',
    reasoning: false,
    input: ['text'],
    contextWindow: 32768,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const provider = (pi: ExtensionAPI) => {
    for (const tool of tools) pi.registerTool(tool);
    pi.registerProvider('offline-hindsight', {
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey: 'fake-not-a-credential',
      models: [model],
      streamSimple(_model, context) {
        requests.push(JSON.parse(JSON.stringify(context.messages)));
        const stream = createAssistantMessageEventStream();
        const reply = replies.shift();
        if (!reply) throw new Error('Synthetic response queue exhausted');
        const requestIndex = requests.length - 1;
        queueMicrotask(async () => {
          await onRequest?.(requestIndex);
          stream.push({ type: 'start', partial: reply });
          stream.push({ type: 'done', reason: 'stop', message: reply });
        });
        return stream;
      },
    });
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(
      {
        compaction: { enabled: false },
        retry: { enabled: false },
        defaultProjectTrust: 'always',
        enableAnalytics: false,
        enableInstallTelemetry: false,
      },
      { projectTrusted: true },
    ),
    resourceLoaderOptions: {
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: 'Offline synthetic test',
      extensionFactories: [
        provider,
        createHindsightExtension({
          configPath: options.configPath ?? config(root),
          globalConfigPath: join(root, 'no-global.json'),
          fetch: server.fetch,
          ...options,
        }),
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: 'off',
    tools: tools.map((t) => t.name),
  });
  await session.bindExtensions({ mode: 'print' });
  return {
    session,
    requests,
    async dispose() {
      session.dispose();
    },
  };
}

/** Mocked TypeSafe transport: each call consumes one Noul value (or a callback returning one), 'error' (HTTP 500) or 'hang' (ignores abort). */
export function jev(answers: Array<number | number[] | 'error' | 'hang' | (() => number)>) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body });
    const answer = answers.shift(),
      next = typeof answer === 'function' ? answer() : answer;
    if (next === undefined) throw new Error('Unexpected Jev call');
    if (next === 'hang') return new Promise<Response>(() => {});
    if (next === 'error') return new Response('{}', { status: 500 });
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key, i) => [
            key,
            { type: 'noul', noul: Array.isArray(next) ? next[i] : next },
          ]),
        ),
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  };
  return { calls, fetch };
}
export function typesafe(agentDir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'typesafe.json'),
    JSON.stringify({ hindsight: { enabled: true }, ...extra }),
  );
}
