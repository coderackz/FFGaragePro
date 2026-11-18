import { averageCost } from "@ffgp/shared";
import { newId, now, type Db } from "./db";

export type MovementReason = "receive" | "job" | "invoice" | "adjust" | "opening";

export interface Movement {
  partId: string;
  /** + into stock, − out of stock. */
  qty: number;
  reason: MovementReason;
  /** Cost of goods coming in. Ignored for outgoing movements, which go out at the current average. */
  unitCostFils?: number;
  documentId?: string | null;
  poLineId?: string | null;
  note?: string | null;
  userId: string;
}

/** Quantities are REAL (litres); keep them to 3 decimals so 4.5 + 0.7 − 5.2 is exactly 0. */
export const round3 = (x: number): number => Math.round(x * 1000) / 1000 + 0;

/**
 * The only way stock changes. Appends a movement and keeps parts.on_hand / avg_cost_fils current.
 * Call inside db.tx.
 */
export function postMovement(db: Db, m: Movement): void {
  const part = db.get<{ on_hand: number; avg_cost_fils: number }>("SELECT on_hand, avg_cost_fils FROM parts WHERE id = ?", [m.partId]);
  if (!part) throw new Error(`postMovement: unknown part ${m.partId}`);
  const qty = round3(m.qty);
  if (qty === 0) return;
  let avg = part.avg_cost_fils;
  let unitCost = avg;
  if (qty > 0 && m.unitCostFils !== undefined) {
    avg = averageCost(part.on_hand, part.avg_cost_fils, qty, m.unitCostFils);
    unitCost = m.unitCostFils;
  }
  const t = now();
  db.run(
    `INSERT INTO stock_movements (id, part_id, qty, unit_cost_fils, reason, document_id, po_line_id, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), m.partId, qty, unitCost, m.reason, m.documentId ?? null, m.poLineId ?? null, m.note ?? null, m.userId, t],
  );
  db.run("UPDATE parts SET on_hand = ?, avg_cost_fils = ?, updated_at = ? WHERE id = ?", [round3(part.on_hand + qty), avg, t, m.partId]);
}
