import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  Container,
  MouseRegion,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from '@earendil-works/pi-tui';
import {
  CONTEXT_TYPE,
  deliveryKey,
  deliveryState,
  injections,
  type ContextEntry,
} from './retrieval.js';

/** UI reads the actual stored message; only delivery metadata is duplicated. */
export function createRetrievalUI(pi: ExtensionAPI, pendingId: () => string | undefined) {
  let context: ExtensionContext | undefined;
  let tui: TUI | undefined;
  let status = '';
  const expanded = new Map<string, { global: boolean; local: boolean }>();
  const state = (entry: Pick<ContextEntry, 'content' | 'details'>) => {
    if (!context) return 'not delivered';
    const branch = context.sessionManager.getBranch();
    const { released } = deliveryState(branch);
    // Curation is bank truth even after returning to a pre-curation branch.
    const { invalidated } = deliveryState(context.sessionManager.getEntries());
    const id = deliveryKey(entry);
    if (invalidated.has(id))
      return !entry.details?.hindsight?.late || released.has(id) ? 'invalidated' : 'not delivered';
    if (!entry.details?.hindsight?.late || released.has(id)) return 'injected';
    return id === pendingId() ? 'selected, awaiting model request' : 'not delivered';
  };
  pi.registerMessageRenderer<ContextEntry['details']>(CONTEXT_TYPE, (message, options, theme) => {
    const id = deliveryKey(message);
    const previous = expanded.get(id);
    if (!previous || previous.global !== options.expanded)
      expanded.set(id, { global: options.expanded, local: options.expanded });
    let rendered: Container | undefined;
    const component: Component = {
      render(width) {
        const open = expanded.get(id)?.local ?? false;
        const candidates = message.details?.hindsight?.candidates ?? [];
        const scopes = [...new Set(candidates.map((c) => c.scope))].join(' + ');
        const label = `${open ? '▾' : '▸'} Hindsight · ${candidates.length || 'Legacy'} memor${candidates.length === 1 ? 'y' : 'ies'} ${state(message)}${scopes ? ` · ${scopes}` : ''}`;
        rendered = new Container();
        rendered.addChild(
          new MouseRegion(new Text(theme.fg('muted', label), 0, 0), (event) => {
            if (event.type !== 'click' || event.button !== 'left') return undefined;
            const value = expanded.get(id)!;
            value.local = !value.local;
            tui?.requestRender();
            return { handled: true };
          }),
        );
        if (open) {
          if (candidates.length)
            rendered.addChild(
              new Text(
                theme.fg(
                  'dim',
                  candidates
                    .map((c) => `${c.scope} · ${JSON.stringify(c.bank)} · ${JSON.stringify(c.id)}`)
                    .join('\n'),
                ),
                0,
                0,
              ),
            );
          rendered.addChild(
            new Text(
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
              0,
              0,
            ),
          );
        }
        return rendered.render(width);
      },
      invalidate() {
        rendered?.invalidate();
      },
      handleMouse(event: TuiMouseEvent) {
        return rendered?.handleMouse(event);
      },
    };
    return component; // undefined would expose Pi's full-content fallback.
  });
  return {
    bind(ctx: ExtensionContext) {
      context = ctx;
      expanded.clear();
      status = '';
      tui = undefined;
      if (ctx.mode === 'tui') ctx.ui.setWidget('pi-hindsight-memory', undefined);
      ctx.ui.setStatus('pi-hindsight-retrieval', undefined);
    },
    note(ctx: ExtensionContext, text: string) {
      context = ctx;
      status = text;
      if (ctx.mode === 'tui')
        ctx.ui.setWidget(
          'pi-hindsight-memory',
          (host, theme) => {
            tui = host;
            return {
              invalidate() {},
              render(width) {
                const text = truncateToWidth(`[memory: ${status}]`, width);
                return [
                  ' '.repeat(Math.max(0, width - visibleWidth(text))) + theme.fg('dim', text),
                ];
              },
            };
          },
          { placement: 'aboveEditor' },
        );
      tui?.requestRender();
    },
    refresh(ctx: ExtensionContext) {
      context = ctx;
      tui?.requestRender();
    },
    inspect(ctx: ExtensionContext) {
      context = ctx;
      const entries = injections(ctx.sessionManager.getBranch());
      return entries.length
        ? entries
            .map((e) => {
              const status = state(e);
              return `Hindsight · ${deliveryKey(e)} · ${status}\n${status === 'injected' || status === 'invalidated' ? e.content : '(never delivered; no injected memory)'}`;
            })
            .join('\n\n')
        : 'No automatic memory deliveries on this branch.';
    },
  };
}
