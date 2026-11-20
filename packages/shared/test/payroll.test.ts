import { describe, expect, it } from "vitest";
import { annualLeaveBalance, buildSif, can, gratuityOwed, proposeLine, serviceDays, settingsSchemas, SYSTEM_ACCOUNTS } from "../src";

const emp = { basicFils: 300000, housingFils: 100000, transportFils: 50000, otherAllowanceFils: 0, joinDate: "2024-01-01", leftDate: null };
const sifLine = { name: "Ravi", personId: "10012345678901", routingCode: "803320101", account: "AE070331234567890123456", from: "2026-10-01", to: "2026-10-31", days: 31, fixedFils: 450000, variableFils: 0, leaveDays: 0 };
const sifInput = { establishmentId: "1234567890123", employerRoutingCode: "803320101", month: "2026-10", createdAt: new Date("2026-11-01T06:30:15Z"), reference: "OCT26", lines: [sifLine] };

describe("payroll maths", () => {
  it("a full month pays basic and allowances", () => {
    expect(proposeLine({ month: "2026-10", employee: emp, unpaidLeave: [], salaryDayRate: "gross_30", advanceDueFils: 0 }))
      .toMatchObject({ workedDays: 31, basicFils: 300000, allowancesFils: 150000, unpaidDays: 0, netFils: 450000 });
  });
  it("joiner mid-month is prorated", () => {
    const l = proposeLine({ month: "2026-10", employee: { ...emp, joinDate: "2026-10-22" }, unpaidLeave: [], salaryDayRate: "gross_30", advanceDueFils: 0 });
    expect(l.workedDays).toBe(10);
    expect(l.basicFils + l.allowancesFils).toBe(150000);
  });
  it("unpaid leave across months", () => {
    const l = proposeLine({ month: "2026-10", employee: emp, unpaidLeave: [{ from: "2026-10-30", to: "2026-11-03" }], salaryDayRate: "gross_365", advanceDueFils: 10000 });
    expect(l.unpaidDays).toBe(2);
    expect(l.unpaidDeductionFils).toBe(Math.round((450000 * 12 / 365) * 2));
    expect(l.advanceRepaymentFils).toBe(10000);
    expect(l.netFils).toBe(450000 - l.unpaidDeductionFils - 10000);
  });
  it("gratuity: 21 days a year to five, 30 after, capped", () => {
    expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: 365, dayRate: "basic_30", cap: "basic" })).toBe(210000);
    expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: 365 * 7, dayRate: "basic_30", cap: "basic" })).toBe(10000 * (105 + 60));
    expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: 365 * 30, dayRate: "basic_30", cap: "basic" })).toBe(300000 * 24);
    expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: 365 * 30, dayRate: "basic_30", cap: "gross" })).toBe(10000 * (105 + 750));
  });
  it("gratuity leaves out unpaid days", () => {
    expect(serviceDays("2025-01-01", "2025-12-31", [{ from: "2025-03-01", to: "2025-03-10" }])).toBe(365 - 10);
  });
  it("annual leave builds at 2.5 days a month", () => {
    expect(annualLeaveBalance("2026-01-15", "2026-11-20", [{ from: "2026-06-01", to: "2026-06-05" }])).toBe(2.5 * 10 - 5);
  });
  it("SIF: EDR per employee, SCR last, named for the employer", () => {
    const s = buildSif(sifInput);
    expect(s.fileName).toBe("1234567890123261101103015.SIF");
    expect(s.text.split("\r\n")).toEqual([
      "EDR,10012345678901,803320101,AE070331234567890123456,2026-10-01,2026-10-31,31,4500.00,0.00,0",
      "SCR,1234567890123,803320101,2026-11-01,1030,102026,1,4500.00,AED,OCT26", "",
    ]);
    expect(() => buildSif({ ...sifInput, lines: [{ ...sifLine, personId: "123" }] })).toThrow(/Ravi/);
  });
  it("payroll permissions, settings and accounts", () => {
    expect(can("accountant", "payroll.manage")).toBe(true);
    expect(can("accountant", "payroll.approve")).toBe(false);
    expect(can("advisor", "payroll.manage")).toBe(false);
    expect(settingsSchemas.payroll.parse({})).toMatchObject({ bonusInWps: false, gratuityDayRate: null, salaryDayRate: null });
    expect(SYSTEM_ACCOUNTS.salaries_payable.code).toBe("2200");
    expect(SYSTEM_ACCOUNTS.staff_advances.code).toBe("1410");
  });
});
