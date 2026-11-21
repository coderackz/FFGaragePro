import { describe, expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const part = async (body: Record<string, unknown>, opening?: { qty: number; unitCostFils: number }) => {
    const r = await call(app, "POST", "/api/parts", owner, { stocked: true, sellPriceFils: 1000, ...body });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    if (opening) await call(app, "POST", `/api/parts/${r.body.part.id}/adjustments`, owner, { reason: "opening", ...opening });
    return r.body.part;
  };
  const filter = await part({ partNo: "OF-1", name: "Oil filter" }, { qty: 3, unitCostFils: 2000 });
  const oil = await part({ partNo: "5W30", name: "Engine oil 5W-30", unit: "litre" }, { qty: 10, unitCostFils: 800 });
  const kit = await part({ partNo: "KIT-MIN", name: "Minor service", stocked: false, sellPriceFils: 15000, isKit: true, components: [{ partId: filter.id, qty: 1 }, { partId: oil.id, qty: 4.5 }] });
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "individual", name: "Ali" })).body.customer;
  const onHand = async (p: { id: string }) => (await call(app, "GET", `/api/parts/${p.id}`, owner)).body.part.onHand;
  const kitLine = (qty: number) => ({ kind: "part", partId: kit.id, description: "Minor service", qty, unitPriceFils: 15000, discountPct: 0 });
  return { app, owner, part, filter, oil, kit, customer, onHand, kitLine };
}

describe("kits", () => {
  it("kits", async () => {
    const g = await garage();
    const detail = (await call(g.app, "GET", `/api/parts/${g.kit.id}`, g.owner)).body.part;
    expect(detail).toMatchObject({ isKit: true, stocked: false, kitAvailable: 2 });
    expect(detail.components).toEqual([
      expect.objectContaining({ partId: g.filter.id, partNo: "OF-1", qty: 1, onHand: 3 }),
      expect.objectContaining({ partId: g.oil.id, partNo: "5W30", qty: 4.5, onHand: 10 }),
    ]);
    // On a job card the kit takes its parts off the shelf.
    const jc = (await call(g.app, "POST", "/api/documents", g.owner, { type: "jobcard", customerId: g.customer.id, lines: [g.kitLine(1)] })).body.document;
    expect([await g.onHand(g.filter), await g.onHand(g.oil)]).toEqual([2, 5.5]);
    await call(g.app, "PATCH", `/api/documents/${jc.id}`, g.owner, { lines: [g.kitLine(2)] });
    expect([await g.onHand(g.filter), await g.onHand(g.oil)]).toEqual([1, 1]);
    // The kit's cost is its parts': 2 × (AED 20 + 4.5 L × AED 8) = AED 112.
    const doc = (await call(g.app, "GET", `/api/documents/${jc.id}`, g.owner)).body.document;
    expect(doc.lines[0].costFils).toBe(11200);
    expect(doc).toMatchObject({ partsCostFils: 11200, costPending: false });
    // Converted and issued: nothing is taken twice.
    const inv = (await call(g.app, "POST", `/api/documents/${jc.id}/convert`, g.owner)).body.document;
    await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner);
    expect([await g.onHand(g.filter), await g.onHand(g.oil)]).toEqual([1, 1]);
    expect((await call(g.app, "GET", `/api/parts/${g.kit.id}`, g.owner)).body.part.kitAvailable).toBe(0);
    // A job card that drops the kit puts its parts back.
    const jc2 = (await call(g.app, "POST", "/api/documents", g.owner, { type: "jobcard", customerId: g.customer.id, lines: [g.kitLine(1)] })).body.document;
    expect(await g.onHand(g.filter)).toBe(0);
    await call(g.app, "PATCH", `/api/documents/${jc2.id}`, g.owner, { lines: [] });
    expect([await g.onHand(g.filter), await g.onHand(g.oil)]).toEqual([1, 1]);
  });

  it("kit block", async () => {
    const g = await garage();
    await call(g.app, "PUT", "/api/settings/inventory", g.owner, { belowZero: "block" });
    // 3 kits need 13.5 L of oil; there are 10.
    const r = await call(g.app, "POST", "/api/documents", g.owner, { type: "jobcard", customerId: g.customer.id, lines: [g.kitLine(3)] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/5W30/);
    expect((await call(g.app, "POST", "/api/documents", g.owner, { type: "jobcard", customerId: g.customer.id, lines: [g.kitLine(2)] })).status).toBe(200);
  });

  it("kit rules", async () => {
    const g = await garage();
    const bad = (body: Record<string, unknown>) => call(g.app, "POST", "/api/parts", g.owner, { partNo: `K-${Math.random()}`, name: "K", stocked: false, sellPriceFils: 1, isKit: true, ...body });
    // No kit inside a kit; only stocked parts; no unknown parts.
    expect((await bad({ components: [{ partId: g.kit.id, qty: 1 }] })).body.error).toMatch(/kit inside a kit/);
    const perJob = await g.part({ partNo: "PJ-1", name: "Bought per job", stocked: false });
    expect((await bad({ components: [{ partId: perJob.id, qty: 1 }] })).body.error).toMatch(/stocked/);
    expect((await bad({ components: [{ partId: crypto.randomUUID(), qty: 1 }] })).status).toBe(400);
    // A part already in a kit can't become a kit.
    const plug = await g.part({ partNo: "DP-1", name: "Drain plug washer" });
    await call(g.app, "POST", "/api/parts", g.owner, { partNo: "KIT-2", name: "Oil change", stocked: false, sellPriceFils: 1, isKit: true, components: [{ partId: plug.id, qty: 1 }] });
    const made = await call(g.app, "PATCH", `/api/parts/${plug.id}`, g.owner, { partNo: "DP-1", name: "Drain plug washer", stocked: false, sellPriceFils: 1, isKit: true, components: [{ partId: g.oil.id, qty: 1 }] });
    expect(made.status).toBe(409);
    expect(made.body.error).toMatch(/in the kit KIT-2/);
    // Nor stop being stocked while it's in the kit.
    const unstock = await call(g.app, "PATCH", `/api/parts/${plug.id}`, g.owner, { partNo: "DP-1", name: "Drain plug washer", stocked: false, sellPriceFils: 1 });
    expect(unstock.body.error).toMatch(/in the kit KIT-2/);
    // Editing the kit's parts keeps their rows (stable ids), and a change in quantity is a change.
    const k1 = (await call(g.app, "GET", `/api/parts/${g.kit.id}`, g.owner)).body.part;
    const k2 = (await call(g.app, "PATCH", `/api/parts/${g.kit.id}`, g.owner, { partNo: "KIT-MIN", name: "Minor service", stocked: false, sellPriceFils: 15000, isKit: true, components: [{ partId: g.filter.id, qty: 1 }, { partId: g.oil.id, qty: 5 }] })).body.part;
    expect(k2.components.map((c: { id: string }) => c.id)).toEqual(k1.components.map((c: { id: string }) => c.id));
    expect(k2.components[1].qty).toBe(5);
  });
});
