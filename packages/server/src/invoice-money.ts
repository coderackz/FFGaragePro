import { invoiceStatus } from "@ffgp/shared";
import type { Db } from "./db";

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
