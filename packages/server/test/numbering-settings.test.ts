import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { takeNumber } from "../src/numbering";
import { call, makeApp, setUp, tempDir } from "./helpers";

const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
  const invoice = async () => (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [LINE] })).body.document;
  const numbering = (body: Record<string, unknown>) => call(app, "PUT", "/api/settings/numbering", owner, body);
  return { app, owner, invoice, numbering };
}

describe("numbering from settings", () => {
  it("a new prefix applies to new documents only", async () => {
    const { invoice, numbering, app, owner } = await garage();
    const first = await invoice();
    expect(first.number).toBe("INV-00001");
    expect((await numbering({ invoicePrefix: "TI" })).status).toBe(200);
    expect((await invoice()).number).toBe("TI-00002");
    expect((await call(app, "GET", `/api/documents/${first.id}`, owner)).body.document.number).toBe("INV-00001");
  });

  it("next number can jump forward", async () => {
    const { invoice, numbering } = await garage();
    expect((await numbering({ invoiceStart: 500 })).status).toBe(200);
    expect((await invoice()).number).toBe("INV-00500");
    expect((await invoice()).number).toBe("INV-00501");
  });

  it("next number never goes back", async () => {
    const { invoice, numbering } = await garage();
    for (let i = 0; i < 3; i++) await invoice();
    const res = await numbering({ invoiceStart: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INV can't go back: the next number is INV-00004");
    expect((await numbering({ invoiceStart: 4 })).status).toBe(200);
    expect((await invoice()).number).toBe("INV-00004");
  });

  it("an old start that's now behind doesn't block saving other numbering changes", async () => {
    const { invoice, numbering } = await garage();
    await numbering({ invoiceStart: 10 });
    await invoice();
    await invoice();
    expect((await numbering({ invoiceStart: 10, jobcardPrefix: "JOB" })).status).toBe(200);
  });

  it("two types can't share a prefix", async () => {
    const { numbering } = await garage();
    const res = await numbering({ jobcardPrefix: "INV" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Each document type needs its own prefix");
  });

  it("offline series ignore the start", async () => {
    const dir = tempDir();
    const app = await buildApp({ dataDir: dir, numbers: { next: async () => null, offlineSeries: "P1" } });
    try {
      const owner = await setUp(app);
      await call(app, "PUT", "/api/settings/numbering", owner, { invoiceStart: 500 });
      const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
      const doc = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [LINE] })).body.document;
      expect(doc.number).toBe("INV-P1-00001");
    } finally {
      await app.close();
    }
  });

  it("the cloud's reserved number honours the start", async () => {
    const { app, numbering } = await garage();
    await numbering({ invoiceStart: 900 });
    expect(app.db.tx(() => takeNumber(app.db, "invoice", null, undefined)).seq).toBe(900);
  });

  it("purchase orders use their prefix too", async () => {
    const { app, owner, numbering } = await garage();
    await numbering({ purchaseOrderPrefix: "LPO", purchaseOrderStart: 20 });
    const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Parts Co" })).body.supplier;
    const po = (await call(app, "POST", "/api/purchase-orders", owner, { supplierId: supplier.id, lines: [{ description: "Filter", qty: 1 }] })).body.purchaseOrder;
    expect(po.number).toBe("LPO-00020");
  });
});
