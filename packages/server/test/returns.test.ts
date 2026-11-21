import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { vatFigures } from "../src/vat/figures";
import { addUser, call, makeApp, setUp, type App } from "./helpers";

const today = () => dubaiDate(new Date().toISOString());

/** A garage that posts its books from today, with a supplier and a delivery helper. */
async function garage() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  expect((await call(app, "PUT", "/api/settings/books", owner, { startDate: today() })).status).toBe(200);
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim Parts" })).body.supplier;
  const part = async (body: Record<string, unknown>) => {
    const r = await call(app, "POST", "/api/parts", owner, { stocked: true, sellPriceFils: 5000, ...body });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.part;
  };
  const receive = async (partId: string, qty: number, unitCostFils: number, vatFils: number, extra: Record<string, unknown> = {}) => {
    const po = (await call(app, "POST", "/api/purchase-orders", owner, { supplierId: supplier.id, lines: [{ partId, description: "x", qty, unitCostFils }] })).body.purchaseOrder;
    await call(app, "PATCH", `/api/purchase-orders/${po.id}`, owner, { status: "sent" });
    const r = await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, owner, { supplierInvoiceNo: "AF-1", vatFils, lines: [{ poLineId: po.lines[0].id, qty, unitCostFils, ...extra }] });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return r.body.purchaseOrder.receipts.at(-1) as { id: string; netFils: number };
  };
  const balance = async () => (await call(app, "GET", `/api/suppliers/${supplier.id}`, owner)).body.supplier.balanceFils;
  const onHand = async (id: string) => (await call(app, "GET", `/api/parts/${id}`, owner)).body.part.onHand;
  return { app, owner, supplier, part, receive, balance, onHand };
}

/** The entry with this post key, net by account code (debit +, credit −). */
function entry(app: App, postKey: string) {
  return Object.fromEntries(app.db.all<{ code: string; n: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS n FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [postKey],
  ).map((r) => [r.code, r.n]));
}

