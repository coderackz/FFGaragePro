import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { vatFigures, type VatFigures } from "../src/vat/figures";
import { call, makeApp, receiveFrom, setUp } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const RENT = "00000000-0000-4000-8000-0000000a6010";
const CHARGES = "00000000-0000-4000-8000-0000000a6030";
const FUEL = "00000000-0000-4000-8000-0000000a6040";
const labour = (unitPriceFils: number) => ({ kind: "labour", description: "Service", qty: 1, unitPriceFils, discountPct: 0 });
const box = (f: VatFigures, key: string) => f.boxes.find((b) => b.key === key)!;
const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
afterEach(() => vi.useRealTimers());

async function garage(startDate = "2026-09-01") {
  at("2026-10-15T08:00:00Z");
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate });
  await call(app, "PUT", "/api/settings/garage", owner, { emirate: "dubai" });
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC" })).body.customer;
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim" })).body.supplier;
  const invoice = async (lines: unknown[]) => {
    const d = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines })).body.document;
    return (await call(app, "POST", `/api/documents/${d.id}/issue`, owner)).body.document;
  };
  const journal = async (date: string, lines: { accountId: string; debitFils?: number; creditFils?: number; vatBox?: string }[]) => {
    const d = (await call(app, "POST", "/api/books/drafts", owner, { date, narration: "VAT journal", lines })).body.draft;
    const r = await call(app, "POST", `/api/books/drafts/${d.id}/post`, owner);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  };
  const figures = (from: string, to: string) => { postPending(app.db); return vatFigures(app.db, from, to); };
  return { app, owner, customer, supplier, invoice, journal, figures };
}

describe("VAT201 figures", () => {
  it("box 1 from invoices less credit notes, in the garage's emirate", async () => {
    const { app, owner, invoice, figures } = await garage();
    const inv = await invoice([labour(80000), labour(20000)]);
    at("2026-10-20T08:00:00Z");
    const small = inv.lines.find((l: { unitPriceFils: number }) => l.unitPriceFils === 20000);
    expect((await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "Overcharged", lines: [{ lineId: small.id, qty: 1 }], returnToStock: false })).status).toBe(200);
    const f = figures("2026-10-01", "2026-10-31");
    expect(box(f, "1b")).toMatchObject({ amountFils: 80000, vatFils: 4000, adjustmentFils: 0 });
    expect(box(f, "1b").rows).toHaveLength(2);
    expect(box(f, "1a")).toMatchObject({ amountFils: 0, vatFils: 0 });
    expect(f.emirate).toBe("dubai");
    expect(f.dueFils).toBe(4000);
  });

  it("box 9 counts only VAT-bearing net", async () => {
    const { app, owner, supplier, figures } = await garage();
    expect((await call(app, "POST", "/api/bills", owner, { supplierId: supplier.id, supplierInvoiceNo: "B1", billDate: "2026-10-12", lines: [
      { accountId: RENT, description: "Rent", netFils: 100000, vat: "standard" }, { accountId: CHARGES, description: "Fee", netFils: 20000, vat: "none" },
    ] })).status).toBe(200);
    await receiveFrom(app, owner, supplier.id, 30000, 0, "2026-10-14");
    expect((await call(app, "POST", "/api/expenses", owner, { date: "2026-10-13", accountId: FUEL, description: "Diesel", netFils: 10000, paidFromAccountId: A.cash.id })).status).toBe(200);
    const f = figures("2026-10-01", "2026-10-31");
    expect(box(f, "9")).toMatchObject({ amountFils: 110000, vatFils: 5500 });
    expect(box(f, "9").rows).toHaveLength(2); // the bill and the expense; the receipt with no VAT counts nothing
    expect(f.recoverableFils).toBe(5500);
    expect(f.payableFils).toBe(-5500);
  });

  it("tagged journals fill the other boxes and adjustments", async () => {
    const { invoice, journal, figures } = await garage();
    await invoice([labour(80000)]);
    await journal("2026-10-16", [{ accountId: A.bank.id, debitFils: 50000 }, { accountId: A.sales_other.id, creditFils: 50000, vatBox: "4" }]);
    await journal("2026-10-16", [{ accountId: A.bank.id, debitFils: 30000 }, { accountId: A.sales_other.id, creditFils: 30000, vatBox: "5" }]);
    await journal("2026-10-17", [{ accountId: A.vat_output.id, debitFils: 2000, vatBox: "1adj" }, { accountId: A.bank.id, creditFils: 2000 }]);
    const f = figures("2026-10-01", "2026-10-31");
    expect(box(f, "4").amountFils).toBe(50000);
    expect(box(f, "5").amountFils).toBe(30000);
    expect(box(f, "1b").adjustmentFils).toBe(-2000);
    expect(box(f, "8")).toMatchObject({ amountFils: 80000 + 50000 + 30000, vatFils: 4000, adjustmentFils: -2000 });
    expect(f.dueFils).toBe(2000);
  });

  it("period straddling the start counts only from the start", async () => {
    const { figures } = await garage("2026-10-10");
    const f = figures("2026-10-01", "2026-12-31");
    expect(f.countedFrom).toBe("2026-10-10");
    expect(figures("2026-11-01", "2026-11-30").countedFrom).toBe("2026-11-01");
  });

  it("untagged VAT movements are listed, advances are listed", async () => {
    const { app, owner, customer, journal, figures } = await garage();
    await journal("2026-10-16", [{ accountId: A.vat_input.id, debitFils: 1500 }, { accountId: A.bank.id, creditFils: 1500 }]);
    await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 10500, method: "cash" });
    const f = figures("2026-10-01", "2026-10-31");
    expect(f.notInBox.map((r) => r.vatFils)).toEqual([1500]);
    expect(f.advances).toEqual([expect.objectContaining({ customerId: customer.id, creditFils: 10500, vatInsideFils: 500 })]);
    expect(f.recoverableFils).toBe(0);
  });
});
