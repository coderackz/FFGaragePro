import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { call, makeApp, setUp, tempDir, type App } from "./helpers";

const LINE = (fils: number) => ({ kind: "labour", description: "Service", qty: 1, unitPriceFils: fils, discountPct: 0 });

async function garage(app?: App) {
  const a = app ?? (await makeApp());
  const owner = await setUp(a);
  const customer = (await call(a, "POST", "/api/customers", owner, { name: "Fleet LLC", kind: "company", creditAllowed: true })).body.customer;
  /** An issued invoice for `net` fils (+5% VAT) due on `due`. */
  const invoice = async (net: number, due: string, customerId = customer.id) => {
    const doc = (await call(a, "POST", "/api/documents", owner, { type: "invoice", customerId, lines: [LINE(net)] })).body.document;
    await call(a, "POST", `/api/documents/${doc.id}/issue`, owner);
    a.db.run("UPDATE documents SET due_date = ? WHERE id = ?", [due, doc.id]);
    return doc as { id: string; number: string };
  };
  const status = (id: string) => a.db.get<{ status: string; paid_fils: number }>("SELECT status, paid_fils FROM documents WHERE id = ?", [id])!;
  const receive = (body: Record<string, unknown>) => call(a, "POST", "/api/receipts", owner, { customerId: customer.id, method: "bank_transfer", ...body });
  const balance = async () => (await call(a, "GET", `/api/customers/${customer.id}`, owner)).body.customer;
  return { app: a, owner, customer, invoice, status, receive, balance };
}

describe("receipts", () => {
  it("one transfer across three invoices, oldest first", async () => {
    const { invoice, receive, status } = await garage();
    const a = await invoice(10000, "2026-11-01");
    const b = await invoice(20000, "2026-11-10");
    const c = await invoice(5000, "2026-11-20");
    const res = await receive({ amountFils: 30000, reference: "TT 4471" });
    expect(res.status).toBe(200);
    expect(res.body.receipt.number).toBe("RCT-00001");
    expect(res.body.receipt.allocations.map((x: { documentId: string; amountFils: number }) => [x.documentId, x.amountFils])).toEqual([[a.id, 10500], [b.id, 19500]]);
    expect(res.body.receipt.unallocatedFils).toBe(0);
    expect([status(a.id).status, status(b.id).status, status(c.id).status]).toEqual(["paid", "part_paid", "issued"]);
  });

  it("what isn't allocated is the customer's credit, and can be allocated later", async () => {
    const { app, owner, invoice, receive, status, balance } = await garage();
    await invoice(10000, "2026-11-01");
    await invoice(20000, "2026-11-10");
    await invoice(5000, "2026-11-20");
    const r = (await receive({ amountFils: 40000 })).body.receipt;
    expect(r.unallocatedFils).toBe(3250);
    expect((await balance()).creditFils).toBe(3250);
    const later = await invoice(2000, "2026-11-25");
    const res = await call(app, "POST", `/api/receipts/${r.id}/allocations`, owner, { allocations: [{ documentId: later.id, amountFils: 2100 }] });
    expect(res.status).toBe(200);
    expect(status(later.id).status).toBe("paid");
    expect((await balance()).creditFils).toBe(1150);
    // An allocation can be undone (a negative one), never below what was put there.
    expect((await call(app, "POST", `/api/receipts/${r.id}/allocations`, owner, { allocations: [{ documentId: later.id, amountFils: -2100 }] })).status).toBe(200);
    expect(status(later.id).status).toBe("issued");
    const tooMuch = await call(app, "POST", `/api/receipts/${r.id}/allocations`, owner, { allocations: [{ documentId: later.id, amountFils: -1 }] });
    expect(tooMuch.status).toBe(400);
  });

  it("bad amounts are refused, nothing written", async () => {
    const { app, owner, invoice, receive } = await garage();
    const a = await invoice(10000, "2026-11-01");
    const other = (await call(app, "POST", "/api/customers", owner, { name: "Someone else" })).body.customer;
    const theirs = await invoice(1000, "2026-11-01", other.id);
    const draft = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: (await receive({ amountFils: 1 })).body.receipt.customerId, lines: [LINE(1000)] })).body.document;
    const before = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM receipts")!.n;
    const cases: [Record<string, unknown>, string][] = [
      [{ amountFils: 0 }, "Amount can't be zero"],
      [{ amountFils: 5000, allocations: [{ documentId: a.id, amountFils: 6000 }] }, "The amounts put against invoices add up to more than the payment"],
      [{ amountFils: 20000, allocations: [{ documentId: a.id, amountFils: 11000 }] }, `${a.number} only owes AED 104.99`],
      [{ amountFils: 1000, allocations: [{ documentId: draft.id, amountFils: 1000 }] }, `${draft.number} hasn't been issued`],
      [{ amountFils: 1000, allocations: [{ documentId: theirs.id, amountFils: 1000 }] }, `${theirs.number} is another customer's invoice`],
      [{ amountFils: -5000 }, "The refund is more than the customer's credit of AED 0.00"],
    ];
    for (const [body, error] of cases) {
      const res = await receive(body);
      expect(res.status, error).toBe(400);
      expect(res.body.error).toBe(error);
    }
    expect(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM receipts")!.n).toBe(before);
  });

  it("a refund pays out credit", async () => {
    const { receive, balance } = await garage();
    await receive({ amountFils: 1150 });
    expect((await balance())).toMatchObject({ creditFils: 1150, balanceFils: -1150 });
    const refund = await receive({ amountFils: -1150, method: "cash" });
    expect(refund.status).toBe(200);
    expect((await balance())).toMatchObject({ creditFils: 0, balanceFils: 0 });
  });

  it("the invoice screen's Record payment still works", async () => {
    const { app, owner, invoice, status } = await garage();
    const a = await invoice(10000, "2026-11-01");
    expect((await call(app, "POST", `/api/documents/${a.id}/payments`, owner, { amountFils: 5000, method: "card" })).status).toBe(200);
    expect(status(a.id)).toEqual({ status: "part_paid", paid_fils: 5000 });
    expect(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM receipt_allocations WHERE document_id = ?", [a.id])!.n).toBe(1);
    const log = (await call(app, "GET", "/api/audit?action=receipt.create", owner)).body.entries;
    expect(log[0].after).toMatchObject({ customer: "Fleet LLC", amountFils: 5000, allocations: [{ document: a.number, amountFils: 5000 }] });
  });

  it("receipts are listed and logged", async () => {
    const { app, owner, customer, invoice, receive } = await garage();
    await invoice(10000, "2026-11-01");
    const r = (await receive({ amountFils: 10500 })).body.receipt;
    const list = (await call(app, "GET", `/api/receipts?customerId=${customer.id}`, owner)).body.receipts;
    expect(list.map((x: { number: string }) => x.number)).toEqual([r.number]);
    expect((await call(app, "GET", `/api/receipts/${r.id}`, owner)).body.receipt.allocations).toHaveLength(1);
    const log = (await call(app, "GET", "/api/audit?action=receipt.create", owner)).body.entries;
    expect(log[0].after).toMatchObject({ receipt: "RCT-00001", customer: "Fleet LLC", amountFils: 10500 });
  });

  it("a refused receipt takes no number", async () => {
    let asked = 0;
    const app = await buildApp({ dataDir: tempDir(), numbers: { next: async () => (asked++, null), offlineSeries: "P1" } });
    try {
      const { receive } = await garage(app);
      const before = asked;
      expect((await receive({ amountFils: -100 })).status).toBe(400);
      expect(asked).toBe(before);
    } finally {
      await app.close();
    }
  });
});
