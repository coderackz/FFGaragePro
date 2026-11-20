/** Money is always integer fils (1 AED = 100 fils). */

export const VAT_RATE_BP = 500; // 5% in basis points

export interface LineAmounts {
  qty: number;
  unitPriceFils: number;
  discountPct: number;
  /** This line's share of a promo code's discount: off the net (prices without VAT) or off the gross (prices with VAT). */
  promoFils?: number;
}

export interface Totals {
  netFils: number;
  vatFils: number;
  grossFils: number;
}

/** Rounds half away from zero, after trimming float noise (e.g. 1100.0000000000002). */
export function roundFils(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const clean = Number(x.toFixed(6));
  return Math.sign(clean) * Math.round(Math.abs(clean));
}

function safe(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/**
 * A line's amounts. `includeVat`: the typed price already includes VAT, so the line's total is what was typed and
 * VAT is taken out of it (net = total × 100 / 105), and the printed total equals what was typed.
 */
export function lineTotals(line: LineAmounts, vatRateBp: number = VAT_RATE_BP, includeVat = false): Totals {
  const qty = Math.max(0, safe(line.qty));
  const price = safe(line.unitPriceFils);
  const discount = Math.min(100, Math.max(0, safe(line.discountPct)));
  const promo = Math.max(0, safe(line.promoFils ?? 0));
  if (includeVat) {
    const grossFils = Math.max((roundFils(qty * price * (1 - discount / 100)) || 0) - promo, 0);
    const netFils = roundFils((grossFils * 10000) / (10000 + vatRateBp)) || 0;
    return { netFils, vatFils: grossFils - netFils, grossFils };
  }
  const netFils = Math.max((roundFils(qty * price * (1 - discount / 100)) || 0) - promo, 0);
  const vatFils = roundFils((netFils * vatRateBp) / 10000) || 0;
  return { netFils, vatFils, grossFils: netFils + vatFils };
}

export function docTotals(lines: LineAmounts[], vatRateBp: number = VAT_RATE_BP, includeVat = false): Totals {
  return lines.reduce<Totals>(
    (sum, line) => {
      const t = lineTotals(line, vatRateBp, includeVat);
      return { netFils: sum.netFils + t.netFils, vatFils: sum.vatFils + t.vatFils, grossFils: sum.grossFils + t.grossFils };
    },
    { netFils: 0, vatFils: 0, grossFils: 0 },
  );
}

const aed = new Intl.NumberFormat("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatAED(fils: number): string {
  const text = `AED ${aed.format(Math.abs(fils) / 100)}`;
  return fils < 0 ? `-${text}` : text;
}

/** Formats fils as a plain number for input fields ("1234.50"). */
export function filsToInput(fils: number): string {
  return (fils / 100).toFixed(2);
}

/** Parses "AED 1,234.5" / "1234.50" into fils; null when it isn't a number. */
export function parseAED(text: string): number | null {
  const cleaned = text.replace(/aed/i, "").replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned) && !/^-?\.\d+$/.test(cleaned)) return null;
  return roundFils(Number(cleaned) * 100);
}

/** Weighted average cost after receiving `qtyIn` at `costFils`. With nothing (or less) on hand, the new cost wins. */
export function averageCost(onHand: number, avgFils: number, qtyIn: number, costFils: number): number {
  if (onHand <= 0) return costFils;
  return roundFils((onHand * avgFils + qtyIn * costFils) / (onHand + qtyIn));
}

/**
 * A catalogue price (parts are priced before VAT) as the price to type on a document's line: on a document whose
 * prices include VAT, the VAT is added so the customer is charged the same.
 */
export function catalogueLinePrice(sellPriceFils: number, vatRateBp: number = VAT_RATE_BP, includeVat = false): number {
  return includeVat ? roundFils((sellPriceFils * (10000 + vatRateBp)) / 10000) : sellPriceFils;
}
