import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { addDays } from "../src/books/post";
import { call, makeApp, receiveFrom, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const RENT = "00000000-0000-4000-8000-0000000a6010";
const CHARGES = "00000000-0000-4000-8000-0000000a6030";
const today = () => dubaiDate(new Date().toISOString());
const dmy = (ymd: string) => `${ymd.slice(8)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const MAPPING = { date: 0, description: 1, debit: 2, credit: 3, dateFormat: "dd/mm/yyyy", hasHeader: true };

async function garage(startDate: string | null = addDays(today(), -60), posts = true) {
  const app = await makeApp(undefined, { postsBooks: posts });
  const owner = await setUp(app);
  if (startDate) await call(app, "PUT", "/api/settings/books", owner, { startDate });
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim", termsDays: 30 })).body.supplier;
  const bill = async (netFils: number, billDate = today()) =>
    (await call(app, "POST", "/api/bills", owner, { supplierId: supplier.id, supplierInvoiceNo: `B${Math.random()}`, billDate, lines: [{ accountId: RENT, description: "Rent", netFils, vat: "none" }] })).body.bill;
  const pay = async (amountFils: number, extra: Record<string, unknown> = {}) =>
    (await call(app, "POST", "/api/supplier-payments", owner, { supplierId: supplier.id, amountFils, method: "bank_transfer", paidFromAccountId: A.bank.id, ...extra })).body.payment;
  const check = async (key: string) => (await call(app, "GET", "/api/books/health", owner)).body.checks.find((c: { key: string }) => c.key === key);
  const csv = (lines: [string, string, string, string][]) => `Date,Details,Debit,Credit\n${lines.map((l) => l.join(",")).join("\n")}\n`;
  return { app, owner, supplier, bill, pay, check, csv };
}
const postOpening = async (app: App, owner: string, extra: { accountId: string; debitFils: number; creditFils: number }[] = []) => {
  const p = (await call(app, "GET", "/api/books/opening/proposal", owner)).body;
  const d = (await call(app, "POST", "/api/books/drafts", owner, { kind: "opening", date: p.date, narration: "Opening", lines: [...p.lines, ...extra] })).body.draft;
  const r = await call(app, "POST", `/api/books/drafts/${d.id}/post`, owner);
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return p;
};

describe("Part 2 review fixes", () => {
  it("C1: a bank with an opening balance reconciles from the statement's starting balance", async () => {
    const { app, owner, pay, csv } = await garage(today());
    await postOpening(app, owner, [{ accountId: A.bank.id, debitFils: 5000000, creditFils: 0 }]);
    await pay(10000);
    await call(app, "PUT", `/api/money-accounts/${A.bank.id}/mapping`, owner, MAPPING);
    const statement = csv([[dmy(today()), "Transfer Al Futtaim", "100.00", ""]]);
    const first = await call(app, "POST", `/api/money-accounts/${A.bank.id}/imports`, owner, { fileName: "nov.csv", csv: statement });
    expect(first.status).toBe(400);
    expect(first.body.error).toMatch(/balance before/);
    expect((await call(app, "POST", `/api/money-accounts/${A.bank.id}/imports`, owner, { fileName: "nov.csv", csv: statement, openingBalanceFils: 5000000 })).body.added).toBe(1);
    let r = (await call(app, "GET", `/api/money-accounts/${A.bank.id}/reconcile`, owner)).body;
    await call(app, "POST", `/api/bank-lines/${r.lines[0].id}/match`, owner, { journalLineId: r.suggestions[0].journalLineId });
    r = (await call(app, "GET", `/api/money-accounts/${A.bank.id}/reconcile`, owner)).body;
    expect(r).toMatchObject({ statementBalanceFils: 4990000, bookBalanceFils: 4990000, unmatchedBookLines: [], reconciled: true });
  });

  it("I1: the opening proposal carries suppliers, cheques in hand and cheques issued from before the start", async () => {
    const { app, owner, supplier, pay, check } = await garage(null);
    await receiveFrom(app, owner, supplier.id, 10000, 500, addDays(today(), -20));
    await pay(2000, { method: "cheque", chequeNo: "77" });
    const c = (await call(app, "POST", "/api/customers", owner, { name: "Gulf Fleet" })).body.customer;
    await call(app, "POST", "/api/receipts", owner, { customerId: c.id, amountFils: 30000, method: "cheque", chequeDate: today() });
    await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), 1) });
    const p = await postOpening(app, owner);
    expect(p.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: A.payables.id, supplierId: supplier.id, creditFils: 8500 }),
      expect.objectContaining({ accountId: A.cheques_issued.id, creditFils: 2000 }),
      expect.objectContaining({ accountId: A.cheques_in_hand.id, debitFils: 30000 }),
    ]));
    for (const key of ["receivables", "payables"]) expect(await check(key)).toMatchObject({ ok: true });
  });

  it("I2: items dated in the future don't turn health red", async () => {
    const { bill, check } = await garage();
    await bill(10500, addDays(today(), 3));
    expect(await check("payables")).toMatchObject({ ok: true });
  });

  it("I3: an opening balance is the oldest item: in aging, and paid first", async () => {
    const { app, owner, supplier, bill, pay } = await garage();
    await call(app, "PATCH", `/api/suppliers/${supplier.id}`, owner, { openingBalanceFils: 100000, openingBalanceDate: addDays(today(), -40) });
    const aging = (await call(app, "GET", "/api/reports/payables-aging", owner)).body;
    expect(aging.suppliers[0]).toMatchObject({ id: supplier.id, totalFils: 100000 });
    await bill(50000);
    const p = await pay(100000);
    expect(p.allocations.map((a: { target: string; amountFils: number }) => [a.target, a.amountFils])).toEqual([["opening", 100000]]);
    expect(p.unallocatedFils).toBe(0);
    expect((await call(app, "GET", `/api/suppliers/${supplier.id}`, owner)).body.supplier).toMatchObject({ balanceFils: 50000, advanceFils: 0 });
  });

  it("I4: an advance is used by the next bill", async () => {
    const { app, owner, supplier, bill, pay } = await garage();
    const p = await pay(100000);
    expect(p.unallocatedFils).toBe(100000);
    await bill(100000);
    expect((await call(app, "GET", `/api/suppliers/${supplier.id}/open-items`, owner)).body.items).toEqual([]);
    expect((await call(app, "GET", `/api/supplier-payments?supplierId=${supplier.id}`, owner)).body.payments[0].unallocatedFils).toBe(0);
  });

  it("I7: cheques paid in together are one bank line", async () => {
    const { app, owner } = await garage();
    const c = (await call(app, "POST", "/api/customers", owner, { name: "Gulf Fleet" })).body.customer;
    const ids: string[] = [];
    for (const amountFils of [100000, 200000, 50000]) ids.push((await call(app, "POST", "/api/receipts", owner, { customerId: c.id, amountFils, method: "cheque" })).body.receipt.id);
    expect((await call(app, "POST", "/api/cheques/deposits", owner, { receiptIds: ids, bankAccountId: A.bank.id, date: today() })).status).toBe(200);
    const bankLines = app.db.all<{ debit_fils: number }>(
      "SELECT l.debit_fils FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_type = 'cheque_deposit' AND l.account_id = ?", [A.bank.id]);
    expect(bankLines).toEqual([{ debit_fils: 350000 }]);
  });

  it("I8: a match is suggested for a unique amount even weeks apart", async () => {
    const { app, owner, pay, csv } = await garage();
    await pay(12345, { paidAt: addDays(today(), -20) });
    await call(app, "PUT", `/api/money-accounts/${A.bank.id}/mapping`, owner, MAPPING);
    await call(app, "POST", `/api/money-accounts/${A.bank.id}/imports`, owner, { fileName: "s.csv", csv: csv([[dmy(addDays(today(), -25)), "Interest", "", "1.00"], [dmy(today()), "Late transfer", "123.45", ""]]), openingBalanceFils: 0 });
    const r = (await call(app, "GET", `/api/money-accounts/${A.bank.id}/reconcile`, owner)).body;
    expect(r.suggestions).toEqual([{ bankLineId: r.lines.find((l: { amountFils: number }) => l.amountFils === -12345).id, journalLineId: expect.any(String) }]);
  });

  it("I9: a bank charge is entered once, at its exact amount, and matched", async () => {
    const { app, owner, csv } = await garage();
    await call(app, "PUT", `/api/money-accounts/${A.bank.id}/mapping`, owner, MAPPING);
    await call(app, "POST", `/api/money-accounts/${A.bank.id}/imports`, owner, { fileName: "s.csv", csv: csv([[dmy(today()), "Fee", "105.01", ""]]), openingBalanceFils: 0 });
    const line = (await call(app, "GET", `/api/money-accounts/${A.bank.id}/reconcile`, owner)).body.lines[0];
    const res = await call(app, "POST", `/api/bank-lines/${line.id}/expense`, owner, { accountId: CHARGES, vat: "standard", description: "Fee" });
    expect(res.body).toMatchObject({ matched: true, expense: { grossFils: 10501 } });
    expect((await call(app, "POST", `/api/bank-lines/${line.id}/expense`, owner, { accountId: CHARGES, vat: "standard", description: "Fee" })).status).toBe(409);
    // A linked PC: the expense is made, a second click is still refused.
    const pc = await garage(addDays(today(), -60), false);
    await call(pc.app, "PUT", `/api/money-accounts/${A.bank.id}/mapping`, pc.owner, MAPPING);
    await call(pc.app, "POST", `/api/money-accounts/${A.bank.id}/imports`, pc.owner, { fileName: "s.csv", csv: csv([[dmy(today()), "Fee", "10.00", ""]]), openingBalanceFils: 0 });
    const pcLine = (await call(pc.app, "GET", `/api/money-accounts/${A.bank.id}/reconcile`, pc.owner)).body.lines[0];
    expect((await call(pc.app, "POST", `/api/bank-lines/${pcLine.id}/expense`, pc.owner, { accountId: CHARGES, vat: "none", description: "Fee" })).body.matched).toBe(false);
    expect((await call(pc.app, "POST", `/api/bank-lines/${pcLine.id}/expense`, pc.owner, { accountId: CHARGES, vat: "none", description: "Fee" })).status).toBe(409);
  });
});
