import { chequeClearSchema, chequeDepositSchema, expenseSchema, formatNumberOf, lineVat, prefixOf, transferSchema } from "@ffgp/shared";
import { checkNotLocked } from "../books/journals";
import { formatDay } from "../books/post";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { reserveNumber, takeNumber, type NumberSource } from "../numbering";
import { getSettings } from "../settings";
import { NOT_ON_BILLS } from "./bills";

/** A bank, cash, card or cheques account in use (what money is paid from, moved between and reconciled). */
export function moneyAccount(db: Db, id: string, label = "That"): { id: string; name: string; money_kind: string } {
  const a = db.get<{ id: string; name: string; money_kind: string | null; active: number }>("SELECT id, name, money_kind, active FROM accounts WHERE id = ?", [id]);
  if (!a?.money_kind || !a.active) throw badRequest(`${label} isn't a bank or cash account in use`);
  return a as { id: string; name: string; money_kind: string };
}

/** Bank, cash, card and cheques accounts with their balance in the books. */
export const moneyAccounts = (db: Db) =>
  db.all<{ id: string; code: string; name: string; money_kind: string; balance: number }>(
    `SELECT a.id, a.code, a.name, a.money_kind, COALESCE((SELECT SUM(debit_fils - credit_fils) FROM journal_lines WHERE account_id = a.id), 0) AS balance
     FROM accounts a WHERE a.money_kind IS NOT NULL AND a.active = 1 ORDER BY a.code`,
  ).map((a) => ({ id: a.id, code: a.code, name: a.name, moneyKind: a.money_kind, balanceFils: a.balance }));

// ── Expenses paid on the spot ──────────────────────────────────────────────────────────────────────────────────────
interface ExpenseRow {
  id: string; number: string; date: string; account_id: string; account_name: string; description: string; net_fils: number; vat: string; vat_fils: number;
  gross_fils: number; paid_from_account_id: string; paid_from_name: string; payee: string | null; reference: string | null; has_photo: number; created_at: string;
}
const EXPENSE_SELECT = `SELECT e.id, e.number, e.date, e.account_id, a.name AS account_name, e.description, e.net_fils, e.vat, e.vat_fils, e.gross_fils,
  e.paid_from_account_id, f.name AS paid_from_name, e.payee, e.reference, e.photo IS NOT NULL AS has_photo, e.created_at
  FROM expenses e JOIN accounts a ON a.id = e.account_id JOIN accounts f ON f.id = e.paid_from_account_id`;
const expenseOut = (e: ExpenseRow) => ({
  id: e.id, number: e.number, date: e.date, accountId: e.account_id, accountName: e.account_name, description: e.description, netFils: e.net_fils, vat: e.vat,
  vatFils: e.vat_fils, grossFils: e.gross_fils, paidFromAccountId: e.paid_from_account_id, paidFromName: e.paid_from_name, payee: e.payee, reference: e.reference,
  hasPhoto: !!e.has_photo, createdAt: e.created_at,
});

export const listExpenses = (db: Db, q: { from?: string; to?: string }) =>
  db.all<ExpenseRow>(`${EXPENSE_SELECT} WHERE (:from IS NULL OR e.date >= :from) AND (:to IS NULL OR e.date <= :to) ORDER BY e.date DESC, e.seq DESC LIMIT 500`,
    { from: q.from || null, to: q.to || null }).map(expenseOut);

export function expensePhoto(db: Db, id: string): string | null {
  const e = db.get<{ photo: string | null }>("SELECT photo FROM expenses WHERE id = ?", [id]);
  if (!e) throw notFound("Expense not found");
  return e.photo;
}

