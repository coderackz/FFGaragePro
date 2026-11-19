import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { addUser, call, createPart, setUp, tempDir } from "./helpers";

/** A cloud-linked PC: every number comes from the cloud's series, so a refused save must not use one up. */
async function linkedGarage() {
  let asked = 0;
  let seq = 0;
  const app = await buildApp({ dataDir: tempDir(), numbers: { next: async () => (asked++, { series: "", seq: ++seq }), offlineSeries: "P1" } });
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
  return { app, owner, customer, asked: () => asked };
}

describe("refused saves don't use up numbers", () => {
  it("a discount waiting for the Owner's approval takes no number", async () => {
    const { app, owner, customer, asked } = await linkedGarage();
    try {
      await call(app, "PUT", "/api/settings/pricing", owner, { maxDiscountAdvisorPct: 10 });
      const advisor = await addUser(app, owner, "advisor");
      const before = asked();
      const refused = await call(app, "POST", "/api/documents", advisor, {
        type: "invoice", customerId: customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 20 }],
      });
      expect(refused.body.code).toBe("discount_approval");
      expect(asked()).toBe(before);
    } finally {
      await app.close();
    }
  });

  it("a job card refused for stock takes no number, created or converted", async () => {
    const { app, owner, customer, asked } = await linkedGarage();
    try {
      await call(app, "PUT", "/api/settings/inventory", owner, { belowZero: "block" });
      const part = await createPart(app, owner, {}, { qty: 1, unitCostFils: 2000 });
      const lines = [{ kind: "part", description: "Oil filter", qty: 3, unitPriceFils: 3500, discountPct: 0, partId: part.id }];
      const est = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines })).body.document;
      const before = asked();
      expect((await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, lines })).body.code).toBe("out_of_stock");
      expect((await call(app, "POST", `/api/documents/${est.id}/convert`, owner)).body.code).toBe("out_of_stock");
      expect(asked()).toBe(before);
    } finally {
      await app.close();
    }
  });
});
