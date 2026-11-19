import { dubaiDate, SYSTEM_ACCOUNTS as A } from "@ffgp/shared";
import { audit } from "../audit";
import type { Db } from "../db";
import { badRequest, conflict } from "../errors";
import { getSettings } from "../settings";
import { NOT_HERE, getEntry, type EntryOut } from "./journals";
import { addDays, formatDay, postEntry } from "./post";

/**
 * Closes a fiscal year once it has ended: every income, cost of sales and expense balance up to the year end (earlier
 * unclosed years too) goes to retained earnings, dated the year end, and the books lock up to it. Closing the same
 * year again (after the owner reopened it and something was posted) closes only what changed.
 */
export function closeYear(db: Db, yearEnd: string, userId: string, posts: boolean): EntryOut | null {
  if (!posts) throw conflict(NOT_HERE);
  const books = getSettings(db).books;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yearEnd) || Number.isNaN(Date.parse(`${yearEnd}T00:00:00Z`))) throw badRequest("Use a date like 2025-12-31");
  const next = addDays(yearEnd, 1);
  if (Number(next.slice(5, 7)) !== books.fiscalYearStartMonth || next.slice(8) !== "01") {
    throw badRequest(`${formatDay(yearEnd)} isn't the last day of a fiscal year`);
  }
  if (yearEnd >= dubaiDate(new Date().toISOString())) throw badRequest("A year can be closed once it has ended");
  const balances = db.all<{ account_id: string; b: number }>(
    `SELECT l.account_id, SUM(l.debit_fils - l.credit_fils) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.type IN ('income', 'cost_of_sales', 'expense') AND e.date <= ? GROUP BY l.account_id HAVING b <> 0`,
    [yearEnd],
  );
  const closings = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal_entries WHERE post_key LIKE ?", [`year_close:${yearEnd}%`])!.n;
  if (!balances.length && closings) throw conflict("That year is already closed");
  const net = balances.reduce((s, r) => s + r.b, 0);
  return db.tx(() => {
    const id = balances.length
      ? postEntry(db, {
          date: yearEnd, narration: `Year end ${formatDay(yearEnd)}: profit to retained earnings`, sourceType: "year_close", postKey: `year_close:${yearEnd}:${closings + 1}`,
          userId, allowLocked: true,
          lines: [
            ...balances.map((r) => ({ accountId: r.account_id, debitFils: r.b < 0 ? -r.b : 0, creditFils: r.b > 0 ? r.b : 0 })),
            { accountId: A.retained_earnings.id, debitFils: net > 0 ? net : 0, creditFils: net < 0 ? -net : 0 },
          ],
        })
      : null;
    if (!books.lockDate || books.lockDate < yearEnd) {
      db.run("INSERT INTO settings (key, value) VALUES ('books.lockDate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(yearEnd)]);
      audit(db, { action: "settings.change", entity: "settings", entityId: "books", before: { lockDate: books.lockDate }, after: { lockDate: yearEnd }, userId });
    }
    return id ? getEntry(db, id)! : null;
  });
}
