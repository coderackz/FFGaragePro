import { bankMappingSchema, BILL_VAT, dubaiDate, lineVat, parseStatement, type BankMapping } from "@ffgp/shared";
import { z } from "zod";
import { postPending } from "../books/pending";
import { parseCsv } from "../csv";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import type { NumberSource } from "../numbering";
import { createExpense, moneyAccount } from "./money";

const DAY = 86_400_000;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;

/** How this bank's CSV is laid out (set once per account). */
export function setMapping(db: Db, accountId: string, input: unknown): BankMapping {
  moneyAccount(db, accountId);
  const m = bankMappingSchema.parse(input);
  db.run("UPDATE accounts SET bank_mapping = ?, updated_at = ? WHERE id = ?", [JSON.stringify(m), now(), accountId]);
  return m;
}

export function getMapping(db: Db, accountId: string): BankMapping | null {
  const row = db.get<{ bank_mapping: string | null }>("SELECT bank_mapping FROM accounts WHERE id = ?", [accountId]);
  return row?.bank_mapping ? (JSON.parse(row.bank_mapping) as BankMapping) : null;
}

const importInput = z.object({ fileName: z.string().trim().min(1).max(200), csv: z.string().min(1).max(5_000_000) });

/** Imports a bank statement (CSV, by the account's mapping). A line already imported is skipped. */
export function importStatement(db: Db, accountId: string, input: unknown, userId: string): { added: number; skipped: number } {
  moneyAccount(db, accountId);
  const { fileName, csv } = importInput.parse(input);
  const mapping = getMapping(db, accountId);
  if (!mapping) throw badRequest("Set up this bank's columns first");
  let lines;
  try {
    lines = parseStatement(parseCsv(csv), mapping);
  } catch (error) {
    throw badRequest((error as Error).message);
  }
  const seen = new Map<string, number>();
  return db.tx(() => {
    const importId = newId();
    const t = now();
    let added = 0;
    let skipped = 0;
    db.run("INSERT INTO bank_imports (id, account_id, file_name, added, skipped, created_by, created_at) VALUES (?, ?, ?, 0, 0, ?, ?)", [importId, accountId, fileName, userId, t]);
    for (const l of lines) {
      // Identical lines in one file (two equal charges on a day) are told apart by their order.
      const base = `${l.date}|${l.amountFils}|${l.description}|${l.reference ?? ""}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const changed = db.run(
        `INSERT OR IGNORE INTO bank_lines (id, account_id, import_id, date, description, amount_fils, reference, line_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), accountId, importId, l.date, l.description, l.amountFils, l.reference, `${base}#${n}`, t, t],
      );
      if (changed) added++;
      else skipped++;
    }
    db.run("UPDATE bank_imports SET added = ?, skipped = ? WHERE id = ?", [added, skipped, importId]);
    return { added, skipped };
  });
}

interface BookLine { journalLineId: string; entryId: string; number: string; date: string; narration: string; amountFils: number }

/**
 * Where reconciliation stands up to `to`: the statement lines (unmatched first), the book's lines on this account
 * that no statement line matches, suggested pairs (same amount, within 5 days, nearest first; each book line once),
 * and the book and statement balances.
 */
export function reconcileView(db: Db, accountId: string, to = dubaiDate(new Date().toISOString())) {
  moneyAccount(db, accountId);
  const lines = db.all<{ id: string; date: string; description: string; amount_fils: number; reference: string | null; matched_line_id: string | null }>(
    `SELECT id, date, description, amount_fils, reference, matched_line_id FROM bank_lines WHERE account_id = ? AND date <= ?
     ORDER BY matched_line_id IS NOT NULL, date, rowid`,
    [accountId, to],
  ).map((l) => ({ id: l.id, date: l.date, description: l.description, amountFils: l.amount_fils, reference: l.reference, matchedLineId: l.matched_line_id }));
  const unmatchedBookLines = db.all<{ id: string; entry_id: string; number: string; date: string; narration: string; amount: number }>(
    `SELECT l.id, l.entry_id, e.number, e.date, e.narration, l.debit_fils - l.credit_fils AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? AND e.date <= ? AND NOT EXISTS (SELECT 1 FROM bank_lines b WHERE b.matched_line_id = l.id) ORDER BY e.date, e.seq`,
    [accountId, to],
  ).map((l): BookLine => ({ journalLineId: l.id, entryId: l.entry_id, number: l.number, date: l.date, narration: l.narration, amountFils: l.amount }));
  const used = new Set<string>();
  const suggestions: { bankLineId: string; journalLineId: string }[] = [];
  for (const b of lines.filter((l) => !l.matchedLineId)) {
    const best = unmatchedBookLines
      .filter((j) => !used.has(j.journalLineId) && j.amountFils === b.amountFils && daysApart(j.date, b.date) <= 5)
      .sort((x, y) => daysApart(x.date, b.date) - daysApart(y.date, b.date))[0];
    if (best) {
      used.add(best.journalLineId);
      suggestions.push({ bankLineId: b.id, journalLineId: best.journalLineId });
    }
  }
  const bookBalanceFils = db.get<{ b: number | null }>(
    "SELECT SUM(l.debit_fils - l.credit_fils) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.date <= ?",
    [accountId, to],
  )!.b ?? 0;
  const statementBalanceFils = lines.reduce((s, l) => s + l.amountFils, 0);
  return { to, mapping: getMapping(db, accountId), lines, suggestions, unmatchedBookLines, bookBalanceFils, statementBalanceFils };
}

