import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { addDays } from "../src/books/post";
import { call, makeApp, setUp } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const CHARGES = "00000000-0000-4000-8000-0000000a6030";
const today = () => dubaiDate(new Date().toISOString());
const dmy = (ymd: string) => `${ymd.slice(8)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const MAPPING = { date: 0, description: 1, debit: 2, credit: 3, reference: 4, dateFormat: "dd/mm/yyyy", hasHeader: true };

async function garage() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), -60) });
  expect((await call(app, "PUT", `/api/money-accounts/${A.bank.id}/mapping`, owner, MAPPING)).status).toBe(200);
  const upload = (csv: string) => call(app, "POST", `/api/money-accounts/${A.bank.id}/imports`, owner, { fileName: "statement.csv", csv, openingBalanceFils: 0 });
  const reconcile = async () => (await call(app, "GET", `/api/money-accounts/${A.bank.id}/reconcile`, owner)).body;
  return { app, owner, upload, reconcile };
}

describe("bank reconciliation", () => {
  it("import parses layouts and skips duplicates", async () => {
    const { upload, reconcile } = await garage();
    const csv = `Date,Details,Debit,Credit,Ref\n${dmy(today())},"Transfer, Al Futtaim","1,234.50",,TR1\n${dmy(today())},Card settlement,,"2,000.00",\n${dmy(today())},Bank charge,15.75,,\n`;
    expect((await upload(csv)).body).toMatchObject({ added: 3, skipped: 0 });
    expect((await upload(csv)).body).toMatchObject({ added: 0, skipped: 3 });
    const r = await reconcile();
    expect(r.lines.map((l: { amountFils: number }) => l.amountFils).sort((a: number, b: number) => a - b)).toEqual([-123450, -1575, 200000]);
    expect(r.statementBalanceFils).toBe(200000 - 123450 - 1575);
    expect((await upload("Date,Details,Debit,Credit,Ref\n31/02/2026,x,1,,\n")).status).toBe(400);
  });

  it("suggest, match, add a bank charge, reconcile", async () => {
    const { app, owner, upload, reconcile } = await garage();
    const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim" })).body.supplier;
    await call(app, "POST", "/api/supplier-payments", owner, { supplierId: supplier.id, amountFils: 123450, method: "bank_transfer", paidFromAccountId: A.bank.id, paidAt: addDays(today(), -2) });
    await upload(`Date,Details,Debit,Credit,Ref\n${dmy(today())},Transfer Al Futtaim,"1,234.50",,TR1\n${dmy(today())},Bank charge,15.75,,\n`);
    let r = await reconcile();
    const transfer = r.lines.find((l: { amountFils: number }) => l.amountFils === -123450);
    const charge = r.lines.find((l: { amountFils: number }) => l.amountFils === -1575);
    const suggestion = r.suggestions.find((s: { bankLineId: string }) => s.bankLineId === transfer.id);
    expect(suggestion).toBeTruthy();
    expect((await call(app, "POST", `/api/bank-lines/${transfer.id}/match`, owner, { journalLineId: suggestion.journalLineId })).status).toBe(200);
    const added = await call(app, "POST", `/api/bank-lines/${charge.id}/expense`, owner, { accountId: CHARGES, vat: "none", description: "Bank charges" });
    expect(added.status).toBe(200);
    r = await reconcile();
    expect(r.lines.filter((l: { matchedLineId: string | null }) => !l.matchedLineId)).toEqual([]);
    expect(r.unmatchedBookLines).toEqual([]);
    expect(r.bookBalanceFils).toBe(r.statementBalanceFils);
    expect(r.bookBalanceFils).toBe(-125025);
  });

  it("a journal line can't be matched twice; unmatching frees it", async () => {
    const { app, owner, upload, reconcile } = await garage();
    await call(app, "POST", "/api/transfers", owner, { date: today(), fromAccountId: A.cash.id, toAccountId: A.bank.id, amountFils: 5000 });
    await upload(`Date,Details,Debit,Credit,Ref\n${dmy(today())},Cash in,,50.00,A\n${dmy(today())},Cash in again,,50.00,B\n`);
    const r = await reconcile();
    const journalLineId = r.suggestions[0].journalLineId;
    const [a, b] = r.lines;
    expect((await call(app, "POST", `/api/bank-lines/${a.id}/match`, owner, { journalLineId })).status).toBe(200);
    expect((await call(app, "POST", `/api/bank-lines/${b.id}/match`, owner, { journalLineId })).status).toBe(409);
    expect((await call(app, "POST", `/api/bank-lines/${a.id}/unmatch`, owner)).status).toBe(200);
    expect((await call(app, "POST", `/api/bank-lines/${b.id}/match`, owner, { journalLineId })).status).toBe(200);
  });
});
