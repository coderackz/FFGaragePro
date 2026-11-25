import { afterEach, describe, expect, it } from "vitest";
import { applyAtCloud, installCapture, localChanges } from "../src/index";
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
});
