import { describe, expect, it } from "vitest";
import { addUser, call, createPart, makeApp, onHand, setUp, type App } from "./helpers";

async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const a = await createPart(app, owner, { partNo: "A-1", name: "Part A", sellPriceFils: 6000 }, { qty: 10, unitCostFils: 4000 });
  const b = await createPart(app, owner, { partNo: "B-1", name: "Part B", sellPriceFils: 2000 }, { qty: 5, unitCostFils: 1000 });
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  return { app, owner, a, b, customer };
}

const partLine = (part: { id: string; name: string }, qty: number, extra: Record<string, unknown> = {}) => ({
  kind: "part", description: part.name, qty, unitPriceFils: 6000, discountPct: 0, partId: part.id, ...extra,
});
const labour = { kind: "labour", description: "Fitting", qty: 1, unitPriceFils: 10000, discountPct: 0 };

async function newDoc(app: App, token: string, type: string, customerId: string, lines: unknown[]) {
  const res = await call(app, "POST", "/api/documents", token, { type, customerId, lines });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.document;
}
const putLines = (app: App, token: string, id: string, lines: unknown[]) => call(app, "PUT", `/api/documents/${id}/lines`, token, { lines });

describe("stock follows documents", () => {
  it("estimate never moves stock", async () => {
    const { app, owner, a, customer } = await world();
    await newDoc(app, owner, "estimate", customer.id, [partLine(a, 2)]);
    expect(await onHand(app, owner, a.id)).toBe(10);
  });

  it("estimate converted to a job card takes stock", async () => {
    const { app, owner, a, customer } = await world();
    const est = await newDoc(app, owner, "estimate", customer.id, [partLine(a, 2)]);
    const jc = (await call(app, "POST", `/api/documents/${est.id}/convert`, owner)).body.document;
    expect(jc.lines[0].partId).toBe(a.id);
    expect(await onHand(app, owner, a.id)).toBe(8);
  });

  it("job card takes, edits and returns", async () => {
    const { app, owner, a, customer } = await world();
    const jc = await newDoc(app, owner, "jobcard", customer.id, [labour, partLine(a, 2)]);
    expect(await onHand(app, owner, a.id)).toBe(8);
    await putLines(app, owner, jc.id, [labour, partLine(a, 3)]);
    expect(await onHand(app, owner, a.id)).toBe(7);
    await putLines(app, owner, jc.id, [labour, partLine(a, 3)]);
    await call(app, "PATCH", `/api/documents/${jc.id}`, owner, { lines: [labour, partLine(a, 3)] });
    expect(await onHand(app, owner, a.id)).toBe(7);
    const movements = (await call(app, "GET", `/api/parts/${a.id}`, owner)).body.movements;
    expect(movements.filter((m: { reason: string }) => m.reason === "job")).toHaveLength(2);
    await putLines(app, owner, jc.id, [labour, partLine(a, 0)]);
    expect(await onHand(app, owner, a.id)).toBe(10);
  });

  it("swapping a line's part returns A and takes B", async () => {
    const { app, owner, a, b, customer } = await world();
    const jc = await newDoc(app, owner, "jobcard", customer.id, [partLine(a, 1)]);
    await putLines(app, owner, jc.id, [partLine(b, 1)]);
    expect(await onHand(app, owner, a.id)).toBe(10);
    expect(await onHand(app, owner, b.id)).toBe(4);
  });

  it("convert moves nothing; issue moves only the extra", async () => {
    const { app, owner, a, customer } = await world();
    const jc = await newDoc(app, owner, "jobcard", customer.id, [partLine(a, 2)]);
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner)).body.document;
    expect(await onHand(app, owner, a.id)).toBe(8);
    await putLines(app, owner, inv.id, [partLine(a, 2), partLine(a, 1)]);
    expect(await onHand(app, owner, a.id)).toBe(8);
    await call(app, "POST", `/api/documents/${inv.id}/issue`, owner);
    expect(await onHand(app, owner, a.id)).toBe(7);
  });

  it("counter-sale invoice takes stock at issue", async () => {
    const { app, owner, a, customer } = await world();
    const inv = await newDoc(app, owner, "invoice", customer.id, [partLine(a, 1)]);
    expect(await onHand(app, owner, a.id)).toBe(10);
    await call(app, "POST", `/api/documents/${inv.id}/issue`, owner);
    expect(await onHand(app, owner, a.id)).toBe(9);
  });

  it("Fleet Fix and free-text lines never move stock; Fleet Fix line is zero-priced", async () => {
    const { app, owner, a, customer } = await world();
    const jc = await newDoc(app, owner, "jobcard", customer.id, [
      partLine(a, 1, { suppliedBy: "fleetfix", unitPriceFils: 9900, discountPct: 5 }),
      { kind: "part", description: "Wiper blade", qty: 2, unitPriceFils: 1500, discountPct: 0 },
    ]);
    expect(jc.lines[0]).toMatchObject({ suppliedBy: "fleetfix", unitPriceFils: 0, discountPct: 0, grossFils: 0, partId: a.id });
    expect(await onHand(app, owner, a.id)).toBe(10);
  });

  it("rejects an unknown part", async () => {
    const { app, owner, customer } = await world();
    const res = await call(app, "POST", "/api/documents", owner, {
      type: "jobcard", customerId: customer.id, lines: [partLine({ id: "11111111-1111-4111-8111-111111111111", name: "?" }, 1)],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Part not found");
  });

  it("stock can go negative", async () => {
    const { app, owner, a, customer } = await world();
    await newDoc(app, owner, "jobcard", customer.id, [partLine(a, 12)]);
    expect(await onHand(app, owner, a.id)).toBe(-2);
  });

  it("fractional litres", async () => {
    const { app, owner, customer } = await world();
    const oil = await createPart(app, owner, { partNo: "OIL-5W30", name: "Engine oil 5W-30", unit: "litre" }, { qty: 10, unitCostFils: 2500 });
    const jc = await newDoc(app, owner, "jobcard", customer.id, [partLine(oil, 4.5), partLine(oil, 0.7)]);
    expect(await onHand(app, owner, oil.id)).toBe(4.8);
    await putLines(app, owner, jc.id, [partLine(oil, 5.2)]);
    expect(await onHand(app, owner, oil.id)).toBe(4.8);
    await putLines(app, owner, jc.id, [partLine(oil, 4.4), partLine(oil, 0.1), partLine(oil, 0.7)]);
    expect(await onHand(app, owner, oil.id)).toBe(4.8);
  });

  it("advisor sees no cost on documents; owner sees margin", async () => {
    const { app, owner, a, customer } = await world();
    const advisor = await addUser(app, owner, "advisor");
    const jc = await newDoc(app, advisor, "jobcard", customer.id, [partLine(a, 2)]);
    expect(jc).not.toHaveProperty("partsCostFils");
    expect(jc.lines[0]).not.toHaveProperty("costFils");
    const seen = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document;
    expect(seen.partsCostFils).toBe(8000);
    expect(seen.marginFils).toBe(4000);
    expect(seen.costPending).toBe(false);
    expect(seen.lines[0].costFils).toBe(8000);
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner)).body.document;
    expect(inv.partsCostFils).toBe(8000);
  });
});
