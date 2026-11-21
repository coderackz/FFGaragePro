import { formatNumberOf, prefixOf, SYSTEM_ACCOUNTS, type SystemKey, type VatTag } from "@ffgp/shared";
import { newId, now, type Db } from "../db";
import { badRequest } from "../errors";
import { takeNumber } from "../numbering";
import { getSettings } from "../settings";

export type SourceType =
  | "invoice" | "credit_note" | "receipt" | "goods_receipt" | "stock" | "cogs" | "customer_opening" | "opening" | "manual" | "reversal"
  | "year_close" | "revaluation" | "supplier_bill" | "bill_cancel" | "supplier_payment" | "supplier_opening" | "expense" | "transfer"
  | "supplier_return" | "core_writeoff"
  | "cheque_deposit" | "cheque_clear" | "vat_return" | "payroll_run" | "wps_paid" | "bonus_paid" | "staff_advance" | "payroll_opening" | "final_settlement" | "settlement_paid" | "depreciation" | "asset_disposal";

export interface PostLine {
  accountId: string;
  debitFils: number;
  creditFils: number;
  customerId?: string | null;
  supplierId?: string | null;
  /** Work in progress lines: the job card the parts are on. */
  documentId?: string | null;
  memo?: string | null;
  /** The VAT return box this line belongs to (tagged manual journals and their reversals). */
  vatBox?: VatTag | null;
  /** The fixed asset a depreciation or disposal line is for. */
  assetId?: string | null;
}

export interface PostInput {
  /** YYYY-MM-DD (Dubai). */
  date: string;
  narration: string;
  sourceType: SourceType;
  sourceId?: string | null;
  /** Unique per event: posting the same key again does nothing. */
  postKey?: string | null;
  reversesId?: string | null;
  lines: PostLine[];
  userId: string | null;
  /** Opening balances and year-end closing are dated where they belong, even inside a locked period. */
  allowLocked?: boolean;
  /** The lock date, when the caller already has it (saves reading the settings for every entry). */
  lockDate?: string | null;
}

/** The id of a system account (receivables, inventory…): fixed ids, the same in every garage. */
export const accountId = (_db: Db, key: SystemKey): string => SYSTEM_ACCOUNTS[key].id;

const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
export const formatDay = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));
export const addDays = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Posts one journal entry, or nothing if `postKey` was posted before (returns null). Debits must equal credits (else
 * 400 and nothing is written); zero lines are dropped. An entry dated on or before the lock date is posted on the day
 * after it, keeping its own date as `original_date` and saying so in the narration. Numbered JV-… from this
 * garage's series. Posted entries are never changed.
 */
export function postEntry(db: Db, e: PostInput): string | null {
  const lines = e.lines.filter((l) => l.debitFils !== 0 || l.creditFils !== 0);
  for (const l of lines) {
    if (l.debitFils < 0 || l.creditFils < 0 || !Number.isInteger(l.debitFils) || !Number.isInteger(l.creditFils)) {
      throw badRequest("Amounts must be whole fils, not negative");
    }
  }
  const debits = lines.reduce((s, l) => s + l.debitFils, 0);
  const credits = lines.reduce((s, l) => s + l.creditFils, 0);
  if (debits !== credits) throw badRequest("Debits and credits must be equal");
  if (!lines.length) return null;
  return db.tx(() => {
    if (e.postKey && db.get("SELECT 1 FROM journal_entries WHERE post_key = ?", [e.postKey])) return null;
    const settings = getSettings(db);
    const lockDate = e.lockDate !== undefined ? e.lockDate : settings.books.lockDate;
    const late = !e.allowLocked && lockDate !== null && e.date <= lockDate;
    const date = late ? addDays(lockDate, 1) : e.date;
    const narration = late ? `${e.narration} (dated ${formatDay(e.date)}; books locked)` : e.narration;
    const { series, seq } = takeNumber(db, "journal", null, undefined);
    const number = formatNumberOf("journal", seq, series, prefixOf(settings, "journal"));
    const id = newId();
    db.run(
      `INSERT INTO journal_entries (id, series, seq, number, date, narration, source_type, source_id, post_key, reverses_id, original_date, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, series, seq, number, date, narration, e.sourceType, e.sourceId ?? null, e.postKey ?? null, e.reversesId ?? null, late ? e.date : null, e.userId, now()],
    );
    lines.forEach((l, i) => {
      db.run(
        `INSERT INTO journal_lines (id, entry_id, position, account_id, debit_fils, credit_fils, customer_id, supplier_id, document_id, memo, vat_box, asset_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), id, i, l.accountId, l.debitFils, l.creditFils, l.customerId ?? null, l.supplierId ?? null, l.documentId ?? null, l.memo ?? null, l.vatBox ?? null, l.assetId ?? null],
      );
    });
    return id;
  });
}
