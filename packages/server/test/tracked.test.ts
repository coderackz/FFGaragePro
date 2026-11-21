import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

type Unit = { id: string; code: string; status: string; documentNumber: string | null; warrantyEnds: string | null; unitCostFils?: number };

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const part = async (body: Record<string, unknown>) => {
    const r = await call(app, "POST", "/api/parts", owner, { stocked: true, sellPriceFils: 50000, ...body });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.part;
  };
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Tyre Co" })).body.supplier;
  /** A PO for `qty` of the part, sent; returns the PO. */
  const order = async (partId: string, qty: number, unitCostFils = 30000) => {
    const po = (await call(app, "POST", "/api/purchase-orders", owner, { supplierId: supplier.id, lines: [{ partId, description: "x", qty, unitCostFils }] })).body.purchaseOrder;
    await call(app, "POST", `/api/purchase-orders/${po.id}/send`, owner, {});
    return po;
  };
  const receive = (po: { id: string; lines: { id: string }[] }, qty: number, units: string[], unitCostFils = 30000) =>
    call(app, "POST", `/api/purchase-orders/${po.id}/receive`, owner, { supplierInvoiceNo: "T-1", lines: [{ poLineId: po.lines[0]!.id, qty, unitCostFils, units }] });
  const units = async (partId: string, status = "in_stock") => (await call(app, "GET", `/api/parts/${partId}/units?status=${status}`, owner)).body.units as Unit[];
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "individual", name: "Ali" })).body.customer;
  const vehicle = (await call(app, "POST", "/api/vehicles", owner, { customerId: customer.id, plate: "DXB A 1", make: "Toyota", model: "Land Cruiser", year: 2018 })).body.vehicle;
  const line = (partId: string, qty: number, unitIds: string[]) => ({ kind: "part", partId, description: "Tyre", qty, unitPriceFils: 50000, discountPct: 0, unitIds });
  const jobCard = async (lines: unknown[]) => {
    const r = await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, vehicleId: vehicle.id, lines });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.document;
  };
  return { app, owner, part, order, receive, units, line, jobCard, customer, vehicle };
}

