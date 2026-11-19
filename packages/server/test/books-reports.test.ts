import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { addDays } from "../src/books/post";
import { customerBalance } from "../src/ledger";
import { call, createPart, makeApp, setUp } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const RENT = "00000000-0000-4000-8000-0000000a6010";
const today = () => dubaiDate(new Date().toISOString());

/** A small garage day: parts bought, one fitted and invoiced with labour, paid in cash, rent paid from the bank. */
async function day() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: today() });
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Gulf Fleet LLC" })).body.customer;
  const part = await createPart(app, owner, { sellPriceFils: 6000 });
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim Parts" })).body.supplier;
  const po = (await call(app, "POST", "/api/purchase-orders", owner, { supplierId: supplier.id, lines: [{ partId: part.id, description: "Oil filter", qty: 2, unitCostFils: 4000 }] })).body.purchaseOrder;
  await call(app, "PATCH", `/api/purchase-orders/${po.id}`, owner, { status: "sent" });
  await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, owner, { vatFils: 400, lines: [{ poLineId: po.lines[0].id, qty: 2, unitCostFils: 4000 }] });
  const jc = (await call(app, "POST", "/api/documents", owner, {
    type: "jobcard", customerId: customer.id,
    lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }, { kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 6000, discountPct: 0, partId: part.id }],
  })).body.document;
  const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
  await call(app, "POST", `/api/documents/${inv.id}/issue`, owner);
  await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 16800, method: "cash" });
  const draft = (await call(app, "POST", "/api/books/drafts", owner, { date: today(), narration: "Rent", lines: [{ accountId: RENT, debitFils: 3000 }, { accountId: A.bank.id, creditFils: 3000 }] })).body.draft;
  expect((await call(app, "POST", `/api/books/drafts/${draft.id}/post`, owner)).status).toBe(200);
  const get = async (path: string) => {
    const res = await call(app, "GET", path, owner);
    if (res.status !== 200) throw new Error(`${path}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  return { app, owner, customer, part, get };
}

const amount = (rows: { code: string; amountFils: number }[], code: string) => rows.find((r) => r.code === code)?.amountFils;

describe("reports", () => {
  it("trial balance balances", async () => {
    const { get } = await day();
    const tb = await get(`/api/books/trial-balance?asOf=${today()}`);
    expect(tb.totals.debitFils).toBe(tb.totals.creditFils);
    const row = (code: string) => tb.rows.find((r: { code: string }) => r.code === code);
    expect(row("1000")).toMatchObject({ debitFils: 16800, creditFils: 0 });
    expect(row("2000")).toMatchObject({ debitFils: 0, creditFils: 8400 });
    expect(row("1100")).toBeUndefined(); // paid in full: zero balances aren't listed
  });

  it("profit and loss", async () => {
    const { get } = await day();
    const pl = await get(`/api/books/profit-loss?from=${today()}&to=${today()}`);
    expect(amount(pl.current.income, "4000")).toBe(10000);
    expect(amount(pl.current.income, "4010")).toBe(6000);
    expect(amount(pl.current.costOfSales, "5000")).toBe(4000);
    expect(pl.current).toMatchObject({ incomeFils: 16000, costOfSalesFils: 4000, grossProfitFils: 12000, expensesFils: 3000, netProfitFils: 9000 });
    expect(pl.previous.netProfitFils).toBe(0);
  });

  it("balance sheet: assets = liabilities + equity", async () => {
    const { get } = await day();
    const bs = await get(`/api/books/balance-sheet?asOf=${today()}`);
    expect(bs).toMatchObject({ assetsFils: 18200, liabilitiesFils: 9200, profitThisYearFils: 9000, equityFils: 9000 });
    expect(bs.assetsFils).toBe(bs.liabilitiesFils + bs.equityFils);
  });

  it("the customer's ledger ends at their balance", async () => {
    const { app, customer, get } = await day();
    const ledger = await get(`/api/books/ledger?accountId=${A.receivables.id}&customerId=${customer.id}`);
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.closingFils).toBe(customerBalance(app.db, customer.id).balanceFils);
    expect(ledger.rows[0]).toMatchObject({ debitFils: 16800, balanceFils: 16800, sourceType: "invoice" });
    expect(ledger.rows[0].sourceNumber).toMatch(/^INV-/);
  });

  it("journals list and one journal with its lines", async () => {
    const { get } = await day();
    const list = await get("/api/books/journals");
    expect(list.journals.map((j: { sourceType: string }) => j.sourceType).sort()).toEqual(["cogs", "goods_receipt", "invoice", "manual", "receipt", "stock"]);
    const manual = list.journals.find((j: { sourceType: string }) => j.sourceType === "manual");
    expect(manual.totalFils).toBe(3000);
    const one = await get(`/api/books/journals/${manual.id}`);
    expect(one.entry.lines.map((l: { code: string }) => l.code)).toEqual(["6010", "1020"]);
  });

  it("health is green after normal work and flags a mismatch; revalue stock clears it", async () => {
    const { app, owner, part, get } = await day();
    const health = await get("/api/books/health");
    expect(health.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(health.checks.map((c: { key: string }) => c.key)).toEqual(["trial_balance", "receivables", "inventory", "output_vat", "opening_clearing"]);
    // A recalculated cost: the books correct inventory by themselves (to stock revaluation, a cost of sales).
    app.db.run("UPDATE parts SET avg_cost_fils = 4500 WHERE id = ?", [part.id]);
    expect((await get("/api/books/health")).checks.find((c: { key: string }) => c.key === "inventory")).toMatchObject({ ok: true, appFils: 4500, booksFils: 4500 });
    expect(app.db.get("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'revaluation'")).toEqual({ n: 1 });
    expect((await call(app, "POST", "/api/books/revalue-stock", owner)).status).toBe(409);
  });

  it("report dates: a trial balance before an entry excludes it", async () => {
    const { get } = await day();
    const tb = await get(`/api/books/trial-balance?asOf=${addDays(today(), -1)}`);
    expect(tb.rows).toEqual([]);
    expect(tb.totals).toEqual({ debitFils: 0, creditFils: 0 });
  });

  it("opening WIP keeps its job card through a draft", async () => {
    const app = await makeApp(undefined, { postsBooks: true });
    const owner = await setUp(app);
    const start = addDays(today(), 1);
    await call(app, "PUT", "/api/settings/books", owner, { startDate: start });
    const customer = (await call(app, "POST", "/api/customers", owner, { name: "X" })).body.customer;
    const part = await createPart(app, owner, {}, { qty: 2, unitCostFils: 2500 });
    const jc = (await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, lines: [{ kind: "part", description: "Filter", qty: 1, unitPriceFils: 4000, discountPct: 0, partId: part.id }] })).body.document;
    const proposal = (await call(app, "GET", "/api/books/opening/proposal", owner)).body;
    const draft = (await call(app, "POST", "/api/books/drafts", owner, { kind: "opening", date: proposal.date, narration: "Opening", lines: proposal.lines })).body.draft;
    const posted = (await call(app, "POST", `/api/books/drafts/${draft.id}/post`, owner)).body.entry;
    expect(posted.lines.find((l: { code: string }) => l.code === "1210")).toMatchObject({ debitFils: 2500, documentId: jc.id });
  });
});
