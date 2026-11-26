import { describe, expect, it } from "vitest";
import { amountInWords } from "../src";

describe("amountInWords", () => {
  const cases: [number, string][] = [
    [0, "Zero dirhams only"],
    [1, "One fils only"],
    [50, "Fifty fils only"],
    [100, "One dirham only"],
    [200, "Two dirhams only"],
    [300, "Three dirhams only"],
    [1100, "Eleven dirhams only"],
    [10000, "One hundred dirhams only"],
    [20000, "Two hundred dirhams only"],
    [123450, "One thousand two hundred thirty-four dirhams and fifty fils only"],
    [200000, "Two thousand dirhams only"],
    [525000, "Five thousand two hundred fifty dirhams only"],
    [1200000, "Twelve thousand dirhams only"],
    [100000025, "One million dirhams and twenty-five fils only"],
  ];
  it.each(cases)("%i fils", (fils, en) => {
    expect(amountInWords(fils)).toBe(en);
  });
  it("negative amounts use the absolute value", () => expect(amountInWords(-100)).toBe("One dirham only"));
});