describe("tracked stock", () => {
  it("receive units", async () => {
    const g = await garage();
    const tyre = await g.part({ partNo: "MICH-1", name: "Michelin LTX 265/65R17", tracking: "dot" });
    const po = await g.order(tyre.id, 4);
    // Four tyres need four DOT codes; a bad one names the line, and nothing is received.
    const short = await g.receive(po, 4, ["2524", "2524", "2624"]);
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/4 DOT codes/);
    const bad = await g.receive(po, 4, ["2524", "2524", "2624", "9924"]);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/"9924" isn't a DOT code/);
    expect((await g.units(tyre.id))).toEqual([]);
    expect((await g.receive(po, 4, ["2524", "25/24", "1025", "2624"])).status).toBe(200);
    const inStock = await g.units(tyre.id);
    // Oldest first: week 25 of 2024 twice, then week 26 of 2024, then week 10 of 2025.
    expect(inStock.map((u) => u.code)).toEqual(["2524", "2524", "2624", "1025"]);
    expect(inStock[0]).toMatchObject({ status: "in_stock", unitCostFils: 30000 });
    // Serials: one each, never twice for the same part.
    const battery = await g.part({ partNo: "AMR-70", name: "Amaron 70Ah", tracking: "serial", warrantyMonths: 24 });
    const bpo = await g.order(battery.id, 2, 20000);
    expect((await g.receive(bpo, 2, ["SN-1", "SN-1"], 20000)).body.error).toMatch(/SN-1 twice/);
    expect((await g.receive(bpo, 2, ["SN-1", "SN-2"], 20000)).status).toBe(200);
    const again = await g.order(battery.id, 1, 20000);
    expect((await g.receive(again, 1, ["sn-1"], 20000)).body.error).toMatch(/SN-1 is already/);
    // A part not tracked takes no codes.
    const filter = await g.part({ partNo: "OF-1", name: "Oil filter" });
    const fpo = await g.order(filter.id, 1, 1000);
    expect((await g.receive(fpo, 1, ["X"], 1000)).status).toBe(400);
  });

  it("fit and return", async () => {
    const g = await garage();
    const tyre = await g.part({ partNo: "MICH-1", name: "Michelin LTX", tracking: "dot" });
    await g.receive(await g.order(tyre.id, 4), 4, ["1025", "2524", "2624", "2524"]);
    const [a, b, c] = await g.units(tyre.id);
    // A job card fits two tyres; stock and units move together.
    const jc = await g.jobCard([g.line(tyre.id, 2, [a!.id, b!.id])]);
    expect(jc.lines[0].units.map((u: Unit) => u.code)).toEqual(["2524", "2524"]);
    expect((await g.units(tyre.id)).map((u) => u.id)).toEqual([c!.id, expect.any(String)]);
    const fitted = await g.units(tyre.id, "fitted");
    expect(fitted.map((u) => [u.id, u.documentNumber])).toEqual([[a!.id, jc.number], [b!.id, jc.number]]);
    // More units than the quantity, a fraction of a tyre, or a unit of another part: refused.
    expect((await call(g.app, "PATCH", `/api/documents/${jc.id}`, g.owner, { lines: [g.line(tyre.id, 1, [a!.id, b!.id])] })).status).toBe(400);
    expect((await call(g.app, "PATCH", `/api/documents/${jc.id}`, g.owner, { lines: [g.line(tyre.id, 1.5, [a!.id])] })).status).toBe(400);
    // Another job card can't take a fitted tyre.
    const other = await call(g.app, "POST", "/api/documents", g.owner, { type: "jobcard", customerId: g.customer.id, lines: [g.line(tyre.id, 1, [a!.id])] });
    expect(other.status).toBe(409);
    expect(other.body.error).toMatch(new RegExp(`2524 is already fitted on ${jc.number}`));
    // Swapping one tyre puts the other back on the shelf.
    await call(g.app, "PATCH", `/api/documents/${jc.id}`, g.owner, { lines: [g.line(tyre.id, 2, [a!.id, c!.id])] });
    expect((await g.units(tyre.id, "fitted")).map((u) => u.id).sort()).toEqual([a!.id, c!.id].sort());
    // Fewer units than the quantity is allowed (tyres not picked yet), never more.
    await call(g.app, "PATCH", `/api/documents/${jc.id}`, g.owner, { lines: [g.line(tyre.id, 2, [a!.id])] });
    expect((await g.units(tyre.id, "fitted")).map((u) => u.id)).toEqual([a!.id]);
    // Converting to an invoice keeps the tyre fitted once, now on the invoice.
    await call(g.app, "PATCH", `/api/documents/${jc.id}`, g.owner, { lines: [g.line(tyre.id, 2, [a!.id, c!.id])] });
    const inv = (await call(g.app, "POST", `/api/documents/${jc.id}/convert`, g.owner)).body.document;
    expect(inv.lines[0].unitIds.sort()).toEqual([a!.id, c!.id].sort());
    expect((await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner)).status).toBe(200);
    expect((await g.units(tyre.id, "fitted")).map((u) => u.documentNumber)).toEqual([expect.stringMatching(/^INV/), expect.stringMatching(/^INV/)]);
    expect((await call(g.app, "GET", `/api/parts/${tyre.id}`, g.owner)).body.part.onHand).toBe(2);
    // Removing the line from a job card puts its tyres back.
    const jc2 = await g.jobCard([g.line(tyre.id, 1, [b!.id])]);
    await call(g.app, "PATCH", `/api/documents/${jc2.id}`, g.owner, { lines: [] });
    expect((await g.units(tyre.id)).map((u) => u.id)).toContain(b!.id);
    // An estimate never fits anything.
    const est = await call(g.app, "POST", "/api/documents", g.owner, { type: "estimate", customerId: g.customer.id, lines: [g.line(tyre.id, 1, [b!.id])] });
    expect(est.body.document.lines[0].unitIds).toEqual([]);
    expect((await g.units(tyre.id)).map((u) => u.id)).toContain(b!.id);
  });

  it("warranty", async () => {
    const g = await garage();
    const battery = await g.part({ partNo: "AMR-70", name: "Amaron 70Ah", tracking: "serial", warrantyMonths: 24 });
    await g.receive(await g.order(battery.id, 1, 20000), 1, ["SN-70-0001"], 20000);
    const [u] = await g.units(battery.id);
    const jc = await g.jobCard([g.line(battery.id, 1, [u!.id])]);
    const today = new Date().toISOString().slice(0, 10);
    const [y, m, d] = today.split("-");
    expect(jc.lines[0].units[0]).toMatchObject({ code: "SN-70-0001", warrantyEnds: `${Number(y) + 2}-${m}-${d === "29" && m === "02" ? "28" : d}` });
    // Lookup by serial (any case, part of it): the part, where it was fitted, the customer and vehicle.
    const found = (await call(g.app, "GET", "/api/stock-units?q=70-0001", g.owner)).body.units;
    expect(found).toEqual([expect.objectContaining({ code: "SN-70-0001", partNo: "AMR-70", status: "fitted", documentNumber: jc.number, customerName: "Ali", vehiclePlate: "DXB A 1" })]);
    // Advisors see units but never their cost.
    const advisor = await addUser(g.app, g.owner, "advisor");
    const seen = (await call(g.app, "GET", `/api/parts/${battery.id}/units?status=fitted`, advisor)).body.units;
    expect(seen[0].unitCostFils).toBeUndefined();
  });

  it("adjust", async () => {
    const g = await garage();
    const tyre = await g.part({ partNo: "T-1", name: "Tyre", tracking: "dot" });
    // Opening stock of tracked tyres lists each DOT.
    expect((await call(g.app, "POST", `/api/parts/${tyre.id}/adjustments`, g.owner, { reason: "opening", qty: 2, unitCostFils: 25000 })).status).toBe(400);
    expect((await call(g.app, "POST", `/api/parts/${tyre.id}/adjustments`, g.owner, { reason: "opening", qty: 2, unitCostFils: 25000, units: ["0125", "0225"] })).status).toBe(200);
    const [a] = await g.units(tyre.id);
    // Down: the tyres that went (damaged) are written off.
    expect((await call(g.app, "POST", `/api/parts/${tyre.id}/adjustments`, g.owner, { reason: "damaged", qty: -1 })).status).toBe(400);
    expect((await call(g.app, "POST", `/api/parts/${tyre.id}/adjustments`, g.owner, { reason: "damaged", qty: -1, unitIds: [a!.id] })).status).toBe(200);
    expect((await g.units(tyre.id)).map((u) => u.code)).toEqual(["0225"]);
    expect((await g.units(tyre.id, "written_off")).map((u) => u.code)).toEqual(["0125"]);
    expect((await call(g.app, "GET", `/api/parts/${tyre.id}`, g.owner)).body.part.onHand).toBe(1);
  });

  it("credit note", async () => {
    const g = await garage();
    const tyre = await g.part({ partNo: "T-1", name: "Tyre", tracking: "dot" });
    await g.receive(await g.order(tyre.id, 2), 2, ["0125", "0225"]);
    const [a, b] = await g.units(tyre.id);
    const inv = (await call(g.app, "POST", "/api/documents", g.owner, { type: "invoice", customerId: g.customer.id, lines: [g.line(tyre.id, 2, [a!.id, b!.id])] })).body.document;
    // A draft invoice (counter sale) fits nothing until it's issued.
    expect(await g.units(tyre.id, "fitted")).toEqual([]);
    await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner);
    expect(await g.units(tyre.id, "fitted")).toHaveLength(2);
    // One tyre comes back: the credit note names it and it's back on the shelf, for good.
    const issued = (await call(g.app, "GET", `/api/documents/${inv.id}`, g.owner)).body.document;
    const cn = await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "Wrong size", lines: [{ lineId: issued.lines[0].id, qty: 1, unitIds: [b!.id] }] });
    expect(cn.status).toBe(200);
    expect(cn.body.document.lines[0].units.map((u: Unit) => u.code)).toEqual(["0225"]);
    expect((await g.units(tyre.id)).map((u) => u.id)).toEqual([b!.id]);
    expect((await g.units(tyre.id, "fitted")).map((u) => u.id)).toEqual([a!.id]);
    // Not given: the line's last units go back.
    const cn2 = await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "Both", lines: [{ lineId: issued.lines[0].id, qty: 1 }] });
    expect(cn2.body.document.lines[0].units.map((u: Unit) => u.code)).toEqual(["0125"]);
    expect(await g.units(tyre.id, "fitted")).toEqual([]);
  });
});
