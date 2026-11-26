import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEETFIX_SUPPLIER_ID, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { Db, newId } from "../src/db";
import { addUser, call, createPart, makeApp, onHand, orderRequest, setUp, tempDir, type App } from "./helpers";

export async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const advisor = await addUser(app, owner, "advisor");
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  const jobCard = async (lines: unknown[], type = "jobcard") =>
    (await call(app, "POST", "/api/documents", owner, { type, customerId: customer.id, lines })).body.document;
  return { app, owner, advisor, customer, jobCard };
}
export const USED = { kind: "part", description: "Alternator", qty: 1, unitPriceFils: 30000, discountPct: 0, condition: "used" };

async function booksWorld(startDate: string) {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  expect((await call(app, "PUT", "/api/settings/books", owner, { startDate })).status).toBe(200);
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  return { app, owner, customer };
}

/** A used purchase for a job written straight to the database (the API for it has its own tests). */
function boughtUsed(app: App, docId: string, position: number, days: number | null, on: string): string {
  const { db } = app;
  const [po, line, receipt] = [newId(), newId(), newId()];
  const t = "2026-11-26T08:00:00.000Z";
  db.run("INSERT INTO purchase_orders (id, series, seq, number, supplier_id, status, created_at, updated_at) VALUES (?, '', 900, 'PO-00900', ?, 'received', ?, ?)", [po, FLEETFIX_SUPPLIER_ID, t, t]);
  db.run(
    `INSERT INTO po_lines (id, po_id, position, description, qty, received_qty, unit_cost_fils, job_document_id, condition, warranty_days, created_at, updated_at)
     VALUES (?, ?, 0, 'Alternator', 1, 1, 15000, ?, 'used', ?, ?, ?)`, [line, po, docId, days, t, t]);
  db.run("INSERT INTO goods_receipts (id, po_id, supplier_invoice_date, net_fils, vat_fils, gross_fils, created_at) VALUES (?, ?, ?, 15000, 0, 15000, ?)", [receipt, po, on, t]);
  db.run("INSERT INTO goods_receipt_lines (id, receipt_id, po_line_id, qty, unit_cost_fils, core_fils) VALUES (?, ?, ?, 1, 15000, 0)", [newId(), receipt, line]);
  db.run("UPDATE document_lines SET po_line_id = ? WHERE document_id = ? AND position = ?", [line, docId, position]);
  return line;
}

