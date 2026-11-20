import { describe, expect, it } from "vitest";
import { annualLeaveBalance, buildSif, can, gratuityOwed, MESSAGE_EVENTS, proposeLine, runLineEditSchema, serviceDays, settingsSchemas, settlementEditSchema, settlementProposal, settlementTotal, SYSTEM_ACCOUNTS } from "../src";

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
  it("I4: a whole month unpaid pays nothing, never less", () => {
    for (const [month, rule] of [["2026-02", "gross_30"], ["2026-10", "gross_30"], ["2026-10", "gross_365"]] as const) {
      const m = month === "2026-02" ? { from: "2026-02-01", to: "2026-02-28" } : { from: "2026-10-01", to: "2026-10-31" };
      const l = proposeLine({ month, employee: emp, unpaidLeave: [m], salaryDayRate: rule, advanceDueFils: 0 });
      expect(l.netFils).toBe(0);
    }
  });
  it("I10: editing one field of a line leaves the note alone", () => {
    expect(runLineEditSchema.parse({ bonusFils: 100 })).not.toHaveProperty("extrasNote");
    expect(runLineEditSchema.parse({ extrasNote: "" }).extrasNote).toBeNull();
  });
  const leaver = { ...emp, joinDate: "2024-01-01", leftDate: "2026-10-12" };
  const rules = { salaryDayRate: "gross_30", gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic" } as const;
  const settle = (o: Partial<Parameters<typeof settlementProposal>[0]> = {}) =>
    settlementProposal({ employee: leaver, lastDay: "2026-10-12", unpaidLeave: [], annualTaken: [], rules, salaryAlreadyPaid: false, gratuityHeldFils: 0, advancesOwedFils: 0, ...o });
  it("a final settlement: salary to the last day, leave, gratuity, less advances", () => {
    const items = settle({ advancesOwedFils: 20000 });
    const by = Object.fromEntries(items.map((i) => [i.key, i.amountFils]));
    expect(by.salary).toBe(180000);
    expect(by.leave).toBe(Math.round(2.5 * 33 * 10000));
    expect(by.gratuity).toBe(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: serviceDays("2024-01-01", "2026-10-12", []), dayRate: "basic_30", cap: "basic" }));
    expect(by.advances).toBe(-20000);
    expect(items.every((i) => i.how.length > 0 && i.amountFils === i.proposedFils && i.reason === null)).toBe(true);
    expect(settlementTotal(items)).toBe(by.salary! + by.leave! + by.gratuity! - 20000);
  });
  it("under a year: no gratuity", () => {
    const g = settle({ employee: { ...leaver, joinDate: "2026-01-01" }, gratuityHeldFils: 50000 }).find((i) => i.key === "gratuity")!;
    expect(g.amountFils).toBe(0);
    expect(g.how).toMatch(/Under one year/);
  });
  it("negative leave balance deducts", () => {
    const l = settle({ employee: { ...leaver, joinDate: "2026-06-01" }, annualTaken: [{ from: "2026-08-01", to: "2026-08-20" }] }).find((i) => i.key === "leave")!;
    expect(l.amountFils).toBe(Math.round((2.5 * 4 - 20) * 10000));
  });
  it("salary already paid in the payroll", () => {
    const s = settle({ salaryAlreadyPaid: true }).find((i) => i.key === "salary")!;
    expect(s.amountFils).toBe(0);
    expect(s.how).toMatch(/Paid in the Oct 2026 payroll/);
  });
  it("payslip is a message event; a settlement change needs a reason", () => {
    expect(MESSAGE_EVENTS).toContain("payslip");
    expect(() => settlementEditSchema.parse({ key: "leave", amountFils: 100, reason: "" })).toThrow();
    expect(settlementEditSchema.parse({ key: "leave", amountFils: 100, reason: "Agreed" }).reason).toBe("Agreed");
  });
});

