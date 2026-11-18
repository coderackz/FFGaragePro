import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PC ↔ cloud: the desktop app (built) syncing with Fleetfix Cloud on a fresh data folder, plus the browser app.
const dataDir = mkdtempSync(join(tmpdir(), "ffgp-sync-e2e-"));

export default defineConfig({
  testDir: "apps/desktop/test",
  testMatch: "cloud-sync.spec.ts",
  outputDir: "test-results/sync",
  timeout: 240_000,
  workers: 1,
  use: { baseURL: "http://localhost:4792", viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  webServer: {
    command: "npm run web:cloud -w @ffgp/desktop && npm run dev -w @ffgp/cloud",
    url: "http://localhost:4792/api/health",
    env: { FFGP_CLOUD_DATA: dataDir, PORT: "4792", FFGP_CLOUD_STAFF: "fleetfix:Fleet Fix Admin:admin-pass-1" },
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
