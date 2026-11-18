import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fleetfix Cloud in a browser: the web build served by @ffgp/cloud on a fresh data folder.
const dataDir = mkdtempSync(join(tmpdir(), "ffgp-cloud-e2e-"));

export default defineConfig({
  testDir: "apps/desktop/test",
  testMatch: "cloud.spec.ts",
  outputDir: "test-results/cloud",
  timeout: 150_000,
  use: { baseURL: "http://localhost:4791", viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  webServer: {
    command: "npm run web:cloud -w @ffgp/desktop && npm run dev -w @ffgp/cloud",
    url: "http://localhost:4791/api/health",
    env: { FFGP_CLOUD_DATA: dataDir, PORT: "4791", FFGP_CLOUD_STAFF: "fleetfix:Fleet Fix Admin:admin-pass-1" },
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
