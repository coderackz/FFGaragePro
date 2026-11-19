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
  /** Owed on invoices past their due date. */
  overdueFils: number;
  /** Received but not yet put against an invoice. */
  creditFils: number;
}

export function customerBalance(db: Db, customerId: string, asOf: string = today()): Balance {
  const c = customerRow(db, customerId);
  if (!c) return { balanceFils: 0, overdueFils: 0, creditFils: 0 };
  const sum = (sql: string) => db.get<{ v: number }>(sql, [customerId, asOf])!.v;
  const invoices = sum(`SELECT COALESCE(SUM(gross_fils), 0) AS v FROM documents WHERE customer_id = ? AND type = 'invoice' AND status <> 'draft' AND ${D("issued_at")} <= ?`);
  const credits = sum(`SELECT COALESCE(SUM(gross_fils), 0) AS v FROM documents WHERE customer_id = ? AND type = 'credit_note' AND status = 'issued' AND ${D("issued_at")} <= ?`);
  const received = sum(`SELECT COALESCE(SUM(amount_fils), 0) AS v FROM receipts WHERE customer_id = ? AND ${D("received_at")} <= ?`);
  const allocated = sum(
    `SELECT COALESCE(SUM(a.amount_fils), 0) AS v FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE r.customer_id = ? AND ${D("r.received_at")} <= ?`,
  );
  const overdue = db.get<{ v: number }>(
    `SELECT COALESCE(SUM(MAX(gross_fils - credited_fils - paid_fils, 0)), 0) AS v FROM documents
     WHERE customer_id = ? AND type = 'invoice' AND status IN ('issued', 'part_paid') AND due_date < ?`,
    [customerId, asOf],
  )!.v;
  return { balanceFils: openingBy(c, asOf) + invoices - credits - received, overdueFils: overdue, creditFils: received - allocated };
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
  aging: Record<AgingBucket, number>;
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
  return { openingFils, rows, closingFils: customerBalance(db, customerId, to).balanceFils, aging: aged?.buckets ?? emptyBuckets() };
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
    if (c.opening_balance_fils > 0 && (!c.opening_balance_date || c.opening_balance_date <= asOf)) {
      buckets[c.opening_balance_date ? agingBucket(c.opening_balance_date, asOf) : "current"] += c.opening_balance_fils;
    }
    for (const inv of db.all<{ due: string; owed: number }>(
      `SELECT COALESCE(due_date, ${D("issued_at")}) AS due, gross_fils - credited_fils - paid_fils AS owed FROM documents
       WHERE customer_id = ? AND type = 'invoice' AND status IN ('issued', 'part_paid') AND ${D("issued_at")} <= ?`,
      [c.id, asOf],
    )) {
      if (inv.owed > 0) buckets[agingBucket(inv.due, asOf)] += inv.owed;
    }
    const creditFils = customerBalance(db, c.id, asOf).creditFils;
    const totalFils = AGING_BUCKETS.reduce((s, b) => s + buckets[b], 0);
    if (!totalFils && !creditFils && !onlyCustomer) continue;
    for (const b of AGING_BUCKETS) totals[b] += buckets[b];
    out.push({ id: c.id, name: c.name, buckets, totalFils, creditFils });
  }
  return { customers: out, totals };
}
