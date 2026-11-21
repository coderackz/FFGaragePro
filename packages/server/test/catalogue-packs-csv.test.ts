import { describe, expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";

describe("catalogue: packs on POs, CSV", () => {
  it("packs", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const oil = (await call(app, "POST", "/api/parts", owner, { partNo: "5W30", name: "Engine oil 5W-30", unit: "litre", stocked: true, sellPriceFils: 3000, packs: [{ name: "Drum 208 L", size: 208 }] })).body.part;
    const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Lube Co" })).body.supplier;
    // 2 drums at AED 1,664 each = 416 litres at AED 8.00.
    const po = (await call(app, "POST", "/api/purchase-orders", owner, {
      supplierId: supplier.id, lines: [{ partId: oil.id, description: "Engine oil 5W-30", qty: 416, unitCostFils: 800, packName: "Drum 208 L", packSize: 208 }],
    })).body.purchaseOrder;
    expect(po.lines[0]).toMatchObject({ qty: 416, unitCostFils: 800, packName: "Drum 208 L", packSize: 208 });
    expect(po.netFils).toBe(332800);
    // A pack size that doesn't divide the quantity is refused (it would print a fraction of a drum).
    const bad = await call(app, "PATCH", `/api/purchase-orders/${po.id}`, owner, { lines: [{ id: po.lines[0].id, partId: oil.id, description: "x", qty: 100, unitCostFils: 800, packName: "Drum 208 L", packSize: 208 }] });
    expect(bad.status).toBe(400);
    await call(app, "POST", `/api/purchase-orders/${po.id}/send`, owner, {});
    await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, owner, { supplierInvoiceNo: "L-1", lines: [{ poLineId: po.lines[0].id, qty: 416, unitCostFils: 800 }] });
    const after = (await call(app, "GET", `/api/parts/${oil.id}`, owner)).body.part;
    expect(after).toMatchObject({ onHand: 416, avgCostFils: 800 });
  });

  it("csv", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const csv = [
      "part_no,name,category,numbers,fitment",
      'OF-1,Oil filter,Filters,"OEM:04152-YZZA1; AM:W 68/3","Toyota|Land Cruiser|2016-2021|1GR-FE; Lexus|GX 460|2010-"',
      "BP-1,Brake pads,Brakes,,Nissan|Patrol||",
    ].join("\n");
    const ok = await call(app, "POST", "/api/parts/import", owner, { csv });
    expect(ok.body).toMatchObject({ created: 2, errors: [] });
    const parts = (await call(app, "GET", "/api/parts?q=OF-1", owner)).body.parts;
    const of = (await call(app, "GET", `/api/parts/${parts[0].id}`, owner)).body.part;
    expect(of.categoryName).toBe("Filters");
    expect(of.numbers.map((n: { kind: string; number: string }) => `${n.kind}:${n.number}`)).toEqual(["oem:04152-YZZA1", "aftermarket:W 68/3"]);
    expect(of.fitments).toEqual([
      expect.objectContaining({ make: "Lexus", model: "GX 460", yearFrom: 2010, yearTo: null }),
      expect.objectContaining({ make: "Toyota", model: "Land Cruiser", yearFrom: 2016, yearTo: 2021, engine: "1GR-FE" }),
    ]);
    // A bad cell names the row and column, and nothing is imported.
    const bad = await call(app, "POST", "/api/parts/import", owner, { csv: "part_no,name,category,fitment\nX-1,X,Filters,Toyota|Corolla|20x6-2020\nX-2,Y,Nope," });
    expect(bad.body.created).toBe(0);
    expect(bad.body.errors).toEqual([
      { row: 2, message: expect.stringMatching(/^fitment: /) },
      { row: 3, message: 'category: "Nope" isn\'t a category (Settings → Inventory)' },
    ]);
    // Updating without those columns keeps what the part has.
    await call(app, "POST", "/api/parts/import", owner, { csv: "part_no,name\nOF-1,Oil filter (Toyota)" });
    const kept = (await call(app, "GET", `/api/parts/${of.id}`, owner)).body.part;
    expect(kept).toMatchObject({ name: "Oil filter (Toyota)", categoryName: "Filters" });
    expect(kept.numbers).toHaveLength(2);
  });
});
