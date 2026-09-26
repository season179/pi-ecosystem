#!/usr/bin/env node
// Bundle scripts/claude-stop-guard.mjs with its vendored config/bank/client modules into ONE
// dependency-free file for ~/.hindsight/pi-hindsight/ (0600). Run `npm run build` first.
// esbuild comes from the workspace toolchain (vitest -> vite); this operator script is not shipped.
//   node scripts/bundle-claude-guard.mjs <out.mjs>
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) { console.error('usage: bundle-claude-guard.mjs <out.mjs>'); process.exit(2); }
await build({ entryPoints: [fileURLToPath(new URL('./claude-stop-guard.mjs', import.meta.url))], outfile: out,
  bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'warning', legalComments: 'inline' });
chmodSync(out, 0o600);
console.log(`bundled ${out} sha256 ${createHash('sha256').update(readFileSync(out)).digest('hex')}`);
