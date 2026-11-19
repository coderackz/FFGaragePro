import { billTotals, lineVat, SYSTEM_ACCOUNTS as A, supplierBillSchema, dubaiDate } from "@ffgp/shared";
import { audit } from "../audit";
import { checkNotLocked } from "../books/journals";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";

/** Accounts a bill line can't use: the ones the app keeps in step with documents, and the bill's own payable and VAT. */
export const NOT_ON_BILLS = new Set([A.receivables.id, A.payables.id, A.inventory.id, A.wip.id, A.vat_output.id, A.vat_input.id, A.opening_clearing.id]);

interface BillRow {
  id: string; supplier_id: string; supplier_name: string; supplier_invoice_no: string; bill_date: string; due_date: string | null; notes: string | null;
  net_fils: number; vat_fils: number; gross_fils: number; status: string; cancel_reason: string | null; cancelled_at: string | null; created_at: string;
}

export function billOut(db: Db, b: BillRow) {
  const lines = db.all<{ id: string; account_id: string; code: string; name: string; description: string; net_fils: number; vat: string; vat_fils: number }>(
    "SELECT l.*, a.code, a.name FROM supplier_bill_lines l JOIN accounts a ON a.id = l.account_id WHERE l.bill_id = ? ORDER BY l.position",
    [b.id],
  );
  const paid = db.get<{ p: number | null }>("SELECT SUM(amount_fils) AS p FROM supplier_allocations WHERE target = 'bill' AND target_id = ?", [b.id])!.p ?? 0;
  return {
    id: b.id, supplierId: b.supplier_id, supplierName: b.supplier_name, supplierInvoiceNo: b.supplier_invoice_no, billDate: b.bill_date, dueDate: b.due_date,
    notes: b.notes, netFils: b.net_fils, vatFils: b.vat_fils, grossFils: b.gross_fils, paidFils: paid, owedFils: b.status === "posted" ? b.gross_fils - paid : 0,
    status: b.status, cancelReason: b.cancel_reason, cancelledAt: b.cancelled_at, createdAt: b.created_at,
    lines: lines.map((l) => ({ id: l.id, accountId: l.account_id, code: l.code, name: l.name, description: l.description, netFils: l.net_fils, vat: l.vat, vatFils: l.vat_fils })),
  };
}
export type BillOut = ReturnType<typeof billOut>;

const SELECT = "SELECT b.*, s.name AS supplier_name FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id";
export function getBill(db: Db, id: string): BillOut | null {
  const b = db.get<BillRow>(`${SELECT} WHERE b.id = ?`, [id]);
  return b ? billOut(db, b) : null;
}
export const listBills = (db: Db, q: { supplierId?: string; status?: string }) =>
  db.all<BillRow>(`${SELECT} WHERE (:s IS NULL OR b.supplier_id = :s) AND (:st IS NULL OR b.status = :st) ORDER BY b.bill_date DESC, b.created_at DESC LIMIT 500`,
    { s: q.supplierId ?? null, st: q.status ?? null }).map((b) => billOut(db, b));

/** Enters a supplier's bill: posted when saved (the books post it), never edited; cancelled if it was a mistake. */
export function createBill(db: Db, input: unknown, userId: string): BillOut {
  const b = supplierBillSchema.parse(input);
  if (!db.get("SELECT 1 FROM suppliers WHERE id = ?", [b.supplierId])) throw notFound("Supplier not found");
  checkNotLocked(db, b.billDate);
  for (const l of b.lines) {
    const a = db.get<{ active: number }>("SELECT active FROM accounts WHERE id = ?", [l.accountId]);
    if (!a || !a.active) throw badRequest(`"${l.description}": choose an account in use`);
    if (NOT_ON_BILLS.has(l.accountId)) throw badRequest(`"${l.description}": that account is kept by the app; choose an expense or asset account`);
  }
  const totals = billTotals(b.lines);
  const id = newId();
  const t = now();
  db.tx(() => {
    db.run(
      `INSERT INTO supplier_bills (id, supplier_id, supplier_invoice_no, bill_date, due_date, notes, net_fils, vat_fils, gross_fils, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)`,
      [id, b.supplierId, b.supplierInvoiceNo, b.billDate, b.dueDate, b.notes, totals.netFils, totals.vatFils, totals.grossFils, userId, t, t],
    );
    b.lines.forEach((l, i) => {
      db.run("INSERT INTO supplier_bill_lines (id, bill_id, position, account_id, description, net_fils, vat, vat_fils) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        newId(), id, i, l.accountId, l.description, l.netFils, l.vat, lineVat(l),
      ]);
    });
  });
  return getBill(db, id)!;
}

/** Cancels a bill entered by mistake (only if nothing is paid against it): its entry is reversed. */
export function cancelBill(db: Db, id: string, reason: string, userId: string): BillOut {
  const b = getBill(db, id);
  if (!b) throw notFound("Bill not found");
  if (b.status === "cancelled") throw conflict("Already cancelled");
  if (b.paidFils) throw conflict("Payments are put against this bill: take them off first");
  const day = dubaiDate(new Date().toISOString());
  checkNotLocked(db, day);
  db.tx(() => {
    db.run("UPDATE supplier_bills SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?, updated_at = ? WHERE id = ?", [reason.trim() || "Cancelled", day, now(), id]);
    audit(db, { action: "settings.change", entity: "supplier_bill", entityId: id, before: { status: "posted" }, after: { status: "cancelled", reason }, userId });
  });
  return getBill(db, id)!;
}
