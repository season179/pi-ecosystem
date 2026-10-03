import { afterEach, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_TYPE, DELIVERY_TYPE } from '../src/retrieval.js';
import { retrievalFixture } from './retrieval-support.js';

const roots: string[] = [];
afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const theme = { fg: (_name: string, text: string) => text };

it('one above-editor indicator; header click toggles only its receipt, exact text and honest release/invalidation survive resume', async () => {
  const r = mkdtempSync(join(tmpdir(), 'hindsight-ui-'));
  roots.push(r);
  const f = retrievalFixture(r, [0.9, 0.9, 0.9]);
  await f.send('task');
  await f.ready();
  const first = await f.stage();
  const render = f.ext.renderers.get(CONTEXT_TYPE)!;
  const component = render(first, { expanded: false, outputPad: 1 }, theme);
  expect(component.render(100).join('\n')).toContain('awaiting model request');
  expect(component.render(100).join('\n')).not.toContain(f.server.reflectText);
  await f.release();
  expect(component.render(100).join('\n')).toContain('1 memory injected');
  const widget = f.ext.widgets.get('pi-hindsight-memory')({ requestRender() {} }, theme);
  expect(widget.render(30)[0].length).toBeLessThanOrEqual(30);
  expect(f.ext.status).not.toContain('retrieval'); // no new footer noise
  component.handleMouse({ type: 'click', button: 'left', x: 1, y: 0, width: 100, height: 1 });
  expect(component.render(100).join('\n')).toContain('▾ Hindsight');
  expect(component.render(48).every((line: string) => visibleWidth(line) <= 48)).toBe(true);
  // Wide render allows byte-for-byte equality independent of wrapping.
  expect(
    component
      .render(10000)
      .map((line: string) => line.trimEnd())
      .join('\n'),
  ).toContain(first.content);
  component.handleMouse({ type: 'click', button: 'left', x: 1, y: 0, width: 100, height: 1 });
  expect(component.render(100).join('\n')).not.toContain(f.server.reflectText);
  f.manager.appendCustomEntry(DELIVERY_TYPE, {
    action: 'invalidate',
    ids: [first.details.hindsight.deliveryId],
  });
  expect(component.render(100).join('\n')).toContain('invalidated');
  // Pi global Ctrl+O drives the expanded renderer option; local clicks do not override a new global value.
  const globalExpanded = render(first, { expanded: true, outputPad: 1 }, theme);
  expect(
    globalExpanded
      .render(10000)
      .map((line: string) => line.trimEnd())
      .join('\n'),
  ).toContain(first.content);
  await f.ext.emit('agent_settled');
  await f.ext.emit('session_start');
  const resumed = render(first, { expanded: false, outputPad: 1 }, theme);
  expect(resumed.render(100).join('\n')).toContain('invalidated');
  const notify: string[] = [];
  f.ext.ctx.ui.notify = (text) => {
    notify.push(text);
  };
  await f.ext.commands.get('hindsight').handler('memories', f.ext.ctx);
  expect(notify[0]).toContain(first.content);
  // A second receipt has independent local expansion state.
  f.server.reflectText = 'Different selected memory';
  await f.send('next task');
  await f.ready();
  const second = await f.stage();
  await f.release();
  const other = render(second, { expanded: false, outputPad: 1 }, theme);
  expect(other.render(100).join('\n')).not.toContain(f.server.reflectText);
  await f.ext.emit('agent_settled');
  f.server.reflectText = 'Never released memory';
  await f.send('last task');
  await f.ready();
  const undelivered = await f.stage();
  await f.ext.emit('agent_settled');
  expect(
    render(undelivered, { expanded: false, outputPad: 1 }, theme).render(100).join('\n'),
  ).toContain('not delivered');
  await f.ext.commands.get('hindsight').handler('memories', f.ext.ctx);
  expect(notify.at(-1)).toContain('(never delivered; no injected memory)');
  expect(notify.at(-1)).not.toContain(undelivered.content);
});
