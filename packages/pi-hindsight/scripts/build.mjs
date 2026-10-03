import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { piPaths } from './pi-path.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'pi-hindsight-types-'));
const check = process.argv.includes('--check-tests');
try {
  const paths = Object.fromEntries(
    Object.entries(piPaths()).map(([k, v]) => [k, [v.replace(/\.js$/, '.d.ts')]]),
  );
  const config = {
    extends: join(root, 'tsconfig.json'),
    compilerOptions: { paths, ...(check ? { noEmit: true, rootDir: root } : {}) },
    include: [join(root, 'src/**/*.ts'), ...(check ? [join(root, 'test/**/*.ts')] : [])],
  };
  writeFileSync(join(temp, 'tsconfig.json'), JSON.stringify(config));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', join(temp, 'tsconfig.json')], {
    stdio: 'inherit',
    cwd: root,
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
