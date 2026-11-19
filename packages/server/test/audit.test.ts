import { describe, expect, it } from "vitest";
import { audit } from "../src/audit";
import { call, makeApp, setUp } from "./helpers";

describe("audit log", () => {
  it("audit writes who, what, where", async () => {
    const app = await makeApp();
    const token = await setUp(app);
    const me = (await call(app, "GET", "/api/me", token)).body.user;
    audit(app.db, { action: "settings.change", entity: "settings", entityId: "pricing", before: { a: 1 }, after: { a: 2 }, userId: me.id });
    const row = app.db.get<{ before: string; after: string; device: string; created_at: string; user_id: string; entity_id: string }>(
      "SELECT * FROM audit_log",
    )!;
    expect(row.before).toBe('{"a":1}');
    expect(row.after).toBe('{"a":2}');
    expect(row.entity_id).toBe("pricing");
    expect(row.user_id).toBe(me.id);
    expect(row.device.length).toBeGreaterThan(0);
    expect(new Date(row.created_at).toISOString()).toBe(row.created_at);
  });

  it("migration 7 adds prices_include_vat defaulting to 0", async () => {
    const app = await makeApp();
    const cols = app.db.all<{ name: string; dflt_value: string | null }>("PRAGMA table_info(documents)");
    expect(cols.find((c) => c.name === "prices_include_vat")?.dflt_value).toBe("0");
    expect(app.db.all("PRAGMA table_info(document_prints)").length).toBeGreaterThan(0);
  });
});
