import { addDays, AGING_BUCKETS, agingBucket, dubaiDate, type AgingBucket } from "@ffgp/shared";
import type { Db } from "../db";

const today = () => dubaiDate(new Date().toISOString());
const D = (col: string) => `date(${col}, '+4 hours')`;

export interface OpenItem { target: "bill" | "goods_receipt"; id: string; number: string; date: string; dueDate: string; grossFils: number; owedFils: number }

interface SupplierRow { id: string; name: string; terms_days: number; opening_balance_fils: number; opening_balance_date: string | null }
const supplierRow = (db: Db, id: string) =>
  db.get<SupplierRow>("SELECT id, name, terms_days, opening_balance_fils, opening_balance_date FROM suppliers WHERE id = ?", [id]);

/**
 * What we owe a supplier, item by item, up to `asOf`: goods receipts (their bills for parts, due on their invoice date
 * plus the supplier's terms) and other bills not cancelled, less what payments have been put against each.
 */
export function supplierItems(db: Db, supplierId: string, asOf: string = today()): OpenItem[] {
  const s = supplierRow(db, supplierId);
  if (!s) return [];
  const allocated = (target: string, id: string) =>
    db.get<{ a: number | null }>(
      `SELECT SUM(a.amount_fils) AS a FROM supplier_allocations a JOIN supplier_payments p ON p.id = a.payment_id WHERE a.target = ? AND a.target_id = ? AND p.paid_at <= ?`,
      [target, id, asOf],
    )!.a ?? 0;
  const items: OpenItem[] = [];
  for (const g of db.all<{ id: string; invoice_no: string | null; day: string; gross_fils: number }>(
    `SELECT g.id, g.supplier_invoice_no AS invoice_no, COALESCE(g.supplier_invoice_date, ${D("g.created_at")}) AS day, g.gross_fils
     FROM goods_receipts g JOIN purchase_orders p ON p.id = g.po_id WHERE p.supplier_id = ? AND COALESCE(g.supplier_invoice_date, ${D("g.created_at")}) <= ?`,
    [supplierId, asOf],
  )) {
    items.push({ target: "goods_receipt", id: g.id, number: g.invoice_no ?? "Parts received", date: g.day, dueDate: addDays(g.day, s.terms_days), grossFils: g.gross_fils, owedFils: g.gross_fils - allocated("goods_receipt", g.id) });
  }
  for (const b of db.all<{ id: string; supplier_invoice_no: string; bill_date: string; due_date: string | null; gross_fils: number }>(
    "SELECT id, supplier_invoice_no, bill_date, due_date, gross_fils FROM supplier_bills WHERE supplier_id = ? AND status = 'posted' AND bill_date <= ?",
    [supplierId, asOf],
  )) {
    items.push({ target: "bill", id: b.id, number: b.supplier_invoice_no, date: b.bill_date, dueDate: b.due_date ?? addDays(b.bill_date, s.terms_days), grossFils: b.gross_fils, owedFils: b.gross_fils - allocated("bill", b.id) });
  }
  return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.date.localeCompare(b.date));
}

/** Items still owed, oldest due first (what a payment is split across). */
export const supplierOpenItems = (db: Db, supplierId: string, asOf?: string) => supplierItems(db, supplierId, asOf).filter((i) => i.owedFils > 0);

/**
 * A supplier's balance on `asOf`: opening balance + goods receipts + bills − payments. Negative = an advance (we
 * paid ahead). Overdue = items past their due date still owed.
 */
export function supplierBalance(db: Db, supplierId: string, asOf: string = today()) {
  const s = supplierRow(db, supplierId);
  if (!s) return { balanceFils: 0, overdueFils: 0, advanceFils: 0 };
  const opening = s.opening_balance_fils && (!s.opening_balance_date || s.opening_balance_date <= asOf) ? s.opening_balance_fils : 0;
  const items = supplierItems(db, supplierId, asOf);
  const paid = db.get<{ p: number | null }>("SELECT SUM(amount_fils) AS p FROM supplier_payments WHERE supplier_id = ? AND paid_at <= ?", [supplierId, asOf])!.p ?? 0;
  const balanceFils = opening + items.reduce((t, i) => t + i.grossFils, 0) - paid;
  const overdueFils = items.filter((i) => i.owedFils > 0 && i.dueDate < asOf).reduce((t, i) => t + i.owedFils, 0);
  return { balanceFils, overdueFils, advanceFils: Math.max(0, -balanceFils) };
}

export interface SupplierStatementRow { date: string; kind: "opening" | "goods_receipt" | "bill" | "payment"; number: string; description: string; debitFils: number; creditFils: number; balanceFils: number }

/** A supplier's statement for [from, to]: what we were billed (credit) and paid (debit), with a running balance owed. */
export function supplierStatement(db: Db, supplierId: string, from: string, to: string) {
  const s = supplierRow(db, supplierId);
  const openingFils = supplierBalance(db, supplierId, addDays(from, -1)).balanceFils;
  const rows: Omit<SupplierStatementRow, "balanceFils">[] = [];
  if (s?.opening_balance_fils && s.opening_balance_date && s.opening_balance_date >= from && s.opening_balance_date <= to) {
    const v = s.opening_balance_fils;
    rows.push({ date: s.opening_balance_date, kind: "opening", number: "", description: "Opening balance", debitFils: Math.max(-v, 0), creditFils: Math.max(v, 0) });
  }
  for (const i of supplierItems(db, supplierId, to).filter((x) => x.date >= from)) {
    rows.push({ date: i.date, kind: i.target, number: i.number, description: `${i.target === "bill" ? "Bill" : "Parts received"}, due ${i.dueDate}`, debitFils: 0, creditFils: i.grossFils });
  }
  for (const p of db.all<{ paid_at: string; number: string; amount_fils: number; method: string; reference: string | null }>(
    "SELECT paid_at, number, amount_fils, method, reference FROM supplier_payments WHERE supplier_id = ? AND paid_at BETWEEN ? AND ?",
    [supplierId, from, to],
  )) {
    rows.push({ date: p.paid_at, kind: "payment", number: p.number, description: `Payment (${p.method.replace("_", " ")}${p.reference ? `, ${p.reference}` : ""})`, debitFils: p.amount_fils, creditFils: 0 });
  }
  const order = { opening: 0, goods_receipt: 1, bill: 2, payment: 3 } as const;
  rows.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind]);
  let running = openingFils;
  return {
    openingFils,
    rows: rows.map((r) => ({ ...r, balanceFils: (running += r.creditFils - r.debitFils) })),
    closingFils: supplierBalance(db, supplierId, to).balanceFils,
  };
}

/** What we owe each supplier, by how late (items past due), with advances beside it. */
export function payablesAging(db: Db, asOf: string = today()) {
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  const suppliers: { id: string; name: string; buckets: Record<AgingBucket, number>; totalFils: number; advanceFils: number }[] = [];
  for (const s of db.all<{ id: string; name: string }>("SELECT id, name FROM suppliers ORDER BY name COLLATE NOCASE")) {
    const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
    for (const i of supplierOpenItems(db, s.id, asOf)) buckets[agingBucket(i.dueDate, asOf)] += i.owedFils;
    const totalFils = AGING_BUCKETS.reduce((t, b) => t + buckets[b], 0);
    const { advanceFils } = supplierBalance(db, s.id, asOf);
    if (!totalFils && !advanceFils) continue;
    for (const b of AGING_BUCKETS) totals[b] += buckets[b];
    suppliers.push({ id: s.id, name: s.name, buckets, totalFils, advanceFils });
  }
  return { asOf, suppliers, totals };
}