const bankLine = (db: Db, id: string) => {
  const l = db.get<{ id: string; account_id: string; date: string; description: string; amount_fils: number; matched_line_id: string | null }>(
    "SELECT id, account_id, date, description, amount_fils, matched_line_id FROM bank_lines WHERE id = ?", [id]);
  if (!l) throw notFound("Statement line not found");
  return l;
};

/** Pairs a statement line with the book's line for the same money. */
export function matchLine(db: Db, bankLineId: string, journalLineId: string): void {
  db.tx(() => {
    const b = bankLine(db, bankLineId);
    if (b.matched_line_id) throw conflict("That statement line is already matched");
    const j = db.get<{ account_id: string; amount: number }>("SELECT account_id, debit_fils - credit_fils AS amount FROM journal_lines WHERE id = ?", [journalLineId]);
    if (!j || j.account_id !== b.account_id) throw badRequest("That entry isn't on this account");
    if (j.amount !== b.amount_fils) throw badRequest("The amounts are different");
    if (db.get("SELECT 1 FROM bank_lines WHERE matched_line_id = ?", [journalLineId])) throw conflict("That entry is already matched to another statement line");
    db.run("UPDATE bank_lines SET matched_line_id = ?, matched_at = ?, updated_at = ? WHERE id = ?", [journalLineId, now(), now(), bankLineId]);
  });
}

export function unmatchLine(db: Db, bankLineId: string): void {
  bankLine(db, bankLineId);
  db.run("UPDATE bank_lines SET matched_line_id = NULL, matched_at = NULL, updated_at = ? WHERE id = ?", [now(), bankLineId]);
}

const chargeInput = z.object({ accountId: z.string().min(1), vat: z.enum(BILL_VAT).default("none"), description: z.string().trim().min(1).max(200) });

/** The net that, with its VAT, comes to exactly `gross` (VAT rounded per line as on bills). */
function netForGross(gross: number, vat: "standard" | "none"): number {
  if (vat === "none") return gross;
  const guess = Math.round(gross / 1.05);
  for (const n of [guess, guess - 1, guess + 1]) if (n + lineVat({ netFils: n, vat }) === gross) return n;
  return guess;
}

/**
 * A statement line that's money out with no entry yet (bank charges, fees): entered as an expense paid from this
 * account and matched to it.
 */
export async function expenseFromLine(db: Db, bankLineId: string, input: unknown, userId: string, posts: boolean, numbers?: NumberSource) {
  const b = bankLine(db, bankLineId);
  if (b.matched_line_id) throw conflict("That statement line is already matched");
  if (b.amount_fils >= 0) throw badRequest("Only money out can be entered as an expense");
  const x = chargeInput.parse(input);
  const expense = await createExpense(db, {
    date: b.date, accountId: x.accountId, description: x.description, netFils: netForGross(-b.amount_fils, x.vat), vat: x.vat, paidFromAccountId: b.account_id,
    reference: b.description.slice(0, 120),
  }, userId, numbers);
  if (!posts) return { expense, matched: false };
  postPending(db);
  const line = db.get<{ id: string }>(
    "SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.post_key = ? AND l.account_id = ?",
    [`expense:${expense.id}`, b.account_id],
  );
  if (line && expense.grossFils === -b.amount_fils) matchLine(db, b.id, line.id);
  return { expense, matched: !!line };
}
