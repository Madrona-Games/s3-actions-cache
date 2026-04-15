import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@actions/cache/lib/internal/cacheUtils": path.resolve(
        __dirname,
        "node_modules/@actions/cache/lib/internal/cacheUtils.js",
      ),
      "@actions/cache/lib/internal/constants": path.resolve(
        __dirname,
        "node_modules/@actions/cache/lib/internal/constants.js",
      ),
      "@actions/cache/lib/internal/tar": path.resolve(
        __dirname,
        "node_modules/@actions/cache/lib/internal/tar.js",
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    exclude: ["__tests__/integration/**"],
    setupFiles: ["./__tests__/setupTests.ts"],
  },
});
