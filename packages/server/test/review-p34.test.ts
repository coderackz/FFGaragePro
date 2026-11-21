import { describe, expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim Parts" })).body.supplier;
  const part = async (body: Record<string, unknown>, opening?: Record<string, unknown>) => {
    const r = await call(app, "POST", "/api/parts", owner, { stocked: true, sellPriceFils: 5000, ...body });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    if (opening) await call(app, "POST", `/api/parts/${r.body.part.id}/adjustments`, owner, opening);
    return r.body.part;
  };
  const receive = async (partId: string, qty: number, unitCostFils: number, extra: Record<string, unknown> = {}) => {
    const po = (await call(app, "POST", "/api/purchase-orders", owner, { supplierId: supplier.id, lines: [{ partId, description: "x", qty, unitCostFils }] })).body.purchaseOrder;
    await call(app, "PATCH", `/api/purchase-orders/${po.id}`, owner, { status: "sent" });
    const r = await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, owner, { lines: [{ poLineId: po.lines[0].id, qty, unitCostFils, ...extra }] });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  };
  const age = (partId: string, days: number) => app.db.run("UPDATE stock_movements SET created_at = ? WHERE part_id = ?", [new Date(Date.now() - days * 86400000).toISOString(), partId]);
  return { app, owner, supplier, part, receive, age };
}

describe("planning and returns (review fixes)", () => {
  it("the same part twice on a return", async () => {
    const g = await garage();
    const p = await g.part({ partNo: "X-1", name: "X" }, { reason: "opening", qty: 5, unitCostFils: 1000 });
    const twice = await call(g.app, "POST", "/api/supplier-returns", g.owner, {
      supplierId: g.supplier.id, kind: "return", reason: "Two lines", lines: [{ partId: p.id, qty: 5, unitCreditFils: 1000 }, { partId: p.id, qty: 5, unitCreditFils: 1000 }],
    });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatch(/X-1 is on the return twice/);
    expect((await call(g.app, "GET", `/api/parts/${p.id}`, g.owner)).body.part.onHand).toBe(5);
  });

  it("dead stock leaves out what has just arrived", async () => {
    const g = await garage();
    const fresh = await g.part({ partNo: "NEW-1", name: "Just bought" });
    await g.receive(fresh.id, 3, 1000);
    const old = await g.part({ partNo: "OLD-1", name: "Bought long ago" });
    await g.receive(old.id, 2, 1000);
    g.age(old.id, 300);
    const dead = (await call(g.app, "GET", "/api/reports/inventory/dead?months=6", g.owner)).body.parts.map((p: { partNo: string }) => p.partNo);
    expect(dead).toEqual(["OLD-1"]);
  });

  it("aging: stock that came another way", async () => {
    const g = await garage();
    // Found on a count today (no delivery): it's new stock, not over a year old.
    await g.part({ partNo: "CNT-1", name: "Counted" }, { reason: "count", qty: 4, unitCostFils: 1000 });
    const aging = (await call(g.app, "GET", "/api/reports/inventory/aging", g.owner)).body;
    expect(aging.parts[0]).toMatchObject({ partNo: "CNT-1", bucket: "0–90", days: 0 });
  });

  it("returning every core clears the deposits exactly", async () => {
    const g = await garage();
    const alt = await g.part({ partNo: "ALT-1", name: "Alternator", coreFils: 3334 });
    await g.receive(alt.id, 1, 40000);
    await g.receive(alt.id, 2, 40000, { coreFils: 3333 });
    const [owed] = (await call(g.app, "GET", "/api/cores", g.owner)).body.cores;
    expect(owed).toMatchObject({ qty: 3, valueFils: 10000, depositFils: 3333 });
    const back = (await call(g.app, "POST", "/api/supplier-returns", g.owner, {
      supplierId: g.supplier.id, kind: "core", reason: "All back", lines: [{ partId: alt.id, qty: 3, unitCreditFils: owed.depositFils }],
    })).body.supplierReturn;
    expect(back.netFils).toBe(10000);
    expect((await call(g.app, "GET", "/api/cores", g.owner)).body.cores).toEqual([]);
  });

  it("a credited claim for several parts", async () => {
    const g = await garage();
    const pump = await g.part({ partNo: "WP-1", name: "Water pump" });
    const claim = (await call(g.app, "POST", "/api/warranty-claims", g.owner, { supplierId: g.supplier.id, partId: pump.id, qty: 4, reason: "Leaking seals" })).body.warrantyClaim;
    const done = (await call(g.app, "POST", `/api/warranty-claims/${claim.id}/resolve`, g.owner, { outcome: "credited", creditFils: 40001 })).body.warrantyClaim;
    const note = (await call(g.app, "GET", `/api/supplier-returns/${done.debitNote.id}`, g.owner)).body.supplierReturn;
    expect(note).toMatchObject({ netFils: 40001, lines: [expect.objectContaining({ qty: 4, netFils: 40001 })] });
  });
});
