import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { addDays } from "../src/books/post";
import { call, createPart, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const today = () => dubaiDate(new Date().toISOString());
const LABOUR = { kind: "labour", description: "Brake service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

/** A garage that posts its books, started today. */
async function books(startDate = today()) {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  expect((await call(app, "PUT", "/api/settings/books", owner, { startDate })).status).toBe(200);
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC" })).body.customer;
  const doc = async (type: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
    (await call(app, "POST", "/api/documents", owner, { type, customerId: customer.id, lines, ...extra })).body.document;
  const issue = async (id: string) => (await call(app, "POST", `/api/documents/${id}/issue`, owner)).body.document;
  return { app, owner, customer, doc, issue };
}

/** The lines of the entry with this post key, as { code, debit, credit, customer, document }. */
function entry(app: App, postKey: string) {
  return app.db.all<{ code: string; debit: number; credit: number; customer: string | null; document: string | null }>(
    `SELECT a.code, l.debit_fils AS debit, l.credit_fils AS credit, l.customer_id AS customer, l.document_id AS document
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? ORDER BY l.position`,
    [postKey],
  );
}
const byCode = (lines: ReturnType<typeof entry>) => Object.fromEntries(lines.map((l) => [l.code, l.debit - l.credit]));
const count = (app: App) => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal_entries")!.n;

async function receive(app: App, token: string, lines: { partId?: string; description: string; qty: number; unitCostFils: number; jobDocumentId?: string }[], vatFils: number) {
  const supplier = (await call(app, "POST", "/api/suppliers", token, { name: "Al Futtaim Parts" })).body.supplier;
  const po = (await call(app, "POST", "/api/purchase-orders", token, { supplierId: supplier.id, lines })).body.purchaseOrder;
  await call(app, "PATCH", `/api/purchase-orders/${po.id}`, token, { status: "sent" });
  const got = await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, token, {
    supplierInvoiceNo: "AF-1", vatFils, lines: po.lines.map((l: { id: string; qty: number; unitCostFils: number }) => ({ poLineId: l.id, qty: l.qty, unitCostFils: l.unitCostFils })),
  });
  if (got.status !== 200) throw new Error(JSON.stringify(got.body));
  return { supplier, receipt: got.body.purchaseOrder.receipts.at(-1) as { id: string } };
}

describe("automatic posting", () => {
  it("invoice posts by line kind", async () => {
    const { app, customer, doc, issue } = await books();
    const inv = await issue((await doc("invoice", [
      LABOUR,
      { kind: "part", description: "Brake pads", qty: 1, unitPriceFils: 5000, discountPct: 10 },
      { kind: "other", description: "Disposal", qty: 1, unitPriceFils: 2000, discountPct: 0 },
    ])).id);
    postPending(app.db);
    const lines = entry(app, `invoice:${inv.id}`);
    expect(byCode(lines)).toEqual({ "1100": inv.totals.grossFils, "4000": -10000, "4010": -4500, "4020": -2000, "2100": -inv.totals.vatFils });
    expect(lines.find((l) => l.code === "1100")!.customer).toBe(customer.id);
  });

  it("credit note reverses by line kind", async () => {
    const { app, owner, doc, issue } = await books();
    const inv = await issue((await doc("invoice", [LABOUR, { kind: "part", description: "Brake pads", qty: 2, unitPriceFils: 5000, discountPct: 10 }])).id);
    const partLine = inv.lines.find((l: { kind: string }) => l.kind === "part");
    const cn = (await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "One pad returned", lines: [{ lineId: partLine.id, qty: 1 }], returnToStock: false })).body.document;
    postPending(app.db);
    const lines = byCode(entry(app, `credit_note:${cn.id}`));
    expect(lines).toEqual({ "4010": 4500, "2100": cn.totals.vatFils, "1100": -cn.totals.grossFils });
  });

  it("receipts post by method; refunds reverse", async () => {
    const { app, owner, customer } = await books();
    const pay = async (amountFils: number, method: string) =>
      (await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils, method })).body.receipt;
    const cash = await pay(5000, "cash");
    const cheque = await pay(3000, "cheque");
    const refund = await pay(-2000, "cash");
    postPending(app.db);
    expect(byCode(entry(app, `receipt:${cash.id}`))).toEqual({ "1000": 5000, "1100": -5000 });
    expect(byCode(entry(app, `receipt:${cheque.id}`))).toEqual({ "1030": 3000, "1100": -3000 });
    expect(byCode(entry(app, `receipt:${refund.id}`))).toEqual({ "1100": 2000, "1000": -2000 });
  });

  it("goods receipt and WIP to COGS", async () => {
    const { app, owner, doc, issue } = await books();
    const part = await createPart(app, owner, { sellPriceFils: 6000 });
    const { supplier, receipt } = await receive(app, owner, [{ partId: part.id, description: "Oil filter", qty: 2, unitCostFils: 4000 }], 400);
    postPending(app.db);
    const gr = entry(app, `goods_receipt:${receipt.id}`);
    expect(byCode(gr)).toEqual({ "1200": 8000, "1300": 400, "2000": -8400 });
    expect(app.db.get("SELECT supplier_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.post_key = ? AND l.credit_fils > 0", [`goods_receipt:${receipt.id}`]))
      .toEqual({ supplier_id: supplier.id });

    const jc = await doc("jobcard", [{ kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 6000, discountPct: 0, partId: part.id }]);
    postPending(app.db);
    const fitted = app.db.get<{ id: string }>("SELECT id FROM stock_movements WHERE reason = 'job' AND document_id = ?", [jc.id])!;
    const wip = entry(app, `stock:${fitted.id}`);
    expect(byCode(wip)).toEqual({ "1210": 4000, "1200": -4000 });
    expect(wip.find((l) => l.code === "1210")!.document).toBe(jc.id);

    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    await issue(inv.id);
    postPending(app.db);
    expect(byCode(entry(app, `cogs:${inv.id}:1`))).toEqual({ "5000": 4000, "1210": -4000 });
    expect(app.db.get("SELECT COALESCE(SUM(debit_fils - credit_fils), 0) AS wip FROM journal_lines WHERE account_id = ? AND document_id = ?", [A.wip.id, jc.id])).toEqual({ wip: 0 });
  });

  it("counter sale takes stock straight to COGS; a stock count adjustment of −1", async () => {
    const { app, owner, doc, issue } = await books();
    const part = await createPart(app, owner, { sellPriceFils: 6000 }, { qty: 5, unitCostFils: 3000 });
    const inv = await issue((await doc("invoice", [{ kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 6000, discountPct: 0, partId: part.id }])).id);
    await call(app, "POST", `/api/parts/${part.id}/adjustments`, owner, { qty: -1, reason: "count" });
    postPending(app.db);
    const sold = app.db.get<{ id: string }>("SELECT id FROM stock_movements WHERE reason = 'invoice' AND document_id = ?", [inv.id])!;
    expect(byCode(entry(app, `stock:${sold.id}`))).toEqual({ "5000": 3000, "1200": -3000 });
    const counted = app.db.get<{ id: string }>("SELECT id FROM stock_movements WHERE reason = 'adjust' AND qty < 0")!;
    expect(byCode(entry(app, `stock:${counted.id}`))).toEqual({ "5010": 3000, "1200": -3000 });
    const opening = app.db.get<{ id: string }>("SELECT id FROM stock_movements WHERE reason = 'opening'")!;
    expect(byCode(entry(app, `stock:${opening.id}`))).toEqual({ "1200": 15000, "2900": -15000 });
  });

  it("opening items go to clearing; a change posts the difference", async () => {
    const { app, owner } = await books();
    const c = (await call(app, "POST", "/api/customers", owner, { name: "Old account", openingBalanceFils: 30000, openingBalanceDate: today() })).body.customer;
    postPending(app.db);
    expect(byCode(entry(app, `customer_opening:${c.id}:1`))).toEqual({ "1100": 30000, "2900": -30000 });
    await call(app, "PATCH", `/api/customers/${c.id}`, owner, { openingBalanceFils: 25000 });
    postPending(app.db);
    expect(byCode(entry(app, `customer_opening:${c.id}:2`))).toEqual({ "1100": -5000, "2900": 5000 });
  });

  it("dates: before start never, locked → first open day", async () => {
    const { app, owner, customer } = await books();
    const pay = async (receivedAt: string) =>
      (await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 1000, method: "cash", receivedAt })).body.receipt;
    const before = await pay(new Date(Date.now() - 3 * 86_400_000).toISOString());
    postPending(app.db);
    expect(entry(app, `receipt:${before.id}`)).toEqual([]);

    // A receipt from an offline PC arrives after the owner locked yesterday: it posts today, keeping its date.
    const { app: b, customer: c2 } = await books(addDays(today(), -5));
    const yesterday = addDays(today(), -1);
    b.db.run("UPDATE settings SET value = ? WHERE key = 'books.lockDate'", [JSON.stringify(yesterday)]);
    const t = new Date().toISOString();
    b.db.run(
      `INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, received_at, created_at)
       VALUES ('r-late', 'P1', 1, 'RCT-P1-00001', ?, 1000, 'cash', ?, ?)`,
      [c2.id, `${yesterday}T08:00:00.000Z`, t],
    );
    postPending(b.db);
    expect(b.db.get("SELECT date, original_date FROM journal_entries WHERE post_key = 'receipt:r-late'")).toEqual({ date: today(), original_date: yesterday });
  });

  it("postPending is idempotent", async () => {
    const { app, owner, customer, doc, issue } = await books();
    await issue((await doc("invoice", [LABOUR])).id);
    await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 10500, method: "cash" });
    postPending(app.db);
    const n = count(app);
    expect(n).toBe(2);
    expect(postPending(app.db)).toBe(0);
    await Promise.all([
      call(app, "POST", "/api/customers", owner, { name: "One" }),
      call(app, "POST", "/api/customers", owner, { name: "Two" }),
    ]);
    expect(count(app)).toBe(n);
    expect(app.db.get("SELECT COUNT(*) AS n FROM (SELECT post_key FROM journal_entries GROUP BY post_key HAVING COUNT(*) > 1)")).toEqual({ n: 0 });
  });

  it("the hook posts after changes, and every entry balances", async () => {
    const { app, owner, customer, doc, issue } = await books();
    const part = await createPart(app, owner, {}, { qty: 3, unitCostFils: 2000 });
    await issue((await doc("invoice", [LABOUR, { kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 3500, discountPct: 0, partId: part.id }])).id);
    await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 5000, method: "card" });
    // No explicit postPending: the request hook posted them.
    expect(count(app)).toBeGreaterThanOrEqual(4);
    expect(app.db.all("SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_fils) <> SUM(credit_fils)")).toEqual([]);
    expect(app.db.get("SELECT SUM(debit_fils) - SUM(credit_fils) AS d FROM journal_lines")).toEqual({ d: 0 });
  });

  it("no start date, nothing posts", async () => {
    const app = await makeApp(undefined, { postsBooks: true });
    const owner = await setUp(app);
    const c = (await call(app, "POST", "/api/customers", owner, { name: "X" })).body.customer;
    await call(app, "POST", "/api/receipts", owner, { customerId: c.id, amountFils: 1000, method: "cash" });
    expect(postPending(app.db)).toBe(0);
    expect(count(app)).toBe(0);
  });
});
