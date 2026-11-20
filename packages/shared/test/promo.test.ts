import { describe, expect, it } from "vitest";
import { docTotals, lineTotals, promoProblem, promoSchema, promoShares } from "../src";

const labour = { kind: "labour" as const, qty: 1, unitPriceFils: 10000, discountPct: 0 };
const part = { kind: "part" as const, qty: 1, unitPriceFils: 5000, discountPct: 0 };

describe("promo codes", () => {
  it("percent on labour only", () => {
    const r = promoShares([labour, part], { kind: "percent", value: 10, appliesTo: "labour" }, false);
    expect(r).toMatchObject({ shares: [1000, 0], discountFils: 1000, baseFils: 10000 });
    const t = docTotals([{ ...labour, promoFils: 1000 }, { ...part, promoFils: 0 }], 500, false);
    expect(t).toEqual({ netFils: 14000, vatFils: 700, grossFils: 14700 });
  });
  it("fixed code capped", () => {
    const lines = [{ ...labour, unitPriceFils: 7000 }, { ...part, unitPriceFils: 5000 }];
    const r = promoShares(lines, { kind: "amount", value: 50000, appliesTo: "all" }, false);
    expect(r.discountFils).toBe(12000);
    expect(r.shares.reduce((a, b) => a + b, 0)).toBe(12000);
    lines.forEach((l, i) => expect(lineTotals({ ...l, promoFils: r.shares[i] }, 500, false).netFils).toBeGreaterThanOrEqual(0));
  });
  it("spread with remainder", () => {
    const three = [1, 2, 3].map(() => ({ ...part, unitPriceFils: 3333 }));
    const r = promoShares(three, { kind: "percent", value: 10, appliesTo: "all" }, false);
    expect(r.discountFils).toBe(1000);
    expect(r.shares).toEqual([333, 333, 334]);
  });
  it("Fleet Fix supplied lines never take a promo", () => {
    const r = promoShares([labour, { ...part, suppliedBy: "fleetfix" }], { kind: "percent", value: 10, appliesTo: "all" }, false);
    expect(r.shares).toEqual([1000, 0]);
  });
  it("promo with prices including VAT", () => {
    const typed = { ...labour, unitPriceFils: 10500 };
    const r = promoShares([typed], { kind: "percent", value: 10, appliesTo: "all" }, true);
    expect(r.shares).toEqual([1050]);
    expect(lineTotals({ ...typed, promoFils: 1050 }, 500, true)).toEqual({ netFils: 9000, vatFils: 450, grossFils: 9450 });
  });
  it("problems", () => {
    const code = promoSchema.parse({ code: "summer24", kind: "percent", value: 10, appliesTo: "all", validFrom: "2026-06-01", validTo: "2026-08-31", minNetFils: 20000, maxUses: 2, oncePerCustomer: true, active: true });
    expect(code.code).toBe("SUMMER24");
    const ok = { today: "2026-07-01", baseFils: 30000, uses: 0, usedByCustomer: false };
    expect(promoProblem(code, ok)).toBeNull();
    expect(promoProblem(code, { ...ok, today: "2026-09-01" })).toMatch(/Ended on/);
    expect(promoProblem(code, { ...ok, today: "2026-05-01" })).toMatch(/Starts on/);
    expect(promoProblem(code, { ...ok, baseFils: 10000 })).toMatch(/at least/);
    expect(promoProblem(code, { ...ok, uses: 2 })).toMatch(/Used up/);
    expect(promoProblem(code, { ...ok, usedByCustomer: true })).toMatch(/Already used by this customer/);
    expect(promoProblem({ ...code, active: false }, ok)).toMatch(/Not active/);
    expect(() => promoSchema.parse({ code: "x", kind: "percent", value: 120, appliesTo: "all", oncePerCustomer: false, active: true })).toThrow();
  });
});
