import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const part = async (body: Record<string, unknown>, opening?: { qty: number; unitCostFils: number }) => {
    const r = await call(app, "POST", "/api/parts", owner, { stocked: true, sellPriceFils: 1000, ...body });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    if (opening) await call(app, "POST", `/api/parts/${r.body.part.id}/adjustments`, owner, { reason: "opening", ...opening });
    return r.body.part;
  };
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "individual", name: "Ali" })).body.customer;
  const sell = async (partId: string, qty: number) => {
    const inv = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [{ kind: "part", partId, description: "x", qty, unitPriceFils: 1000, discountPct: 0 }] })).body.document;
    await call(app, "POST", `/api/documents/${inv.id}/issue`, owner);
    return inv;
  };
  const supplier = async (name: string) => (await call(app, "POST", "/api/suppliers", owner, { name })).body.supplier;
  /** Moves a part's stock movements back in time (for usage windows and aging). */
  const age = (partId: string, days: number) => app.db.run("UPDATE stock_movements SET created_at = ? WHERE part_id = ?", [new Date(Date.now() - days * 86400000).toISOString(), partId]);
  return { app, owner, part, sell, supplier, age, customer };
}

describe("planning", () => {
  it("levels", async () => {
    const g = await garage();
    const p = await g.part({ partNo: "OF-1", name: "Oil filter", leadTimeDays: 7 }, { qty: 100, unitCostFils: 1000 });
    const inv = await g.sell(p.id, 50);
    // 5 come back on a credit note: 45 used.
    const issued = (await call(g.app, "GET", `/api/documents/${inv.id}`, g.owner)).body.document;
    await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "Five not fitted", lines: [{ lineId: issued.lines[0].id, qty: 5 }] });
    const rows = (await call(g.app, "GET", "/api/inventory/levels", g.owner)).body.parts;
    expect(rows).toEqual([expect.objectContaining({ partId: p.id, partNo: "OF-1", usage90: 45, suggestedMin: 11, suggestedMax: 26, reorderLevel: 0, maxLevel: 0, leadTimeDays: 7 })]);
    // Accepted: the part's levels change; an advisor can't.
    const advisor = await addUser(g.app, g.owner, "advisor");
    expect((await call(g.app, "POST", "/api/inventory/levels", advisor, { items: [{ partId: p.id, reorderLevel: 11, maxLevel: 26 }] })).status).toBe(403);
    expect((await call(g.app, "POST", "/api/inventory/levels", g.owner, { items: [{ partId: p.id, reorderLevel: 11, maxLevel: 26 }] })).status).toBe(200);
    expect((await call(g.app, "GET", `/api/parts/${p.id}`, g.owner)).body.part).toMatchObject({ reorderLevel: 11, maxLevel: 26 });
    // Usage older than 90 days doesn't count.
    g.age(p.id, 120);
    expect((await call(g.app, "GET", "/api/inventory/levels", g.owner)).body.parts[0].usage90).toBe(0);
  });

  it("suggested", async () => {
    const g = await garage();
    const s = await g.supplier("Filters Co");
    const other = await g.supplier("Other Co");
    const q = await g.part({ partNo: "AF-1", name: "Air filter", reorderLevel: 10, maxLevel: 20, preferredSupplierId: s.id }, { qty: 3, unitCostFils: 1500 });
    const r = await g.part({ partNo: "CF-1", name: "Cabin filter", reorderLevel: 2, maxLevel: 6 });
    const fine = await g.part({ partNo: "FF-1", name: "Fuel filter", reorderLevel: 1, maxLevel: 5, preferredSupplierId: s.id }, { qty: 4, unitCostFils: 500 });
    // 5 on order on a sent PO, at AED 7.00 from Filters Co; the cabin filter was last bought from Other Co.
    const po = (await call(g.app, "POST", "/api/purchase-orders", g.owner, { supplierId: s.id, lines: [{ partId: q.id, description: "Air filter", qty: 5, unitCostFils: 700 }] })).body.purchaseOrder;
    await call(g.app, "PATCH", `/api/purchase-orders/${po.id}`, g.owner, { status: "sent" });
    const old = (await call(g.app, "POST", "/api/purchase-orders", g.owner, { supplierId: other.id, lines: [{ partId: r.id, description: "Cabin filter", qty: 1, unitCostFils: 900 }] })).body.purchaseOrder;
    expect((await call(g.app, "PATCH", `/api/purchase-orders/${old.id}`, g.owner, { status: "cancelled" })).status).toBe(200);
    const got = (await call(g.app, "GET", "/api/inventory/suggested-orders", g.owner)).body.suppliers;
    // 3 on hand + 5 on order = 8 ≤ 10: top up to 20 → 12. Cabin filter: 0 → 6, from its last supplier.
    expect(got).toEqual([
      expect.objectContaining({ supplierId: s.id, supplierName: "Filters Co", lines: [expect.objectContaining({ partId: q.id, qty: 12, onHand: 3, onOrder: 5, unitCostFils: 700 })] }),
      expect.objectContaining({ supplierId: other.id, lines: [expect.objectContaining({ partId: r.id, qty: 6, onOrder: 0, unitCostFils: 900 })] }),
    ]);
    expect(JSON.stringify(got)).not.toContain(fine.id);
    // One click: a draft PO per supplier; asked again, nothing (drafts count as on order).
    const made = await call(g.app, "POST", "/api/inventory/suggested-orders", g.owner, { lines: got.flatMap((x: { supplierId: string; lines: { partId: string; qty: number }[] }) => x.lines.map((l) => ({ partId: l.partId, qty: l.qty, supplierId: x.supplierId }))) });
    expect(made.status).toBe(200);
    expect(made.body.purchaseOrders).toHaveLength(2);
    const draft = (await call(g.app, "GET", `/api/purchase-orders/${made.body.purchaseOrders[0].id}`, g.owner)).body.purchaseOrder;
    expect(draft).toMatchObject({ status: "draft", lines: [expect.objectContaining({ partId: q.id, qty: 12, unitCostFils: 700 })] });
    expect((await call(g.app, "GET", "/api/inventory/suggested-orders", g.owner)).body.suppliers).toEqual([]);
  });

  it("reports", async () => {
    const g = await garage();
    const cats = (await call(g.app, "GET", "/api/part-categories", g.owner)).body.categories;
    const filters = cats.find((c: { name: string }) => c.name === "Filters");
    const a = await g.part({ partNo: "A-1", name: "Used a lot", categoryId: filters.id }, { qty: 100, unitCostFils: 1000 });
    const b = await g.part({ partNo: "B-1", name: "Used a little" }, { qty: 10, unitCostFils: 1000 });
    const dead = await g.part({ partNo: "D-1", name: "Never used" }, { qty: 4, unitCostFils: 2500 });
    const old = await g.part({ partNo: "O-1", name: "Used long ago" }, { qty: 10, unitCostFils: 100 });
    await g.sell(a.id, 50);
    await g.sell(b.id, 10);
    await g.sell(old.id, 2);
    g.age(old.id, 400);
    // Never used, and it came in long ago: dead. (Just received, it wouldn't be.)
    g.age(dead.id, 400);
    const abc = (await call(g.app, "GET", "/api/reports/inventory/abc", g.owner)).body;
    expect(abc.parts.map((p: { partNo: string; abc: string }) => [p.partNo, p.abc])).toEqual([["A-1", "A"], ["B-1", "B"], ["D-1", "C"], ["O-1", "C"]]);
    expect(abc.parts[0]).toMatchObject({ usageQty: 50, usageValueFils: 50000 });
    const deadStock = (await call(g.app, "GET", "/api/reports/inventory/dead?months=6", g.owner)).body;
    expect(deadStock.parts.map((p: { partNo: string }) => p.partNo)).toEqual(["D-1", "O-1"]);
    expect(deadStock).toMatchObject({ totalFils: 10000 + 800 });
    const movers = (await call(g.app, "GET", "/api/reports/inventory/movers?days=90", g.owner)).body.parts;
    expect(movers.map((p: { partNo: string; usageQty: number }) => [p.partNo, p.usageQty])).toEqual([["A-1", 50], ["B-1", 10], ["D-1", 0], ["O-1", 0]]);
    const val = (await call(g.app, "GET", "/api/reports/inventory/valuation", g.owner)).body;
    expect(val.categories).toEqual([
      expect.objectContaining({ name: "Filters", qty: 50, valueFils: 50000 }),
      expect.objectContaining({ name: "No category", qty: 4 + 8, valueFils: 10000 + 800 }),
    ]);
    expect(val.totalFils).toBe(60800);
    const aging = (await call(g.app, "GET", "/api/reports/inventory/aging", g.owner)).body;
    expect(aging.buckets).toEqual({ "0–90": 50000, "91–180": 0, "181–365": 0, "Over 365": 10800 });
    // Costs only for those who may see them.
    const advisor = await addUser(g.app, g.owner, "advisor");
    expect((await call(g.app, "GET", "/api/reports/inventory/valuation", advisor)).status).toBe(403);
  });
});
