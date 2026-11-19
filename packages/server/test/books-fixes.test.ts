import { describe, expect, it, vi } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { addDays } from "../src/books/post";
import { call, createPart, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const RENT = "00000000-0000-4000-8000-0000000a6010";
const today = () => dubaiDate(new Date().toISOString());
const LABOUR = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };
const line = (accountId: string, debitFils: number, creditFils: number) => ({ accountId, debitFils, creditFils });

async function books(o: { posts?: boolean; startDate?: string } = {}) {
  const app = await makeApp(undefined, { postsBooks: o.posts ?? true });
  const owner = await setUp(app);
  expect((await call(app, "PUT", "/api/settings/books", owner, { startDate: o.startDate ?? today() })).status).toBe(200);
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Gulf Fleet LLC" })).body.customer;
  return { app, owner, customer };
}
const health = async (app: App, token: string) => (await call(app, "GET", "/api/books/health", token)).body;
const check = async (app: App, token: string, key: string) => (await health(app, token)).checks.find((c: { key: string }) => c.key === key);
const setBooks = (app: App, field: string, value: unknown) => app.db.run("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(value), `books.${field}`]);
async function postJournal(app: App, token: string, date: string, lines: ReturnType<typeof line>[]) {
  const d = (await call(app, "POST", "/api/books/drafts", token, { date, narration: "x", lines })).body.draft;
  return call(app, "POST", `/api/books/drafts/${d.id}/post`, token);
}
async function receive(app: App, token: string, partId: string, qty: number, unitCostFils: number) {
  const supplier = (await call(app, "POST", "/api/suppliers", token, { name: `S${Math.random()}` })).body.supplier;
  const po = (await call(app, "POST", "/api/purchase-orders", token, { supplierId: supplier.id, lines: [{ partId, description: "Part", qty, unitCostFils }] })).body.purchaseOrder;
  await call(app, "PATCH", `/api/purchase-orders/${po.id}`, token, { status: "sent" });
  const r = await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, token, { vatFils: 0, lines: [{ poLineId: po.lines[0].id, qty, unitCostFils }] });
  expect(r.status).toBe(200);
}

