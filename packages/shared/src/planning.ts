// Inventory v2, Part 3: stock planning (min/max from usage) and the stock reports.

/**
 * Suggested levels from the last 90 days' usage: the minimum covers the lead time plus two weeks, the maximum a
 * further 30 days. Whole units, rounded up.
 */
export function suggestLevels(usage90: number, leadDays: number): { min: number; max: number } {
  const daily = Math.max(0, usage90) / 90;
  const up = (x: number) => Math.max(0, Math.ceil(x - 1e-9));
  const min = up(daily * (Math.max(0, leadDays) + 14));
  return { min, max: min + up(daily * 30) };
}

export type AbcClass = "A" | "B" | "C";

/** ABC by usage value: the parts making up the first 80 % of the value are A, the next 15 % B, the rest (and unused) C. */
export function abcClasses(items: { id: string; value: number }[]): Map<string, AbcClass> {
  const out = new Map<string, AbcClass>();
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  let before = 0;
  for (const i of [...items].sort((a, b) => b.value - a.value)) {
    const share = total > 0 ? before / total : 1;
    out.set(i.id, i.value <= 0 ? "C" : share < 0.8 ? "A" : share < 0.95 ? "B" : "C");
    before += Math.max(0, i.value);
  }
  return out;
}

export const STOCK_AGE_BUCKETS = ["0–90", "91–180", "181–365", "Over 365"] as const;
export type StockAgeBucket = (typeof STOCK_AGE_BUCKETS)[number];
/** Days since a part was last received → its aging bucket. */
export const stockAgeBucket = (days: number): StockAgeBucket => (days <= 90 ? "0–90" : days <= 180 ? "91–180" : days <= 365 ? "181–365" : "Over 365");
