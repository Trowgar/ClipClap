import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@clipfast/shared": new URL("./packages/shared/src", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: [
      "tests/**/*.test.ts",
      "packages/**/src/**/__tests__/**/*.test.ts",
      "apps/**/src/**/__tests__/**/*.test.ts",
    ],
    testTimeout: 30000,
  },
});
