import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { addDays } from "../src/books/post";
import { addUser, call, makeApp, receiveFrom, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const RENT = "00000000-0000-4000-8000-0000000a6010";
const CHARGES = "00000000-0000-4000-8000-0000000a6030";
const today = () => dubaiDate(new Date().toISOString());

async function garage(startDate = addDays(today(), -60)) {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate });
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Quoz Properties", termsDays: 30 })).body.supplier;
  const bill = async (lines: { accountId: string; description: string; netFils: number; vat?: string }[], billDate = today()) =>
    call(app, "POST", "/api/bills", owner, { supplierId: supplier.id, supplierInvoiceNo: `B-${Math.random().toString(36).slice(2, 7)}`, billDate, lines });
  const pay = (amountFils: number, extra: Record<string, unknown> = {}) =>
    call(app, "POST", "/api/supplier-payments", owner, { supplierId: supplier.id, amountFils, method: "bank_transfer", paidFromAccountId: A.bank.id, ...extra });
  const balance = async () => (await call(app, "GET", `/api/suppliers/${supplier.id}`, owner)).body.supplier;
  return { app, owner, supplier, bill, pay, balance };
}

const byCode = (app: App, postKey: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [postKey]).map((r) => [r.code, r.d]));
const healthOf = async (app: App, token: string, key: string) =>
  (await call(app, "GET", "/api/books/health", token)).body.checks.find((c: { key: string }) => c.key === key);

describe("supplier bills and payments", () => {
  it("bill posts net by account and VAT per line", async () => {
    const { app, supplier, bill } = await garage();
    const res = await bill([{ accountId: RENT, description: "Bay rent", netFils: 10000 }, { accountId: CHARGES, description: "Admin fee", netFils: 2000, vat: "none" }]);
    expect(res.status).toBe(200);
    expect(res.body.bill).toMatchObject({ netFils: 12000, vatFils: 500, grossFils: 12500, status: "posted" });
    expect(byCode(app, `supplier_bill:${res.body.bill.id}`)).toEqual({ "6010": 10000, "6030": 2000, "1300": 500, "2000": -12500 });
    expect(app.db.get("SELECT supplier_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.post_key = ? AND l.credit_fils > 0", [`supplier_bill:${res.body.bill.id}`]))
      .toEqual({ supplier_id: supplier.id });
  });

  it("pay oldest first", async () => {
    const { app, owner, supplier, bill, pay, balance } = await garage();
    const gr = await receiveFrom(app, owner, supplier.id, 8000, 400, addDays(today(), -40));
    const b = (await bill([{ accountId: RENT, description: "Rent", netFils: 10000 }, { accountId: CHARGES, description: "Fee", netFils: 2000, vat: "none" }])).body.bill;
    const p = await pay(10000);
    expect(p.status).toBe(200);
    expect(p.body.payment.number).toBe("PV-00001");
    expect(p.body.payment.allocations.map((a: { target: string; id: string; amountFils: number }) => [a.target, a.id, a.amountFils]))
      .toEqual([["goods_receipt", gr.id, 8400], ["bill", b.id, 1600]]);
    expect(byCode(app, `supplier_payment:${p.body.payment.id}`)).toEqual({ "2000": 10000, "1020": -10000 });
    expect((await balance()).balanceFils).toBe(10900);
  });

  it("overpayment becomes an advance", async () => {
    const { app, owner, supplier, bill, pay, balance } = await garage();
    await receiveFrom(app, owner, supplier.id, 8000, 400, addDays(today(), -40));
    await bill([{ accountId: RENT, description: "Rent", netFils: 10000 }, { accountId: CHARGES, description: "Fee", netFils: 2000, vat: "none" }]);
    const p = (await pay(25000)).body.payment;
    expect(p.unallocatedFils).toBe(4100);
    expect(await balance()).toMatchObject({ balanceFils: -4100, advanceFils: 4100 });
    expect(await healthOf(app, owner, "payables")).toMatchObject({ ok: true });
    const later = (await bill([{ accountId: RENT, description: "Next rent", netFils: 3905 }])).body.bill;
    expect(later.grossFils).toBe(4100);
    // The advance goes against the next bill by itself.
    const used = (await call(app, "GET", `/api/supplier-payments?supplierId=${supplier.id}`, owner)).body.payments.find((x: { id: string }) => x.id === p.id);
    expect(used.unallocatedFils).toBe(0);
    expect(await balance()).toMatchObject({ balanceFils: 0, advanceFils: 0 });
    expect((await call(app, "GET", `/api/suppliers/${supplier.id}/open-items`, owner)).body.items).toEqual([]);
    expect((await call(app, "POST", `/api/supplier-payments/${p.id}/allocations`, owner, { allocations: [{ target: "bill", id: later.id, amountFils: 1 }] })).status).toBe(400);
  });

  it("cancel only an unpaid bill", async () => {
    const { app, owner, bill, pay, balance } = await garage();
    const paid = (await bill([{ accountId: RENT, description: "Rent", netFils: 10000 }])).body.bill;
    await pay(5000);
    expect((await call(app, "POST", `/api/bills/${paid.id}/cancel`, owner, { reason: "Wrong" })).status).toBe(409);
    const unpaid = (await bill([{ accountId: RENT, description: "Duplicate", netFils: 2000 }])).body.bill;
    const cancelled = await call(app, "POST", `/api/bills/${unpaid.id}/cancel`, owner, { reason: "Entered twice" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.bill.status).toBe("cancelled");
    expect(byCode(app, `bill_cancel:${unpaid.id}`)).toEqual({ "6010": -2000, "1300": -100, "2000": 2100 });
    expect((await balance()).balanceFils).toBe(10500 - 5000);
  });

  it("locked dates and dates before the books start are refused", async () => {
    const { app, owner, bill, pay } = await garage(addDays(today(), -30));
    await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), -30), lockDate: addDays(today(), -10) });
    expect((await bill([{ accountId: RENT, description: "Rent", netFils: 1000 }], addDays(today(), -12))).status).toBe(400);
    expect((await bill([{ accountId: RENT, description: "Rent", netFils: 1000 }], addDays(today(), -40))).status).toBe(400);
    expect((await pay(1000, { paidAt: addDays(today(), -11) })).status).toBe(400);
    expect((await bill([{ accountId: A.receivables.id, description: "Odd", netFils: 1000 }])).status).toBe(400);
  });

  it("advisors can't touch bills or payments", async () => {
    const { app, owner, supplier } = await garage();
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "GET", "/api/bills", advisor)).status).toBe(403);
    expect((await call(app, "POST", "/api/supplier-payments", advisor, { supplierId: supplier.id, amountFils: 100, method: "cash", paidFromAccountId: A.cash.id })).status).toBe(403);
  });
});
