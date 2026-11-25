import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Used parts (ticked on a job card, bought, printed, taken off), in the browser, on a fresh garage database of their own.
const dataDir = mkdtempSync(join(tmpdir(), "ffgp-e2e-used-"));

export default defineConfig({
  testDir: "apps/desktop/test",
  testMatch: "used.spec.ts",
  outputDir: "test-results",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: "http://localhost:5180", viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  webServer: [
    { command: "npm run dev:server -w @ffgp/server", url: "http://127.0.0.1:4780/api/health", env: { FFGP_DATA: dataDir, PORT: "4780" }, reuseExistingServer: false },
    { command: "npm run web -w @ffgp/desktop", url: "http://localhost:5180", reuseExistingServer: false },
  ],
});
