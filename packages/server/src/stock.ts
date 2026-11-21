import { averageCost } from "@ffgp/shared";
import { newId, now, type Db } from "./db";
import { HttpError } from "./errors";
import { reconcileDocumentUnits, type UnitConflict } from "./units";

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
  /** Going back to the supplier on this return (its debit note posts the stock; postStock skips it). */
  supplierReturnId?: string | null;
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
    `INSERT INTO stock_movements (id, part_id, qty, unit_cost_fils, reason, document_id, po_line_id, note, created_by, created_at, supplier_return_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), m.partId, qty, unitCost, m.reason, m.documentId ?? null, m.poLineId ?? null, m.note ?? null, m.userId, t, m.supplierReturnId ?? null],
  );
  db.run("UPDATE parts SET on_hand = ?, avg_cost_fils = ?, updated_at = ? WHERE id = ?", [round3(part.on_hand + qty), avg, t, m.partId]);
}

interface ChainDoc { id: string; type: string; source_id: string | null }

/** The documents whose movements count for `doc`: itself, plus the job card it was converted from. */
function chainIds(db: Db, doc: ChainDoc): string[] {
  const ids = [doc.id];
  if (doc.source_id) {
    const src = db.get<{ type: string }>("SELECT type FROM documents WHERE id = ?", [doc.source_id]);
    if (src?.type === "jobcard") ids.push(doc.source_id);
  }
  return ids;
}

const inList = (ids: string[]) => ids.map(() => "?").join(", ");

/** A kit's parts and quantities as it is now (empty for a part that isn't a kit). */
export const kitParts = (db: Db, partId: string) =>
  db.all<{ partId: string; qty: number }>("SELECT component_part_id AS partId, qty FROM kit_components WHERE kit_part_id = ?", [partId]);
/** A kit line's parts: as kept on the line when it was written (kit_json), or the kit as it is now for older lines. */
export const kitPartsOf = (db: Db, partId: string, kitJson: string | null | undefined) =>
  kitJson ? (JSON.parse(kitJson) as { partId: string; qty: number }[]) : kitParts(db, partId);

/**
 * The stocked parts a set of part lines takes, by part: a kit line counts as its parts × the line's quantity.
 * Lines Fleet Fix supplies take nothing.
 */
function partsWanted(db: Db, lines: { partId: string | null; qty: number; suppliedBy: string; kitJson?: string | null }[]): Map<string, number> {
  const wanted = new Map<string, number>();
  const add = (id: string, q: number) => wanted.set(id, round3((wanted.get(id) ?? 0) + q));
  for (const l of lines) {
    if (!l.partId || l.suppliedBy !== "garage") continue;
    const p = db.get<{ stocked: number; is_kit: number }>("SELECT stocked, is_kit FROM parts WHERE id = ?", [l.partId]);
    if (p?.is_kit || l.kitJson) {
      for (const c of kitPartsOf(db, l.partId, l.kitJson)) {
        if (db.get<{ stocked: number }>("SELECT stocked FROM parts WHERE id = ?", [c.partId])?.stocked) add(c.partId, c.qty * l.qty);
      }
    } else if (p?.stocked) add(l.partId, l.qty);
  }
  return wanted;
}

function takenByPart(db: Db, ids: string[]): Map<string, { qty: number; costFils: number }> {
  const rows = db.all<{ part_id: string; qty: number; cost: number }>(
    `SELECT part_id, -SUM(qty) AS qty, -SUM(qty * unit_cost_fils) AS cost FROM stock_movements
     WHERE document_id IN (${inList(ids)}) GROUP BY part_id`,
    ids,
  );
  return new Map(rows.map((r) => [r.part_id, { qty: round3(r.qty), costFils: r.cost }]));
}

/**
 * Makes the stock taken for a document's chain equal to the stocked, garage-supplied part lines on it,
 * by posting only the difference. Saving the same lines twice posts nothing. Then the tracked units (tyres, batteries)
 * named on the lines are fitted to it; returns the units another document already held. Call inside db.tx.
 */
export function reconcileDocumentStock(db: Db, docId: string, userId: string, opts: { block?: boolean } = {}): UnitConflict[] {
  const doc = db.get<ChainDoc>("SELECT id, type, source_id FROM documents WHERE id = ?", [docId]);
  // Estimates take nothing; a credit note's returns are its own movements, posted once when it is issued.
  if (!doc || doc.type === "estimate" || doc.type === "credit_note") return [];
  const wanted = partsWanted(
    db,
    db.all<{ partId: string | null; qty: number; suppliedBy: string; kitJson: string | null }>(
      "SELECT part_id AS partId, qty, supplied_by AS suppliedBy, kit_json AS kitJson FROM document_lines WHERE document_id = ?", [docId],
    ),
  );
  const taken = takenByPart(db, chainIds(db, doc));
  const partIds = new Set([...wanted.keys(), ...taken.keys()]);
  for (const partId of partIds) {
    const diff = round3((wanted.get(partId) ?? 0) - (taken.get(partId)?.qty ?? 0));
    if (diff > 0 && opts.block) {
      // Settings -> Inventory "block": stock can't be taken below zero (sync's own recalculation never blocks).
      const p = db.get<{ on_hand: number; unit: string; part_no: string }>("SELECT on_hand, unit, part_no FROM parts WHERE id = ?", [partId]);
      if (p && round3(p.on_hand - diff) < 0) {
        throw new HttpError(409, `Only ${Math.max(0, p.on_hand)} ${p.unit} of ${p.part_no} in stock`, "out_of_stock");
      }
    }
    if (diff !== 0) {
      postMovement(db, { partId, qty: -diff, reason: doc.type === "jobcard" ? "job" : "invoice", documentId: docId, userId });
    }
  }
  return reconcileDocumentUnits(db, docId);
}

/**
 * Settings → Inventory "block", checked before a job card is created or converted (and before a document number is
 * taken for it): throws when `lines` would take a stocked part below zero, counting what `chainDocIds` already took.
 */
export function checkStockAvailable(
  db: Db,
  lines: { kind: string; partId?: string | null; qty: number; suppliedBy?: string }[],
  chainDocIds: string[],
): void {
  const wanted = partsWanted(db, lines.filter((l) => l.kind === "part").map((l) => ({ partId: l.partId ?? null, qty: l.qty, suppliedBy: l.suppliedBy ?? "garage" })));
  const taken = chainDocIds.length ? takenByPart(db, chainDocIds) : new Map<string, { qty: number }>();
  for (const [partId, qty] of wanted) {
    const p = db.get<{ on_hand: number; unit: string; part_no: string; stocked: number }>("SELECT on_hand, unit, part_no, stocked FROM parts WHERE id = ?", [partId]);
    if (!p?.stocked) continue;
    const diff = round3(qty - (taken.get(partId)?.qty ?? 0));
    if (diff > 0 && round3(p.on_hand - diff) < 0) {
      throw new HttpError(409, `Only ${Math.max(0, p.on_hand)} ${p.unit} of ${p.part_no} in stock`, "out_of_stock");
    }
  }
}

/** What one unit of a part cost when it left the shelf for a document's chain (its job card and invoice); null if it didn't. */
export function costTakenFor(db: Db, docId: string, partId: string): number | null {
  const doc = db.get<ChainDoc>("SELECT id, type, source_id FROM documents WHERE id = ?", [docId]);
  if (!doc) return null;
  const t = takenByPart(db, chainIds(db, doc)).get(partId);
  return t && t.qty > 0 ? Math.round(t.costFils / t.qty) : null;
}

export interface DocumentCost {
  /** Cost per line id; null while a bought-for-the-job part hasn't been received. */
  lineCosts: Map<string, number | null>;
  partsCostFils: number;
  costPending: boolean;
  /** Typed-in part lines (not from the parts list, not ordered): their cost is unknown, so margin may be high. */
  uncostedLines: number;
}

/**
 * What the parts on a document cost the garage. Stocked parts: the cost they left the shelf at (or the current
 * average if they haven't left yet, e.g. on an estimate). Parts bought for the job: the received PO cost.
 * Fleet Fix-supplied, free-text and non-part lines cost nothing.
 */
export function documentCost(db: Db, docId: string): DocumentCost {
  const doc = db.get<ChainDoc>("SELECT id, type, source_id FROM documents WHERE id = ?", [docId]);
  const lineCosts = new Map<string, number | null>();
  if (!doc) return { lineCosts, partsCostFils: 0, costPending: false, uncostedLines: 0 };
  const lines = db.all<{
    id: string; kind: string; qty: number; supplied_by: string; part_id: string | null; stocked: number | null; avg_cost_fils: number | null;
    po_line_id: string | null; po_received: number | null; po_cost: number | null; is_kit: number | null; kit_json: string | null;
  }>(
    `SELECT dl.id, dl.kind, dl.qty, dl.supplied_by, dl.part_id, p.stocked, p.avg_cost_fils, p.is_kit, dl.kit_json, dl.po_line_id,
            pl.received_qty AS po_received, pl.unit_cost_fils AS po_cost
     FROM document_lines dl LEFT JOIN parts p ON p.id = dl.part_id LEFT JOIN po_lines pl ON pl.id = dl.po_line_id
     WHERE dl.document_id = ? ORDER BY dl.position`,
    [docId],
  );
  const taken = takenByPart(db, chainIds(db, doc));
  let total = 0;
  let pending = false;
  let uncosted = 0;
  // What one unit of a stocked part cost this work: as it left the shelf, or (not taken yet) its average.
  const perUnit = (partId: string, avg: number) => {
    const t = taken.get(partId);
    return t && t.qty > 0 ? t.costFils / t.qty : avg;
  };
  for (const l of lines) {
    let cost: number | null = 0;
    if (l.supplied_by !== "garage") cost = 0;
    else if (l.part_id && (l.is_kit || l.kit_json)) {
      // A kit costs what its parts cost; unknown while any of them was taken at no cost.
      const parts = kitPartsOf(db, l.part_id, l.kit_json).map((c) => ({ ...c, unit: perUnit(c.partId, db.get<{ a: number }>("SELECT avg_cost_fils AS a FROM parts WHERE id = ?", [c.partId])?.a ?? 0) }));
      cost = parts.some((c) => c.unit <= 0) ? null : Math.round(parts.reduce((s, c) => s + c.unit * c.qty, 0) * l.qty);
    }
    else if (l.po_line_id && l.po_received && l.po_received > 0) {
      // Bought for this job: what was actually paid, even if the part is also kept on the shelf.
      cost = Math.round((l.po_cost ?? 0) * l.qty);
    } else if (l.part_id && l.stocked) {
      const unit = perUnit(l.part_id, l.avg_cost_fils ?? 0);
      // Taken at no cost: fitted before any delivery was entered, so the real cost isn't known yet.
      cost = unit > 0 ? Math.round(unit * l.qty) : null;
    } else if (l.po_line_id || l.part_id) {
      cost = null; // ordered but not received, or a per-job part not requested yet
    } else if (l.kind === "part") {
      uncosted++;
    }
    lineCosts.set(l.id, cost);
    if (cost === null) pending = true;
    else total += cost;
  }
  return { lineCosts, partsCostFils: total, costPending: pending, uncostedLines: uncosted };
}