describe("used on document lines", () => {
  it("carries from estimate to job card to invoice to credit note", async () => {
    const { app, owner, jobCard } = await world();
    const est = await jobCard([USED, { ...USED, description: "Belt", condition: "new" }], "estimate");
    const jc = (await call(app, "POST", `/api/documents/${est.id}/convert`, owner, {})).body.document;
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    for (const d of [est, jc, inv]) expect(d.lines.map((l: any) => l.condition)).toEqual(["used", "new"]);
    expect((await call(app, "POST", `/api/documents/${inv.id}/issue`, owner, {})).status).toBe(200);
    const cn = await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "Goodwill", returnToStock: false });
    expect(cn.body.document.lines.map((l: any) => l.condition)).toEqual(["used", "new"]);
  });

  it("a save that doesn't send the condition keeps it; another line in its place is new", async () => {
    const { app, owner, jobCard } = await world();
    const part = await createPart(app, owner);
    const jc = await jobCard([USED]);
    const { condition: _c, ...older } = USED;
    const same = await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...older, qty: 2 }] });
    expect(same.body.document.lines[0]).toMatchObject({ condition: "used", qty: 2 });
    const other = await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...older, description: "Oil filter", partId: part.id }] });
    expect(other.body.document.lines[0]).toMatchObject({ condition: "new", partId: part.id });
  });

  it("an older screen picking a part with the same text makes it a new part", async () => {
    const { app, owner, jobCard } = await world();
    const part = await createPart(app, owner, { name: "Alternator" });
    const jc = await jobCard([USED]);
    const { condition: _c, ...older } = USED;
    const res = await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...older, partId: part.id }] });
    expect(res.body.document.lines[0]).toMatchObject({ condition: "new", partId: part.id });
  });

  it("is refused with a part or from Fleet Fix, and moves no stock", async () => {
    const { app, owner, jobCard } = await world();
    const part = await createPart(app, owner);
    const jc = await jobCard([USED]);
    const put = (l: object) => call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...USED, ...l }] });
    expect((await put({ partId: part.id })).status).toBe(400);
    expect((await put({ suppliedBy: "fleetfix" })).status).toBe(400);
    expect(app.db.all("SELECT * FROM stock_movements")).toEqual([]);
  });

  it("once bought it can't become new, and keeps its purchase and warranty when its text changes", async () => {
    const { app, owner, advisor, jobCard } = await world();
    const jc = await jobCard([USED]);
    const poLineId = boughtUsed(app, jc.id, 0, 7, "2026-11-26");
    const seen = { condition: "used", poLineId, purchasedOn: "2026-11-26", warrantyDays: 7, warrantyUntil: "2026-12-03" };
    expect((await call(app, "GET", `/api/documents/${jc.id}`, advisor)).body.document.lines[0]).toMatchObject(seen);
    const res = await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...USED, description: "Alternator 90A", condition: "new", poLineId }] });
    expect(res.body.document.lines[0]).toMatchObject({ ...seen, description: "Alternator 90A" });
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    expect(inv.lines[0]).toMatchObject(seen);
  });

  it("no warranty, and a used line not bought yet", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED, USED]);
    boughtUsed(app, jc.id, 0, null, "2026-11-26");
    const doc = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document;
    expect(doc.lines[0]).toMatchObject({ purchasedOn: "2026-11-26", warrantyDays: null, warrantyUntil: null });
    expect(doc.lines[1]).toMatchObject({ purchasedOn: null, warrantyDays: null, warrantyUntil: null });
  });

  it("a garage from before opens with every line new", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 27 });
    const t = "2026-11-01T08:00:00.000Z";
    old.run("INSERT INTO customers (id, kind, name, created_at, updated_at) VALUES ('c1', 'individual', 'A', ?, ?)", [t, t]);
    old.run("INSERT INTO documents (id, type, series, seq, number, status, customer_id, created_at, updated_at) VALUES ('d1', 'jobcard', '', 1, 'JC-1', 'open', 'c1', ?, ?)", [t, t]);
    old.run("INSERT INTO document_lines (id, document_id, position, kind, description, qty, unit_price_fils, net_fils, vat_fils, gross_fils) VALUES ('l1', 'd1', 0, 'part', 'Belt', 1, 100, 100, 5, 105)");
    old.close();
    const db = new Db(file);
    expect(db.get("SELECT condition FROM document_lines")).toEqual({ condition: "new" });
    db.close();
  });
});

const TRN = "100123456700003";
export const buy = (app: App, token: string, documentId: string, extra: Record<string, unknown> = {}) =>
  call(app, "POST", "/api/used-purchases", token, {
    documentId, position: 0, description: "Alternator", qty: 1, seller: { name: "Al Sajaa Used Parts", phone: "0501234567" },
    unitCostFils: 15000, purchasedOn: "2026-11-26", bill: null, warrantyDays: 7, ...extra,
  });
const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
const receipts = (app: App) => app.db.all<{ net_fils: number; vat_fils: number; gross_fils: number; supplier_invoice_date: string; supplier_invoice_no: string | null }>("SELECT * FROM goods_receipts ORDER BY created_at, rowid");
const sellers = (app: App) => app.db.all<{ id: string; name: string; phone: string | null; trn: string | null }>("SELECT id, name, phone, trn FROM suppliers WHERE is_fleetfix = 0 ORDER BY rowid");

