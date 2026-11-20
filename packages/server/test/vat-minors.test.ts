import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { postEntry } from "../src/books/post";
import { vatFigures } from "../src/vat/figures";
import { call, makeApp, SETUP, setUp } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const RENT = "00000000-0000-4000-8000-0000000a6010";
const labour = (unitPriceFils: number) => ({ kind: "labour", description: "Service", qty: 1, unitPriceFils, discountPct: 0 });
const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
afterEach(() => vi.useRealTimers());
type L = { accountId: string; debitFils?: number; creditFils?: number; vatBox?: string };

async function garage(o: { firstPeriodStart?: string } = {}) {
  at("2026-10-15T08:00:00Z");
  const app = await makeApp(undefined, { postsBooks: true });
  let owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: "2026-09-01" });
  await call(app, "PUT", "/api/settings/garage", owner, { emirate: "dubai" });
  await call(app, "PUT", "/api/settings/tax", owner, { returnPeriod: "monthly", firstPeriodStart: o.firstPeriodStart ?? "2026-09-01" });
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC" })).body.customer;
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim" })).body.supplier;
  const invoice = async (net: number) => {
    const d = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [labour(net)] })).body.document;
    return (await call(app, "POST", `/api/documents/${d.id}/issue`, owner)).body.document;
  };
  const bill = (net: number, billDate: string) =>
    call(app, "POST", "/api/bills", owner, { supplierId: supplier.id, supplierInvoiceNo: `B${net}${billDate}`, billDate, lines: [{ accountId: RENT, description: "Rent", netFils: net, vat: "standard" }] });
  const journal = async (date: string, lines: L[], kind = "manual") => {
    const d = (await call(app, "POST", "/api/books/drafts", owner, { kind, date, narration: "J", lines })).body.draft;
    return call(app, "POST", `/api/books/drafts/${d.id}/post`, owner);
  };
  const file = (from: string, to: string) => { postPending(app.db); return call(app, "POST", "/api/vat/returns", owner, { from, to }); };
  const later = async () => {
    at("2026-11-20T08:00:00Z");
    owner = (await call(app, "POST", "/api/auth/login", undefined, { username: SETUP.owner.username, password: SETUP.owner.password })).body.token;
  };
  const balance = (accountId: string) => app.db.get<{ b: number }>("SELECT COALESCE(SUM(debit_fils - credit_fils), 0) AS b FROM journal_lines WHERE account_id = ?", [accountId])!.b;
  return { app, get owner() { return owner; }, customer, invoice, bill, journal, file, later, balance };
}

