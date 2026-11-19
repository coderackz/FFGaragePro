import { describe, expect, it } from "vitest";
import {
  billTotals, can, DEFAULT_SETTINGS, formatNumberOf, parseStatement, supplierBillSchema, supplierPaymentSchema, transferSchema,
} from "../src";

const ACC = "00000000-0000-4000-8000-0000000a6010";
const SUP = "11111111-1111-4111-8111-111111111111";

describe("bills", () => {
  it("billTotals rounds VAT per standard line", () => {
    expect(billTotals([
      { netFils: 10000, vat: "standard" }, { netFils: 3333, vat: "standard" }, { netFils: 2000, vat: "none" },
    ])).toEqual({ netFils: 15333, vatFils: 667, grossFils: 16000 });
  });

  it("schemas refuse nonsense", () => {
    expect(transferSchema.safeParse({ date: "2026-11-20", fromAccountId: ACC, toAccountId: ACC, amountFils: 100 }).success).toBe(false);
    expect(supplierPaymentSchema.safeParse({ supplierId: SUP, amountFils: 0, method: "cash", paidFromAccountId: ACC }).success).toBe(false);
    expect(supplierBillSchema.safeParse({ supplierId: SUP, supplierInvoiceNo: "A1", billDate: "2026-11-20", lines: [] }).success).toBe(false);
    expect(supplierBillSchema.parse({ supplierId: SUP, supplierInvoiceNo: "A1", billDate: "2026-11-20", lines: [{ accountId: ACC, description: "Rent", netFils: 100 }] })
      .lines[0]!.vat).toBe("standard");
  });
});

describe("parseStatement", () => {
  it("dd/mm/yyyy with thousands separators", () => {
    const rows = [["Date", "Details", "Amount", "Ref"], ["05/11/2026", "Transfer to Al Futtaim", "-1,234.50", "TR1"], ["06/11/2026", "Card settlement", "2,000.00", ""]];
    expect(parseStatement(rows, { date: 0, description: 1, amount: 2, reference: 3, dateFormat: "dd/mm/yyyy", hasHeader: true })).toEqual([
      { date: "2026-11-05", description: "Transfer to Al Futtaim", amountFils: -123450, reference: "TR1" },
      { date: "2026-11-06", description: "Card settlement", amountFils: 200000, reference: null },
    ]);
  });

  it("debit and credit columns", () => {
    const rows = [["11/05/2026", "Bank charge", "50.00", ""], ["11/06/2026", "Deposit", "", "1,000.00"]];
    expect(parseStatement(rows, { date: 0, description: 1, debit: 2, credit: 3, dateFormat: "mm/dd/yyyy", hasHeader: false }).map((r) => [r.date, r.amountFils]))
      .toEqual([["2026-11-05", -5000], ["2026-11-06", 100000]]);
  });

  it("yyyy-mm-dd with brackets for money out; bad rows are named", () => {
    expect(parseStatement([["2026-11-05", "Fee", "(12.00)"]], { date: 0, description: 1, amount: 2, dateFormat: "yyyy-mm-dd", hasHeader: false })[0]!.amountFils).toBe(-1200);
    expect(() => parseStatement([["h"], ["2026-11-05", "a", "1"], ["31/31/2026", "b", "1"]], { date: 0, description: 1, amount: 2, dateFormat: "yyyy-mm-dd", hasHeader: true }))
      .toThrow(/^Row 3: /);
  });
});

describe("permissions and numbering", () => {
  it("payables permissions, PV and EX numbers", () => {
    expect(can("accountant", "payables.manage")).toBe(true);
    expect(can("advisor", "payables.manage")).toBe(false);
    expect(DEFAULT_SETTINGS.numbering.supplierPaymentPrefix).toBe("PV");
    expect(DEFAULT_SETTINGS.numbering.expensePrefix).toBe("EX");
    expect(formatNumberOf("supplier_payment", 7)).toBe("PV-00007");
    expect(formatNumberOf("expense", 7)).toBe("EX-00007");
  });
});
