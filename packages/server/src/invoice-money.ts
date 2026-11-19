import { invoiceStatus } from "@ffgp/shared";
import { newId, now, type Db } from "./db";

/**
 * An issued invoice's paid amount (its receipt allocations), credited amount (its issued credit notes) and status,
 * recalculated from rows — the same on a PC and in the cloud, so sync always adds up. Drafts and other types: no-op.
 */
export function recomputeInvoiceMoney(db: Db, docId: string): void {
  const doc = db.get<{ type: string; status: string; gross_fils: number }>("SELECT type, status, gross_fils FROM documents WHERE id = ?", [docId]);
  if (!doc || doc.type !== "invoice") return;
  const paid = db.get<{ v: number }>("SELECT COALESCE(SUM(amount_fils), 0) AS v FROM receipt_allocations WHERE document_id = ?", [docId])!.v;
  const credited = db.get<{ v: number }>(
    "SELECT COALESCE(SUM(gross_fils), 0) AS v FROM documents WHERE type = 'credit_note' AND status = 'issued' AND source_id = ?",
    [docId],
  )!.v;
  const status = doc.status === "draft" ? "draft" : invoiceStatus({ grossFils: doc.gross_fils, creditedFils: credited, paidFils: paid });
  db.run("UPDATE documents SET paid_fils = ?, credited_fils = ?, status = ? WHERE id = ?", [paid, credited, status, docId]);
}

/**
 * An old-style payment (from before migration 8) that arrives by sync after the upgrade: turned into the same receipt
 * and allocation the migration makes (same ids, number from the id), so every side agrees. Does nothing if present.
 */
export function legacyPaymentReceipt(db: Db, p: { id: string; document_id: string; amount_fils: number; method: string; reference: string | null; paid_at: string; created_by: string | null; created_at: string }): void {
  const doc = db.get<{ customer_id: string }>("SELECT customer_id FROM documents WHERE id = ?", [p.document_id]);
  if (!doc || db.get("SELECT 1 FROM receipts WHERE id = ?", [p.id])) return;
  db.run(
    `INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, reference, cheque_date, received_at, created_by, created_at)
     VALUES (?, ?, 1, 'RCT-' || upper(substr(replace(?, '-', ''), 1, 10)), ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [p.id, p.id, p.id, doc.customer_id, p.amount_fils, p.method, p.reference, p.paid_at, p.created_by, p.created_at],
  );
  db.run("INSERT INTO receipt_allocations (id, receipt_id, document_id, amount_fils, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    `${p.id}-a`, p.id, p.document_id, p.amount_fils, p.created_by, p.created_at,
  ]);
  recomputeInvoiceMoney(db, p.document_id);
}

/**
 * An issued invoice paid more than it now owes (a credit note after payment, or payments from two places): the excess
 * is taken back off it with negative allocations, newest payments first, so it becomes the customer's credit — usable
 * and refundable. Returns the amount released.
 */
export function releaseOverpayment(db: Db, invoiceId: string, userId: string | null): number {
  const d = db.get<{ type: string; status: string; owed: number }>(
    "SELECT type, status, gross_fils - credited_fils - paid_fils AS owed FROM documents WHERE id = ?",
    [invoiceId],
  );
  if (!d || d.type !== "invoice" || d.status === "draft" || d.owed >= 0) return 0;
  let excess = -d.owed;
  const byReceipt = db.all<{ receipt_id: string; amount: number }>(
    `SELECT a.receipt_id, SUM(a.amount_fils) AS amount, MAX(r.received_at) AS at FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id
     WHERE a.document_id = ? GROUP BY a.receipt_id HAVING SUM(a.amount_fils) > 0 ORDER BY at DESC, a.receipt_id DESC`,
    [invoiceId],
  );
  let released = 0;
  const t = now();
  for (const r of byReceipt) {
    if (excess <= 0) break;
    const take = Math.min(excess, r.amount);
    db.run("INSERT INTO receipt_allocations (id, receipt_id, document_id, amount_fils, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      newId(), r.receipt_id, invoiceId, -take, userId, t,
    ]);
    excess -= take;
    released += take;
  }
  if (released) recomputeInvoiceMoney(db, invoiceId);
  return released;
}
