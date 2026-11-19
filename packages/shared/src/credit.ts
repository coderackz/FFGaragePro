/** Credit customers: what an invoice still owes, allocating a payment, due dates and aging. Pure, integer fils. */

export interface InvoiceMoney {
  grossFils: number;
  creditedFils: number;
  paidFils: number;
}

/** What an issued invoice still owes: its total less credit notes against it and payments allocated to it. */
export function owedFils(d: InvoiceMoney): number {
  return d.grossFils - d.creditedFils - d.paidFils;
}

/** An issued invoice's status, from its money. */
export function invoiceStatus(d: InvoiceMoney): "issued" | "part_paid" | "paid" {
  if (d.grossFils > 0 && owedFils(d) <= 0) return "paid";
  return d.paidFils + d.creditedFils > 0 ? "part_paid" : "issued";
}

export interface OpenInvoice {
  id: string;
  dueDate: string;
  issuedAt: string;
  owedFils: number;
}

/** Splits a payment across invoices, the one due first first, never paying any more than it owes. */
export function allocateOldestFirst(amountFils: number, invoices: OpenInvoice[]): { documentId: string; amountFils: number }[] {
  const sorted = [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id));
  const out: { documentId: string; amountFils: number }[] = [];
  let left = amountFils;
  for (const inv of sorted) {
    if (left <= 0) break;
    const take = Math.min(left, inv.owedFils);
    if (take <= 0) continue;
    out.push({ documentId: inv.id, amountFils: take });
    left -= take;
  }
  return out;
}

const DUBAI_OFFSET_MS = 4 * 3_600_000;
const DAY_MS = 86_400_000;

/** The calendar date in Dubai (UTC+4, no daylight saving) of an ISO time, as YYYY-MM-DD. */
export function dubaiDate(iso: string): string {
  return new Date(Date.parse(iso) + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus `days`. */
export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** When an invoice is due: the Dubai date it was issued plus the terms; cash customers pay on the day. */
export function dueDate(issuedAt: string, termsDays: number, creditAllowed: boolean): string {
  return addDays(dubaiDate(issuedAt), creditAllowed ? termsDays : 0);
}

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** How overdue something due on `dueDate` is on `asOf` (both YYYY-MM-DD). */
export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const days = Math.round((Date.parse(`${asOf}T00:00:00.000Z`) - Date.parse(`${dueDate}T00:00:00.000Z`)) / DAY_MS);
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}
