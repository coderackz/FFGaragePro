import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { addDays } from "../src/books/post";
import { call, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const FUEL = "00000000-0000-4000-8000-0000000a6040";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const today = () => dubaiDate(new Date().toISOString());

async function garage() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), -60) });
  return { app, owner };
}
const byCode = (app: App, postKey: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [postKey]).map((r) => [r.code, r.d]));
const balanceOf = async (app: App, token: string, id: string) =>
  (await call(app, "GET", "/api/money-accounts", token)).body.accounts.find((a: { id: string }) => a.id === id).balanceFils;

describe("expenses, transfers and cheques", () => {
  it("expense with a photo", async () => {
    const { app, owner } = await garage();
    const res = await call(app, "POST", "/api/expenses", owner, { date: today(), accountId: FUEL, description: "Fuel for the tow truck", netFils: 10000, paidFromAccountId: A.cash.id, photo: PNG });
    expect(res.status).toBe(200);
    expect(res.body.expense).toMatchObject({ number: "EX-00001", vatFils: 500, grossFils: 10500, hasPhoto: true });
    expect(byCode(app, `expense:${res.body.expense.id}`)).toEqual({ "6040": 10000, "1300": 500, "1000": -10500 });
    expect((await call(app, "GET", `/api/expenses/${res.body.expense.id}/photo`, owner)).body.photo).toBe(PNG);
    const big = `data:image/png;base64,${"A".repeat(1_500_000)}`;
    expect((await call(app, "POST", "/api/expenses", owner, { date: today(), accountId: FUEL, description: "x", netFils: 100, paidFromAccountId: A.cash.id, photo: big })).status).toBe(400);
  });

  it("transfer moves money between accounts", async () => {
    const { app, owner } = await garage();
    expect((await call(app, "POST", "/api/transfers", owner, { date: today(), fromAccountId: A.bank.id, toAccountId: A.cash.id, amountFils: 50000, reference: "Float" })).status).toBe(200);
    expect(await balanceOf(app, owner, A.bank.id)).toBe(-50000);
    expect(await balanceOf(app, owner, A.cash.id)).toBe(50000);
    expect((await call(app, "POST", "/api/transfers", owner, { date: today(), fromAccountId: A.bank.id, toAccountId: FUEL, amountFils: 100 })).status).toBe(400);
  });

  it("customer cheque deposited; post-dated cheques wait", async () => {
    const { app, owner } = await garage();
    const c = (await call(app, "POST", "/api/customers", owner, { name: "Gulf Fleet" })).body.customer;
    const cheque = (await call(app, "POST", "/api/receipts", owner, { customerId: c.id, amountFils: 30000, method: "cheque", reference: "CHQ 101", chequeDate: today() })).body.receipt;
    const later = (await call(app, "POST", "/api/receipts", owner, { customerId: c.id, amountFils: 20000, method: "cheque", chequeDate: addDays(today(), 1) })).body.receipt;
    const inHand = (await call(app, "GET", "/api/cheques/in-hand", owner)).body.cheques;
    expect(inHand.map((x: { receiptId: string }) => x.receiptId).sort()).toEqual([cheque.id, later.id].sort());
    const dep = await call(app, "POST", "/api/cheques/deposits", owner, { receiptIds: [cheque.id], bankAccountId: A.bank.id, date: today() });
    expect(dep.status).toBe(200);
    expect(byCode(app, `cheque_deposit:${dep.body.deposits[0].id}`)).toEqual({ "1020": 30000, "1030": -30000 });
    expect((await call(app, "GET", "/api/cheques/in-hand", owner)).body.cheques.map((x: { receiptId: string }) => x.receiptId)).toEqual([later.id]);
    expect((await call(app, "POST", "/api/cheques/deposits", owner, { receiptIds: [cheque.id], bankAccountId: A.bank.id, date: today() })).status).toBe(409);
    const early = await call(app, "POST", "/api/cheques/deposits", owner, { receiptIds: [later.id], bankAccountId: A.bank.id, date: today() });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/not due until/);
  });

  it("issued cheque: payable on payment, bank on clearing", async () => {
    const { app, owner } = await garage();
    const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim" })).body.supplier;
    const day1 = addDays(today(), -2);
    const p = (await call(app, "POST", "/api/supplier-payments", owner, { supplierId: supplier.id, amountFils: 40000, method: "cheque", paidFromAccountId: A.bank.id, chequeNo: "000123", paidAt: day1 })).body.payment;
    expect(byCode(app, `supplier_payment:${p.id}`)).toEqual({ "2000": 40000, "2010": -40000 });
    expect(await balanceOf(app, owner, A.bank.id)).toBe(0);
    expect((await call(app, "GET", "/api/cheques/issued", owner)).body.cheques.map((x: { paymentId: string }) => x.paymentId)).toEqual([p.id]);
    const cleared = await call(app, "POST", "/api/cheques/clearances", owner, { paymentIds: [p.id], date: today() });
    expect(cleared.status).toBe(200);
    const clearKey = `cheque_clear:${cleared.body.clearances[0].id}`;
    expect(byCode(app, clearKey)).toEqual({ "2010": 40000, "1020": -40000 });
    expect(app.db.get("SELECT date FROM journal_entries WHERE post_key = ?", [clearKey])).toEqual({ date: today() });
    expect(await balanceOf(app, owner, A.bank.id)).toBe(-40000);
    expect((await call(app, "POST", "/api/cheques/clearances", owner, { paymentIds: [p.id], date: today() })).status).toBe(409);
    expect((await call(app, "GET", "/api/cheques/issued", owner)).body.cheques).toEqual([]);
  });
});
