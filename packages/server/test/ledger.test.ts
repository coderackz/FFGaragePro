import { describe, expect, it } from "vitest";
import { agingReport, customerBalance, customerLedger } from "../src/ledger";
import { addUser, call, makeApp, setUp } from "./helpers";

const LINE = (fils: number) => ({ kind: "labour", description: "Service", qty: 1, unitPriceFils: fils, discountPct: 0 });

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, {
    name: "Fleet LLC", kind: "company", creditAllowed: true, termsDays: 30, openingBalanceFils: 5000, openingBalanceDate: "2026-10-01",
  })).body.customer;
  /** An issued invoice for `net` fils (+5% VAT), issued on `day` (Dubai), due `due`. */
  const invoice = async (net: number, day: string, due: string) => {
    const doc = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [LINE(net)] })).body.document;
    await call(app, "POST", `/api/documents/${doc.id}/issue`, owner);
    app.db.run("UPDATE documents SET issued_at = ?, due_date = ? WHERE id = ?", [`${day}T06:00:00.000Z`, due, doc.id]);
    return doc.id as string;
  };
  /** A payment on an invoice, received on `day`. */
  const pay = async (docId: string, fils: number, day: string) => {
    await call(app, "POST", `/api/documents/${docId}/payments`, owner, { amountFils: fils, method: "bank_transfer" });
    app.db.run("UPDATE receipts SET received_at = ? WHERE id = (SELECT receipt_id FROM receipt_allocations WHERE document_id = ? ORDER BY created_at DESC LIMIT 1)", [`${day}T06:00:00.000Z`, docId]);
  };
  /** Money received but not put against any invoice. */
  const unallocated = (fils: number, day: string) => {
    const t = `${day}T06:00:00.000Z`;
    app.db.run(
      "INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, received_at, created_at) VALUES (?, '', 99, 'RCT-00099', ?, ?, 'cash', ?, ?)",
      [`r-${fils}`, customer.id, fils, t, t],
    );
  };
  return { app, owner, customer, invoice, pay, unallocated };
}

describe("customer ledger", () => {
  it("balance = opening + invoices − credit notes − receipts", async () => {
    const { app, customer, invoice, pay, unallocated } = await garage();
    const inv = await invoice(10000, "2026-10-10", "2026-11-09");
    await pay(inv, 8000, "2026-10-20");
    expect(customerBalance(app.db, customer.id)).toEqual({ balanceFils: 7500, overdueFils: expect.any(Number), creditFils: 0 });
    unallocated(1000, "2026-10-25");
    expect(customerBalance(app.db, customer.id)).toMatchObject({ balanceFils: 6500, creditFils: 1000 });
  });

  it("statement ties to the balance", async () => {
    const { app, customer, invoice, pay } = await garage();
    const oct = await invoice(10000, "2026-10-10", "2026-11-09");
    await pay(oct, 8000, "2026-10-20");
    const nov = await invoice(20000, "2026-11-05", "2026-12-05");
    await pay(nov, 3000, "2026-11-15");
    const s = customerLedger(app.db, customer.id, "2026-11-01", "2026-11-30");
    expect(s.openingFils).toBe(5000 + 10500 - 8000);
    expect(s.rows.map((r) => [r.kind, r.debitFils, r.creditFils])).toEqual([["invoice", 21000, 0], ["receipt", 0, 3000]]);
    expect(s.rows.at(-1)!.balanceFils).toBe(s.closingFils);
    expect(s.closingFils).toBe(customerBalance(app.db, customer.id, "2026-11-30").balanceFils);
    expect(s.closingFils).toBe(7500 + 21000 - 3000);
    // A range that starts before the opening balance shows it as its own row.
    const all = customerLedger(app.db, customer.id, "2026-09-01", "2026-11-30");
    expect(all.openingFils).toBe(0);
    expect(all.rows[0]).toMatchObject({ kind: "opening", debitFils: 5000 });
    expect(all.closingFils).toBe(s.closingFils);
  });

  it("aging puts each invoice in its bucket by days past due", async () => {
    const { app, invoice } = await garage();
    await invoice(10000, "2026-09-01", "2026-10-20"); // 12 days late on 1 Nov
    await invoice(20000, "2026-08-01", "2026-09-20"); // 42
    await invoice(40000, "2026-06-01", "2026-07-20"); // 104
    await invoice(80000, "2026-10-25", "2026-11-24"); // not yet due
    const r = agingReport(app.db, "2026-11-01");
    expect(r.customers).toHaveLength(1);
    // The opening balance (dated 1 Oct) ages from its own date.
    expect(r.customers[0]!.buckets).toEqual({ current: 84000, "1-30": 10500, "31-60": 21000 + 5000, "61-90": 0, "90+": 42000 });
    expect(r.customers[0]!.totalFils).toBe(84000 + 5000 + 10500 + 21000 + 42000);
    expect(r.totals["90+"]).toBe(42000);
  });

  it("customer API shows credit fields and balance; advisors can't see aging", async () => {
    const { app, owner, customer, invoice } = await garage();
    await invoice(10000, "2026-10-10", "2026-11-09");
    const res = await call(app, "PATCH", `/api/customers/${customer.id}`, owner, { name: "Fleet LLC", kind: "company", creditAllowed: true, creditLimitFils: 500000, termsDays: 45 });
    expect(res.status).toBe(200);
    const got = (await call(app, "GET", `/api/customers/${customer.id}`, owner)).body.customer;
    expect(got).toMatchObject({ creditAllowed: true, creditLimitFils: 500000, termsDays: 45, balanceFils: 15500, overLimit: false });
    const listed = (await call(app, "GET", "/api/customers", owner)).body.customers.find((c: { id: string }) => c.id === customer.id);
    expect(listed.balanceFils).toBe(15500);
    expect((await call(app, "GET", `/api/customers/${customer.id}/statement?from=2026-10-01&to=2026-10-31`, owner)).body.statement.closingFils).toBe(15500);
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "GET", "/api/reports/aging?asOf=2026-11-01", advisor)).status).toBe(403);
    expect((await call(app, "GET", "/api/reports/aging?asOf=2026-11-01", owner)).status).toBe(200);
    // Advisors keep customers up to date but can't change credit terms.
    expect((await call(app, "PATCH", `/api/customers/${customer.id}`, advisor, { phone: "050 5" })).status).toBe(200);
    const refused = await call(app, "PATCH", `/api/customers/${customer.id}`, advisor, { creditLimitFils: 9_000_000 });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Only the Owner or an Accountant can change a customer's credit terms");
    expect((await call(app, "POST", "/api/customers", advisor, { name: "New Co", creditAllowed: true })).status).toBe(403);
  });
});