describe("buying a used part", () => {
  beforeEach(() => at("2026-11-26T08:00:00Z"));
  afterEach(() => { vi.useRealTimers(); });

  it("without a VAT bill: the job gets the cost, the seller is kept, no VAT, nothing in the parts list", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED]);
    const res = await buy(app, owner, jc.id);
    expect(res.status).toBe(200);
    expect(res.body.document.lines[0]).toMatchObject({ condition: "used", orderStatus: "received", costFils: 15000, purchasedOn: "2026-11-26", warrantyUntil: "2026-12-03" });
    expect(receipts(app)).toMatchObject([{ net_fils: 15000, vat_fils: 0, gross_fils: 15000, supplier_invoice_date: "2026-11-26", supplier_invoice_no: null }]);
    expect(sellers(app)).toMatchObject([{ name: "Al Sajaa Used Parts", phone: "0501234567", trn: null }]);
    expect(app.db.all("SELECT * FROM parts")).toEqual([]);
    const list = (await call(app, "GET", "/api/purchase-orders", owner)).body.purchaseOrders;
    expect(list).toMatchObject([{ status: "received", usedPart: true, netFils: 15000 }]);
    const po = (await call(app, "GET", `/api/purchase-orders/${list[0].id}`, owner)).body.purchaseOrder;
    expect(po).toMatchObject({ usedPart: true, lines: [{ condition: "used", warrantyDays: 7 }] });
  });

  it("with a VAT bill: the VAT and the seller's TRN are kept; another TRN is refused", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED, USED]);
    expect((await buy(app, owner, jc.id, { bill: { trn: TRN, invoiceNo: "A-77", vatFils: 750 } })).status).toBe(200);
    expect(receipts(app)).toMatchObject([{ vat_fils: 750, gross_fils: 15750, supplier_invoice_no: "A-77" }]);
    expect(sellers(app)).toMatchObject([{ trn: TRN }]);
    const other = await buy(app, owner, jc.id, { position: 1, bill: { trn: "100999999900003", invoiceNo: "B-1", vatFils: 750 } });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("This seller has another TRN saved");
    expect(receipts(app)).toHaveLength(1);
  });

  it("refuses what can't be right, and saves nothing", async () => {
    const { app, owner, advisor, jobCard } = await world();
    const jc = await jobCard([{ ...USED, qty: 2 }, { ...USED, description: "Belt", condition: "new" }]);
    expect((await buy(app, advisor, jc.id, { qty: 2 })).status).toBe(403);
    expect((await buy(app, owner, jc.id, { qty: 2, purchasedOn: "2026-11-27" })).status).toBe(400);
    expect((await buy(app, owner, jc.id, { qty: 2, purchasedOn: "2026-02-30" })).status).toBe(400);
    expect((await buy(app, owner, jc.id, { qty: 2, position: 1, description: "Belt" })).status).toBe(400);
    const few = await buy(app, owner, jc.id, { qty: 1 });
    expect(few.status).toBe(400);
    expect(few.body.error).toBe("Buy at least the 2 on the job card");
    expect((await buy(app, owner, jc.id, { qty: 2, description: "Starter" })).status).toBe(409);
    expect((await buy(app, owner, jc.id, { qty: 2, seller: { supplierId: "00000000-0000-4000-8000-00000000dead" } })).status).toBe(404);
    expect(sellers(app)).toEqual([]);
    expect(app.db.all("SELECT * FROM purchase_orders")).toEqual([]);
    expect((await buy(app, owner, jc.id, { qty: 2 })).status).toBe(200);
    expect((await buy(app, owner, jc.id, { qty: 2 })).body.error).toBe("This part is already bought");
    const open = await jobCard([USED]);
    await call(app, "POST", `/api/documents/${open.id}/convert`, owner, {});
    expect((await buy(app, owner, open.id)).status).toBe(400);
    const est = await jobCard([USED], "estimate");
    expect((await buy(app, owner, est.id)).status).toBe(400);
  });

  it("the same phone typed another way, or the same name without a phone, is the same seller", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED, USED, USED, USED]);
    for (const [position, seller] of [
      { name: "Al Sajaa", phone: "0501234567" }, { name: "Sajaa yard", phone: "+971 50 123 4567" }, { name: "al sajaa", phone: "" }, { name: "Other yard", phone: "" },
    ].entries()) expect((await buy(app, owner, jc.id, { position, seller })).status).toBe(200);
    expect(sellers(app).map((s) => s.name)).toEqual(["Al Sajaa", "Other yard"]);
  });

  it("dates are Dubai's: 2 am on the 26th is the 26th", async () => {
    at("2026-11-25T22:30:00Z");
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED, { ...USED, description: "Coolant", condition: "new" }]);
    expect((await buy(app, owner, jc.id)).status).toBe(200);
    const bought = (extra: object) => call(app, "POST", "/api/purchase-requests", owner, { documentId: jc.id, position: 1, supplierId: FLEETFIX_SUPPLIER_ID, qty: 1, alreadyBought: true, unitCostFils: 100, ...extra });
    expect((await bought({ purchasedOn: "2026-11-27" })).status).toBe(400);
    expect((await bought({})).status).toBe(200);
    expect(receipts(app).map((r) => r.supplier_invoice_date)).toEqual(["2026-11-26", "2026-11-26"]);
  });

  it("dated in a locked month: the books take it on the first open day, keeping its date", async () => {
    const { app, owner, customer } = await booksWorld("2026-11-01");
    app.db.run("UPDATE settings SET value = ? WHERE key = 'books.lockDate'", [JSON.stringify("2026-11-20")]);
    const jc = (await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, lines: [USED] })).body.document;
    expect((await buy(app, owner, jc.id, { purchasedOn: "2026-11-15" })).status).toBe(200);
    postPending(app.db);
    expect(app.db.get("SELECT date, original_date FROM journal_entries WHERE source_type = 'goods_receipt'")).toEqual({ date: "2026-11-21", original_date: "2026-11-15" });
  });

  it("VAT left out follows the supplier's TRN", async () => {
    const { app, owner, jobCard } = await world();
    const supplier = async (body: object) => (await call(app, "POST", "/api/suppliers", owner, body)).body.supplier.id as string;
    const plain = await supplier({ name: "No TRN" });
    const registered = await supplier({ name: "With TRN", trn: TRN });
    for (const id of [plain, registered, FLEETFIX_SUPPLIER_ID]) {
      const jc = await jobCard([{ ...USED, condition: "new" }]);
      expect((await call(app, "POST", "/api/purchase-requests", owner, { documentId: jc.id, position: 0, supplierId: id, qty: 1, alreadyBought: true, unitCostFils: 10000 })).status).toBe(200);
    }
    expect(receipts(app).map((r) => r.vat_fils)).toEqual([0, 500, 500]);
  });

  it("a used line isn't ordered with Request part", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED]);
    const res = await call(app, "POST", "/api/purchase-requests", owner, { documentId: jc.id, position: 0, supplierId: FLEETFIX_SUPPLIER_ID, qty: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Use Buy used part");
  });

  it("lists the used parts still to buy, for those who buy", async () => {
    const { app, owner, advisor, jobCard } = await world();
    const list = async () => (await call(app, "GET", "/api/used-parts-to-buy", owner)).body.items;
    expect((await call(app, "GET", "/api/used-parts-to-buy", advisor)).status).toBe(403);
    await jobCard([USED], "estimate");
    const a = await jobCard([{ ...USED, description: "Belt", condition: "new" }, USED]);
    const b = await jobCard([USED]);
    const c = await jobCard([USED]);
    expect(await list()).toHaveLength(3);
    const item = (await list()).find((i: any) => i.documentId === a.id);
    expect(item).toEqual({ documentId: a.id, documentNumber: a.number, position: 1, description: "Alternator", qty: 1, customerName: "Ahmed", plate: null });
    await buy(app, owner, a.id, { position: 1 });
    await call(app, "PUT", `/api/documents/${b.id}/lines`, owner, { lines: [{ ...USED, condition: "new" }] });
    expect((await list()).map((i: any) => i.documentId)).toEqual([c.id]);
    await call(app, "POST", `/api/documents/${c.id}/convert`, owner, {});
    expect(await list()).toEqual([]);
  });
});

