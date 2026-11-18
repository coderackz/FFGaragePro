import { describe, expect, it } from "vitest";
import { FLEETFIX_SUPPLIER_ID } from "@ffgp/shared";
import { addUser, call, createPart, makeApp, setUp } from "./helpers";

describe("parts", () => {
  it("owner creates a stocked part, opening stock sets cost", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const part = await createPart(app, owner, {}, { qty: 10, unitCostFils: 4000 });
    const page = (await call(app, "GET", `/api/parts/${part.id}`, owner)).body;
    expect(page.part.onHand).toBe(10);
    expect(page.part.avgCostFils).toBe(4000);
    expect(page.movements).toHaveLength(1);
    expect(page.movements[0]).toMatchObject({ reason: "opening", qty: 10, unitCostFils: 4000, createdBy: "Owner One" });
  });

  it("advisor sees parts without cost and can't edit", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const advisor = await addUser(app, owner, "advisor");
    const part = await createPart(app, owner, {}, { qty: 2, unitCostFils: 4000 });
    const list = (await call(app, "GET", "/api/parts", advisor)).body.parts;
    expect(list).toHaveLength(1);
    expect(list[0].onHand).toBe(2);
    expect(list[0]).not.toHaveProperty("avgCostFils");
    const page = (await call(app, "GET", `/api/parts/${part.id}`, advisor)).body;
    expect(page.part).not.toHaveProperty("avgCostFils");
    expect(page.movements[0]).not.toHaveProperty("unitCostFils");
    expect((await call(app, "POST", "/api/parts", advisor, { partNo: "X", name: "X", stocked: true, sellPriceFils: 1 })).status).toBe(403);
    expect((await call(app, "POST", `/api/parts/${part.id}/adjustments`, advisor, { qty: 1, reason: "count" })).status).toBe(403);
  });

  it("low stock filter", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const low = await createPart(app, owner, { partNo: "A", reorderLevel: 5 }, { qty: 3, unitCostFils: 100 });
    await createPart(app, owner, { partNo: "B", reorderLevel: 5 }, { qty: 6, unitCostFils: 100 });
    await createPart(app, owner, { partNo: "C", stocked: false, reorderLevel: 5 });
    const list = (await call(app, "GET", "/api/parts?lowStock=1", owner)).body.parts;
    expect(list.map((p: { id: string }) => p.id)).toEqual([low.id]);
  });

  it("can't switch stocked with stock on hand", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const part = await createPart(app, owner, {}, { qty: 1, unitCostFils: 100 });
    const res = await call(app, "PATCH", `/api/parts/${part.id}`, owner, { partNo: "OF-1001", name: "Oil filter", stocked: false, sellPriceFils: 3500 });
    expect(res.status).toBe(409);
    await call(app, "POST", `/api/parts/${part.id}/adjustments`, owner, { qty: -1, reason: "count" });
    expect((await call(app, "PATCH", `/api/parts/${part.id}`, owner, { partNo: "OF-1001", name: "Oil filter", stocked: false, sellPriceFils: 3500 })).status).toBe(200);
  });

  it("rejects a duplicate part number", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    await createPart(app, owner);
    expect((await call(app, "POST", "/api/parts", owner, { partNo: "of-1001", name: "Other", stocked: true, sellPriceFils: 1 })).status).toBe(409);
  });

  it("searches by part number, name, brand and fits", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    await createPart(app, owner, { partNo: "BP-77", name: "Brake pads", brand: "Brembo", fits: "Nissan Patrol 2018" });
    await createPart(app, owner);
    for (const q of ["bp-7", "pads", "brembo", "patrol"]) {
      expect((await call(app, "GET", `/api/parts?q=${q}`, owner)).body.parts).toHaveLength(1);
    }
  });
});

describe("suppliers", () => {
  it("Fleet Fix supplier exists after setup and keeps its name", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const list = (await call(app, "GET", "/api/suppliers", owner)).body.suppliers;
    expect(list).toEqual([expect.objectContaining({ id: FLEETFIX_SUPPLIER_ID, name: "Fleet Fix", isFleetfix: true })]);
    expect((await call(app, "PATCH", `/api/suppliers/${FLEETFIX_SUPPLIER_ID}`, owner, { name: "Other" })).status).toBe(409);
    expect((await call(app, "PATCH", `/api/suppliers/${FLEETFIX_SUPPLIER_ID}`, owner, { name: "Fleet Fix", phone: "800 FLEET" })).body.supplier.phone).toBe("800 FLEET");
  });

  it("accountant adds suppliers; advisor can only read", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const accountant = await addUser(app, owner, "accountant");
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "POST", "/api/suppliers", accountant, { name: "Al Futtaim Parts", trn: "100200300400003" })).status).toBe(200);
    expect((await call(app, "POST", "/api/suppliers", advisor, { name: "X" })).status).toBe(403);
    expect((await call(app, "GET", "/api/suppliers", advisor)).body.suppliers).toHaveLength(2);
  });
});
