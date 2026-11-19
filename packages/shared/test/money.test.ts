import { describe, expect, it } from "vitest";
import { docTotals, formatAED, lineTotals, parseAED } from "../src/index";

describe("lineTotals", () => {
  it("applies discount then 5% VAT", () => {
    expect(lineTotals({ qty: 2, unitPriceFils: 10000, discountPct: 10 })).toEqual({ netFils: 18000, vatFils: 900, grossFils: 18900 });
  });
  it("qty 0 and 100% discount give zeros", () => {
    expect(lineTotals({ qty: 0, unitPriceFils: 10000, discountPct: 0 })).toEqual({ netFils: 0, vatFils: 0, grossFils: 0 });
    expect(lineTotals({ qty: 3, unitPriceFils: 10000, discountPct: 100 })).toEqual({ netFils: 0, vatFils: 0, grossFils: 0 });
  });
  it("rounds VAT half-up to the fil", () => {
    expect(lineTotals({ qty: 1, unitPriceFils: 1, discountPct: 0 }).vatFils).toBe(0);
    expect(lineTotals({ qty: 1, unitPriceFils: 10, discountPct: 0 }).vatFils).toBe(1);
  });
  it("allows fractional labour hours", () => {
    expect(lineTotals({ qty: 1.5, unitPriceFils: 15000, discountPct: 0 })).toEqual({ netFils: 22500, vatFils: 1125, grossFils: 23625 });
  });
  it("never returns NaN for bad input", () => {
    const t = lineTotals({ qty: Number.NaN, unitPriceFils: 100, discountPct: 0 });
    expect(t).toEqual({ netFils: 0, vatFils: 0, grossFils: 0 });
  });
});

describe("docTotals", () => {
  it("sums line values", () => {
    const t = docTotals([
      { qty: 2, unitPriceFils: 10000, discountPct: 10 },
      { qty: 1, unitPriceFils: 10, discountPct: 0 },
    ]);
    expect(t).toEqual({ netFils: 18010, vatFils: 901, grossFils: 18911 });
  });
});

describe("AED formatting", () => {
  it("formats fils as AED", () => {
    expect(formatAED(123450)).toBe("AED 1,234.50");
    expect(formatAED(-500)).toBe("-AED 5.00");
  });
  it("parses typed amounts to fils", () => {
    expect(parseAED("1,234.5")).toBe(123450);
    expect(parseAED("AED 10")).toBe(1000);
    expect(parseAED("0.005")).toBe(1);
    expect(parseAED("abc")).toBeNull();
  });
});

describe("including VAT", () => {
  it("including VAT: the typed price is the total", () => {
    expect(lineTotals({ qty: 1, unitPriceFils: 10500, discountPct: 0 }, 500, true)).toEqual({ netFils: 10000, vatFils: 500, grossFils: 10500 });
    expect(lineTotals({ qty: 1, unitPriceFils: 999, discountPct: 0 }, 500, true)).toEqual({ netFils: 951, vatFils: 48, grossFils: 999 });
    expect(lineTotals({ qty: 3, unitPriceFils: 1000, discountPct: 10 }, 500, true)).toEqual({ netFils: 2571, vatFils: 129, grossFils: 2700 });
    expect(docTotals([{ qty: 1, unitPriceFils: 10500, discountPct: 0 }, { qty: 1, unitPriceFils: 999, discountPct: 0 }], 500, true))
      .toEqual({ netFils: 10951, vatFils: 548, grossFils: 11499 });
  });
});