describe("a bought part's cost stays on its job", () => {
  beforeEach(() => at("2026-11-26T08:00:00Z"));
  afterEach(() => { vi.useRealTimers(); });
  const doc = async (app: App, token: string, id: string) => (await call(app, "GET", `/api/documents/${id}`, token)).body.document;
  const lines = (app: App, token: string, id: string, ls: unknown[]) => call(app, "PUT", `/api/documents/${id}/lines`, token, { lines: ls });

  it("taken off the job it shows as not charged, and can be put back", async () => {
    const { app, owner, advisor, jobCard } = await world();
    const jc = await jobCard([USED]);
    const bought = (await buy(app, owner, jc.id)).body.document;
    expect(bought).toMatchObject({ uncharged: [], partsCostFils: 15000, marginFils: 15000 });
    const poLineId = bought.lines[0].poLineId;
    const gone = (await lines(app, owner, jc.id, [])).body.document;
    expect(gone.uncharged).toEqual([{ poLineId, partId: null, description: "Alternator", condition: "used", qty: 1, costFils: 15000 }]);
    expect(gone).toMatchObject({ partsCostFils: 15000, marginFils: -15000 });
    const seen = await doc(app, advisor, jc.id);
    expect(seen.uncharged).toEqual([{ poLineId, partId: null, description: "Alternator", condition: "used", qty: 1 }]);
    expect(seen.partsCostFils).toBeUndefined();
    const back = (await lines(app, owner, jc.id, [{ ...USED, unitPriceFils: 0, poLineId }])).body.document;
    expect(back).toMatchObject({ uncharged: [], partsCostFils: 15000, lines: [{ condition: "used", costFils: 15000, warrantyUntil: "2026-12-03" }] });
  });

  it("what was bought beyond the line counts too", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED]);
    const d = (await buy(app, owner, jc.id, { qty: 2, unitCostFils: 10000 })).body.document;
    expect(d.uncharged).toMatchObject([{ qty: 1, costFils: 10000 }]);
    expect(d.partsCostFils).toBe(20000);
  });

  it("taken off the invoice only, it shows on the invoice only", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED]);
    await buy(app, owner, jc.id);
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    expect(inv.uncharged).toEqual([]);
    expect((await lines(app, owner, inv.id, [])).body.document.uncharged).toHaveLength(1);
    expect((await doc(app, owner, jc.id)).uncharged).toEqual([]);
  });

  it("not bought yet: the cost is pending, also on the invoice", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED]);
    expect(await doc(app, owner, jc.id)).toMatchObject({ costPending: true, uncostedLines: 0, lines: [{ costFils: null }] });
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    expect(inv).toMatchObject({ costPending: true });
  });

  it("a shelf part bought for a job and taken off is back on the shelf, not on the list", async () => {
    const { app, owner, jobCard } = await world();
    const part = await createPart(app, owner);
    const jc = await jobCard([{ kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 3500, discountPct: 0, partId: part.id }]);
    const res = await call(app, "POST", "/api/purchase-requests", owner, { documentId: jc.id, position: 0, supplierId: FLEETFIX_SUPPLIER_ID, qty: 1, alreadyBought: true, unitCostFils: 1000 });
    expect(res.status).toBe(200);
    expect((await lines(app, owner, jc.id, [])).body.document).toMatchObject({ uncharged: [], partsCostFils: 0 });
    expect(await onHand(app, owner, part.id)).toBe(1);
  });

  it("a part only ordered (not delivered) isn't a cost", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([{ ...USED, condition: "new" }]);
    await call(app, "POST", "/api/purchase-requests", owner, { documentId: jc.id, position: 0, supplierId: FLEETFIX_SUPPLIER_ID, qty: 1 });
    expect((await lines(app, owner, jc.id, [])).body.document).toMatchObject({ uncharged: [], partsCostFils: 0 });
  });

  it("the books' cost of parts is the invoice's", async () => {
    const { app, owner, customer } = await booksWorld("2026-11-01");
    const jc = (await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, lines: [USED, { ...USED, description: "Starter" }] })).body.document;
    await buy(app, owner, jc.id);
    await buy(app, owner, jc.id, { position: 1, description: "Starter", unitCostFils: 9000 });
    const d = await doc(app, owner, jc.id);
    await lines(app, owner, jc.id, [d.lines[0]].map((l: any) => ({ ...USED, poLineId: l.poLineId })));
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner, {})).body.document;
    expect((await call(app, "POST", `/api/documents/${inv.id}/issue`, owner, {})).status).toBe(200);
    postPending(app.db);
    const cogs = app.db.get<{ v: number }>("SELECT SUM(debit_fils - credit_fils) AS v FROM journal_lines WHERE account_id = ?", [SYSTEM_ACCOUNTS.cogs_parts.id])!.v;
    expect(cogs).toBe(24000);
    expect((await doc(app, owner, inv.id)).partsCostFils).toBe(24000);
  });
});

