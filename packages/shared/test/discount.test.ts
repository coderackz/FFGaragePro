import { describe, expect, it } from "vitest";
import { discountPct, discountSchema, needsConfirmation } from "../src/index";

describe("overall discount", () => {
  it("its share of the bill, to two decimals, and when it needs a confirmation (strictly above the limit)", () => {
    expect(discountPct(5000, 50000)).toBe(10);
    expect(discountPct(1000, 30000)).toBe(3.33);
    expect(discountPct(1000, 0)).toBe(0);
    expect(needsConfirmation(25, 25)).toBe(false);
    expect(needsConfirmation(25.01, 25)).toBe(true);
  });
  it("percent at most 100, an amount in whole fils, a remark of 3–300 characters", () => {
    expect(discountSchema.safeParse({ kind: "percent", value: 101 }).success).toBe(false);
    expect(discountSchema.safeParse({ kind: "amount", value: 10.5 }).success).toBe(false);
    expect(discountSchema.safeParse({ kind: "percent", value: 0 }).success).toBe(false);
    expect(discountSchema.safeParse({ kind: "percent", value: 30, confirmed: true, remark: "ok" }).success).toBe(false);
    expect(discountSchema.safeParse({ kind: "percent", value: 30, confirmed: true, remark: "x".repeat(301) }).success).toBe(false);
    expect(discountSchema.parse({ kind: "amount", value: 5000 })).toMatchObject({ kind: "amount", value: 5000 });
  });
});
