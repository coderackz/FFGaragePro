import { formatNumberOf, prefixOf, type warrantyClaimSchema, type warrantyResolveSchema } from "@ffgp/shared";
import type { z } from "zod";
import type { SessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { takeNumber, type NumberSource, type Reserved } from "../numbering";
import { getSettings } from "../settings";
import { postMovement } from "../stock";
import { addUnits, checkIncomingCodes } from "../units";
import { returnOut, writeDebitNote } from "./returns";

// Inventory v2, Part 4: warranty claims against suppliers (WC), for a part or a tyre/battery by its serial.
// open → replaced (the replacement comes onto the shelf at no cost) / credited (a debit note) / rejected.

interface ClaimRow {
  id: string; number: string; supplier_id: string; part_id: string; unit_id: string | null; document_id: string | null; qty: number; reason: string;
  status: "open" | "replaced" | "credited" | "rejected"; outcome_note: string | null; return_id: string | null; created_at: string; closed_at: string | null;
}

export function claimOut(db: Db, id: string) {
  const c = db.get<ClaimRow & { supplier_name: string; part_no: string; part_name: string; doc_number: string | null; unit_code: string | null; created_by_name: string | null }>(
    `SELECT c.*, s.name AS supplier_name, p.part_no, p.name AS part_name, d.number AS doc_number, u.code AS unit_code, us.name AS created_by_name
     FROM warranty_claims c JOIN suppliers s ON s.id = c.supplier_id JOIN parts p ON p.id = c.part_id
     LEFT JOIN documents d ON d.id = c.document_id LEFT JOIN stock_units u ON u.id = c.unit_id LEFT JOIN users us ON us.id = c.created_by WHERE c.id = ?`,
    [id],
  );
  if (!c) throw notFound("Warranty claim not found");
  const note = c.return_id ? returnOut(db, c.return_id) : null;
  return {
    id: c.id, number: c.number, status: c.status, reason: c.reason, qty: c.qty, outcomeNote: c.outcome_note, createdAt: c.created_at, closedAt: c.closed_at,
    createdBy: c.created_by_name, supplier: { id: c.supplier_id, name: c.supplier_name }, part: { id: c.part_id, partNo: c.part_no, name: c.part_name },
    unit: c.unit_id ? { id: c.unit_id, code: c.unit_code } : null, documentId: c.document_id, documentNumber: c.doc_number,
    debitNote: note ? { id: note.id, number: note.number, grossFils: note.grossFils } : null,
  };
}

export function listClaims(db: Db, f: { status?: string | null; supplierId?: string | null }) {
  return db.all<{ id: string }>(
    "SELECT id FROM warranty_claims WHERE (? IS NULL OR status = ?) AND (? IS NULL OR supplier_id = ?) ORDER BY created_at DESC, seq DESC LIMIT 500",
    [f.status ?? null, f.status ?? null, f.supplierId ?? null, f.supplierId ?? null],
  ).map((r) => claimOut(db, r.id));
}

/** Opens a claim (numbered WC). A tyre or battery is claimed by its unit, which must have been fitted. Call inside db.tx. */
export function createClaim(db: Db, input: z.infer<typeof warrantyClaimSchema>, user: SessionUser, numbers: NumberSource | undefined, reserved: Reserved | null): string {
  if (!db.get("SELECT 1 FROM suppliers WHERE id = ?", [input.supplierId])) throw notFound("Supplier not found");
  if (!db.get("SELECT 1 FROM parts WHERE id = ?", [input.partId])) throw badRequest("Part not found");
  if (input.documentId && !db.get("SELECT 1 FROM documents WHERE id = ?", [input.documentId])) throw badRequest("Job card not found");
  let qty = input.qty;
  if (input.unitId) {
    const u = db.get<{ part_id: string; status: string }>("SELECT part_id, status FROM stock_units WHERE id = ?", [input.unitId]);
    if (!u || u.part_id !== input.partId) throw badRequest("That serial isn't one of this part's");
    if (u.status === "in_stock") throw badRequest("It's still on the shelf: return it to the supplier instead");
    if (u.status !== "fitted") throw badRequest("That one has already gone back");
    if (db.get("SELECT 1 FROM warranty_claims WHERE unit_id = ? AND status = 'open'", [input.unitId])) throw conflict("There's already an open claim for it");
    qty = 1;
  }
  const { series, seq } = takeNumber(db, "warranty_claim", reserved, numbers);
  const number = formatNumberOf("warranty_claim", seq, series, prefixOf(getSettings(db), "warranty_claim"));
  const id = newId();
  const t = now();
  db.run(
    `INSERT INTO warranty_claims (id, series, seq, number, supplier_id, part_id, unit_id, document_id, qty, reason, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    [id, series, seq, number, input.supplierId, input.partId, input.unitId, input.documentId, qty, input.reason, user.id, t, t],
  );
  return id;
}

/**
 * Closes a claim. Replaced: the replacement comes onto the shelf at no cost (a tracked part with its new serial or
 * DOT). Credited: a debit note for what the supplier credited. Either way a claimed unit has gone back. Rejected:
 * nothing moves. Call inside db.tx.
 */
export function resolveClaim(
  db: Db, id: string, input: z.infer<typeof warrantyResolveSchema>, user: SessionUser, numbers: NumberSource | undefined, reserved: Reserved | null,
): void {
  const c = db.get<ClaimRow>("SELECT * FROM warranty_claims WHERE id = ?", [id]);
  if (!c) throw notFound("Warranty claim not found");
  if (c.status !== "open") throw conflict(`${c.number} is already ${c.status}`);
  let returnId: string | null = null;
  if (input.outcome === "replaced") {
    const p = db.get<{ stocked: number }>("SELECT stocked FROM parts WHERE id = ?", [c.part_id])!;
    const codes = checkIncomingCodes(db, c.part_id, c.qty, input.replacementCodes, "The replacement");
    if (p.stocked) {
      postMovement(db, { partId: c.part_id, qty: c.qty, reason: "adjust", unitCostFils: 0, note: `Warranty replacement on ${c.number}`, userId: user.id });
      addUnits(db, c.part_id, codes, 0, null);
    }
  } else if (input.outcome === "credited") {
    const p = db.get<{ name: string; part_no: string }>("SELECT name, part_no FROM parts WHERE id = ?", [c.part_id])!;
    returnId = writeDebitNote(db, user, numbers, reserved, { supplierId: c.supplier_id, kind: "warranty", reason: `Warranty credit on ${c.number}: ${c.reason}`, vatFils: input.vatFils }, [
      { partId: c.part_id, description: `${p.name} (${p.part_no}) — ${c.number}`, qty: c.qty, unitCreditFils: Math.round(input.creditFils! / c.qty), unitCostFils: 0, unitIds: [], netFils: input.creditFils! },
    ]);
  }
  if (input.outcome !== "rejected" && c.unit_id) db.run("UPDATE stock_units SET status = 'returned', updated_at = ? WHERE id = ? AND status = 'fitted'", [now(), c.unit_id]);
  const t = now();
  db.run("UPDATE warranty_claims SET status = ?, outcome_note = ?, return_id = ?, closed_at = ?, updated_at = ? WHERE id = ?", [
    input.outcome, input.note ?? null, returnId, t, t, id,
  ]);
}
