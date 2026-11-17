import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh garage database for every run, separate from the real app's data.
const dataDir = mkdtempSync(join(tmpdir(), "ffgp-e2e-"));

export default defineConfig({
  testDir: "apps/desktop/test",
  testMatch: "workflow.spec.ts",
  outputDir: "test-results",
  timeout: 60_000,
  use: { baseURL: "http://localhost:5180", viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  webServer: [
    { command: "npm run dev:server -w @ffgp/server", url: "http://127.0.0.1:4780/api/health", env: { FFGP_DATA: dataDir, PORT: "4780" }, reuseExistingServer: false },
    { command: "npm run web -w @ffgp/desktop", url: "http://localhost:5180", reuseExistingServer: false },
  ],
});
