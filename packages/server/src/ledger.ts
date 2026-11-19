import { addDays, AGING_BUCKETS, agingBucket, dubaiDate, type AgingBucket } from "@ffgp/shared";
import type { Db } from "./db";

/**
 * A customer's account: one set of rules for the balance on screen, the statement and the aging report, so they
 * always agree. Dates are Dubai calendar dates (YYYY-MM-DD); documents count from the day they were issued,
 * receipts from the day they were received.
 */

const today = () => dubaiDate(new Date().toISOString());
const D = (col: string) => `date(${col}, '+4 hours')`;

interface Customer { opening_balance_fils: number; opening_balance_date: string | null }

function customerRow(db: Db, customerId: string): Customer | undefined {
  return db.get<Customer>("SELECT opening_balance_fils, opening_balance_date FROM customers WHERE id = ?", [customerId]);
}

/** The opening balance counts from its date (no date: from the very start). */
const openingBy = (c: Customer, asOf: string) => (!c.opening_balance_date || c.opening_balance_date <= asOf ? c.opening_balance_fils : 0);

export interface Balance {
  /** What the customer owes (negative: in credit). */
  balanceFils: number;
  /** Owed past the due date: invoices, and an opening balance not yet paid. */
  overdueFils: number;
  /** Money the customer can use or have refunded: what's left once everything owed is covered. */
  creditFils: number;
  /** The part of the opening balance still owed (payments not put against an invoice pay it first). */
  openingDueFils: number;
}

interface OpenInvoice { id: string; due: string; owed: number }

/**
 * Each issued invoice's amount still owed as it stood on `asOf`: its total, less credit notes issued by then and
 * payments received by then (an allocation counts from its receipt's date).
 */
function invoicesAsOf(db: Db, customerId: string, asOf: string): OpenInvoice[] {
  return db.all<OpenInvoice>(
    `SELECT d.id, COALESCE(d.due_date, ${D("d.issued_at")}) AS due,
       d.gross_fils
       - COALESCE((SELECT SUM(c.gross_fils) FROM documents c WHERE c.source_id = d.id AND c.type = 'credit_note' AND c.status = 'issued' AND ${D("c.issued_at")} <= :asOf), 0)
       - COALESCE((SELECT SUM(a.amount_fils) FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.document_id = d.id AND ${D("r.received_at")} <= :asOf), 0)
       AS owed
     FROM documents d WHERE d.customer_id = :customer AND d.type = 'invoice' AND d.status <> 'draft' AND ${D("d.issued_at")} <= :asOf`,
    { customer: customerId, asOf },
  );
}

/** Where a customer's account stood on `asOf`, and each invoice's part in it. */
function accountAsOf(db: Db, customerId: string, asOf: string): Balance & { invoices: OpenInvoice[]; opening: Customer | undefined } {
  const c = customerRow(db, customerId);
  if (!c) return { balanceFils: 0, overdueFils: 0, creditFils: 0, openingDueFils: 0, invoices: [], opening: undefined };
  const sum = (sql: string) => db.get<{ v: number }>(sql, [customerId, asOf])!.v;
  const invoiced = sum(`SELECT COALESCE(SUM(gross_fils), 0) AS v FROM documents WHERE customer_id = ? AND type = 'invoice' AND status <> 'draft' AND ${D("issued_at")} <= ?`);
  const credited = sum(`SELECT COALESCE(SUM(gross_fils), 0) AS v FROM documents WHERE customer_id = ? AND type = 'credit_note' AND status = 'issued' AND ${D("issued_at")} <= ?`);
  const received = sum(`SELECT COALESCE(SUM(amount_fils), 0) AS v FROM receipts WHERE customer_id = ? AND ${D("received_at")} <= ?`);
  const opening = openingBy(c, asOf);
  const balance = opening + invoiced - credited - received;
  const invoices = invoicesAsOf(db, customerId, asOf);
  const owedOnInvoices = invoices.reduce((s, i) => s + Math.max(i.owed, 0), 0);
  // Money not on an invoice (and over-paid invoices) covers the oldest debt, the opening balance, first.
  const openingDue = Math.min(Math.max(balance - owedOnInvoices, 0), Math.max(opening, 0));
  const credit = Math.max(owedOnInvoices - balance, 0);
  const overdue = invoices.filter((i) => i.owed > 0 && i.due < asOf).reduce((s, i) => s + i.owed, 0)
    + (openingDue > 0 && (c.opening_balance_date ?? "") < asOf ? openingDue : 0);
  return { balanceFils: balance, overdueFils: overdue, creditFils: credit, openingDueFils: openingDue, invoices, opening: c };
}

export function customerBalance(db: Db, customerId: string, asOf: string = today()): Balance {
  const { balanceFils, overdueFils, creditFils, openingDueFils } = accountAsOf(db, customerId, asOf);
  return { balanceFils, overdueFils, creditFils, openingDueFils };
}

export interface LedgerRow {
  date: string;
  kind: "opening" | "invoice" | "credit_note" | "receipt";
  number: string;
  description: string;
  debitFils: number;
  creditFils: number;
  balanceFils: number;
}

