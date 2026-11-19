import type { AccountType } from "@ffgp/shared";

export interface Account { id: string; code: string; name: string; type: AccountType; systemKey: string | null; active: boolean; moneyKind?: string | null }
export interface EntryLine {
  id: string; accountId: string; code: string; name: string; debitFils: number; creditFils: number;
  customerId: string | null; supplierId: string | null; documentId: string | null; memo: string | null;
}
export interface Entry {
  id: string; number: string; date: string; narration: string; sourceType: string; sourceId: string | null; sourceNumber: string | null;
  reversesId: string | null; reversedBy: string | null; originalDate: string | null; createdBy: string | null; createdAt: string;
  lines: EntryLine[];
}
export type EntrySummary = Omit<Entry, "lines"> & { totalFils: number };
export interface DraftLine { accountId: string; debitFils: number; creditFils: number; customerId?: string | null; supplierId?: string | null; documentId?: string | null; memo?: string | null }
export interface Draft { id: string; kind: "manual" | "opening"; date: string; narration: string; lines: DraftLine[]; updatedAt: string }

export const SOURCE_LABELS: Record<string, string> = {
  invoice: "Invoice", credit_note: "Credit note", receipt: "Receipt", goods_receipt: "Parts received", stock: "Stock", cogs: "Parts cost",
  customer_opening: "Customer opening balance", opening: "Opening balances", manual: "Journal", reversal: "Reversal", year_close: "Year end",
  revaluation: "Stock revaluation",
};

/** 1,234.50 (fils → AED, no currency sign: report columns are all AED). */
export const money = (fils: number) => (fils / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Debit/credit columns show nothing for zero. */
export const amount = (fils: number) => (fils ? money(fils) : "");
/** "12.50" typed in a field → fils (blank → 0). */
export const toFils = (text: string) => {
  const n = Number.parseFloat(text.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
