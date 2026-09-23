import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: resolve(packageRoot, "../.."),
    include: ["packages/pi-accounts/test/**/*.test.ts"],
    setupFiles: [resolve(packageRoot, "test/setup.ts")],
  },
});
