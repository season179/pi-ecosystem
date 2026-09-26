// Derived from official 0.7.0 core/hindsight.ts and knowledge-tools.ts (MIT).
// Patch: only Retain/Reflect/page reads; guarded abortable transport, no setup/deletes/retries.
import type { ObservationScopes } from './defaults.js';

export interface RetainOptions {
  timestamp: string;
  metadata: Record<string, string>;
  operationId: string;
}
export interface ClientOptions {
  apiUrl: string; apiToken?: string; bank: string;
  observationScopes: ObservationScopes;
  guard: () => void;
  signal: AbortSignal;
  fetch?: typeof fetch;
}
export class HindsightClient {
  constructor(readonly options: ClientOptions) {}
  bankUrl(suffix = ''): string {
    return `${this.options.apiUrl.replace(/\/$/, '')}/v1/default/banks/${encodeURIComponent(this.options.bank)}${suffix}`;
  }
  async request(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, allowMissing = false): Promise<any> {
    const { signal, guard } = this.options;
    guard(); signal.throwIfAborted();
    // Also bound fetch implementations that fail to honor AbortSignal.
    return await new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Hindsight request cancelled or deadline exceeded; write outcome may be unknown'));
      signal.addEventListener('abort', abort, { once: true });
      void (async () => {
        try {
          const response = await (this.options.fetch ?? fetch)(url, {
            method, signal, redirect: 'error',
            headers: { 'Content-Type': 'application/json', ...(this.options.apiToken ? { Authorization: `Bearer ${this.options.apiToken}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          guard(); signal.throwIfAborted();
          if (response.status === 404 && allowMissing) { await response.body?.cancel(); resolve(undefined); return; }
          if (!response.ok) { await response.body?.cancel(); throw new Error(`Hindsight HTTP ${response.status}; no automatic retry`); }
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = []; let bytes = 0;
          if (reader) try {
            for (;;) {
              const part = await reader.read(); guard(); signal.throwIfAborted();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 1_048_576) { await reader.cancel(); throw new Error('Hindsight response exceeds safety limit'); }
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          // Never expose fetch URLs, tokens, server bodies or parser excerpts.
          reject(error instanceof Error && error.message.startsWith('Hindsight ') ? error : new Error('Hindsight request failed; write outcome may be unknown'));
        } finally { signal.removeEventListener('abort', abort); }
      })();
    });
  }
  async supportsIdempotentRetain(): Promise<boolean> {
    const value = await this.request('GET', `${this.options.apiUrl.replace(/\/$/, '')}/version`);
    const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(value?.api_version ?? '');
    if (!match) return false;
    const [, major, minor, patch] = match.map(Number);
    return major > 0 || minor > 8 || (minor === 8 && patch >= 6);
  }
  async retain(content: string, context: string, documentId: string, tags: string[], strategy: string, opts: RetainOptions): Promise<string> {
    const configured = this.options.observationScopes;
    const scopes = configured === 'per_source'
      ? [[], ...[...new Set(tags.filter(t => t.startsWith('source:')))].sort().map(t => [t])]
      : configured;
    const value = await this.request('POST', this.bankUrl('/memories'), {
      items: [{ content, context, document_id: documentId, tags, strategy,
        observation_scopes: scopes, timestamp: opts.timestamp, metadata: opts.metadata,
        update_mode: 'append' }],
      async: true, operation_id: opts.operationId,
    });
    if (value?.operation_id !== opts.operationId) throw new Error('Hindsight did not confirm the deterministic operation ID; outcome unknown');
    return value.operation_id;
  }
  document(id: string): Promise<any> {
    return this.request('GET', this.bankUrl(`/documents/${encodeURIComponent(id)}`), undefined, true);
  }
  async operation(id: string): Promise<any> {
    const value = await this.request('GET', this.bankUrl(`/operations/${encodeURIComponent(id)}`), undefined, true);
    if (value === undefined) return undefined;
    if (value.operation_id !== id) throw new Error('Hindsight operation identity mismatch');
    return value.status === 'not_found' ? undefined : value;
  }
  async reflect(query: string, budget: string): Promise<string> {
    const value = await this.request('POST', this.bankUrl('/reflect'), { query, budget });
    if (typeof value?.text !== 'string') throw new Error('Hindsight invalid Reflect response');
    return value.text.trim();
  }
  async searchKnowledgePages(query: string, limit: number): Promise<unknown> {
    // Missing API is an error, not a fabricated empty result or automatic generation.
    const value = await this.request('GET', this.bankUrl(`/knowledge-base/search?q=${encodeURIComponent(query)}&limit=${limit}`));
    if (!Array.isArray(value?.results)) throw new Error('Hindsight invalid knowledge-page search response');
    return value.results.map((x: any) => ({ id: x.id, name: x.name, snippet: x.snippet ?? '', score: x.score ?? 0 }));
  }
  async getPage(id: string): Promise<unknown> {
    return shapePage(await this.request('GET', this.bankUrl(`/knowledge-base/pages/${encodeURIComponent(id)}`)));
  }
  /** Fact detail (0.10.1): the kind is `type`, unlike list items' `fact_type`. */
  fact(id: string): Promise<any> {
    return this.request('GET', this.bankUrl(`/memories/${encodeURIComponent(id)}`));
  }
  curate(id: string, patch: Record<string, string>): Promise<any> {
    return this.request('PATCH', this.bankUrl(`/memories/${encodeURIComponent(id)}`), patch);
  }
  /** Request (not await) regeneration of this bank's pages after curation; returns accepted page IDs. */
  async refreshPages(max: number): Promise<string[]> {
    const value = await this.request('GET', this.bankUrl(`/mental-models?limit=${max}`));
    if (!Array.isArray(value?.items)) throw new Error('Hindsight invalid page list response');
    const accepted: string[] = [];
    for (const page of value.items.slice(0, max)) {
      if (typeof page?.id !== 'string') continue;
      await this.request('POST', this.bankUrl(`/mental-models/${encodeURIComponent(page.id)}/refresh`));
      accepted.push(page.id);
    }
    return accepted;
  }
}
// Official page response shaping: don't send body twice or the generation trace.
export function shapePage(page: unknown): unknown {
  const p = (page ?? {}) as Record<string, unknown>;
  const body = typeof p.body === 'string' && p.body.trim() ? p.body : p.markdown;
  return { id: p.id, name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(Array.isArray(p.tags) && p.tags.length ? { tags: p.tags } : {}),
    ...(p.timestamp ? { last_updated_at: p.timestamp } : {}), body };
}
