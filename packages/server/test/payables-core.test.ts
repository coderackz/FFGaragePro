import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { addDays } from "../src/books/post";
import { Db } from "../src/db";
import { addUser, call, createPart, makeApp, setUp, tempDir, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const today = () => dubaiDate(new Date().toISOString());

async function garage() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim Parts", termsDays: 30 })).body.supplier;
  return { app, owner, supplier };
}

export async function receiveFrom(app: App, token: string, supplierId: string, net: number, vat: number, supplierInvoiceDate: string) {
  const part = await createPart(app, token, { partNo: `P-${Math.random().toString(36).slice(2, 8)}` });
  const po = (await call(app, "POST", "/api/purchase-orders", token, { supplierId, lines: [{ partId: part.id, description: "Part", qty: 1, unitCostFils: net }] })).body.purchaseOrder;
  await call(app, "PATCH", `/api/purchase-orders/${po.id}`, token, { status: "sent" });
  const r = await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, token, {
    supplierInvoiceNo: `INV-${Math.random().toString(36).slice(2, 6)}`, supplierInvoiceDate, vatFils: vat, lines: [{ poLineId: po.lines[0].id, qty: 1, unitCostFils: net }],
  });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.purchaseOrder.receipts.at(-1) as { id: string };
}

describe("payables core", () => {
  it("migration 12 keeps old journal entries and accepts the new kinds", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 11 });
    old.run(`INSERT INTO journal_entries (id, series, seq, number, date, narration, source_type, created_at) VALUES ('e1', '', 1, 'JV-00001', '2026-11-01', 'Old', 'manual', 'x')`);
    old.close();
    const db = new Db(file);
    expect(db.get("SELECT narration FROM journal_entries WHERE id = 'e1'")).toEqual({ narration: "Old" });
    db.run(`INSERT INTO journal_entries (id, series, seq, number, date, narration, source_type, created_at) VALUES ('e2', '', 2, 'JV-00002', '2026-11-02', 'Bill', 'supplier_bill', 'x')`);
    expect(db.get("SELECT money_kind FROM accounts WHERE id = ?", [A.bank.id])).toEqual({ money_kind: "bank" });
    expect(db.get("SELECT code FROM accounts WHERE id = ?", [A.cheques_issued.id])).toEqual({ code: "2010" });
    db.close();
  });

  it("a supplier's opening balance and goods receipts make its balance; open items oldest due first", async () => {
    const { app, owner, supplier } = await garage();
    await call(app, "PATCH", `/api/suppliers/${supplier.id}`, owner, { openingBalanceFils: 100000, openingBalanceDate: addDays(today(), -60) });
    await receiveFrom(app, owner, supplier.id, 8000, 400, addDays(today(), -10));
    await receiveFrom(app, owner, supplier.id, 2000, 100, addDays(today(), -40));
    const s = (await call(app, "GET", `/api/suppliers/${supplier.id}`, owner)).body.supplier;
    expect(s).toMatchObject({ termsDays: 30, balanceFils: 110500, advanceFils: 0 });
    expect(s.overdueFils).toBe(2100);
    const items = (await call(app, "GET", `/api/suppliers/${supplier.id}/open-items`, owner)).body.items;
    expect(items.map((i: { dueDate: string; owedFils: number }) => [i.dueDate, i.owedFils])).toEqual([[addDays(today(), -10), 2100], [addDays(today(), 20), 8400]]);
  });

  it("the statement ties to the balance; aging buckets", async () => {
    const { app, owner, supplier } = await garage();
    await receiveFrom(app, owner, supplier.id, 8000, 400, addDays(today(), -45));
    const st = (await call(app, "GET", `/api/suppliers/${supplier.id}/statement?from=${addDays(today(), -60)}&to=${today()}`, owner)).body.statement;
    expect(st.rows).toHaveLength(1);
    expect(st.rows[0]).toMatchObject({ kind: "goods_receipt", creditFils: 8400, balanceFils: 8400 });
    expect(st.closingFils).toBe(8400);
    const aging = (await call(app, "GET", "/api/reports/payables-aging", owner)).body;
    expect(aging.suppliers[0]).toMatchObject({ id: supplier.id, totalFils: 8400 });
    expect(aging.suppliers[0].buckets["1-30"]).toBe(8400);
  });

  it("supplier openings post to clearing; money accounts", async () => {
    const { app, owner, supplier } = await garage();
    await call(app, "PUT", "/api/settings/books", owner, { startDate: today() });
    await call(app, "PATCH", `/api/suppliers/${supplier.id}`, owner, { openingBalanceFils: 50000, openingBalanceDate: today() });
    const lines = app.db.all<{ account_id: string; debit_fils: number; credit_fils: number; supplier_id: string | null }>(
      "SELECT l.account_id, l.debit_fils, l.credit_fils, l.supplier_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.post_key = ? ORDER BY l.position",
      [`supplier_opening:${supplier.id}:1`]);
    expect(lines).toEqual([
      { account_id: A.opening_clearing.id, debit_fils: 50000, credit_fils: 0, supplier_id: null },
      { account_id: A.payables.id, debit_fils: 0, credit_fils: 50000, supplier_id: supplier.id },
    ]);
    const accounts = (await call(app, "GET", "/api/books/accounts", owner)).body.accounts;
    expect(accounts.find((a: { id: string }) => a.id === A.cash.id).moneyKind).toBe("cash");
    const added = await call(app, "POST", "/api/books/accounts", owner, { code: "1021", name: "ADCB current", type: "asset", moneyKind: "bank" });
    expect(added.body.account.moneyKind).toBe("bank");
    expect((await call(app, "POST", "/api/books/accounts", owner, { code: "6071", name: "X", type: "expense", moneyKind: "bank" })).status).toBe(400);
  });

  it("advisors can't see supplier money", async () => {
    const { app, owner, supplier } = await garage();
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "GET", `/api/suppliers/${supplier.id}/statement`, advisor)).status).toBe(403);
    expect((await call(app, "GET", "/api/reports/payables-aging", advisor)).status).toBe(403);
    expect((await call(app, "GET", `/api/suppliers/${supplier.id}`, advisor)).body.supplier.balanceFils).toBeUndefined();
  });
});
