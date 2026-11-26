import { DEFAULT_SETTINGS } from "@ffgp/shared";
import { describe, expect, it } from "vitest";
import { SAMPLE_GARAGE } from "../src/renderer/print/sample";
import { renderBonusVoucherHtml, renderPayslipsHtml, renderSettlementHtml, type Payslip } from "../src/renderer/print/templates";

const slip = (): Payslip => ({
  employee: { id: "e1", name: "Ravi Kumar", job: "Mechanic", personId: "10012345678901" },
  month: "2026-10", workedDays: 31, basicFils: 300000, allowances: { housing: 100000, transport: 50000, other: 0 }, unpaidDays: 2, unpaidDeductionFils: 30000,
  advanceRepaymentFils: 10000, extrasFils: 0, extrasNote: null, bonusFils: 25000, bonusInWps: false, netWpsFils: 410000, paidBy: "Bank transfer (WPS)",
});

describe("payslips and bonus vouchers", () => {
  it("one page per person, in English", () => {
    const html = renderPayslipsHtml([slip(), slip()], SAMPLE_GARAGE, DEFAULT_SETTINGS);
    expect(html.match(/class="page"/g)).toHaveLength(2);
    expect(html).toContain("PAYSLIP");
    expect(html).toContain("October 2026");
    expect(html).toContain("4,100.00");
    expect(html).toContain("Cash bonus");
    expect(html).toContain("Ravi Kumar");
    expect(html).not.toMatch(/[\u0600-\u06FF]/);
  });
  it("the bonus voucher lists each person with a place to sign", () => {
    const html = renderBonusVoucherHtml({ month: "2026-10", lines: [{ employeeId: "e1", name: "Ravi Kumar", job: "Mechanic", bonusFils: 25000 }], totalFils: 25000 }, SAMPLE_GARAGE, DEFAULT_SETTINGS);
    expect(html).toContain("CASH BONUS");
    expect(html).toContain("Ravi Kumar");
    expect(html).toContain("250.00");
    expect(html).toContain("Signature");
  });
  it("the settlement letter shows each amount, how it was worked out, and any reason", () => {
    const html = renderSettlementHtml({
      employeeId: "e1", name: "Sami Haddad", job: "Electrician", joinDate: "2025-03-01", lastDay: "2026-10-31",
      items: [
        { key: "salary", label: "Salary to the last day", proposedFils: 250000, amountFils: 250000, how: "31 days of 2,500.00 a month at Gross ÷ 30, less 0 unpaid days", reason: null },
        { key: "leave", label: "Leave not taken", proposedFils: 158333, amountFils: 5000, how: "19 days not taken × 83.33 a day (Basic ÷ 30)", reason: "Agreed with the owner" },
        { key: "gratuity", label: "End-of-service gratuity", proposedFils: 290000, amountFils: 290000, how: "1 year 245 days: 21 days of basic a year", reason: null },
        { key: "advances", label: "Advances still owed", proposedFils: 0, amountFils: 0, how: "None owed", reason: null },
      ],
      totalFils: 545000,
    }, SAMPLE_GARAGE, DEFAULT_SETTINGS);
    expect(html).toContain("FINAL SETTLEMENT");
    expect(html).toContain("Sami Haddad");
    expect(html).toContain("Agreed with the owner");
    expect(html).toContain("Basic ÷ 30");
    expect(html).toContain("5,450.00");
    expect(html).toContain("Sami Haddad");
    expect(html).not.toMatch(/[\u0600-\u06FF]/);
  });
});

