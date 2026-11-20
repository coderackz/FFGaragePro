import { describe, expect, it } from "vitest";
import { EMIRATE_BOX, journalLineSchema, settingsSchemas, vatPeriods } from "../src";

describe("VAT model", () => {
  it("quarterly periods from the first start, newest first", () => {
    expect(vatPeriods({ returnPeriod: "quarterly", firstPeriodStart: "2026-02-01" }, "2026-11-20")).toEqual([
      { from: "2026-11-01", to: "2027-01-31" }, { from: "2026-08-01", to: "2026-10-31" }, { from: "2026-05-01", to: "2026-07-31" }, { from: "2026-02-01", to: "2026-04-30" },
    ]);
  });
  it("monthly periods handle month ends and leap years", () => {
    expect(vatPeriods({ returnPeriod: "monthly", firstPeriodStart: "2028-01-01" }, "2028-03-01").map((p) => p.to)).toEqual(["2028-03-31", "2028-02-29", "2028-01-31"]);
  });
  it("no first period, no periods", () => expect(vatPeriods({ returnPeriod: "monthly", firstPeriodStart: null }, "2026-11-20")).toEqual([]));
  it("emirates map to boxes 1a–1g", () => expect([EMIRATE_BOX.abu_dhabi, EMIRATE_BOX.dubai, EMIRATE_BOX.fujairah]).toEqual(["1a", "1b", "1g"]));
  it("a journal line may carry a VAT box", () => {
    expect(journalLineSchema.parse({ accountId: "a", creditFils: 100, vatBox: "4" }).vatBox).toBe("4");
    expect(journalLineSchema.parse({ accountId: "a", creditFils: 100 }).vatBox).toBeNull();
    expect(() => journalLineSchema.parse({ accountId: "a", creditFils: 100, vatBox: "8" })).toThrow();
  });
  it("garage emirate setting", () => expect(settingsSchemas.garage.parse({ emirate: "sharjah" }).emirate).toBe("sharjah"));
});
