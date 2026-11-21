import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

const OF = { partNo: "TY-OF1", name: "Oil filter", brand: "Toyota", stocked: true, sellPriceFils: 3500 };

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const part = async (body: Record<string, unknown>) => {
    const r = await call(app, "POST", "/api/parts", owner, body);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.part;
  };
  const search = async (q: string, extra = "") => (await call(app, "GET", `/api/parts?active=1&q=${encodeURIComponent(q)}${extra}`, owner)).body.parts;
  return { app, owner, part, search };
}

describe("catalogue", () => {
  it("alternate numbers", async () => {
    const g = await garage();
    const p = await g.part({ ...OF, numbers: [{ number: "04152-YZZA1", kind: "oem" }, { number: "W 68/3", kind: "aftermarket", brand: "MANN" }] });
    expect(p.numbers).toEqual([
      expect.objectContaining({ number: "04152-YZZA1", kind: "oem" }),
      expect.objectContaining({ number: "W 68/3", kind: "aftermarket", brand: "MANN" }),
    ]);
    const hit = await g.search("04152yzza1");
    expect(hit.map((x: { partNo: string }) => x.partNo)).toEqual(["TY-OF1"]);
    expect(hit[0].matchedBy).toBe("OEM 04152-YZZA1");
    expect((await g.search("w683"))[0].matchedBy).toBe("Aftermarket W 68/3 (MANN)");
    expect((await g.search("Oil filter"))[0].matchedBy).toBeNull();
    // Saving again replaces the set.
    const again = (await call(g.app, "PATCH", `/api/parts/${p.id}`, g.owner, { ...OF, numbers: [{ number: "90915-YZZD4", kind: "oem" }] })).body.part;
    expect(again.numbers.map((n: { number: string }) => n.number)).toEqual(["90915-YZZD4"]);
    expect(await g.search("04152yzza1")).toEqual([]);
  });

  it("supersession", async () => {
    const g = await garage();
    const a = await g.part({ ...OF, partNo: "OLD-1", name: "Air filter (old)" });
    const b = await g.part({ ...OF, partNo: "MID-2", name: "Air filter (mid)" });
    const c = await g.part({ ...OF, partNo: "NEW-3", name: "Air filter" });
    expect((await call(g.app, "POST", `/api/parts/${a.id}/supersede`, g.owner, { byPartId: b.id })).status).toBe(200);
    await call(g.app, "POST", `/api/parts/${b.id}/supersede`, g.owner, { byPartId: c.id });
    // A loop is refused.
    const loop = await call(g.app, "POST", `/api/parts/${c.id}/supersede`, g.owner, { byPartId: a.id });
    expect(loop.status).toBe(400);
    expect(loop.body.error).toMatch(/loop/);
    // The picker: the old part has no stock, so its newest replacement is offered instead.
    const picked = await g.search("OLD-1", "&picker=1");
    expect(picked.map((x: { partNo: string; replaces: string | null }) => [x.partNo, x.replaces])).toEqual([["NEW-3", "OLD-1"]]);
    // With stock it's still offered first (old stock goes first), alongside the replacement.
    await call(g.app, "POST", `/api/parts/${a.id}/adjustments`, g.owner, { qty: 2, reason: "count", note: "found" });
    const withStock = await g.search("OLD-1", "&picker=1");
    expect(withStock.map((x: { partNo: string }) => x.partNo)).toEqual(["OLD-1", "NEW-3"]);
    const detail = (await call(g.app, "GET", `/api/parts/${a.id}`, g.owner)).body.part;
    expect(detail.supersededBy).toMatchObject({ partNo: "MID-2" });
    expect(detail.chain.map((x: { partNo: string }) => x.partNo)).toEqual(["OLD-1", "MID-2", "NEW-3"]);
    expect((await call(g.app, "POST", `/api/parts/${a.id}/supersede`, g.owner, { byPartId: null })).body.part.supersededBy).toBeNull();
  });

  it("fitment ordering and quick fitment", async () => {
    const g = await garage();
    const customer = (await call(g.app, "POST", "/api/customers", g.owner, { kind: "individual", name: "Ali" })).body.customer;
    const lc = (await call(g.app, "POST", "/api/vehicles", g.owner, { customerId: customer.id, plate: "DXB A 1", make: "Toyota", model: "Land Cruiser", year: 2018, engine: "1GR-FE" })).body.vehicle;
    expect(lc.engine).toBe("1GR-FE");
    await g.part({ ...OF, partNo: "BP-NIS", name: "Brake pads front", fitments: [{ make: "Nissan", model: "Patrol" }] });
    const fits = await g.part({ ...OF, partNo: "BP-LC", name: "Brake pads front", fitments: [{ make: "Toyota", model: "Land Cruiser", yearFrom: 2016, yearTo: 2021 }] });
    const any = await g.part({ ...OF, partNo: "BP-GEN", name: "Brake pads front universal" });
    const found = await g.search("brake pads", `&vehicleId=${lc.id}`);
    expect(found.map((x: { partNo: string; fitsVehicle: boolean }) => [x.partNo, x.fitsVehicle])).toEqual([["BP-LC", true], ["BP-GEN", false], ["BP-NIS", false]]);
    // Nothing typed: the parts that fit this vehicle.
    expect((await g.search("", `&vehicleId=${lc.id}`)).map((x: { partNo: string }) => x.partNo)).toEqual(["BP-LC"]);
    // "Fits this vehicle" on another part.
    const add = await call(g.app, "POST", `/api/parts/${any.id}/fitments/from-vehicle`, g.owner, { vehicleId: lc.id });
    expect(add.body.part.fitments).toEqual([expect.objectContaining({ make: "Toyota", model: "Land Cruiser", yearFrom: 2018, yearTo: 2018, engine: "1GR-FE" })]);
    // Twice is the same fitment once.
    await call(g.app, "POST", `/api/parts/${any.id}/fitments/from-vehicle`, g.owner, { vehicleId: lc.id });
    expect((await call(g.app, "GET", `/api/parts/${any.id}`, g.owner)).body.part.fitments).toHaveLength(1);
    const advisor = await addUser(g.app, g.owner, "advisor");
    expect((await call(g.app, "POST", `/api/parts/${fits.id}/fitments/from-vehicle`, advisor, { vehicleId: lc.id })).status).toBe(403);
  });

  it("categories and specs", async () => {
    const g = await garage();
    const cats = (await call(g.app, "GET", "/api/part-categories", g.owner)).body.categories;
    const tyres = cats.find((c: { name: string }) => c.name === "Tyres");
    expect(tyres.attributes.map((a: { key: string }) => a.key)).toEqual(["width", "profile", "rim", "load", "speed"]);
    const t = await g.part({ partNo: "MICH-LTX", name: "Michelin LTX Force", brand: "Michelin", stocked: true, sellPriceFils: 60000, categoryId: tyres.id, attributes: { width: 265, profile: 65, rim: 17, load: "112", speed: "T" } });
    expect(t).toMatchObject({ categoryId: tyres.id, categoryName: "Tyres", attributes: { width: 265, rim: 17 } });
    expect((await g.search("265/65R17")).map((x: { partNo: string }) => x.partNo)).toEqual(["MICH-LTX"]);
    expect((await g.search("2656517")).map((x: { partNo: string }) => x.partNo)).toEqual(["MICH-LTX"]);
    expect((await call(g.app, "GET", `/api/parts?categoryId=${tyres.id}`, g.owner)).body.parts).toHaveLength(1);
    // An attribute the category doesn't have is refused.
    const bad = await call(g.app, "POST", "/api/parts", g.owner, { partNo: "X1", name: "X", stocked: false, sellPriceFils: 0, categoryId: tyres.id, attributes: { colour: "red" } });
    expect(bad.status).toBe(400);
    // New category; the owner only.
    const made = await call(g.app, "POST", "/api/part-categories", g.owner, { name: "Wipers", attributes: [{ key: "length", label: "Length", type: "number", unit: "mm" }] });
    expect(made.body.category).toMatchObject({ name: "Wipers" });
    const advisor = await addUser(g.app, g.owner, "advisor");
    expect((await call(g.app, "POST", "/api/part-categories", advisor, { name: "X" })).status).toBe(403);
    expect((await call(g.app, "PATCH", `/api/part-categories/${made.body.category.id}`, g.owner, { name: "Wiper blades" })).body.category.name).toBe("Wiper blades");
  });

  it("packs on a part", async () => {
    const g = await garage();
    const oil = await g.part({ partNo: "5W30-208", name: "Engine oil 5W-30", unit: "litre", stocked: true, sellPriceFils: 3000, packs: [{ name: "Drum 208 L", size: 208 }, { name: "Can 4 L", size: 4 }] });
    expect(oil.packs).toEqual([expect.objectContaining({ name: "Drum 208 L", size: 208 }), expect.objectContaining({ name: "Can 4 L", size: 4 })]);
  });
});
