import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Most tests start a real garage server (password hashing, SQLite files): Windows CI runners
    // can take over Vitest's 5 s default, so allow 30 s everywhere.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