/** An expense paid there and then (fuel, petty cash), with an optional photo of the receipt. */
export async function createExpense(db: Db, input: unknown, userId: string, numbers?: NumberSource) {
  const x = expenseSchema.parse(input);
  const a = db.get<{ active: number; type: string }>("SELECT active, type FROM accounts WHERE id = ?", [x.accountId]);
  if (!a?.active) throw badRequest("Choose an account in use");
  if (NOT_ON_BILLS.has(x.accountId)) throw badRequest("That account is kept by the app; choose an expense account");
  moneyAccount(db, x.paidFromAccountId, "Paid from");
  checkNotLocked(db, x.date);
  const vatFils = lineVat(x);
  const reserved = await reserveNumber(numbers, "expense");
  const id = db.tx(() => {
    const { series, seq } = takeNumber(db, "expense", reserved, numbers);
    const number = formatNumberOf("expense", seq, series, prefixOf(getSettings(db), "expense"));
    const expenseId = newId();
    db.run(
      `INSERT INTO expenses (id, series, seq, number, date, account_id, description, net_fils, vat, vat_fils, gross_fils, paid_from_account_id, payee, reference, photo,
         created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [expenseId, series, seq, number, x.date, x.accountId, x.description, x.netFils, x.vat, vatFils, x.netFils + vatFils, x.paidFromAccountId, x.payee, x.reference,
        x.photo, userId, now()],
    );
    return expenseId;
  });
  return expenseOut(db.get<ExpenseRow>(`${EXPENSE_SELECT} WHERE e.id = ?`, [id])!);
}

// ── Transfers ──────────────────────────────────────────────────────────────────────────────────────────────────────
export function createTransfer(db: Db, input: unknown, userId: string) {
  const t = transferSchema.parse(input);
  moneyAccount(db, t.fromAccountId, "From");
  moneyAccount(db, t.toAccountId, "To");
  checkNotLocked(db, t.date);
  const id = newId();
  db.run("INSERT INTO money_transfers (id, date, from_account_id, to_account_id, amount_fils, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id, t.date, t.fromAccountId, t.toAccountId, t.amountFils, t.reference, userId, now(),
  ]);
  return { id, ...t };
}

// ── Cheques ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Customers' cheques received and not yet deposited (post-dated ones show their date). */
export const chequesInHand = (db: Db) =>
  db.all<{ id: string; number: string; customer: string; amount_fils: number; cheque_date: string | null; reference: string | null; received_at: string }>(
    `SELECT r.id, r.number, c.name AS customer, r.amount_fils, r.cheque_date, r.reference, r.received_at FROM receipts r JOIN customers c ON c.id = r.customer_id
     WHERE r.method = 'cheque' AND r.amount_fils > 0 AND NOT EXISTS (SELECT 1 FROM cheque_deposits d WHERE d.receipt_id = r.id) ORDER BY COALESCE(r.cheque_date, r.received_at)`,
  ).map((r) => ({ receiptId: r.id, number: r.number, customerName: r.customer, amountFils: r.amount_fils, chequeDate: r.cheque_date, reference: r.reference, receivedAt: r.received_at }));

export function depositCheques(db: Db, input: unknown, userId: string) {
  const d = chequeDepositSchema.parse(input);
  const bank = moneyAccount(db, d.bankAccountId, "Deposit to");
  if (bank.money_kind !== "bank") throw badRequest("Deposit cheques into a bank account");
  checkNotLocked(db, d.date);
  return db.tx(() =>
    d.receiptIds.map((receiptId) => {
      const r = db.get<{ number: string; method: string; amount_fils: number; cheque_date: string | null }>("SELECT number, method, amount_fils, cheque_date FROM receipts WHERE id = ?", [receiptId]);
      if (!r || r.method !== "cheque" || r.amount_fils <= 0) throw badRequest("That isn't a cheque received");
      if (db.get("SELECT 1 FROM cheque_deposits WHERE receipt_id = ?", [receiptId])) throw conflict(`${r.number} is already deposited`);
      if (r.cheque_date && r.cheque_date > d.date) throw badRequest(`${r.number} is not due until ${formatDay(r.cheque_date)}`);
      const id = newId();
      db.run("INSERT INTO cheque_deposits (id, receipt_id, bank_account_id, date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, receiptId, d.bankAccountId, d.date, userId, now()]);
      return { id, receiptId, date: d.date };
    }),
  );
}

/** Our cheques to suppliers not yet cleared by the bank. */
export const chequesIssued = (db: Db) =>
  db.all<{ id: string; number: string; supplier: string; amount_fils: number; cheque_no: string | null; cheque_date: string | null; paid_at: string }>(
    `SELECT p.id, p.number, s.name AS supplier, p.amount_fils, p.cheque_no, p.cheque_date, p.paid_at FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.method = 'cheque' AND NOT EXISTS (SELECT 1 FROM cheque_clearances c WHERE c.payment_id = p.id) ORDER BY p.paid_at`,
  ).map((p) => ({ paymentId: p.id, number: p.number, supplierName: p.supplier, amountFils: p.amount_fils, chequeNo: p.cheque_no, chequeDate: p.cheque_date, paidAt: p.paid_at }));

export function clearCheques(db: Db, input: unknown, userId: string) {
  const c = chequeClearSchema.parse(input);
  checkNotLocked(db, c.date);
  return db.tx(() =>
    c.paymentIds.map((paymentId) => {
      const p = db.get<{ number: string; method: string; paid_at: string }>("SELECT number, method, paid_at FROM supplier_payments WHERE id = ?", [paymentId]);
      if (!p || p.method !== "cheque") throw badRequest("That isn't a cheque we issued");
      if (db.get("SELECT 1 FROM cheque_clearances WHERE payment_id = ?", [paymentId])) throw conflict(`${p.number} is already cleared`);
      if (c.date < p.paid_at) throw badRequest(`${p.number} was written on ${formatDay(p.paid_at)}: it can't clear before that`);
      const id = newId();
      db.run("INSERT INTO cheque_clearances (id, payment_id, date, created_by, created_at) VALUES (?, ?, ?, ?, ?)", [id, paymentId, c.date, userId, now()]);
      return { id, paymentId, date: c.date };
    }),
  );
}
