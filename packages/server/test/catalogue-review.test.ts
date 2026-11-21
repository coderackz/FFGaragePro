import { describe, expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";

const OF = { partNo: "TY-OF1", name: "Oil filter", brand: "Toyota", stocked: true, sellPriceFils: 3500 };

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const part = async (body: Record<string, unknown>) => {
    const r = await call(app, "POST", "/api/parts", owner, body);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.part;
  };
  const search = async (q: string, extra = "") => (await call(app, "GET", `/api/parts?active=1&q=${encodeURIComponent(q)}${extra}`, owner)).body.parts as { partNo: string; replacesPartNo: string | null; fitsVehicle: boolean }[];
  const vehicle = async (v: Record<string, unknown>) => {
    const customer = (await call(app, "POST", "/api/customers", owner, { kind: "individual", name: "Ali" })).body.customer;
    return (await call(app, "POST", "/api/vehicles", owner, { customerId: customer.id, ...v })).body.vehicle;
  };
  return { app, owner, part, search, vehicle };
}

describe("catalogue (review fixes)", () => {
  it("pack price kept as typed", async () => {
    const g = await garage();
    const f = await g.part({ ...OF, packs: [{ name: "Box of 12", size: 12 }] });
    const supplier = (await call(g.app, "POST", "/api/suppliers", g.owner, { name: "Filters Co" })).body.supplier;
    // 3 boxes of 12 at AED 10.00 a box: AED 30.00, not 36 × 0.83 = 29.88. The unit cost is worked out by the server.
    const po = (await call(g.app, "POST", "/api/purchase-orders", g.owner, {
      supplierId: supplier.id, lines: [{ partId: f.id, description: "Oil filter", qty: 36, unitCostFils: 0, packName: "Box of 12", packSize: 12, packCostFils: 1000 }],
    })).body.purchaseOrder;
    expect(po.lines[0]).toMatchObject({ qty: 36, unitCostFils: 83, packCostFils: 1000, netFils: 3000 });
    expect(po.netFils).toBe(3000);
    await call(g.app, "POST", `/api/purchase-orders/${po.id}/send`, g.owner, {});
    const rec = await call(g.app, "POST", `/api/purchase-orders/${po.id}/receive`, g.owner, { supplierInvoiceNo: "F-1", lines: [{ poLineId: po.lines[0].id, qty: 36, unitCostFils: 83 }] });
    expect(rec.status).toBe(200);
    const after = (await call(g.app, "GET", `/api/purchase-orders/${po.id}`, g.owner)).body.purchaseOrder;
    expect(after.receipts[0].netFils).toBe(3000);
    // Without a pack price the line is priced per unit, as before.
    const plain = (await call(g.app, "POST", "/api/purchase-orders", g.owner, { supplierId: supplier.id, lines: [{ partId: f.id, description: "Oil filter", qty: 36, unitCostFils: 83, packName: "Box of 12", packSize: 12 }] })).body.purchaseOrder;
    expect(plain.netFils).toBe(2988);
  });

  it("stale specs after a category edit", async () => {
    const g = await garage();
    const cat = (await call(g.app, "POST", "/api/part-categories", g.owner, {
      name: "Wipers", attributes: [{ key: "type", label: "Type", type: "choice", options: ["Flat", "Hybrid"] }, { key: "side", label: "Side", type: "text" }],
    })).body.category;
    const w = await g.part({ ...OF, partNo: "WB-1", name: "Wiper blade", categoryId: cat.id, attributes: { type: "Hybrid", side: "Driver" } });
    await call(g.app, "PATCH", `/api/part-categories/${cat.id}`, g.owner, { attributes: [{ key: "type", label: "Type", type: "choice", options: ["Flat"] }] });
    // Saving the part as it is still works: the removed spec is dropped, the old choice it already had is kept.
    const saved = await call(g.app, "PATCH", `/api/parts/${w.id}`, g.owner, { ...OF, partNo: "WB-1", name: "Wiper blade", categoryId: cat.id, attributes: { type: "Hybrid", side: "Driver" } });
    expect(saved.status).toBe(200);
    expect(saved.body.part.attributes).toEqual({ type: "Hybrid" });
    // A new choice still has to be on the list.
    const bad = await call(g.app, "PATCH", `/api/parts/${w.id}`, g.owner, { ...OF, partNo: "WB-1", name: "Wiper blade", categoryId: cat.id, attributes: { type: "Rubber" } });
    expect(bad.status).toBe(400);
    // Specs sent without the category keep the part's category.
    const specsOnly = await call(g.app, "PATCH", `/api/parts/${w.id}`, g.owner, { ...OF, partNo: "WB-1", name: "Wiper blade", attributes: { type: "Flat" } });
    expect(specsOnly.body.part).toMatchObject({ categoryId: cat.id, attributes: { type: "Flat" } });
  });

  it("child rows keep their ids", async () => {
    const g = await garage();
    const body = { ...OF, numbers: [{ number: "04152-YZZA1", kind: "oem" }], fitments: [{ make: "Toyota", model: "Land Cruiser" }], packs: [{ name: "Box of 10", size: 10 }] };
    const p = await g.part(body);
    const ids = (x: { numbers: { id: string }[]; fitments: { id: string }[]; packs: { id: string }[] }) => [x.numbers[0]!.id, x.fitments[0]!.id, x.packs[0]!.id];
    const again = (await call(g.app, "PATCH", `/api/parts/${p.id}`, g.owner, { ...body, numbers: [{ number: "04152-YZZA1", kind: "oem", brand: "Toyota" }] })).body.part;
    expect(ids(again)).toEqual(ids(p));
    expect(again.numbers[0].brand).toBe("Toyota");
    // The same number added again on another computer gets the same id, so sync merges it into one row.
    await call(g.app, "PATCH", `/api/parts/${p.id}`, g.owner, { ...body, numbers: [], fitments: [], packs: [] });
    const back = (await call(g.app, "PATCH", `/api/parts/${p.id}`, g.owner, body)).body.part;
    expect(ids(back)).toEqual(ids(p));
    // Quick fitment and the CSV use the same ids.
    const v = await g.vehicle({ plate: "DXB A 1", make: "toyota", model: "land cruiser" });
    await call(g.app, "PATCH", `/api/parts/${p.id}`, g.owner, { ...body, fitments: [] });
    const quick = (await call(g.app, "POST", `/api/parts/${p.id}/fitments/from-vehicle`, g.owner, { vehicleId: v.id })).body.part;
    expect(quick.fitments[0].id).toBe(p.fitments[0].id);
  });

  it("picker: replaced by an inactive part", async () => {
    const g = await garage();
    const a = await g.part({ ...OF, partNo: "OLD-1", name: "Air filter (old)" });
    const b = await g.part({ ...OF, partNo: "MID-2", name: "Air filter (mid)" });
    const c = await g.part({ ...OF, partNo: "NEW-3", name: "Air filter" });
    await call(g.app, "POST", `/api/parts/${a.id}/supersede`, g.owner, { byPartId: b.id });
    await call(g.app, "POST", `/api/parts/${b.id}/supersede`, g.owner, { byPartId: c.id });
    await call(g.app, "PATCH", `/api/parts/${c.id}`, g.owner, { ...OF, partNo: "NEW-3", name: "Air filter", active: false });
    // The newest active part in the chain is offered.
    expect((await g.search("OLD-1", "&picker=1")).map((x) => [x.partNo, x.replacesPartNo])).toEqual([["MID-2", "OLD-1"]]);
    // With nothing active after it, the old part itself is offered.
    await call(g.app, "PATCH", `/api/parts/${b.id}`, g.owner, { ...OF, partNo: "MID-2", name: "Air filter (mid)", active: false });
    expect((await g.search("OLD-1", "&picker=1")).map((x) => [x.partNo, x.replacesPartNo])).toEqual([["OLD-1", null]]);
  });

  it("fitting parts first, past the list cap", async () => {
    const g = await garage();
    const csv = ["part_no,name", ...Array.from({ length: 310 }, (_, i) => `AF-${String(i).padStart(3, "0")},Air filter ${String(i).padStart(3, "0")}`)].join("\n");
    expect((await call(g.app, "POST", "/api/parts/import", g.owner, { csv })).body.errors).toEqual([]);
    await g.part({ ...OF, partNo: "ZZ-LC", name: "Zz air filter", fitments: [{ make: "Toyota", model: "Land Cruiser" }] });
    const lc = await g.vehicle({ plate: "DXB A 1", make: "Toyota", model: "Land Cruiser", year: 2018 });
    expect((await g.search("air filter", `&vehicleId=${lc.id}`))[0]).toMatchObject({ partNo: "ZZ-LC", fitsVehicle: true });
    expect((await g.search("", `&vehicleId=${lc.id}`)).map((x) => x.partNo)).toEqual(["ZZ-LC"]);
    // Case and spacing don't matter, the same as fitmentMatches.
    const lc2 = await g.vehicle({ plate: "DXB A 2", make: "TOYOTA ", model: "land  cruiser" });
    expect((await g.search("", `&vehicleId=${lc2.id}`)).map((x) => x.partNo)).toEqual(["ZZ-LC"]);
    // A vehicle with no make: nothing typed suggests nothing.
    const bare = await g.vehicle({ plate: "DXB A 3" });
    expect(await g.search("", `&vehicleId=${bare.id}`)).toEqual([]);
  });

  it("category parents", async () => {
    const g = await garage();
    expect((await call(g.app, "POST", "/api/part-categories", g.owner, { name: "X", parentId: "00000000-0000-4000-8000-000000000999" })).status).toBe(400);
    const a = (await call(g.app, "POST", "/api/part-categories", g.owner, { name: "A" })).body.category;
    const b = (await call(g.app, "POST", "/api/part-categories", g.owner, { name: "B", parentId: a.id })).body.category;
    const loop = await call(g.app, "PATCH", `/api/part-categories/${a.id}`, g.owner, { parentId: b.id });
    expect(loop.status).toBe(400);
    expect(loop.body.error).toMatch(/inside/);
  });
});