describe("returns to the supplier and cores", () => {
  it("return", async () => {
    const g = await garage();
    const filter = await g.part({ partNo: "OF-1", name: "Oil filter" });
    await g.receive(filter.id, 10, 2000, 1000);
    expect(await g.balance()).toBe(21000);
    // 2 go back, credited at AED 22.00 each (they cost 20.00): AED 44.00 + 2.20 VAT.
    const r = await call(g.app, "POST", "/api/supplier-returns", g.owner, { supplierId: g.supplier.id, kind: "return", reason: "Wrong size", supplierRef: "CRN-77", lines: [{ partId: filter.id, qty: 2, unitCreditFils: 2200 }] });
    expect(r.status).toBe(200);
    const ret = r.body.supplierReturn;
    expect(ret).toMatchObject({ number: "RTS-00001", kind: "return", netFils: 4400, vatFils: 220, grossFils: 4620, lines: [expect.objectContaining({ qty: 2, unitCreditFils: 2200, unitCostFils: 2000 })] });
    expect(await g.onHand(filter.id)).toBe(8);
    // What's owed falls; the delivery is now partly settled by the debit note.
    expect(await g.balance()).toBe(16380);
    expect((await call(g.app, "GET", `/api/suppliers/${g.supplier.id}/open-items`, g.owner)).body.items).toEqual([expect.objectContaining({ owedFils: 16380 })]);
    const st = (await call(g.app, "GET", `/api/suppliers/${g.supplier.id}/statement?from=${today()}&to=${today()}`, g.owner)).body;
    expect(st.statement.rows).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "debit_note", number: "RTS-00001", debitFils: 4620 })]));
    // Books: Dr payables 46.20 / Cr input VAT 2.20, inventory 40.00 (at cost), stock adjustments 4.00.
    postPending(g.app.db);
    const A = SYSTEM_ACCOUNTS;
    expect(entry(g.app, `supplier_return:${ret.id}`)).toEqual({ [A.payables.code]: 4620, [A.vat_input.code]: -220, [A.inventory.code]: -4000, [A.stock_adjustments.code]: -400 });
    // The movement itself isn't posted again as a stock adjustment.
    expect(g.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'stock'")!.n).toBe(0);
    // The VAT return: box 9 is 200.00 − 44.00 and 10.00 − 2.20.
    const nine = vatFigures(g.app.db, today(), today()).boxes.find((b) => b.key === "9")!;
    expect([nine.amountFils, nine.vatFils]).toEqual([15600, 780]);
    // More than is on the shelf can't go back; an advisor can't make one.
    expect((await call(g.app, "POST", "/api/supplier-returns", g.owner, { supplierId: g.supplier.id, kind: "return", reason: "Too many", lines: [{ partId: filter.id, qty: 9, unitCreditFils: 1 }] })).status).toBe(400);
    const advisor = await addUser(g.app, g.owner, "advisor");
    expect((await call(g.app, "POST", "/api/supplier-returns", advisor, { supplierId: g.supplier.id, kind: "return", reason: "x y z", lines: [{ partId: filter.id, qty: 1, unitCreditFils: 1 }] })).status).toBe(403);
  });

  it("return of tracked units", async () => {
    const g = await garage();
    const tyre = await g.part({ partNo: "T-1", name: "Tyre", tracking: "dot" });
    await g.receive(tyre.id, 2, 30000, 3000, { units: ["0125", "0225"] });
    const [a] = (await call(g.app, "GET", `/api/parts/${tyre.id}/units`, g.owner)).body.units;
    const body = { supplierId: g.supplier.id, kind: "return", reason: "Sidewall damage", lines: [{ partId: tyre.id, qty: 1, unitCreditFils: 30000 }] };
    expect((await call(g.app, "POST", "/api/supplier-returns", g.owner, body)).body.error).toMatch(/choose which one goes back/);
    const ok = await call(g.app, "POST", "/api/supplier-returns", g.owner, { ...body, lines: [{ ...body.lines[0], unitIds: [a.id] }] });
    expect(ok.status).toBe(200);
    expect((await call(g.app, "GET", `/api/parts/${tyre.id}/units?status=returned`, g.owner)).body.units.map((u: { code: string }) => u.code)).toEqual(["0125"]);
    expect(await g.onHand(tyre.id)).toBe(1);
  });

  it("cores", async () => {
    const g = await garage();
    const alt = await g.part({ partNo: "ALT-1", name: "Alternator (exchange)", coreFils: 15000 });
    // 2 at AED 400 plus a AED 150 core each (the part's deposit): the delivery is 800 + 300.
    const receipt = await g.receive(alt.id, 2, 40000, 5500);
    expect(receipt.netFils).toBe(110000);
    const A = SYSTEM_ACCOUNTS;
    postPending(g.app.db);
    expect(entry(g.app, `goods_receipt:${receipt.id}`)).toMatchObject({ [A.inventory.code]: 80000, [A.core_deposits.code]: 30000, [A.payables.code]: -115500 });
    expect(await g.onHand(alt.id)).toBe(2);
    const cores = async () => (await call(g.app, "GET", `/api/cores?supplierId=${g.supplier.id}`, g.owner)).body.cores;
    expect(await cores()).toEqual([expect.objectContaining({ partId: alt.id, partNo: "ALT-1", qty: 2, valueFils: 30000 })]);
    // One old unit goes back: a AED 150 + VAT debit note against the core deposits.
    const back = (await call(g.app, "POST", "/api/supplier-returns", g.owner, { supplierId: g.supplier.id, kind: "core", reason: "Old unit returned", lines: [{ partId: alt.id, qty: 1, unitCreditFils: 15000 }] })).body.supplierReturn;
    expect(back).toMatchObject({ kind: "core", netFils: 15000, vatFils: 750 });
    expect(await g.onHand(alt.id)).toBe(2);
    expect(await cores()).toEqual([expect.objectContaining({ qty: 1, valueFils: 15000 })]);
    // More cores than are owed: refused.
    expect((await call(g.app, "POST", "/api/supplier-returns", g.owner, { supplierId: g.supplier.id, kind: "core", reason: "Too many", lines: [{ partId: alt.id, qty: 2, unitCreditFils: 15000 }] })).status).toBe(400);
    // The other is written off (the customer kept the old unit).
    expect((await call(g.app, "POST", "/api/cores/write-offs", g.owner, { supplierId: g.supplier.id, partId: alt.id, qty: 1, reason: "Customer kept the old unit" })).status).toBe(200);
    expect(await cores()).toEqual([]);
    postPending(g.app.db);
    expect(entry(g.app, `supplier_return:${back.id}`)).toEqual({ [A.payables.code]: 15750, [A.vat_input.code]: -750, [A.core_deposits.code]: -15000 });
    const wo = g.app.db.get<{ id: string }>("SELECT id FROM core_writeoffs")!;
    expect(entry(g.app, `core_writeoff:${wo.id}`)).toEqual({ [A.stock_adjustments.code]: 15000, [A.core_deposits.code]: -15000 });
    // 1220 is back to nothing.
    const cd = g.app.db.get<{ b: number }>("SELECT SUM(debit_fils - credit_fils) AS b FROM journal_lines WHERE account_id = ?", [A.core_deposits.id])!.b;
    expect(cd).toBe(0);
  });
});