export interface Statement {
  openingFils: number;
  rows: LedgerRow[];
  closingFils: number;
  /** Owed at the end date by how late, and the customer's credit then: buckets − credit = closing balance. */
  aging: Record<AgingBucket, number>;
  creditFils: number;
}

/** Statement of account for `from`..`to` (inclusive): balance brought forward, each entry with a running balance. */
export function customerLedger(db: Db, customerId: string, from: string, to: string): Statement {
  const c = customerRow(db, customerId);
  const openingFils = customerBalance(db, customerId, addDays(from, -1)).balanceFils;
  const entries: Omit<LedgerRow, "balanceFils">[] = [];
  if (c && c.opening_balance_fils && c.opening_balance_date && c.opening_balance_date >= from && c.opening_balance_date <= to) {
    const v = c.opening_balance_fils;
    entries.push({ date: c.opening_balance_date, kind: "opening", number: "", description: "Opening balance", debitFils: Math.max(v, 0), creditFils: Math.max(-v, 0) });
  }
  for (const d of db.all<{ day: string; type: string; number: string; gross_fils: number; due_date: string | null; source_number: string | null; reason: string | null }>(
    `SELECT ${D("d.issued_at")} AS day, d.type, d.number, d.gross_fils, d.due_date, s.number AS source_number, d.reason FROM documents d
     LEFT JOIN documents s ON s.id = d.source_id
     WHERE d.customer_id = ? AND ((d.type = 'invoice' AND d.status <> 'draft') OR (d.type = 'credit_note' AND d.status = 'issued'))
       AND ${D("d.issued_at")} BETWEEN ? AND ?`,
    [customerId, from, to],
  )) {
    if (d.type === "invoice") {
      entries.push({ date: d.day, kind: "invoice", number: d.number, description: d.due_date ? `Tax invoice, due ${d.due_date}` : "Tax invoice", debitFils: d.gross_fils, creditFils: 0 });
    } else {
      entries.push({ date: d.day, kind: "credit_note", number: d.number, description: `Credit note for ${d.source_number ?? "an invoice"}${d.reason ? ` — ${d.reason}` : ""}`, debitFils: 0, creditFils: d.gross_fils });
    }
  }
  for (const r of db.all<{ day: string; number: string; amount_fils: number; method: string; reference: string | null }>(
    `SELECT ${D("received_at")} AS day, number, amount_fils, method, reference FROM receipts WHERE customer_id = ? AND ${D("received_at")} BETWEEN ? AND ?`,
    [customerId, from, to],
  )) {
    const refund = r.amount_fils < 0;
    entries.push({
      date: r.day, kind: "receipt", number: r.number, description: `${refund ? "Refund" : "Payment"} (${r.method.replace("_", " ")}${r.reference ? `, ${r.reference}` : ""})`,
      debitFils: refund ? -r.amount_fils : 0, creditFils: refund ? 0 : r.amount_fils,
    });
  }
  const order = { opening: 0, invoice: 1, credit_note: 2, receipt: 3 } as const;
  entries.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.number.localeCompare(b.number));
  let running = openingFils;
  const rows = entries.map((e) => ({ ...e, balanceFils: (running += e.debitFils - e.creditFils) }));
  const aged = agingReport(db, to, customerId).customers[0];
  return { openingFils, rows, closingFils: customerBalance(db, customerId, to).balanceFils, aging: aged?.buckets ?? emptyBuckets(), creditFils: aged?.creditFils ?? 0 };
}

const emptyBuckets = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;

export interface AgingRow { id: string; name: string; buckets: Record<AgingBucket, number>; totalFils: number; creditFils: number }

/**
 * Who owes what, by how late: each issued invoice's unpaid amount by days past its due date, and an opening
 * balance by days since its date. Unallocated receipts (credit) are listed beside it, not netted into a bucket.
 */
export function agingReport(db: Db, asOf: string = today(), onlyCustomer?: string): { customers: AgingRow[]; totals: Record<AgingBucket, number> } {
  const customers = db.all<{ id: string; name: string; opening_balance_fils: number; opening_balance_date: string | null }>(
    `SELECT id, name, opening_balance_fils, opening_balance_date FROM customers WHERE (? IS NULL OR id = ?) ORDER BY name COLLATE NOCASE`,
    [onlyCustomer ?? null, onlyCustomer ?? null],
  );
  const totals = emptyBuckets();
  const out: AgingRow[] = [];
  for (const c of customers) {
    const buckets = emptyBuckets();
    const account = accountAsOf(db, c.id, asOf);
    if (account.openingDueFils > 0) buckets[c.opening_balance_date ? agingBucket(c.opening_balance_date, asOf) : "current"] += account.openingDueFils;
    for (const inv of account.invoices) if (inv.owed > 0) buckets[agingBucket(inv.due, asOf)] += inv.owed;
    const creditFils = account.creditFils;
    const totalFils = AGING_BUCKETS.reduce((s, b) => s + buckets[b], 0);
    if (!totalFils && !creditFils && !onlyCustomer) continue;
    for (const b of AGING_BUCKETS) totals[b] += buckets[b];
    out.push({ id: c.id, name: c.name, buckets, totalFils, creditFils });
  }
  return { customers: out, totals };
}
