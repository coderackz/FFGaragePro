import { afterEach, describe, expect, it, vi } from "vitest";
import { postPending } from "../src/books/pending";
import { addUser, call, makeApp, SETUP, setUp, type App } from "./helpers";

const RENT = "00000000-0000-4000-8000-0000000a6010";
const labour = (unitPriceFils: number) => ({ kind: "labour", description: "Service", qty: 1, unitPriceFils, discountPct: 0 });
const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
afterEach(() => vi.useRealTimers());
const byCode = (app: App, postKey: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [postKey]).map((r) => [r.code, r.d]));

async function garage(posts = true) {
  at("2026-10-15T08:00:00Z");
  const app = await makeApp(undefined, { postsBooks: posts });
  let owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: "2026-09-01" });
  await call(app, "PUT", "/api/settings/garage", owner, { emirate: "dubai" });
  await call(app, "PUT", "/api/settings/tax", owner, { returnPeriod: "monthly", firstPeriodStart: "2026-09-01" });
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC" })).body.customer;
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim" })).body.supplier;
  const invoice = async (net: number) => {
    const d = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [labour(net)] })).body.document;
    return (await call(app, "POST", `/api/documents/${d.id}/issue`, owner)).body.document;
  };
  const bill = async (net: number, billDate = "2026-10-12") =>
    (await call(app, "POST", "/api/bills", owner, { supplierId: supplier.id, supplierInvoiceNo: `B${net}${billDate}`, billDate, lines: [{ accountId: RENT, description: "Rent", netFils: net, vat: "standard" }] })).body.bill;
  const file = (from: string, to: string, reference: string | null = null) => {
    postPending(app.db);
    return call(app, "POST", "/api/vat/returns", owner, { from, to, reference });
  };
  const getReturn = async (from: string, to: string) => { postPending(app.db); return (await call(app, "GET", `/api/vat/return?from=${from}&to=${to}`, owner)).body; };
  const periods = async () => (await call(app, "GET", "/api/vat/periods", owner)).body.periods as { from: string; status: string; reference: string | null; payableFils: number | null }[];
  /** On to 20 Nov 2026 (October has ended), signed in again: the session wouldn't last the jump. */
  const later = async () => {
    at("2026-11-20T08:00:00Z");
    owner = (await call(app, "POST", "/api/auth/login", undefined, { username: SETUP.owner.username, password: SETUP.owner.password })).body.token;
  };
  return { app, get owner() { return owner; }, customer, supplier, invoice, bill, file, getReturn, periods, later };
}

describe("VAT returns", () => {
  it("filing posts the settlement and locks the period", async () => {
    const g = await garage();
    const { app, invoice, bill, file, periods } = g;
    await invoice(100000);
    await bill(40000);
    await g.later();
    expect((await periods()).map((p) => [p.from, p.status])).toEqual([["2026-11-01", "open"], ["2026-10-01", "due"], ["2026-09-01", "due"]]);
    expect((await file("2026-09-01", "2026-09-30")).status).toBe(200);
    const r = await file("2026-10-01", "2026-10-31", "FTA-123");
    expect(r.status).toBe(200);
    expect(byCode(app, "vat_return:2026-10-01")).toEqual({ "2100": 5000, "1300": -2000, "2110": -3000 });
    expect(app.db.get("SELECT date FROM journal_entries WHERE post_key = 'vat_return:2026-10-01'")).toEqual({ date: "2026-10-31" });
    expect((await call(app, "GET", "/api/settings", g.owner)).body.settings.books.lockDate).toBe("2026-10-31");
    expect((await periods()).find((p) => p.from === "2026-10-01")).toMatchObject({ status: "filed", reference: "FTA-123", payableFils: 3000 });
    const health = (await call(app, "GET", "/api/books/health", g.owner)).body.checks;
    expect(health.find((c: { key: string }) => c.key === "output_vat")).toMatchObject({ ok: true });
  });

  it("a refund goes to VAT payable as a debit", async () => {
    const g = await garage();
    const { app, bill, file } = g;
    await bill(160000);
    await g.later();
    await file("2026-09-01", "2026-09-30");
    expect((await file("2026-10-01", "2026-10-31")).status).toBe(200);
    expect(byCode(app, "vat_return:2026-10-01")).toEqual({ "1300": -8000, "2110": 8000 });
  });

  it("filing is refused when it shouldn't happen", async () => {
    const g = await garage();
    const { app, invoice, file } = g;
    await invoice(100000);
    await g.later();
    await call(app, "PUT", "/api/settings/garage", g.owner, { emirate: null });
    expect((await file("2026-09-01", "2026-09-30")).body.error).toMatch(/emirate/);
    await call(app, "PUT", "/api/settings/garage", g.owner, { emirate: "dubai" });
    expect((await file("2026-11-01", "2026-11-30")).body.error).toMatch(/once its period has ended/);
    expect((await file("2026-10-01", "2026-10-30")).body.error).toMatch(/isn't a VAT period/);
    const early = await file("2026-10-01", "2026-10-31");
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/File the return for/);
    const accountant = await addUser(app, g.owner, "accountant");
    expect((await call(app, "POST", "/api/vat/returns", accountant, { from: "2026-09-01", to: "2026-09-30" })).status).toBe(403);
    expect((await file("2026-09-01", "2026-09-30")).status).toBe(200);
    expect((await file("2026-10-01", "2026-10-31")).status).toBe(200);
    expect((await file("2026-10-01", "2026-10-31")).status).toBe(409);
    const pc = await garage(false);
    await pc.later();
    expect((await pc.file("2026-09-01", "2026-09-30")).status).toBe(409);
  });

  it("later credit note lands in the open period", async () => {
    const g = await garage();
    const { app, invoice, file, getReturn } = g;
    const inv = await invoice(100000);
    await g.later();
    await file("2026-09-01", "2026-09-30");
    await file("2026-10-01", "2026-10-31");
    expect((await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "Overcharged", lines: [{ lineId: inv.lines[0].id, qty: 1 }], returnToStock: false })).status).toBe(200);
    const oct = await getReturn("2026-10-01", "2026-10-31");
    expect(oct.filed.figures.dueFils).toBe(5000);
    expect(oct.changedSinceFiled).toBe(false);
    expect((await getReturn("2026-11-01", "2026-11-30")).dueFils).toBe(-5000);
  });

  it("bill cancelled after filing", async () => {
    const g = await garage();
    const { app, bill, file, getReturn } = g;
    const b = await bill(40000);
    await g.later();
    await file("2026-09-01", "2026-09-30");
    await file("2026-10-01", "2026-10-31");
    expect((await call(app, "POST", `/api/bills/${b.id}/cancel`, g.owner, { reason: "Entered twice" })).status).toBe(200);
    expect((await getReturn("2026-11-01", "2026-11-30")).recoverableFils).toBe(-2000);
    const oct = await getReturn("2026-10-01", "2026-10-31");
    expect(oct.filed.figures.recoverableFils).toBe(2000);
    expect(oct.changedSinceFiled).toBe(false);
  });
});