describe("review fixes", () => {
  it("C1: a payment account must be an active asset account", async () => {
    const { app, owner } = await books();
    const methods = { cash: A.cash.id, card: A.card_clearing.id, bank_transfer: A.bank.id, cheque: A.cheques_in_hand.id };
    expect((await call(app, "PUT", "/api/settings/books", owner, { startDate: today(), methodAccounts: { ...methods, cash: "nope" } })).status).toBe(400);
    expect((await call(app, "PUT", "/api/settings/books", owner, { startDate: today(), methodAccounts: { ...methods, cash: RENT } })).status).toBe(400);
  });

  it("C1: one event that can't post doesn't stop the others, the reports or sync", async () => {
    const { app, owner, customer } = await books();
    setBooks(app, "methodAccounts", { cash: "00000000-0000-4000-8000-000000000bad", card: A.card_clearing.id, bank_transfer: A.bank.id, cheque: A.cheques_in_hand.id });
    const cash = (await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 1000, method: "cash" })).body.receipt;
    const card = (await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 2000, method: "card" })).body.receipt;
    expect((await call(app, "GET", "/api/books/trial-balance", owner)).status).toBe(200);
    expect(app.db.get("SELECT 1 AS ok FROM journal_entries WHERE post_key = ?", [`receipt:${card.id}`])).toEqual({ ok: 1 });
    const h = await health(app, owner);
    expect(h.failures).toEqual([expect.objectContaining({ postKey: `receipt:${cash.id}` })]);
    setBooks(app, "methodAccounts", { cash: A.cash.id, card: A.card_clearing.id, bank_transfer: A.bank.id, cheque: A.cheques_in_hand.id });
    postPending(app.db);
    expect((await health(app, owner)).failures).toEqual([]);
  });

  it("I1: rounding in average cost doesn't turn inventory health red", async () => {
    const { app, owner } = await books();
    const part = await createPart(app, owner);
    await receive(app, owner, part.id, 3, 1000);
    await receive(app, owner, part.id, 1, 1001);
    expect(await check(app, owner, "inventory")).toMatchObject({ ok: true });
  });

  it("I1: parts fitted before they arrive: inventory matches stock, and their cost reaches cost of sales", async () => {
    const { app, owner, customer } = await books();
    const part = await createPart(app, owner, { sellPriceFils: 6000 });
    const jc = (await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, lines: [{ kind: "part", description: "Filter", qty: 1, unitPriceFils: 6000, discountPct: 0, partId: part.id }] })).body.document;
    await receive(app, owner, part.id, 1, 4000);
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    await call(app, "POST", `/api/documents/${inv.id}/issue`, owner);
    expect(await check(app, owner, "inventory")).toMatchObject({ ok: true });
    const pl = (await call(app, "GET", `/api/books/profit-loss?from=${today()}&to=${today()}`, owner)).body.current;
    expect(pl.costOfSalesFils).toBe(4000);
  });

  it("I2: a year can't be closed before it ends", async () => {
    const { app, owner } = await books();
    const res = await call(app, "POST", "/api/books/year-end", owner, { yearEnd: `${today().slice(0, 4)}-12-31` });
    expect(res.status).toBe(400);
    expect((await call(app, "GET", "/api/settings", owner)).body.settings.books.lockDate).toBeNull();
  });

  it("I2: closing sweeps earlier unclosed years; closing again posts only what changed", async () => {
    const { app, owner } = await books({ startDate: "2024-01-01" });
    expect((await postJournal(app, owner, "2024-06-01", [line(A.bank.id, 5000, 0), line(A.sales_labour.id, 0, 5000)])).status).toBe(200);
    expect((await postJournal(app, owner, "2025-06-01", [line(RENT, 1000, 0), line(A.bank.id, 0, 1000)])).status).toBe(200);
    const first = await call(app, "POST", "/api/books/year-end", owner, { yearEnd: "2025-12-31" });
    expect(first.status).toBe(200);
    const re = (id: string) => app.db.get<{ c: number }>("SELECT credit_fils - debit_fils AS c FROM journal_lines WHERE entry_id = ? AND account_id = ?", [id, A.retained_earnings.id])!.c;
    expect(re(first.body.entry.id)).toBe(4000);
    // The owner reopens December, a late rent goes in, and the year is closed again.
    expect((await call(app, "PUT", "/api/settings/books", owner, { startDate: "2024-01-01", lockDate: "2025-11-30" })).status).toBe(200);
    expect((await postJournal(app, owner, "2025-12-15", [line(RENT, 500, 0), line(A.bank.id, 0, 500)])).status).toBe(200);
    const second = await call(app, "POST", "/api/books/year-end", owner, { yearEnd: "2025-12-31" });
    expect(second.status).toBe(200);
    expect(re(second.body.entry.id)).toBe(-500);
    expect((await call(app, "POST", "/api/books/year-end", owner, { yearEnd: "2025-12-31" })).status).toBe(409);
  });

  it("I3: a customer opening balance added after the start posts, dated or not", async () => {
    const { app, owner } = await books({ startDate: addDays(today(), -10) });
    await call(app, "POST", "/api/customers", owner, { name: "No date", openingBalanceFils: 50000 });
    await call(app, "POST", "/api/customers", owner, { name: "Old date", openingBalanceFils: 20000, openingBalanceDate: addDays(today(), -40) });
    expect(await check(app, owner, "receivables")).toMatchObject({ ok: true, booksFils: 70000 });
  });

  it("I4: payments dated in a locked period or before the books start are refused", async () => {
    const { app, owner, customer } = await books({ startDate: addDays(today(), -20) });
    const inv = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [LABOUR] })).body.document;
    await call(app, "POST", `/api/documents/${inv.id}/issue`, owner);
    await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), -20), lockDate: addDays(today(), -5) });
    const onInvoice = await call(app, "POST", `/api/documents/${inv.id}/payments`, owner, { amountFils: 1000, method: "cash", paidAt: `${addDays(today(), -6)}T08:00:00.000Z` });
    expect(onInvoice.status).toBe(400);
    const beforeStart = await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 1000, method: "cash", receivedAt: `${addDays(today(), -30)}T08:00:00.000Z` });
    expect(beforeStart.status).toBe(400);
    expect(beforeStart.body.error).toMatch(/^The books (are locked up to|start on) /);
    // Books that start next month: today's payments are part of the opening position, not refused.
    const future = await books({ startDate: addDays(today(), 30) });
    expect((await call(future.app, "POST", "/api/receipts", future.owner, { customerId: future.customer.id, amountFils: 1000, method: "cash", receivedAt: new Date().toISOString() })).status).toBe(200);
  });

  it("I5: the opening balances clear opening balance clearing, with nothing counted twice", async () => {
    const { app, owner } = await books();
    await call(app, "POST", "/api/customers", owner, { name: "Old account", openingBalanceFils: 30000, openingBalanceDate: today() });
    await createPart(app, owner, {}, { qty: 2, unitCostFils: 4000 });
    const proposal = (await call(app, "GET", "/api/books/opening/proposal", owner)).body;
    expect(proposal.lines).toEqual([expect.objectContaining({ accountId: A.opening_clearing.id, debitFils: 38000 })]);
    const draft = (await call(app, "POST", "/api/books/drafts", owner, { kind: "opening", date: proposal.date, narration: "Opening", lines: [...proposal.lines, line(A.bank.id, 1000, 0)] })).body.draft;
    expect((await call(app, "POST", `/api/books/drafts/${draft.id}/post`, owner)).status).toBe(200);
    const h = await health(app, owner);
    expect(h.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
  });

  it("I6: a linked PC can't add or recode accounts", async () => {
    const { app, owner } = await books({ posts: false });
    expect((await call(app, "POST", "/api/books/accounts", owner, { code: "6070", name: "Advertising", type: "expense" })).status).toBe(409);
    expect((await call(app, "PATCH", `/api/books/accounts/${RENT}`, owner, { code: "6011" })).status).toBe(409);
  });

  it("I7: nothing changed, nothing rescanned", async () => {
    const { app, owner, customer } = await books();
    await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 1000, method: "cash" });
    postPending(app.db);
    const all = vi.spyOn(app.db, "all");
    expect(postPending(app.db)).toBe(0);
    expect(all).not.toHaveBeenCalled();
    all.mockRestore();
  });

  it("I7: a long history posts in batches", async () => {
    const { app, customer } = await books();
    const t = new Date().toISOString();
    app.db.tx(() => {
      for (let i = 0; i < 1200; i++) {
        app.db.run(`INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, received_at, created_at) VALUES (?, 'X', ?, ?, ?, 100, 'cash', ?, ?)`,
          [`r${i}`, i + 1, `RCT-X-${i}`, customer.id, t, t]);
      }
    });
    expect(postPending(app.db, { limit: 500 })).toBe(500);
    expect(postPending(app.db, { limit: 500 })).toBe(500);
    expect(postPending(app.db, { limit: 500 })).toBe(200);
    expect(app.db.get("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'receipt'")).toEqual({ n: 1200 });
  });

  it("I8: manual journals can't post to accounts the app keeps in step with documents", async () => {
    const { app, owner } = await books();
    for (const id of [A.receivables.id, A.inventory.id, A.wip.id, A.vat_output.id]) {
      const res = await postJournal(app, owner, today(), [line(id, 0, 1000), line(A.bank.id, 1000, 0)]);
      expect(res.status).toBe(400);
    }
    expect((await postJournal(app, owner, today(), [line(A.payables.id, 1000, 0), line(A.bank.id, 0, 1000)])).status).toBe(200);
  });
});
