import { describe, expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";
import { getConfig, recordFailure, retryAll, saveConfig } from "../src/integrations/store";

const OPTS = { integrations: { publicUrl: "https://cloud.test", garageCode: "ABC123" } };

describe("integrations core", () => {
  it("not available on a PC", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const res = await call(app, "GET", "/api/integrations", owner);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false });
    expect((await call(app, "POST", "/api/integrations/zoho/disconnect", owner, {})).status).toBe(404);
  });

  it("secrets never returned; the status row syncs without them", async () => {
    const app = await makeApp(undefined, OPTS);
    const owner = await setUp(app);
    const user = app.db.get<{ id: string }>("SELECT id FROM users LIMIT 1")!.id;
    saveConfig(app.db, user, "whatsapp", { phoneNumberId: "1", accessToken: "SECRET", appSecret: "SECRET2", label: "+971 4 000 0000" });
    expect(getConfig<{ accessToken: string }>(app.db, "whatsapp")?.accessToken).toBe("SECRET");
    const res = await call(app, "GET", "/api/integrations", owner);
    expect(res.body).toMatchObject({ available: true, hookBase: "https://cloud.test/api/hooks/ABC123", status: { whatsapp: { connected: true, label: "+971 4 000 0000" } } });
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
    const row = app.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'integration.status'")!;
    expect(row.value).toContain("+971 4 000 0000");
    expect(row.value).not.toContain("SECRET");
    expect(app.db.get("SELECT 1 AS x FROM audit_log WHERE entity_id = 'integration.whatsapp'")).toEqual({ x: 1 });
    expect((await call(app, "POST", "/api/integrations/whatsapp/disconnect", owner, {})).status).toBe(200);
    expect(getConfig(app.db, "whatsapp")).toBeNull();
    expect((await call(app, "GET", "/api/integrations", owner)).body.status.whatsapp).toBeUndefined();
  });

  it("failure backoff, then waits for Retry all", async () => {
    const app = await makeApp(undefined, OPTS);
    const t0 = Date.parse("2026-11-20T08:00:00Z");
    const nexts: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      recordFailure(app.db, "zoho", "invoice", "d1", "INV-00001", "Zoho said: no", new Date(t0));
      nexts.push(app.db.get<{ n: string | null }>("SELECT next_attempt_at AS n FROM integration_failures")!.n);
    }
    expect(nexts.map((n) => (n ? (Date.parse(n) - t0) / 60_000 : null))).toEqual([1, 5, 30, 120, 360, null]);
    retryAll(app.db, "zoho");
    expect(app.db.get("SELECT attempts, next_attempt_at FROM integration_failures")).toEqual({ attempts: 0, next_attempt_at: null });
  });
});
