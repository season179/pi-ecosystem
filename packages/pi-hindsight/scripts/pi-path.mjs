import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
// Local-only override: never installs or upgrades the workspace's older Pi.
export function piPaths() {
  const candidates = [process.env.PI_HINDSIGHT_PI_ROOT,
    resolve(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent'),
    resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..')].filter(Boolean);
  const root = candidates.find(p => {
    try { return JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version === '0.87.1'; }
    catch { return false; }
  });
  if (!root) throw new Error('Offline checks need Pi 0.87.1; set PI_HINDSIGHT_PI_ROOT to its existing package directory.');
  const fromPi = createRequire(join(root, 'package.json'));
  function entry(name) {
    for (const base of fromPi.resolve.paths(name) ?? []) {
      try {
        const manifest = JSON.parse(readFileSync(join(base, name, 'package.json'), 'utf8'));
        const target = manifest.exports?.['.']?.import;
        return join(base, name, typeof target === 'string' ? target : target?.default ?? manifest.main);
      } catch { /* try next local module root */ }
    }
    throw new Error(`Missing offline Pi dependency: ${name}`);
  }
  return { '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
    '@earendil-works/pi-ai': entry('@earendil-works/pi-ai'), 'typebox': entry('typebox') };

}
