import { DEFAULT_SETTINGS } from "@ffgp/shared";
import { describe, expect, it } from "vitest";
import { SAMPLE_GARAGE } from "../src/renderer/print/sample";
import { renderBonusVoucherHtml, renderPayslipsHtml, type Payslip } from "../src/renderer/print/templates";
import "../src/renderer/print/arabic-font";

const slip = (language: "en" | "en_ar"): Payslip => ({
  employee: { id: "e1", name: "Ravi Kumar", nameAr: "رافي كومار", job: "Mechanic", language, personId: "10012345678901" },
  month: "2026-10", workedDays: 31, basicFils: 300000, allowances: { housing: 100000, transport: 50000, other: 0 }, unpaidDays: 2, unpaidDeductionFils: 30000,
  advanceRepaymentFils: 10000, extrasFils: 0, extrasNote: null, bonusFils: 25000, bonusInWps: false, netWpsFils: 410000, paidBy: "Bank transfer (WPS)",
});

describe("payslips and bonus vouchers", () => {
  it("one page per person, English or English + Arabic", () => {
    const html = renderPayslipsHtml([slip("en"), slip("en_ar")], SAMPLE_GARAGE, DEFAULT_SETTINGS);
    expect(html.match(/class="page"/g)).toHaveLength(2);
    expect(html).toContain("PAYSLIP");
    expect(html).toContain("October 2026");
    expect(html).toContain("4,100.00");
    expect(html).toContain("Cash bonus");
    expect(html).toContain("رافي كومار");
    expect(html).toContain("قسيمة الراتب");
  });
  it("the bonus voucher lists each person with a place to sign", () => {
    const html = renderBonusVoucherHtml({ month: "2026-10", lines: [{ employeeId: "e1", name: "Ravi Kumar", job: "Mechanic", bonusFils: 25000 }], totalFils: 25000 }, SAMPLE_GARAGE, DEFAULT_SETTINGS);
    expect(html).toContain("CASH BONUS");
    expect(html).toContain("Ravi Kumar");
    expect(html).toContain("250.00");
    expect(html).toContain("Signature");
  });
});
