import { describe, expect, it } from "vitest";
import { reconcileDocumentStock } from "../src/stock";
import { call, makeApp, setUp } from "./helpers";

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const part = async (body: Record<string, unknown>, opening?: { qty: number; unitCostFils: number; units?: string[] }) => {
    const r = await call(app, "POST", "/api/parts", owner, { stocked: true, sellPriceFils: 1000, ...body });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    if (opening) {
      const a = await call(app, "POST", `/api/parts/${r.body.part.id}/adjustments`, owner, { reason: "opening", ...opening });
      if (a.status !== 200) throw new Error(JSON.stringify(a.body));
    }
    return r.body.part;
  };
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "individual", name: "Ali" })).body.customer;
  const onHand = async (p: { id: string }) => (await call(app, "GET", `/api/parts/${p.id}`, owner)).body.part.onHand;
  const doc = async (type: string, lines: unknown[]) => {
    const r = await call(app, "POST", "/api/documents", owner, { type, customerId: customer.id, lines });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.document;
  };
  const partLine = (partId: string, qty: number, unitIds: string[] = []) => ({ kind: "part", partId, description: "x", qty, unitPriceFils: 1000, discountPct: 0, unitIds });
  return { app, owner, part, customer, onHand, doc, partLine };
}

describe("tracked stock and kits (review fixes)", () => {
  it("issuing an invoice checks its tyres again", async () => {
    const g = await garage();
    const tyre = await g.part({ partNo: "T-1", name: "Tyre", tracking: "dot" }, { qty: 1, unitCostFils: 30000, units: ["0125"] });
    const [u] = (await call(g.app, "GET", `/api/parts/${tyre.id}/units`, g.owner)).body.units;
    // A draft invoice names the tyre (nothing is fitted until it's issued); a job card then fits it.
    const inv = await g.doc("invoice", [g.partLine(tyre.id, 1, [u.id])]);
    const jc = await g.doc("jobcard", [g.partLine(tyre.id, 1, [u.id])]);
    const issue = await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner);
    expect(issue.status).toBe(409);
    expect(issue.body.error).toMatch(new RegExp(`0125 is already fitted on ${jc.number}`));
    expect((await call(g.app, "GET", `/api/parts/${tyre.id}/units?status=fitted`, g.owner)).body.units[0].documentNumber).toBe(jc.number);
  });

  it("a credit note on a kit puts its parts back", async () => {
    const g = await garage();
    const filter = await g.part({ partNo: "OF-1", name: "Oil filter" }, { qty: 3, unitCostFils: 2000 });
    const oil = await g.part({ partNo: "5W30", name: "Oil", unit: "litre" }, { qty: 10, unitCostFils: 800 });
    const kit = await g.part({ partNo: "KIT", name: "Minor service", stocked: false, isKit: true, components: [{ partId: filter.id, qty: 1 }, { partId: oil.id, qty: 4.5 }] });
    const inv = await g.doc("invoice", [g.partLine(kit.id, 2)]);
    await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner);
    expect([await g.onHand(filter), await g.onHand(oil)]).toEqual([1, 1]);
    const issued = (await call(g.app, "GET", `/api/documents/${inv.id}`, g.owner)).body.document;
    expect((await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "One not done", lines: [{ lineId: issued.lines[0].id, qty: 1 }] })).status).toBe(200);
    expect([await g.onHand(filter), await g.onHand(oil)]).toEqual([2, 5.5]);
  });

  it("a kit changed later doesn't change what was sold", async () => {
    const g = await garage();
    const a = await g.part({ partNo: "OF-A", name: "Filter A" }, { qty: 5, unitCostFils: 2000 });
    const c = await g.part({ partNo: "OF-C", name: "Filter C" }, { qty: 5, unitCostFils: 3000 });
    const kit = await g.part({ partNo: "KIT", name: "Minor service", stocked: false, isKit: true, components: [{ partId: a.id, qty: 1 }] });
    const inv = await g.doc("invoice", [g.partLine(kit.id, 1)]);
    await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner);
    await call(g.app, "PATCH", `/api/parts/${kit.id}`, g.owner, { partNo: "KIT", name: "Minor service", stocked: false, sellPriceFils: 1000, isKit: true, components: [{ partId: c.id, qty: 1 }] });
    // Sync recalculates stock for the invoice: still filter A, at its cost.
    g.app.db.tx(() => reconcileDocumentStock(g.app.db, inv.id, "x"));
    expect([await g.onHand(a), await g.onHand(c)]).toEqual([4, 5]);
    expect((await call(g.app, "GET", `/api/documents/${inv.id}`, g.owner)).body.document.partsCostFils).toBe(2000);
    // The credit note puts back filter A too.
    const issued = (await call(g.app, "GET", `/api/documents/${inv.id}`, g.owner)).body.document;
    await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "Not done", lines: [{ lineId: issued.lines[0].id, qty: 1 }] });
    expect([await g.onHand(a), await g.onHand(c)]).toEqual([5, 5]);
    // An open job card made after the change uses the kit as it is now.
    await g.doc("jobcard", [g.partLine(kit.id, 1)]);
    expect([await g.onHand(a), await g.onHand(c)]).toEqual([5, 4]);
  });

  it("no tyres or batteries inside a kit", async () => {
    const g = await garage();
    const tyre = await g.part({ partNo: "T-1", name: "Tyre", tracking: "dot" });
    const plain = await g.part({ partNo: "V-1", name: "Valve" });
    const bad = await call(g.app, "POST", "/api/parts", g.owner, { partNo: "K", name: "Winter pack", stocked: false, sellPriceFils: 1, isKit: true, components: [{ partId: tyre.id, qty: 1 }] });
    expect(bad.body.error).toMatch(/tracked one by one/);
    await g.part({ partNo: "K2", name: "Valve pack", stocked: false, isKit: true, components: [{ partId: plain.id, qty: 4 }] });
    const track = await call(g.app, "PATCH", `/api/parts/${plain.id}`, g.owner, { partNo: "V-1", name: "Valve", stocked: true, sellPriceFils: 1000, tracking: "serial" });
    expect(track.status).toBe(409);
    expect(track.body.error).toMatch(/in the kit K2/);
  });

  it("the same serial twice on one delivery", async () => {
    const g = await garage();
    const battery = await g.part({ partNo: "AMR-70", name: "Battery", tracking: "serial" });
    const supplier = (await call(g.app, "POST", "/api/suppliers", g.owner, { name: "B Co" })).body.supplier;
    const po = (await call(g.app, "POST", "/api/purchase-orders", g.owner, {
      supplierId: supplier.id, lines: [{ partId: battery.id, description: "a", qty: 1, unitCostFils: 1 }, { partId: battery.id, description: "b", qty: 1, unitCostFils: 1 }],
    })).body.purchaseOrder;
    await call(g.app, "POST", `/api/purchase-orders/${po.id}/send`, g.owner, {});
    const r = await call(g.app, "POST", `/api/purchase-orders/${po.id}/receive`, g.owner, {
      lines: [{ poLineId: po.lines[0].id, qty: 1, unitCostFils: 1, units: ["SN-1"] }, { poLineId: po.lines[1].id, qty: 1, unitCostFils: 1, units: ["sn-1"] }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/SN-1 twice/);
  });
});
