import { afterEach, describe, expect, it } from "vitest";
import { recomputePurchaseOrder } from "../src/index";
import { call, garageApp, setUp, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe("recomputing a purchase order after sync", () => {
  it("prices delivered stock at what each delivery cost and the rest at the line's price, packs as packs", async () => {
    const A = await garageApp();
    apps.push(A);
    const token = await setUp(A);
    const supplier = (await call(A, "POST", "/api/suppliers", token, { name: "Parts Co" })).body.supplier;
    const po = (await call(A, "POST", "/api/purchase-orders", token, {
      supplierId: supplier.id,
      lines: [
        { description: "Oil filter", qty: 10, unitCostFils: 5000 },
        // A box of 12 at AED 10.00: 83 fils each, but exactly AED 10.00 a box.
        { description: "Washers", qty: 12, unitCostFils: 83, packName: "Box", packSize: 12, packCostFils: 1000 },
      ],
    })).body.purchaseOrder;
    const res = await call(A, "POST", `/api/purchase-orders/${po.id}/receive`, token, { lines: [{ poLineId: po.lines[0].id, qty: 4, unitCostFils: 5500 }] });
    expect(res.status).toBe(200);
    const before = res.body.purchaseOrder.netFils;
    expect(before).toBe(4 * 5500 + 6 * 5000 + 1000);
    recomputePurchaseOrder(A.db, po.id);
    expect(A.db.get<{ net_fils: number }>("SELECT net_fils FROM purchase_orders WHERE id = ?", [po.id])!.net_fils).toBe(before);
  });
});
