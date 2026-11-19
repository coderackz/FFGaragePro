import { describe, expect, it } from "vitest";
import {
  agingBucket, allocateOldestFirst, can, creditNoteSchema, DEFAULT_SETTINGS, dueDate, formatDocNumber, formatReceiptNumber, invoiceStatus,
  owedFils, receiptSchema, settingsSchemas,
} from "../src/index";

describe("invoice money", () => {
  it("owed and status come from gross, credited and paid", () => {
    const d = { grossFils: 10500, creditedFils: 500, paidFils: 4000 };
    expect(owedFils(d)).toBe(6000);
    expect(invoiceStatus(d)).toBe("part_paid");
    expect(invoiceStatus({ ...d, paidFils: 10000 })).toBe("paid");
    expect(invoiceStatus({ grossFils: 10500, creditedFils: 0, paidFils: 0 })).toBe("issued");
    expect(invoiceStatus({ grossFils: 10500, creditedFils: 10500, paidFils: 0 })).toBe("paid");
  });
});

describe("allocating a payment", () => {
  it("pays the oldest due first, never more than each owes", () => {
    const invoices = [
      { id: "B", dueDate: "2026-11-10", issuedAt: "2026-10-11T08:00:00.000Z", owedFils: 10000 },
      { id: "A", dueDate: "2026-11-01", issuedAt: "2026-10-02T08:00:00.000Z", owedFils: 8000 },
      { id: "C", dueDate: "2026-11-20", issuedAt: "2026-10-21T08:00:00.000Z", owedFils: 5000 },
    ];
    expect(allocateOldestFirst(15000, invoices)).toEqual([{ documentId: "A", amountFils: 8000 }, { documentId: "B", amountFils: 7000 }]);
    const all = allocateOldestFirst(99999, invoices);
    expect(all.reduce((s, a) => s + a.amountFils, 0)).toBe(23000);
  });
});

describe("due dates and aging", () => {
  it("due date counts from the Dubai date of issue", () => {
    expect(dueDate("2026-11-19T21:30:00.000Z", 30, true)).toBe("2026-12-20");
    expect(dueDate("2026-11-19T21:30:00.000Z", 30, false)).toBe("2026-11-20");
  });
  it("aging buckets by days past due", () => {
    expect(agingBucket("2026-11-01", "2026-11-01")).toBe("current");
    expect(agingBucket("2026-10-01", "2026-11-01")).toBe("31-60");
    expect(agingBucket("2026-10-20", "2026-11-01")).toBe("1-30");
    expect(agingBucket("2026-08-15", "2026-11-01")).toBe("61-90");
    expect(agingBucket("2026-07-01", "2026-11-01")).toBe("90+");
  });
});

describe("numbers and permissions", () => {
  it("credit notes and receipts have their own series", () => {
    expect(formatDocNumber("credit_note", 7)).toBe("CN-00007");
    expect(formatReceiptNumber(3, "P1")).toBe("RCT-P1-00003");
    expect(can("accountant", "credit_notes.issue")).toBe(true);
    expect(can("advisor", "credit_notes.issue")).toBe(false);
    expect(can("accountant", "credit.override")).toBe(false);
    expect(can("owner", "credit.override")).toBe(true);
  });
});

describe("credit settings and inputs", () => {
  it("defaults and checks", () => {
    expect(DEFAULT_SETTINGS.credit.defaultTermsDays).toBe(30);
    expect(DEFAULT_SETTINGS.credit.overLimit).toBe("warn");
    expect(DEFAULT_SETTINGS.numbering.receiptPrefix).toBe("RCT");
    expect(DEFAULT_SETTINGS.numbering.creditNotePrefix).toBe("CN");
    expect(() => settingsSchemas.numbering.parse({ receiptPrefix: "INV" })).toThrow("Each document type needs its own prefix");
    expect(() => receiptSchema.parse({ customerId: "11111111-1111-4111-8111-111111111111", amountFils: 0, method: "cash" })).toThrow("Amount can't be zero");
    expect(() => creditNoteSchema.parse({ reason: "" })).toThrow("Give a reason");
  });
});
