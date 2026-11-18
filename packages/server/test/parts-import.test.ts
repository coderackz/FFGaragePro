import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv";
import { addUser, call, makeApp, setUp } from "./helpers";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF, a BOM and a trailing newline", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });
  it("keeps newlines inside quotes and skips blank lines", () => {
    expect(parseCsv('a\n"line 1\nline 2"\n\n')).toEqual([["a"], ["line 1\nline 2"]]);
  });
});

const CSV = [
  "Part_No,Name,Brand,Unit,Stocked,Sell_Price,Cost,Qty,Reorder_Level,Location,Fits",
  'OF-1001,"Oil filter, small",Bosch,each,yes,35.00,18.00,10,4,A1,"Nissan Sunny"',
  "OIL-5W30,Engine oil 5W-30,Mobil,litre,1,32.5,21,40.5,10,B2,",
  "BD-220,Brake disc,Brembo,each,no,200,,,,,Toyota Land Cruiser",
].join("\n");

describe("parts import", () => {
  it("creates parts with opening stock and cost", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const res = await call(app, "POST", "/api/parts/import", owner, { csv: CSV, dryRun: false });
    expect(res.body).toEqual({ created: 3, updated: 0, errors: [] });
    const parts = (await call(app, "GET", "/api/parts", owner)).body.parts;
    const byNo = Object.fromEntries(parts.map((p: { partNo: string }) => [p.partNo, p]));
    expect(byNo["OF-1001"]).toMatchObject({ name: "Oil filter, small", brand: "Bosch", stocked: true, sellPriceFils: 3500, onHand: 10, avgCostFils: 1800, reorderLevel: 4, location: "A1", fits: "Nissan Sunny" });
    expect(byNo["OIL-5W30"]).toMatchObject({ unit: "litre", onHand: 40.5, avgCostFils: 2100, sellPriceFils: 3250 });
    expect(byNo["BD-220"]).toMatchObject({ stocked: false, onHand: 0, sellPriceFils: 20000 });
  });

  it("updates details of existing part numbers without touching their stock", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    await call(app, "POST", "/api/parts/import", owner, { csv: CSV, dryRun: false });
    const again = await call(app, "POST", "/api/parts/import", owner, { csv: CSV.replace("35.00", "38.00"), dryRun: false });
    expect(again.body).toEqual({ created: 0, updated: 3, errors: [] });
    const filter = (await call(app, "GET", "/api/parts?q=OF-1001", owner)).body.parts[0];
    expect(filter).toMatchObject({ sellPriceFils: 3800, onHand: 10 });
  });

  it("a bad row writes nothing and names the row", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const bad = CSV.replace("32.5", "abc");
    const res = await call(app, "POST", "/api/parts/import", owner, { csv: bad, dryRun: false });
    expect(res.body.created).toBe(0);
    expect(res.body.errors[0]).toMatchObject({ row: 3 });
    expect(res.body.errors[0].message).toMatch(/sell_price/i);
    expect((await call(app, "GET", "/api/parts", owner)).body.parts).toHaveLength(0);
  });

  it("needs part_no and name columns", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const res = await call(app, "POST", "/api/parts/import", owner, { csv: "code,title\nX,Y", dryRun: false });
    expect(res.body.errors[0]).toMatchObject({ row: 1 });
  });

  it("dry run writes nothing but reports counts", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    expect((await call(app, "POST", "/api/parts/import", owner, { csv: CSV, dryRun: true })).body).toEqual({ created: 3, updated: 0, errors: [] });
    expect((await call(app, "GET", "/api/parts", owner)).body.parts).toHaveLength(0);
  });

  it("advisors can't import", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "POST", "/api/parts/import", advisor, { csv: CSV, dryRun: false })).status).toBe(403);
  });
});
