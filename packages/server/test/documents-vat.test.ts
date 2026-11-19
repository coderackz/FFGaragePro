import { describe, expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";

const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10500, discountPct: 0 };

describe("prices typed including VAT", () => {
  it("the setting is copied, not followed", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
    await call(app, "PUT", "/api/settings/tax", owner, { pricesIncludeVat: true });
    const est = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: [LINE] })).body.document;
    expect(est.pricesIncludeVat).toBe(true);
    expect(est.totals).toEqual({ netFils: 10000, vatFils: 500, grossFils: 10500 });

    await call(app, "PUT", "/api/settings/tax", owner, { pricesIncludeVat: false });
    const edited = (await call(app, "PUT", `/api/documents/${est.id}/lines`, owner, { lines: [LINE] })).body.document;
    expect(edited.totals).toEqual({ netFils: 10000, vatFils: 500, grossFils: 10500 });

    const jc = (await call(app, "POST", `/api/documents/${est.id}/convert`, owner)).body.document;
    expect(jc.pricesIncludeVat).toBe(true);
    expect(jc.totals).toEqual({ netFils: 10000, vatFils: 500, grossFils: 10500 });

    const plain = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: [LINE] })).body.document;
    expect(plain.pricesIncludeVat).toBe(false);
    expect(plain.totals).toEqual({ netFils: 10500, vatFils: 525, grossFils: 11025 });
  });
});
