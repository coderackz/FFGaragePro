import { SYSTEM_ACCOUNTS as A } from "@ffgp/shared";
import type { Db } from "../db";
import { badRequest } from "../errors";
import { customerBalance } from "../ledger";
import { getSettings } from "../settings";
import { addDays } from "./post";

export interface ProposalLine { accountId: string; debitFils: number; creditFils: number; customerId: string | null; supplierId: null; memo: string }
const line = (accountId: string, fils: number, memo: string, customerId: string | null = null): ProposalLine =>
  ({ accountId, debitFils: fils > 0 ? fils : 0, creditFils: fils < 0 ? -fils : 0, customerId, supplierId: null, memo });

/**
 * What the app already knows of the opening position, the day before the books start: what each customer owes,
 * the stock on the shelf, and parts on job cards not yet invoiced. The accountant adds the rest (cash, bank,
 * suppliers, capital, the year so far) and posts it.
 */
export function openingProposal(db: Db): { date: string; lines: ProposalLine[] } {
  const { startDate } = getSettings(db).books;
  if (!startDate) throw badRequest("Set the books start date first (Settings → Books)");
  const date = addDays(startDate, -1);
  const lines: ProposalLine[] = [];
  for (const c of db.all<{ id: string; name: string }>("SELECT id, name FROM customers ORDER BY name COLLATE NOCASE")) {
    const owed = customerBalance(db, c.id, date).balanceFils;
    if (owed) lines.push(line(A.receivables.id, owed, c.name, c.id));
  }
  const before = "date(m.created_at, '+4 hours') < ?";
  const stock = db.get<{ v: number | null }>(`SELECT SUM(ROUND(m.qty * m.unit_cost_fils)) AS v FROM stock_movements m WHERE ${before}`, [startDate])!.v ?? 0;
  if (stock) lines.push(line(A.inventory.id, stock, `Stock on ${date}`));
  const jobs = db.all<{ id: string; number: string; wip: number }>(
    `SELECT j.id, j.number, -SUM(ROUND(m.qty * m.unit_cost_fils)) AS wip FROM documents j JOIN stock_movements m ON m.document_id = j.id AND m.reason = 'job'
     WHERE j.type = 'jobcard' AND ${before}
       AND NOT EXISTS (SELECT 1 FROM documents i WHERE i.source_id = j.id AND i.type = 'invoice' AND i.status <> 'draft' AND date(i.issued_at, '+4 hours') < ?)
     GROUP BY j.id HAVING wip <> 0`,
    [startDate, startDate],
  );
  for (const j of jobs) lines.push({ ...line(A.wip.id, j.wip, `Parts on ${j.number}`), documentId: j.id } as ProposalLine);
  return { date, lines };
}
