import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backupAll } from "../src/backups";
import { api, garageReady, startCloud } from "./helpers";

describe("nightly backups", () => {
  it("copies admin.db, the licence key and every garage as working databases, and keeps 30 days", async () => {
    const cloud = await startCloud();
    const { token } = await garageReady(cloud, "alquoz-auto");
    await api(cloud.url, "POST", "/api/customers", { garage: "alquoz-auto", token, body: { name: "Backed up" } });
    // An old backup to be pruned, and a recent one to keep.
    mkdirSync(join(cloud.dataDir, "backups", "2026-09-01"), { recursive: true });
    mkdirSync(join(cloud.dataDir, "backups", "2026-11-01"), { recursive: true });

    const dir = backupAll({ dataDir: cloud.dataDir, admin: cloud.admin, now: Date.parse("2026-11-19T01:00:00Z") });
    expect(dir).toBe(join(cloud.dataDir, "backups", "2026-11-19"));
    const g = cloud.admin.garageByCode("alquoz-auto")!;
    const copy = new DatabaseSync(join(dir, "garages", `${g.id}.db`), { readOnly: true });
    expect(copy.prepare("SELECT name FROM customers").get()).toEqual({ name: "Backed up" });
    copy.close();
    const admin = new DatabaseSync(join(dir, "admin.db"), { readOnly: true });
    expect(admin.prepare("SELECT garage_code FROM garages").get()).toEqual({ garage_code: "alquoz-auto" });
    admin.close();
    expect(existsSync(join(dir, "licence-key.pem"))).toBe(true);
    expect(readdirSync(join(cloud.dataDir, "backups")).sort()).toEqual(["2026-11-01", "2026-11-19"]);

    // Running again the same day replaces that day's copy.
    expect(backupAll({ dataDir: cloud.dataDir, admin: cloud.admin, now: Date.parse("2026-11-19T02:00:00Z") })).toBe(dir);
  });
});
