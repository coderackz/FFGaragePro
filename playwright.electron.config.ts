import { defineConfig } from "@playwright/test";

// Desktop-app tests only: no dev servers, the app starts its own.
export default defineConfig({
  testDir: "apps/desktop/test",
  testMatch: ["electron.spec.ts", "network.spec.ts"],
  outputDir: "test-results/electron",
  timeout: 240_000,
  workers: 1,
});
