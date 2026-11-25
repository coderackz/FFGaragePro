import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FLEETFIX_SUPPLIER_ID } from "@ffgp/shared";
import { Db, newId } from "../src/db";
import { addUser, call, createPart, makeApp, setUp, tempDir, type App } from "./helpers";

export async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const advisor = await addUser(app, owner, "advisor");
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  const jobCard = async (lines: unknown[], type = "jobcard") =>
    (await call(app, "POST", "/api/documents", owner, { type, customerId: customer.id, lines })).body.document;
  return { app, owner, advisor, customer, jobCard };
}
export const USED = { kind: "part", description: "Alternator", qty: 1, unitPriceFils: 30000, discountPct: 0, condition: "used" };

/** A used purchase for a job written straight to the database (the API for it has its own tests). */
function boughtUsed(app: App, docId: string, position: number, days: number | null, on: string): string {
  const { db } = app;
  const [po, line, receipt] = [newId(), newId(), newId()];
  const t = "2026-11-26T08:00:00.000Z";
  db.run("INSERT INTO purchase_orders (id, series, seq, number, supplier_id, status, created_at, updated_at) VALUES (?, '', 900, 'PO-00900', ?, 'received', ?, ?)", [po, FLEETFIX_SUPPLIER_ID, t, t]);
  db.run(
    `INSERT INTO po_lines (id, po_id, position, description, qty, received_qty, unit_cost_fils, job_document_id, condition, warranty_days, created_at, updated_at)
     VALUES (?, ?, 0, 'Alternator', 1, 1, 15000, ?, 'used', ?, ?, ?)`, [line, po, docId, days, t, t]);
  db.run("INSERT INTO goods_receipts (id, po_id, supplier_invoice_date, net_fils, vat_fils, gross_fils, created_at) VALUES (?, ?, ?, 15000, 0, 15000, ?)", [receipt, po, on, t]);
  db.run("INSERT INTO goods_receipt_lines (id, receipt_id, po_line_id, qty, unit_cost_fils, core_fils) VALUES (?, ?, ?, 1, 15000, 0)", [newId(), receipt, line]);
  db.run("UPDATE document_lines SET po_line_id = ? WHERE document_id = ? AND position = ?", [line, docId, position]);
  return line;
}

describe("used on document lines", () => {
  it("carries from estimate to job card to invoice to credit note", async () => {
    const { app, owner, jobCard } = await world();
    const est = await jobCard([USED, { ...USED, description: "Belt", condition: "new" }], "estimate");
    const jc = (await call(app, "POST", `/api/documents/${est.id}/convert`, owner, {})).body.document;
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    for (const d of [est, jc, inv]) expect(d.lines.map((l: any) => l.condition)).toEqual(["used", "new"]);
    expect((await call(app, "POST", `/api/documents/${inv.id}/issue`, owner, {})).status).toBe(200);
    const cn = await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "Goodwill", returnToStock: false });
    expect(cn.body.document.lines.map((l: any) => l.condition)).toEqual(["used", "new"]);
  });

  it("a save that doesn't send the condition keeps it; another line in its place is new", async () => {
    const { app, owner, jobCard } = await world();
    const part = await createPart(app, owner);
    const jc = await jobCard([USED]);
    const { condition: _c, ...older } = USED;
    const same = await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...older, qty: 2 }] });
    expect(same.body.document.lines[0]).toMatchObject({ condition: "used", qty: 2 });
    const other = await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...older, description: "Oil filter", partId: part.id }] });
    expect(other.body.document.lines[0]).toMatchObject({ condition: "new", partId: part.id });
  });

  it("an older screen picking a part with the same text makes it a new part", async () => {
    const { app, owner, jobCard } = await world();
    const part = await createPart(app, owner, { name: "Alternator" });
    const jc = await jobCard([USED]);
    const { condition: _c, ...older } = USED;
    const res = await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...older, partId: part.id }] });
    expect(res.body.document.lines[0]).toMatchObject({ condition: "new", partId: part.id });
  });

  it("is refused with a part or from Fleet Fix, and moves no stock", async () => {
    const { app, owner, jobCard } = await world();
    const part = await createPart(app, owner);
    const jc = await jobCard([USED]);
    const put = (l: object) => call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...USED, ...l }] });
    expect((await put({ partId: part.id })).status).toBe(400);
    expect((await put({ suppliedBy: "fleetfix" })).status).toBe(400);
    expect(app.db.all("SELECT * FROM stock_movements")).toEqual([]);
  });

  it("once bought it can't become new, and keeps its purchase and warranty when its text changes", async () => {
    const { app, owner, advisor, jobCard } = await world();
    const jc = await jobCard([USED]);
    const poLineId = boughtUsed(app, jc.id, 0, 7, "2026-11-26");
    const seen = { condition: "used", poLineId, purchasedOn: "2026-11-26", warrantyDays: 7, warrantyUntil: "2026-12-03" };
    expect((await call(app, "GET", `/api/documents/${jc.id}`, advisor)).body.document.lines[0]).toMatchObject(seen);
    const res = await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...USED, description: "Alternator 90A", condition: "new", poLineId }] });
    expect(res.body.document.lines[0]).toMatchObject({ ...seen, description: "Alternator 90A" });
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    expect(inv.lines[0]).toMatchObject(seen);
  });

  it("no warranty, and a used line not bought yet", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED, USED]);
    boughtUsed(app, jc.id, 0, null, "2026-11-26");
    const doc = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document;
    expect(doc.lines[0]).toMatchObject({ purchasedOn: "2026-11-26", warrantyDays: null, warrantyUntil: null });
    expect(doc.lines[1]).toMatchObject({ purchasedOn: null, warrantyDays: null, warrantyUntil: null });
  });

  it("a garage from before opens with every line new", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 27 });
    const t = "2026-11-01T08:00:00.000Z";
    old.run("INSERT INTO customers (id, kind, name, created_at, updated_at) VALUES ('c1', 'individual', 'A', ?, ?)", [t, t]);
    old.run("INSERT INTO documents (id, type, series, seq, number, status, customer_id, created_at, updated_at) VALUES ('d1', 'jobcard', '', 1, 'JC-1', 'open', 'c1', ?, ?)", [t, t]);
    old.run("INSERT INTO document_lines (id, document_id, position, kind, description, qty, unit_price_fils, net_fils, vat_fils, gross_fils) VALUES ('l1', 'd1', 0, 'part', 'Belt', 1, 100, 100, 5, 105)");
    old.close();
    const db = new Db(file);
    expect(db.get("SELECT condition FROM document_lines")).toEqual({ condition: "new" });
    db.close();
  });
});
