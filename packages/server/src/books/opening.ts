import { SYSTEM_ACCOUNTS as A } from "@ffgp/shared";
import type { Db } from "../db";
import { badRequest } from "../errors";
import { customerBalance } from "../ledger";
import { getSettings } from "../settings";
import { supplierBalance } from "../payables/ledger";
import { addDays } from "./post";

export interface ProposalLine { accountId: string; debitFils: number; creditFils: number; customerId: string | null; supplierId: string | null; documentId: string | null; memo: string }
const line = (accountId: string, fils: number, memo: string, customerId: string | null = null, documentId: string | null = null, supplierId: string | null = null): ProposalLine =>
  ({ accountId, debitFils: fils > 0 ? fils : 0, creditFils: fils < 0 ? -fils : 0, customerId, supplierId, documentId, memo });

/**
 * What the app already knows of the opening position, the day before the books start: what each customer owed from
 * invoices and payments, stock on the shelf, parts on job cards not yet invoiced, and the opening items the books
 * already hold in Opening balance clearing (customer opening balances, opening stock, which post themselves) so the
 * clearing account comes to zero. Also what each supplier was owed (goods receipts, bills, payments before the start;
 * their own opening balances post themselves), customer cheques not yet paid in and our cheques not yet cleared. The
 * accountant adds the rest (cash, bank, capital, the year so far), not suppliers again.
 */
export function openingProposal(db: Db): { date: string; lines: ProposalLine[] } {
  const { startDate } = getSettings(db).books;
  if (!startDate) throw badRequest("Set the books start date first (Settings → Books)");
  const date = addDays(startDate, -1);
  const lines: ProposalLine[] = [];
  for (const c of db.all<{ id: string; name: string; opening: number; opening_date: string | null }>(
    "SELECT id, name, opening_balance_fils AS opening, opening_balance_date AS opening_date FROM customers ORDER BY name COLLATE NOCASE",
  )) {
    // The customer's own opening balance posts by itself (through clearing): leave it out here.
    const inBalance = c.opening && (!c.opening_date || c.opening_date <= date) ? c.opening : 0;
    const owed = customerBalance(db, c.id, date).balanceFils - inBalance;
    if (owed) lines.push(line(A.receivables.id, owed, c.name, c.id));
  }
  const before = "date(m.created_at, '+4 hours') < ?";
  const stock = db.get<{ v: number | null }>(`SELECT SUM(ROUND(m.qty * m.unit_cost_fils)) AS v FROM stock_movements m WHERE m.reason <> 'opening' AND ${before}`, [startDate])!.v ?? 0;
  if (stock) lines.push(line(A.inventory.id, stock, `Stock on ${date}`));
  const jobs = db.all<{ id: string; number: string; wip: number }>(
    `SELECT j.id, j.number, -SUM(ROUND(m.qty * m.unit_cost_fils)) AS wip FROM documents j JOIN stock_movements m ON m.document_id = j.id AND m.reason = 'job'
     WHERE j.type = 'jobcard' AND ${before}
       AND NOT EXISTS (SELECT 1 FROM documents i WHERE i.source_id = j.id AND i.type = 'invoice' AND i.status <> 'draft' AND date(i.issued_at, '+4 hours') < ?)
     GROUP BY j.id HAVING wip <> 0`,
    [startDate, startDate],
  );
  for (const j of jobs) lines.push(line(A.wip.id, j.wip, `Parts on ${j.number}`, null, j.id));
  for (const s of db.all<{ id: string; name: string; opening: number; opening_date: string | null }>(
    "SELECT id, name, opening_balance_fils AS opening, opening_balance_date AS opening_date FROM suppliers ORDER BY name COLLATE NOCASE",
  )) {
    const inBalance = s.opening && (!s.opening_date || s.opening_date <= date) ? s.opening : 0;
    const owedTo = supplierBalance(db, s.id, date).balanceFils - inBalance;
    if (owedTo) lines.push(line(A.payables.id, -owedTo, s.name, null, null, s.id));
  }
  const inHand = db.get<{ v: number | null }>(
    `SELECT SUM(r.amount_fils) AS v FROM receipts r WHERE r.method = 'cheque' AND r.amount_fils > 0 AND date(r.received_at, '+4 hours') < ?
       AND NOT EXISTS (SELECT 1 FROM cheque_deposits d WHERE d.receipt_id = r.id AND d.date < ?)`,
    [startDate, startDate],
  )!.v ?? 0;
  if (inHand) lines.push(line(A.cheques_in_hand.id, inHand, "Customers' cheques not yet paid in"));
  const issued = db.get<{ v: number | null }>(
    `SELECT SUM(p.amount_fils) AS v FROM supplier_payments p WHERE p.method = 'cheque' AND p.paid_at < ?
       AND NOT EXISTS (SELECT 1 FROM cheque_clearances c WHERE c.payment_id = p.id AND c.date < ?)`,
    [startDate, startDate],
  )!.v ?? 0;
  if (issued) lines.push(line(A.cheques_issued.id, -issued, "Our cheques not yet cleared"));
  // Fixed assets from before the books: their cost in their account, the depreciation already taken against it.
  for (const a of db.all<{ name: string; account_id: string; cost_fils: number; opening_depreciation_fils: number }>(
    "SELECT name, account_id, cost_fils, opening_depreciation_fils FROM fixed_assets WHERE in_use_from < ? AND (disposed_on IS NULL OR disposed_on >= ?) ORDER BY in_use_from, name",
    [startDate, startDate],
  )) {
    lines.push(line(a.account_id, a.cost_fils, `Fixed asset: ${a.name}`));
    if (a.opening_depreciation_fils) lines.push(line(A.accumulated_depreciation.id, -a.opening_depreciation_fils, `Depreciation to date: ${a.name}`));
  }
  const clearing = db.get<{ b: number | null }>("SELECT SUM(debit_fils - credit_fils) AS b FROM journal_lines WHERE account_id = ?", [A.opening_clearing.id])!.b ?? 0;
  if (clearing) lines.push(line(A.opening_clearing.id, -clearing, "Opening items the books already hold (customer opening balances, opening stock)"));
  return { date, lines };
}