describe("review fixes", () => {
  beforeEach(() => at("2026-11-26T08:00:00Z"));
  afterEach(() => { vi.useRealTimers(); });

  it("a screen opened before a purchase can't save over it", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED, { ...USED, description: "Coolant", condition: "new" }]);
    const stale = jc.updatedAt;
    at("2026-11-26T08:01:00Z");
    expect((await buy(app, owner, jc.id)).status).toBe(200);
    const edit = await call(app, "PATCH", `/api/documents/${jc.id}`, owner, { baseUpdatedAt: stale, lines: [{ ...USED, description: "Alternator 12V 90A" }, { ...USED, description: "Coolant", condition: "new" }] });
    expect(edit.status).toBe(409);
    const fresh = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document;
    at("2026-11-26T08:02:00Z");
    expect((await call(app, "POST", "/api/purchase-requests", owner, { documentId: jc.id, position: 1, supplierId: FLEETFIX_SUPPLIER_ID, qty: 1 })).status).toBe(200);
    expect((await call(app, "PATCH", `/api/documents/${jc.id}`, owner, { baseUpdatedAt: fresh.updatedAt, notes: "x" })).status).toBe(409);
  });

  it("a bought used part never moves onto a new part with the same text, nor an ordered part onto a used line", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED]);
    const bought = (await buy(app, owner, jc.id)).body.document;
    const swapped = (await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...USED, condition: "new", unitPriceFils: 50000 }] })).body.document;
    expect(swapped.lines[0]).toMatchObject({ condition: "new", poLineId: null, unitPriceFils: 50000 });
    expect(swapped.uncharged).toMatchObject([{ poLineId: bought.lines[0].poLineId, condition: "used" }]);

    const other = await jobCard([{ ...USED, description: "Coolant", condition: "new" }]);
    await call(app, "POST", "/api/purchase-requests", owner, { documentId: other.id, position: 0, supplierId: FLEETFIX_SUPPLIER_ID, qty: 1 });
    const ticked = (await call(app, "PUT", `/api/documents/${other.id}/lines`, owner, { lines: [{ ...USED, description: "Coolant" }] })).body.document;
    expect(ticked.lines[0]).toMatchObject({ condition: "used", poLineId: null });
  });

  it("more on the line than was bought: only what was bought is a cost, the rest is pending", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED]);
    const poLineId = (await buy(app, owner, jc.id)).body.document.lines[0].poLineId;
    const more = (await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [{ ...USED, qty: 3, poLineId }] })).body.document;
    expect(more).toMatchObject({ partsCostFils: 15000, costPending: true, uncharged: [], lines: [{ costFils: 15000 }] });
  });
});