describe("VAT return: the minor findings", () => {
  it("M2: opening balances never carry VAT box tags", async () => {
    const g = await garage();
    const r = await g.journal("2026-08-31", [{ accountId: A.bank.id, debitFils: 1000, vatBox: "9" }, { accountId: A.sales_other.id, creditFils: 1000, vatBox: "4" }], "opening");
    expect(r.status).toBe(200);
    expect(g.app.db.all("SELECT vat_box FROM journal_lines WHERE entry_id = ?", [r.body.entry.id])).toEqual(expect.not.arrayContaining([expect.objectContaining({ vat_box: expect.any(String) })]));
  });

  it("M3: tags go only where they make sense", async () => {
    const g = await garage();
    expect((await g.journal("2026-10-15", [{ accountId: A.bank.id, debitFils: 500 }, { accountId: A.vat_output.id, creditFils: 500, vatBox: "4" }])).status).toBe(400);
    expect((await g.journal("2026-10-15", [{ accountId: A.bank.id, debitFils: 500, vatBox: "4" }, { accountId: A.sales_other.id, creditFils: 500 }])).status).toBe(400);
    expect((await g.journal("2026-10-15", [{ accountId: RENT, debitFils: 500, vatBox: "4" }, { accountId: A.bank.id, creditFils: 500 }])).status).toBe(400);
    expect((await g.journal("2026-10-15", [{ accountId: RENT, debitFils: 500, vatBox: "10" }, { accountId: A.bank.id, creditFils: 500 }])).status).toBe(200);
    expect((await g.journal("2026-10-15", [{ accountId: A.bank.id, debitFils: 500 }, { accountId: A.sales_other.id, creditFils: 500, vatBox: "5" }])).status).toBe(200);
  });

  it("M4: a period before the books start can't be filed", async () => {
    const g = await garage({ firstPeriodStart: "2026-08-01" });
    await g.later();
    const r = await g.file("2026-08-01", "2026-08-31");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/before the books start/);
  });

  it("M5: filing waits until everything has posted", async () => {
    const g = await garage();
    await g.later();
    g.app.db.run("INSERT INTO book_failures (post_key, error, at) VALUES ('invoice:x', 'Account switched off', '2026-11-20')");
    const r = await g.file("2026-09-01", "2026-09-30");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/couldn't post/);
  });

  it("M6: advances are money received beyond what was invoiced, at the VAT rate", async () => {
    const g = await garage();
    await g.invoice(100000);
    await call(g.app, "POST", "/api/receipts", g.owner, { customerId: g.customer.id, amountFils: 110250, method: "cash" });
    expect(vatFigures(g.app.db, "2026-10-01", "2026-10-31").advances).toEqual([expect.objectContaining({ creditFils: 5250, vatInsideFils: 250 })]);
    // Credit from a credit note isn't money received in advance.
    const other = (await call(g.app, "POST", "/api/customers", g.owner, { kind: "company", name: "Zed Motors" })).body.customer;
    const d = (await call(g.app, "POST", "/api/documents", g.owner, { type: "invoice", customerId: other.id, lines: [labour(100000)] })).body.document;
    const inv = (await call(g.app, "POST", `/api/documents/${d.id}/issue`, g.owner)).body.document;
    await call(g.app, "POST", "/api/receipts", g.owner, { customerId: other.id, amountFils: 105000, method: "cash" });
    await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "Goodwill", lines: [{ lineId: inv.lines[0].id, qty: 1 }], returnToStock: false });
    expect(vatFigures(g.app.db, "2026-10-01", "2026-10-31").advances.map((a) => a.name)).toEqual(["Gulf Fleet LLC"]);
  });

  it("M9: not-in-box rows say which VAT account; late items carry their own date", async () => {
    const g = await garage();
    expect((await g.journal("2026-10-16", [{ accountId: A.vat_output.id, debitFils: 1500 }, { accountId: A.vat_input.id, creditFils: 1500 }])).status).toBe(200);
    const f = vatFigures(g.app.db, "2026-10-01", "2026-10-31");
    expect(f.notInBox.map((r) => [r.account, r.vatFils]).sort()).toEqual([["input", -1500], ["output", -1500]]);
    await g.later();
    await g.file("2026-09-01", "2026-09-30");
    await g.file("2026-10-01", "2026-10-31");
    // Something dated in October reaches the books after October was filed: it posts on 1 November.
    postEntry(g.app.db, { date: "2026-10-10", narration: "Late", sourceType: "manual", userId: null, lines: [
      { accountId: RENT, debitFils: 1000, creditFils: 0, vatBox: "9" }, { accountId: A.vat_input.id, debitFils: 50, creditFils: 0, vatBox: "9" }, { accountId: A.bank.id, debitFils: 0, creditFils: 1050 },
    ] });
    const nov = vatFigures(g.app.db, "2026-11-01", "2026-11-30");
    expect(nov.boxes.find((b) => b.key === "9")!.rows).toEqual([expect.objectContaining({ date: "2026-11-01", originalDate: "2026-10-10", vatFils: 50 })]);
  });

  it("M10: opening VAT balances aren't counted; after filing, the VAT accounts are clear", async () => {
    const g = await garage();
    expect((await g.journal("2026-08-31", [{ accountId: A.bank.id, debitFils: 7000 }, { accountId: A.vat_output.id, creditFils: 7000 }], "opening")).status).toBe(200);
    expect(vatFigures(g.app.db, "2026-09-01", "2026-09-30").dueFils).toBe(0);
    at("2026-09-15T08:00:00Z");
    await g.invoice(100000);
    expect((await g.bill(20000, "2026-09-16")).status).toBe(200);
    at("2026-10-15T08:00:00Z");
    await g.invoice(40000);
    expect((await g.bill(60000, "2026-10-16")).status).toBe(200);
    await g.later();
    expect((await g.file("2026-09-01", "2026-09-30")).status).toBe(200);
    expect((await g.file("2026-10-01", "2026-10-31")).status).toBe(200);
    expect(g.balance(A.vat_output.id)).toBe(-7000); // only the opening balance is left
    expect(g.balance(A.vat_input.id)).toBe(0);
    expect(g.balance(A.vat_payable.id)).toBe(-(5000 - 1000) - (2000 - 3000));
  });
});
