import { describe, expect, it } from "vitest";
import { assetSchema, depreciationThrough, employeeSchema, gratuityOwed, mergeRanges, serviceYears, settlementProposal } from "../src";

const emp = { basicFils: 300000, housingFils: 100000, transportFils: 50000, otherAllowanceFils: 0, joinDate: "2024-01-01", leftDate: null };
const rules = { salaryDayRate: "gross_30", gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic" } as const;
const settle = (o: Partial<Parameters<typeof settlementProposal>[0]> = {}) =>
  settlementProposal({ employee: { ...emp, leftDate: "2026-10-31" }, lastDay: "2026-10-31", unpaidLeave: [], annualTaken: [], rules, salaryAlreadyPaid: false, gratuityHeldFils: 0, advancesOwedFils: 0, ...o });

describe("review minors (shared)", () => {
  it("years of service count anniversaries (leap years don't qualify a day early)", () => {
    expect(serviceYears("2024-01-01", "2024-12-30", [])).toBeLessThan(1);
    expect(serviceYears("2024-01-01", "2024-12-31", [])).toBe(1);
    expect(serviceYears("2025-01-01", "2025-12-31", [])).toBe(1);
    expect(serviceYears("2020-03-01", "2025-02-28", [])).toBe(5);
    expect(serviceYears("2025-01-01", "2026-01-10", [{ from: "2025-03-01", to: "2025-03-10" }])).toBe(1);
    expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceYears: 1, dayRate: "basic_30", cap: "basic" })).toBe(210000);
    const g = settle({ employee: { ...emp, joinDate: "2024-01-01", leftDate: "2024-12-30" }, lastDay: "2024-12-30" }).find((i) => i.key === "gratuity")!;
    expect(g.how).toMatch(/Under one year/);
  });
  it("leave entered twice over the same days counts once", () => {
    expect(mergeRanges([{ from: "2026-10-01", to: "2026-10-05" }, { from: "2026-10-04", to: "2026-10-08" }, { from: "2026-10-20", to: "2026-10-20" }]))
      .toEqual([{ from: "2026-10-01", to: "2026-10-08" }, { from: "2026-10-20", to: "2026-10-20" }]);
  });
  it("settlement texts: a full month says so; leave past the last day isn't counted; the leave rate is exact", () => {
    const items = settle({ annualTaken: [{ from: "2026-10-25", to: "2026-11-10" }] });
    expect(items.find((i) => i.key === "salary")!.how).toMatch(/^Full month/);
    const leave = items.find((i) => i.key === "leave")!;
    expect(leave.how).toMatch(/^75\.5 days not taken/);
    expect(leave.how).toMatch(/3,000\.00 ÷ 30/);
  });
  it("IBAN, routing code and person ID: spaces are fine, a wrong IBAN check digit isn't", () => {
    const e = employeeSchema.parse({ name: "R", job: "M", joinDate: "2024-01-01", basicFils: 1, iban: "AE07 0331 2345 6789 0123 456", routingCode: "8033 20101", personId: "1001 2345 6789 01" });
    expect(e).toMatchObject({ iban: "AE070331234567890123456", routingCode: "803320101", personId: "10012345678901" });
    expect(() => employeeSchema.parse({ name: "R", job: "M", joinDate: "2024-01-01", basicFils: 1, iban: "AE080331234567890123456" })).toThrow(/check/);
  });
  it("fixed assets: real dates only; a tiny depreciable amount still spreads", () => {
    expect(() => assetSchema.parse({ name: "X", category: "tools", accountId: "a", costFils: 1000, inUseFrom: "2026-02-31", lifeMonths: 12 })).toThrow(/real date/);
    const tiny = { costFils: 10, residualFils: 0, lifeMonths: 36, inUseFrom: "2026-01-01" };
    expect(depreciationThrough(tiny, "2026-01")).toBe(1);
    expect(depreciationThrough(tiny, "2026-12")).toBe(10);
    expect(depreciationThrough(tiny, "2028-12")).toBe(10);
  });
});
