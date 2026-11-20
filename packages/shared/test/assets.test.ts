import { describe, expect, it } from "vitest";
import { assetSchema, depreciationThrough, disposeSchema, monthsBetween, SYSTEM_ACCOUNTS } from "../src";

const a = { costFils: 1200000, residualFils: 0, lifeMonths: 36, inUseFrom: "2026-01-15" };

describe("fixed asset maths", () => {
  it("a full month's charge from the month in use", () => {
    expect(depreciationThrough(a, "2025-12")).toBe(0);
    expect(depreciationThrough(a, "2026-01")).toBe(33333);
    expect(depreciationThrough(a, "2026-12")).toBe(33333 * 12);
  });
  it("schedule ends at cost less residual", () => {
    expect(depreciationThrough(a, "2028-11")).toBe(33333 * 35);
    expect(depreciationThrough(a, "2028-12")).toBe(1200000);
    expect(depreciationThrough(a, "2030-06")).toBe(1200000);
    expect(depreciationThrough({ ...a, residualFils: 200000 }, "2040-01")).toBe(1000000);
  });
  it("months between", () => {
    expect(monthsBetween("2026-01", "2026-01")).toBe(1);
    expect(monthsBetween("2025-11", "2026-02")).toBe(4);
  });
  it("asset input checks; the accounts", () => {
    const ok = { name: "Lift", category: "equipment", accountId: "x", costFils: 100000, inUseFrom: "2026-01-01", lifeMonths: 12 };
    expect(assetSchema.parse(ok)).toMatchObject({ residualFils: 0, openingDepreciationFils: 0 });
    expect(() => assetSchema.parse({ ...ok, residualFils: 100000 })).toThrow();
    expect(() => disposeSchema.parse({ date: "2026-05-01", proceedsFils: 500, proceedsAccountId: null })).toThrow();
    expect(disposeSchema.parse({ date: "2026-05-01", proceedsFils: 0, proceedsAccountId: null }).proceedsFils).toBe(0);
    expect([SYSTEM_ACCOUNTS.accumulated_depreciation.code, SYSTEM_ACCOUNTS.depreciation.code, SYSTEM_ACCOUNTS.disposal_gain.code, SYSTEM_ACCOUNTS.disposal_loss.code])
      .toEqual(["1590", "6070", "4030", "6080"]);
  });
});
