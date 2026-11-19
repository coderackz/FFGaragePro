import { afterEach, describe, expect, it } from "vitest";
import { installCapture, localChanges } from "../src/index";
import { call, createPart, garageApp, setUp, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function linkedGarage() {
  const app = await garageApp();
  apps.push(app);
  const token = await setUp(app);
  installCapture(app.db, "local");
  return { app, token };
}

const LINES = [
  { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 },
  { kind: "other", description: "Shop supplies", qty: 1, unitPriceFils: 500, discountPct: 0 },
];

describe("change capture", () => {
  it("local and network settings are never captured", async () => {
    const { app } = await linkedGarage();
    const before = localChanges(app.db, 0).length;
    app.db.run("INSERT INTO settings (key, value) VALUES ('local.backup.folder', '\"C:/x\"'), ('network.sharing', '1')");
    app.db.run("UPDATE settings SET value = '\"D:/y\"' WHERE key = 'local.backup.folder'");
    app.db.run("DELETE FROM settings WHERE key = 'local.backup.folder'");
    expect(localChanges(app.db, 0).length).toBe(before);
    app.db.run("INSERT INTO settings (key, value) VALUES ('pricing.labourRateFils', '18000')");
    expect(localChanges(app.db, 0).filter((e) => e.table === "settings")).toHaveLength(1);
  });

  it("prints and audit rows travel insert-only", async () => {
    const { app, token } = await linkedGarage();
    const me = (await call(app, "GET", "/api/me", token)).body.user;
    const c = (await call(app, "POST", "/api/customers", token, { name: "Ahmed" })).body.customer;
    const doc = (await call(app, "POST", "/api/documents", token, { type: "estimate", customerId: c.id, lines: LINES })).body.document;
    app.db.run("INSERT INTO document_prints (id, document_id, user_id, printed_at) VALUES ('p1', ?, ?, '2026-11-19T00:00:00.000Z')", [doc.id, me.id]);
    app.db.run("INSERT INTO audit_log (id, action, entity, user_id, created_at) VALUES ('a1', 'settings.change', 'settings', ?, '2026-11-19T00:00:00.000Z')", [me.id]);
    const ops = localChanges(app.db, 0).filter((e) => e.table === "document_prints" || e.table === "audit_log").map((e) => `${e.table}:${e.op}`);
    expect(ops).toEqual(["document_prints:insert", "audit_log:insert"]);
  });

  it("creating a customer logs an insert with the whole row", async () => {
    const { app, token } = await linkedGarage();
    const c = (await call(app, "POST", "/api/customers", token, { name: "Ahmed", phone: "050 1" })).body.customer;
    const entries = localChanges(app.db, 0).filter((e) => e.table === "customers");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: "insert", rowId: c.id, origin: "local", changed: null });
    expect(entries[0]!.data).toMatchObject({ id: c.id, name: "Ahmed", phone: "050 1", kind: "individual" });
    expect(entries[0]!.originSeq).toBe(entries[0]!.seq);
  });

  it("editing only the phone logs an update with changed ['phone','updated_at']", async () => {
    const { app, token } = await linkedGarage();
    const c = (await call(app, "POST", "/api/customers", token, { name: "Ahmed", phone: "050 1" })).body.customer;
    await new Promise((r) => setTimeout(r, 5));
    await call(app, "PATCH", `/api/customers/${c.id}`, token, { phone: "050 2" });
    const update = localChanges(app.db, 0).filter((e) => e.table === "customers" && e.op === "update");
    expect(update).toHaveLength(1);
    expect(update[0]!.changed).toEqual(["phone", "updated_at"]);
    expect(update[0]!.data).toMatchObject({ name: "Ahmed", phone: "050 2" });
  });

  it("a stock movement logs the movement insert but no update of parts.on_hand/avg_cost", async () => {
    const { app, token } = await linkedGarage();
    const part = await createPart(app, token);
    const before = localChanges(app.db, 0).length;
    await call(app, "POST", `/api/parts/${part.id}/adjustments`, token, { reason: "opening", qty: 4, unitCostFils: 2000 });
    const after = localChanges(app.db, 0).slice(before);
    expect(after.filter((e) => e.table === "stock_movements" && e.op === "insert")).toHaveLength(1);
    for (const e of after.filter((x) => x.table === "parts")) {
      expect(e.changed).not.toContain("on_hand");
      expect(e.changed).not.toContain("avg_cost_fils");
      expect(e.data).not.toHaveProperty("on_hand");
      expect(e.data).not.toHaveProperty("avg_cost_fils");
    }
  });

  it("saving a job card's lines logs `set` entries whose last data equals the saved lines", async () => {
    const { app, token } = await linkedGarage();
    const c = (await call(app, "POST", "/api/customers", token, { name: "Ahmed" })).body.customer;
    const doc = (await call(app, "POST", "/api/documents", token, { type: "jobcard", customerId: c.id, lines: LINES })).body.document;
    await call(app, "PUT", `/api/documents/${doc.id}/lines`, token, { lines: [LINES[1]] });
    const sets = localChanges(app.db, 0).filter((e) => e.table === "document_lines");
    expect(sets.every((e) => e.op === "set" && e.rowId === doc.id)).toBe(true);
    const last = sets.at(-1)!.data as unknown as { description: string; position: number }[];
    expect(last.map((l) => [l.position, l.description])).toEqual([[0, "Shop supplies"]]);
    // Only the latest state of a document's lines is kept: older `set` entries are superseded.
    expect(sets).toHaveLength(1);
    const docEntries = localChanges(app.db, 0).filter((e) => e.table === "documents");
    for (const e of docEntries) expect(e.data).not.toHaveProperty("gross_fils");
  });

  it("network.* settings are not logged", async () => {
    const { app } = await linkedGarage();
    app.db.run("INSERT INTO settings (key, value) VALUES ('network.sharing', '1')");
    app.db.run("INSERT INTO settings (key, value) VALUES ('invoice.footer', 'Thanks')");
    const settings = localChanges(app.db, 0).filter((e) => e.table === "settings");
    expect(settings.map((e) => e.rowId)).toEqual(["invoice.footer"]);
  });

  it("re-installing is harmless", async () => {
    const { app, token } = await linkedGarage();
    installCapture(app.db, "local");
    installCapture(app.db, "local");
    await call(app, "POST", "/api/customers", token, { name: "Ahmed" });
    expect(localChanges(app.db, 0).filter((e) => e.table === "customers")).toHaveLength(1);
  });

  it("entries written while sync_ctx.origin is 'P1' carry origin 'P1'", async () => {
    const { app, token } = await linkedGarage();
    app.db.run("UPDATE sync_ctx SET origin = 'P1', origin_seq = 7");
    await call(app, "POST", "/api/customers", token, { name: "Ahmed" });
    const row = app.db.get<{ origin: string; origin_seq: number }>("SELECT origin, origin_seq FROM change_log WHERE table_name = 'customers'");
    expect(row).toEqual({ origin: "P1", origin_seq: 7 });
    // Not this database's own change, so it isn't pushed.
    expect(localChanges(app.db, 0).filter((e) => e.table === "customers")).toHaveLength(0);
  });
});
