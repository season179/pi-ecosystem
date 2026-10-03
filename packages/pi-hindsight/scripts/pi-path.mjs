import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// Use an installed Pi without downloading it or requiring an exact release.
export function piPaths() {
  const override = process.env.PI_HINDSIGHT_PI_ROOT;
  const candidates =
    override !== undefined
      ? [override]
      : [
          resolve(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent'),
          resolve(
            dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
            '..',
          ),
        ];
  const root = candidates.find((path) => {
    try {
      const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
      return (
        manifest.name === '@earendil-works/pi-coding-agent' &&
        existsSync(join(path, 'dist/index.js'))
      );
    } catch {
      return false;
    }
  });
  if (!root)
    throw new Error(
      override !== undefined
        ? 'PI_HINDSIGHT_PI_ROOT must point to an installed @earendil-works/pi-coding-agent package.'
        : 'Checks need an installed Pi; set PI_HINDSIGHT_PI_ROOT to its package directory.',
    );
  const fromPi = createRequire(join(root, 'package.json'));
  function entry(name) {
    for (const base of fromPi.resolve.paths(name) ?? []) {
      try {
        const manifest = JSON.parse(readFileSync(join(base, name, 'package.json'), 'utf8'));
        const target = manifest.exports?.['.']?.import;
        const path = join(
          base,
          name,
          typeof target === 'string' ? target : (target?.default ?? manifest.main),
        );
        if (existsSync(path)) return path;
      } catch {
        /* try next local module root */
      }
    }
    throw new Error(`Missing offline Pi dependency: ${name}`);
  }
  return {
    '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
    '@earendil-works/pi-ai': entry('@earendil-works/pi-ai'),
    '@earendil-works/pi-tui': entry('@earendil-works/pi-tui'),
    typebox: entry('typebox'),
  };
}
