import { describe, expect, it } from "vitest";
import { call, createPart, makeApp, onHand, setUp } from "./helpers";

async function garage(belowZero?: "block") {
  const app = await makeApp();
  const owner = await setUp(app);
  if (belowZero) await call(app, "PUT", "/api/settings/inventory", owner, { belowZero });
  const part = await createPart(app, owner, {}, { qty: 2, unitCostFils: 2000 });
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
  const jobCard = (qty: number) =>
    call(app, "POST", "/api/documents", owner, {
      type: "jobcard", customerId: customer.id,
      lines: [{ kind: "part", description: "Oil filter", qty, unitPriceFils: 3500, discountPct: 0, partId: part.id }],
    });
  return { app, owner, part, jobCard };
}

describe("stock below zero", () => {
  it("block refuses to go below zero", async () => {
    const { app, owner, part, jobCard } = await garage("block");
    const refused = await jobCard(3);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "out_of_stock", error: "Only 2 each of OF-1001 in stock" });
    expect(await onHand(app, owner, part.id)).toBe(2);
    expect((await jobCard(2)).status).toBe(200);
    expect(await onHand(app, owner, part.id)).toBe(0);
  });

  it("warn keeps today's behaviour", async () => {
    const { app, owner, part, jobCard } = await garage();
    expect((await jobCard(3)).status).toBe(200);
    expect(await onHand(app, owner, part.id)).toBe(-1);
  });
});
