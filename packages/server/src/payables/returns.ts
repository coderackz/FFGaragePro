import { formatNumberOf, prefixOf, roundFils, type supplierReturnSchema, type coreWriteoffSchema } from "@ffgp/shared";
import type { z } from "zod";
import type { SessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { badRequest, notFound } from "../errors";
import { takeNumber, type NumberSource, type Reserved } from "../numbering";
import { garage } from "../routes/setup";
import { getSettings } from "../settings";
import { postMovement, round3 } from "../stock";
import { returnUnitsToSupplier } from "../units";

// Inventory v2, Part 4: debit notes to suppliers — parts returned off the shelf (RTS), cores going back, and (made by
// a credited warranty claim) warranty credits — and cores written off. Payables screens and the books read them.

type ReturnInput = z.infer<typeof supplierReturnSchema>;
type WriteoffInput = z.infer<typeof coreWriteoffSchema>;
export type ReturnKind = "return" | "core" | "warranty";

interface ReturnRow {
  id: string; number: string; supplier_id: string; kind: ReturnKind; return_date: string; reason: string; supplier_ref: string | null;
  net_fils: number; vat_fils: number; gross_fils: number; created_by: string | null; created_at: string;
}
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const vatOn = (db: Db, net: number) => roundFils((net * (garage(db)?.vat_rate_bp ?? 500)) / 10000);

/** A debit note as the screens show it. */
export function returnOut(db: Db, id: string) {
  const r = db.get<ReturnRow & { supplier_name: string; created_by_name: string | null }>(
    `SELECT r.*, s.name AS supplier_name, u.name AS created_by_name FROM supplier_returns r JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?`, [id],
  );
  if (!r) throw notFound("Return not found");
  const lines = db.all<{ id: string; part_id: string; part_no: string; description: string; qty: number; unit_credit_fils: number; unit_cost_fils: number; net_fils: number; unit_ids_json: string }>(
    "SELECT l.*, p.part_no FROM supplier_return_lines l JOIN parts p ON p.id = l.part_id WHERE l.return_id = ? ORDER BY l.position", [id],
  );
  const code = (u: string) => db.get<{ code: string }>("SELECT code FROM stock_units WHERE id = ?", [u])?.code ?? "?";
  return {
    id: r.id, number: r.number, kind: r.kind, date: r.return_date, reason: r.reason, supplierRef: r.supplier_ref,
    supplier: { id: r.supplier_id, name: r.supplier_name }, netFils: r.net_fils, vatFils: r.vat_fils, grossFils: r.gross_fils,
    createdAt: r.created_at, createdBy: r.created_by_name,
    lines: lines.map((l) => ({
      id: l.id, partId: l.part_id, partNo: l.part_no, description: l.description, qty: l.qty, unitCreditFils: l.unit_credit_fils, unitCostFils: l.unit_cost_fils,
      netFils: l.net_fils, units: (JSON.parse(l.unit_ids_json || "[]") as string[]).map(code),
    })),
  };
}

export function listReturns(db: Db, supplierId?: string | null) {
  return db.all<{ id: string }>(
    "SELECT id FROM supplier_returns WHERE (? IS NULL OR supplier_id = ?) ORDER BY return_date DESC, seq DESC LIMIT 500", [supplierId ?? null, supplierId ?? null],
  ).map((r) => returnOut(db, r.id));
}

/** Cores the garage paid deposits on and hasn't had back, by supplier and part: how many and their deposits. */
export function coresOwed(db: Db, supplierId?: string | null) {
  const rows = db.all<{ supplier_id: string; supplier_name: string; part_id: string; part_no: string; name: string; qty: number; value: number }>(
    `SELECT x.supplier_id, s.name AS supplier_name, x.part_id, p.part_no, p.name, SUM(x.qty) AS qty, SUM(x.value) AS value FROM (
       SELECT po.supplier_id, pl.part_id, gl.qty AS qty, ROUND(gl.qty * gl.core_fils) AS value
         FROM goods_receipt_lines gl JOIN po_lines pl ON pl.id = gl.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
         WHERE gl.core_fils > 0 AND pl.part_id IS NOT NULL
       UNION ALL
       SELECT r.supplier_id, l.part_id, -l.qty, -l.net_fils FROM supplier_return_lines l JOIN supplier_returns r ON r.id = l.return_id WHERE r.kind = 'core'
       UNION ALL
       SELECT w.supplier_id, w.part_id, -w.qty, -w.value_fils FROM core_writeoffs w
     ) x JOIN suppliers s ON s.id = x.supplier_id JOIN parts p ON p.id = x.part_id
     WHERE (? IS NULL OR x.supplier_id = ?)
     GROUP BY x.supplier_id, x.part_id HAVING ROUND(SUM(x.qty), 3) > 0 ORDER BY s.name COLLATE NOCASE, p.part_no COLLATE NOCASE`,
    [supplierId ?? null, supplierId ?? null],
  );
  return rows.map((r) => ({
    supplierId: r.supplier_id, supplierName: r.supplier_name, partId: r.part_id, partNo: r.part_no, name: r.name,
    qty: round3(r.qty), valueFils: Math.round(r.value), depositFils: Math.round(r.value / r.qty),
  }));
}
const coresOf = (db: Db, supplierId: string, partId: string) => coresOwed(db, supplierId).find((c) => c.partId === partId) ?? { qty: 0, valueFils: 0, depositFils: 0 };

/** Writes the debit note itself (numbered RTS) and its lines. Call inside db.tx; returns its id. */
export function writeDebitNote(
  db: Db, user: SessionUser, numbers: NumberSource | undefined, reserved: Reserved | null,
  head: { supplierId: string; kind: ReturnKind; reason: string; supplierRef?: string | null; vatFils?: number },
  lines: { partId: string; description: string; qty: number; unitCreditFils: number; unitCostFils: number; unitIds: string[] }[],
): string {
  const { series, seq } = takeNumber(db, "supplier_return", reserved, numbers);
  const number = formatNumberOf("supplier_return", seq, series, prefixOf(getSettings(db), "supplier_return"));
  const id = newId();
  const nets = lines.map((l) => roundFils(l.qty * l.unitCreditFils));
  const net = nets.reduce((s, n) => s + n, 0);
  const vat = head.vatFils ?? vatOn(db, net);
  db.run(
    `INSERT INTO supplier_returns (id, series, seq, number, supplier_id, kind, return_date, reason, supplier_ref, net_fils, vat_fils, gross_fils, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, series, seq, number, head.supplierId, head.kind, today(), head.reason, head.supplierRef ?? null, net, vat, net + vat, user.id, now()],
  );
  lines.forEach((l, i) => db.run(
    `INSERT INTO supplier_return_lines (id, return_id, position, part_id, description, qty, unit_credit_fils, unit_cost_fils, net_fils, unit_ids_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), id, i, l.partId, l.description, l.qty, l.unitCreditFils, l.unitCostFils, nets[i]!, JSON.stringify(l.unitIds)],
  ));
  return id;
}

