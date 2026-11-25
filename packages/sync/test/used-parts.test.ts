import { afterEach, describe, expect, it } from "vitest";
import { applyAtCloud, applyAtPc, changesFor, installCapture, localChanges } from "../src/index";
import { call, garageApp, setUp, twin, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const USED = { kind: "part", description: "Alternator", qty: 1, unitPriceFils: 30000, discountPct: 0, condition: "used" };

describe("used parts across computers", () => {
  it("a used line and a purchase's condition and warranty reach the cloud", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    const customer = (await call(A, "POST", "/api/customers", token, { kind: "individual", name: "Ali" })).body.customer;
    const doc = (await call(A, "POST", "/api/documents", token, { type: "jobcard", customerId: customer.id, lines: [USED] })).body.document;
    const supplier = (await call(A, "POST", "/api/suppliers", token, { name: "Scrapyard" })).body.supplier;
    const po = (await call(A, "POST", "/api/purchase-orders", token, { supplierId: supplier.id, notes: null, lines: [{ partId: null, description: "Alternator", qty: 1, unitCostFils: 15000 }] })).body.purchaseOrder;
    A.db.run("UPDATE po_lines SET condition = 'used', warranty_days = 7 WHERE po_id = ?", [po.id]);
    const result = applyAtCloud(C.db, "P1", localChanges(A.db, 0));
    expect(result.issues).toEqual([]);
    expect(C.db.get("SELECT condition FROM document_lines WHERE document_id = ?", [doc.id])).toEqual({ condition: "used" });
    expect(C.db.get("SELECT condition, warranty_days FROM po_lines WHERE po_id = ?", [po.id])).toEqual({ condition: "used", warranty_days: 7 });
  });

  it("two computers buy the same used line offline: both purchases stay, one on the line, the other not charged", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const customer = (await call(A, "POST", "/api/customers", token, { kind: "individual", name: "Ali" })).body.customer;
    const doc = (await call(A, "POST", "/api/documents", token, { type: "jobcard", customerId: customer.id, lines: [USED] })).body.document;
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    const buy = (app: App, cost: number) => call(app, "POST", "/api/used-purchases", token, {
      documentId: doc.id, position: 0, description: "Alternator", qty: 1, seller: { name: "Yard", phone: "0501234567" },
      unitCostFils: cost, purchasedOn: "2026-11-20", bill: null, warrantyDays: 7,
    });
    expect((await buy(A, 15000)).status).toBe(200);
    expect((await buy(C, 12000)).status).toBe(200);
    expect(applyAtCloud(C.db, "P1", localChanges(A.db, 0)).issues).toEqual([]);
    applyAtPc(A.db, changesFor(C.db, 0, "P1"));
    const seen = async (app: App) => (await call(app, "GET", `/api/documents/${doc.id}`, token)).body.document;
    const [a, c] = [await seen(A), await seen(C)];
    for (const d of [a, c]) {
      expect(d.lines).toHaveLength(1);
      expect(d.lines[0]).toMatchObject({ condition: "used", orderStatus: "received" });
      expect(d.uncharged).toHaveLength(1);
      expect(d.partsCostFils).toBe(27000);
    }
    expect(a.uncharged).toEqual(c.uncharged);
    expect(a.lines[0].poLineId).toBe(c.lines[0].poLineId);
  });
});
