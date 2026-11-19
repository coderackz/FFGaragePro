import { recomputeInvoiceMoney } from "@ffgp/server";
import type { Db } from "@ffgp/server";
import { averageCost, roundFils } from "@ffgp/shared";

const round3 = (x: number): number => Math.round(x * 1000) / 1000 + 0;

/**
 * Stock on hand and average cost from the part's movements, replayed in time order. Each side does this after
 * applying, so movements made in two places add up and both arrive at the same figures.
 */
export function recomputePart(db: Db, partId: string): void {
  // id breaks ties so both sides replay in the same order.
  const moves = db.all<{ qty: number; unit_cost_fils: number }>(
    "SELECT qty, unit_cost_fils FROM stock_movements WHERE part_id = ? ORDER BY created_at, id",
    [partId],
  );
  let onHand = 0;
  let avg = 0;
  for (const m of moves) {
    // An incoming movement without a cost of its own was stored at the average, which leaves the average as it is.
    if (m.qty > 0) avg = averageCost(onHand, avg, m.qty, m.unit_cost_fils);
    onHand = round3(onHand + m.qty);
  }
  if (!moves.length) {
    const part = db.get<{ avg_cost_fils: number }>("SELECT avg_cost_fils FROM parts WHERE id = ?", [partId]);
    avg = part?.avg_cost_fils ?? 0;
  }
  db.run("UPDATE parts SET on_hand = ?, avg_cost_fils = ? WHERE id = ?", [onHand, avg, partId]);
}

/** Totals from the lines; for an issued invoice also what's been paid and so its status. */
export function recomputeDocument(db: Db, docId: string): void {
  const doc = db.get<{ type: string; status: string }>("SELECT type, status FROM documents WHERE id = ?", [docId]);
  if (!doc) return;
  const t = db.get<{ net: number; vat: number; gross: number }>(
    "SELECT COALESCE(SUM(net_fils),0) AS net, COALESCE(SUM(vat_fils),0) AS vat, COALESCE(SUM(gross_fils),0) AS gross FROM document_lines WHERE document_id = ?",
    [docId],
  )!;
  db.run("UPDATE documents SET net_fils = ?, vat_fils = ?, gross_fils = ? WHERE id = ?", [t.net, t.vat, t.gross, docId]);
  // Paid (allocations), credited (credit notes) and status for an invoice; a credit note changes its invoice.
  recomputeInvoiceMoney(db, docId);
  if (doc.type === "credit_note") {
    const source = db.get<{ source_id: string | null }>("SELECT source_id FROM documents WHERE id = ?", [docId])?.source_id;
    if (source) recomputeInvoiceMoney(db, source);
  }
}

/** Received quantities from the goods receipts, the PO total, and part/fully received status. */
export function recomputePurchaseOrder(db: Db, poId: string): void {
  const po = db.get<{ status: string }>("SELECT status FROM purchase_orders WHERE id = ?", [poId]);
  if (!po) return;
  db.run(
    `UPDATE po_lines SET received_qty = (SELECT COALESCE(SUM(qty), 0) FROM goods_receipt_lines WHERE po_line_id = po_lines.id) WHERE po_id = ?`,
    [poId],
  );
  const lines = db.all<{ qty: number; received_qty: number; unit_cost_fils: number }>("SELECT qty, received_qty, unit_cost_fils FROM po_lines WHERE po_id = ?", [poId]);
  const net = lines.reduce((sum, l) => sum + roundFils(l.qty * l.unit_cost_fils), 0);
  let status = po.status;
  if (status !== "cancelled" && lines.some((l) => round3(l.received_qty) > 0)) {
    status = lines.every((l) => round3(l.received_qty) >= l.qty) ? "received" : "part_received";
  }
  // version moves on, so a PO screen opened before this is refused instead of overwriting.
  db.run("UPDATE purchase_orders SET net_fils = ?, status = ?, version = version + 1 WHERE id = ?", [net, status, poId]);
}
