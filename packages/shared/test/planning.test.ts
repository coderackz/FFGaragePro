import { describe, expect, it } from "vitest";
import { abcClasses, partSchema, stockAgeBucket, suggestLevels } from "../src";

describe("planning", () => {
  it("levels", () => {
    // 45 used in 90 days = 0.5 a day; 7 days' lead + 14 = 21 days → 10.5 → 11; plus 30 days (15) → 26.
    expect(suggestLevels(45, 7)).toEqual({ min: 11, max: 26 });
    expect(suggestLevels(0, 7)).toEqual({ min: 0, max: 0 });
    expect(suggestLevels(9, 0)).toEqual({ min: 2, max: 5 });
  });

  it("abc", () => {
    const classes = abcClasses([
      { id: "a", value: 7000 }, { id: "b", value: 1500 }, { id: "c", value: 900 }, { id: "d", value: 400 }, { id: "e", value: 200 }, { id: "z", value: 0 },
    ]);
    // Cumulative before each: a 0 %, b 70 %, c 85 %, d 94 %, e 98 %.
    expect(Object.fromEntries(classes)).toEqual({ a: "A", b: "A", c: "B", d: "B", e: "C", z: "C" });
    expect(abcClasses([])).toEqual(new Map());
  });

  it("aging buckets", () => {
    expect([0, 90, 91, 180, 181, 365, 366].map(stockAgeBucket)).toEqual(["0–90", "0–90", "91–180", "91–180", "181–365", "181–365", "Over 365"]);
  });

  it("schema", () => {
    expect(partSchema.parse({ partNo: "P", name: "P", stocked: true, sellPriceFils: 1 })).toMatchObject({ maxLevel: 0, preferredSupplierId: null, leadTimeDays: 7 });
    expect(partSchema.safeParse({ partNo: "P", name: "P", stocked: true, sellPriceFils: 1, reorderLevel: 10, maxLevel: 5 }).success).toBe(false);
  });
});
