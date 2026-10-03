import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Local JS build helper, deliberately not part of the runtime package.
import { piPaths } from '../scripts/pi-path.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installedPi(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'pi-hindsight-resolver-'));
  roots.push(root);
  for (const [path, name] of [
    [root, '@earendil-works/pi-coding-agent'],
    [join(root, 'node_modules/@earendil-works/pi-ai'), '@earendil-works/pi-ai'],
    [join(root, 'node_modules/typebox'), 'typebox'],
  ]) {
    mkdirSync(join(path, 'dist'), { recursive: true });
    writeFileSync(
      join(path, 'package.json'),
      JSON.stringify({ name, version, main: './dist/index.js' }),
    );
    writeFileSync(join(path, 'dist/index.js'), 'export {};\n');
  }
  vi.stubEnv('PI_HINDSIGHT_PI_ROOT', root);
  return root;
}

it.each(['1.0.0', '2.0.0'])(
  'resolves installed Pi %s and its own dependencies without a release pin',
  (version) => {
    const root = installedPi(version);
    expect(piPaths()).toEqual({
      '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
      '@earendil-works/pi-ai': join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
      typebox: join(root, 'node_modules/typebox/dist/index.js'),
    });
  },
);

it('rejects an invalid explicit installation instead of falling back to another Pi', () => {
  const root = installedPi('1.0.0');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'not-pi', version: '1.0.0' }));
  expect(() => piPaths()).toThrow('PI_HINDSIGHT_PI_ROOT');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }),
  );
  rmSync(join(root, 'dist/index.js'));
  expect(() => piPaths()).toThrow('PI_HINDSIGHT_PI_ROOT');
});
