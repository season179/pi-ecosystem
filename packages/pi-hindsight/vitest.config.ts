import { defineConfig } from 'vitest/config';
// @ts-expect-error Local JS build helper, deliberately not part of the runtime package.
import { piPaths } from './scripts/pi-path.mjs';
export default defineConfig({
  resolve: { alias: piPaths() },
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    setupFiles: ['./test/isolation.ts'],
    testTimeout: 15000,
  },
});
