import { addDays } from "./credit";
import { roundFils } from "./money";
import type { DocType } from "./rules";

/** A part line is new or used. A used part is bought for its job and never stocked. */
export const LINE_CONDITIONS = ["new", "used"] as const;
export type LineCondition = (typeof LINE_CONDITIONS)[number];

/** The last day of a used part's warranty (the seller's, passed on to the customer); null = no warranty. */
export const warrantyUntil = (purchasedOn: string, days: number | null): string | null => (days === null ? null : addDays(purchasedOn, days));

/** "ending" on the last day and the day before. Dates are Dubai's, YYYY-MM-DD. */
export function warrantyState(until: string | null, today: string): "none" | "ok" | "ending" | "ended" {
  if (until === null) return "none";
  if (today > until) return "ended";
  return today >= addDays(until, -1) ? "ending" : "ok";
}

const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** A YYYY-MM-DD date as "3 Dec 2026", the same in every time zone. */
export const formatDay = (ymd: string): string => dayFmt.format(new Date(`${ymd}T00:00:00.000Z`));

/** What prints under a used part: its warranty only on an invoice, judged on `onDate` (the issue date). */
export function usedPartText(
  l: { condition: LineCondition; purchasedOn: string | null; warrantyDays: number | null }, docType: DocType, onDate: string,
): string | null {
  if (l.condition !== "used") return null;
  if (docType !== "invoice" || l.purchasedOn === null) return "Used part";
  const until = warrantyUntil(l.purchasedOn, l.warrantyDays);
  if (until === null) return "Used part, no warranty";
  if (warrantyState(until, onDate) === "ended") return "Used part, no warranty remaining";
  return `Used part, warranty until ${formatDay(until)}`;
}

/** The VAT a purchase starts at: none from a supplier without a TRN (Fleet Fix is always VAT-registered). */
export const defaultPurchaseVat = (netFils: number, supplier: { trn: string | null; isFleetfix: boolean }, rateBp: number): number =>
  supplier.isFleetfix || supplier.trn ? roundFils((netFils * rateBp) / 10000) : 0;
