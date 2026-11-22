import { describe, expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";

async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  return { app, owner, customer };
}

const LINES = [
  { kind: "labour", description: "Front brakes", details: "Pads and discs\nBleed brakes", unit: "Hr", qty: 1.5, unitPriceFils: 18000, discountPct: 0 },
  { kind: "other", description: "Disposal", unit: "Job", qty: 1, unitPriceFils: 2000, discountPct: 0 },
  { kind: "part", description: "Filter", details: "ignored on parts", unit: "Pc", qty: 1, unitPriceFils: 3500, discountPct: 0 },
];

describe("line descriptions and units", () => {
  it("labour and other lines keep a description and a unit; part lines take no description", async () => {
    const { app, owner, customer } = await world();
    const res = await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: LINES });
    expect(res.status).toBe(200);
    const [labour, other, part] = res.body.document.lines;
    expect(labour).toMatchObject({ details: "Pads and discs\nBleed brakes", unit: "Hr" });
    expect(other).toMatchObject({ details: null, unit: "Job" });
    expect(part).toMatchObject({ details: null, unit: "Pc" });
  });

  it("a save that doesn't send details or unit keeps them", async () => {
    const { app, owner, customer } = await world();
    const doc = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: LINES })).body.document;
    const older = LINES.map(({ details: _d, unit: _u, ...l }) => ({ ...l, qty: l.qty + 1 }));
    const res = await call(app, "PATCH", `/api/documents/${doc.id}`, owner, { lines: older });
    expect(res.body.document.lines[0]).toMatchObject({ qty: 2.5, details: "Pads and discs\nBleed brakes", unit: "Hr" });
    expect(res.body.document.lines[1]).toMatchObject({ unit: "Job" });
    // A different title at that position is a different line: nothing carried over.
    const renamed = await call(app, "PATCH", `/api/documents/${doc.id}`, owner, { lines: [{ ...older[0], description: "Rear brakes" }] });
    expect(renamed.body.document.lines[0]).toMatchObject({ details: null, unit: null });
  });

  it("rejects a description over 2,000 characters and a unit over 12", async () => {
    const { app, owner, customer } = await world();
    expect((await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: [{ ...LINES[0], details: "x".repeat(2001) }] })).status).toBe(400);
    expect((await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: [{ ...LINES[0], unit: "x".repeat(13) }] })).status).toBe(400);
  });

  it("descriptions and units go with the work: estimate → job card → invoice → credit note", async () => {
    const { app, owner, customer } = await world();
    const est = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: LINES.slice(0, 2) })).body.document;
    const jc = (await call(app, "POST", `/api/documents/${est.id}/convert`, owner, {})).body.document;
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    for (const d of [jc, inv]) {
      expect(d.lines[0]).toMatchObject({ details: "Pads and discs\nBleed brakes", unit: "Hr" });
      expect(d.lines[1]).toMatchObject({ unit: "Job" });
    }
    expect((await call(app, "POST", `/api/documents/${inv.id}/issue`, owner, {})).status).toBe(200);
    const cn = await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "Goodwill", returnToStock: false });
    expect(cn.status).toBe(200);
    expect(cn.body.document.lines[0]).toMatchObject({ details: "Pads and discs\nBleed brakes", unit: "Hr" });
  });
});