/**
 * A return to the supplier (parts off the shelf at their cost; tyres and batteries one by one) or cores going back
 * (no stock moves; no more than are owed). Makes the debit note. Call inside db.tx.
 */
export function createSupplierReturn(db: Db, input: ReturnInput, user: SessionUser, numbers: NumberSource | undefined, reserved: Reserved | null): string {
  if (!db.get("SELECT 1 FROM suppliers WHERE id = ?", [input.supplierId])) throw notFound("Supplier not found");
  const lines = input.lines.map((l) => {
    const p = db.get<{ part_no: string; name: string; stocked: number; is_kit: number; on_hand: number; avg_cost_fils: number }>(
      "SELECT part_no, name, stocked, is_kit, on_hand, avg_cost_fils FROM parts WHERE id = ?", [l.partId],
    );
    if (!p) throw badRequest("Part not found");
    if (input.kind === "return") {
      if (!p.stocked || p.is_kit) throw badRequest(`${p.part_no}: only parts kept on the shelf go back this way`);
      if (round3(p.on_hand - l.qty) < 0) throw badRequest(`${p.part_no}: only ${Math.max(0, p.on_hand)} on the shelf`);
    } else {
      const owed = coresOf(db, input.supplierId, l.partId);
      if (l.qty > owed.qty) throw badRequest(`${p.part_no}: only ${owed.qty} core${owed.qty === 1 ? "" : "s"} owed by this supplier`);
      if (l.unitIds.length) throw badRequest("Cores don't take units");
    }
    return { ...l, description: `${p.name} (${p.part_no})`, unitCostFils: input.kind === "return" ? p.avg_cost_fils : 0 };
  });
  const id = writeDebitNote(db, user, numbers, reserved, { supplierId: input.supplierId, kind: input.kind, reason: input.reason, supplierRef: input.supplierRef, vatFils: input.vatFils }, lines);
  if (input.kind === "return") {
    const number = db.get<{ number: string }>("SELECT number FROM supplier_returns WHERE id = ?", [id])!.number;
    for (const l of lines) {
      returnUnitsToSupplier(db, l.partId, l.qty, l.unitIds);
      postMovement(db, { partId: l.partId, qty: -l.qty, reason: "adjust", note: `Returned to supplier on ${number}`, userId: user.id, supplierReturnId: id });
    }
  }
  return id;
}

/** Cores the garage won't get back (the customer kept the old unit): their deposits are written off. Call inside db.tx. */
export function writeOffCores(db: Db, input: WriteoffInput, user: SessionUser): string {
  const owed = coresOf(db, input.supplierId, input.partId);
  if (input.qty > owed.qty) throw badRequest(`Only ${owed.qty} core${owed.qty === 1 ? "" : "s"} owed by this supplier`);
  // The last ones owed take what's left, so the deposits clear to the fil.
  const value = input.qty === owed.qty ? owed.valueFils : Math.round(owed.valueFils * (input.qty / owed.qty));
  const id = newId();
  db.run("INSERT INTO core_writeoffs (id, supplier_id, part_id, qty, value_fils, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id, input.supplierId, input.partId, input.qty, value, input.reason, user.id, now(),
  ]);
  return id;
}