describe("minor fixes", () => {
  beforeEach(() => at("2026-11-26T08:00:00Z"));
  afterEach(() => { vi.useRealTimers(); });

  it("a phone typed for a saved seller without one is saved; one with a phone keeps it", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([USED, USED, USED, USED]);
    expect((await buy(app, owner, jc.id, { position: 0, seller: { name: "Al Sajaa", phone: "" } })).status).toBe(200);
    expect((await buy(app, owner, jc.id, { position: 1, seller: { name: "al sajaa", phone: "050 123 4567" } })).status).toBe(200);
    expect(sellers(app)).toMatchObject([{ name: "Al Sajaa", phone: "050 123 4567" }]);
    const yard = (await call(app, "POST", "/api/suppliers", owner, { name: "Yard Two" })).body.supplier;
    expect((await buy(app, owner, jc.id, { position: 2, seller: { supplierId: yard.id, phone: "0507654321" } })).status).toBe(200);
    expect((await buy(app, owner, jc.id, { position: 3, seller: { supplierId: yard.id, phone: "0500000000" } })).status).toBe(200);
    expect(sellers(app)).toMatchObject([{ name: "Al Sajaa", phone: "050 123 4567" }, { name: "Yard Two", phone: "0507654321" }]);
  });

  it("an older screen moving lines keeps a used line used", async () => {
    const { app, owner, jobCard } = await world();
    const coolant = { ...USED, description: "Coolant", condition: "new" };
    const jc = await jobCard([coolant, USED]);
    const { condition: _c, ...older } = USED;
    const { condition: _n, ...olderCoolant } = coolant;
    const up = (await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [older] })).body.document;
    expect(up.lines.map((l: any) => [l.description, l.condition])).toEqual([["Alternator", "used"]]);
    const down = (await call(app, "PUT", `/api/documents/${jc.id}/lines`, owner, { lines: [olderCoolant, { ...olderCoolant, description: "Belt" }, older] })).body.document;
    expect(down.lines.map((l: any) => [l.description, l.condition])).toEqual([["Coolant", "new"], ["Belt", "new"], ["Alternator", "used"]]);
  });

  it("a line partly delivered says how many came", async () => {
    const { app, owner, jobCard } = await world();
    const jc = await jobCard([{ ...USED, condition: "new", qty: 2 }]);
    await call(app, "POST", "/api/purchase-requests", owner, { documentId: jc.id, position: 0, supplierId: FLEETFIX_SUPPLIER_ID, qty: 2 });
    const requested = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document.lines[0];
    expect(requested).toMatchObject({ orderStatus: "requested", receivedQty: 0 });
    await orderRequest(app, owner, requested.purchaseOrderId, FLEETFIX_SUPPLIER_ID);
    const before = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document.lines[0];
    expect(before).toMatchObject({ orderStatus: "on_order", receivedQty: 0 });
    const got = await call(app, "POST", `/api/purchase-orders/${before.purchaseOrderId}/receive`, owner, { vatFils: 0, lines: [{ poLineId: before.poLineId, qty: 1, unitCostFils: 10000 }] });
    expect(got.status).toBe(200);
    const after = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document.lines[0];
    expect(after).toMatchObject({ orderStatus: "on_order", receivedQty: 1 });
  });
});
