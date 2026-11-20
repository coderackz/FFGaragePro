import { dubaiDate, formatAED, formatNumberOf, payableTargetSchema, prefixOf, supplierPaymentSchema, type PayableTarget } from "@ffgp/shared";
import { z } from "zod";
import { checkNotLocked } from "../books/journals";
import { newId, now, type Db } from "../db";
import { badRequest, notFound } from "../errors";
import { reserveNumber, takeNumber, type NumberSource } from "../numbering";
import { getSettings } from "../settings";
import { supplierItems, supplierOpenItems } from "./ledger";

interface PaymentRow {
  id: string; number: string; supplier_id: string; supplier_name: string; amount_fils: number; method: string; paid_from_account_id: string;
  reference: string | null; cheque_no: string | null; cheque_date: string | null; paid_at: string; created_at: string; cleared_at: string | null;
}

const SELECT = `SELECT p.*, s.name AS supplier_name, (SELECT date FROM cheque_clearances c WHERE c.payment_id = p.id) AS cleared_at
  FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id`;

export function paymentOut(db: Db, p: PaymentRow) {
  const allocations = db.all<{ id: string; target: string; target_id: string; amount_fils: number }>(
    "SELECT id, target, target_id, amount_fils FROM supplier_allocations WHERE payment_id = ? ORDER BY created_at, rowid",
    [p.id],
  );
  const allocated = allocations.reduce((s, a) => s + a.amount_fils, 0);
  return {
    id: p.id, number: p.number, supplierId: p.supplier_id, supplierName: p.supplier_name, amountFils: p.amount_fils, method: p.method,
    paidFromAccountId: p.paid_from_account_id, reference: p.reference, chequeNo: p.cheque_no, chequeDate: p.cheque_date, paidAt: p.paid_at,
    clearedAt: p.cleared_at, createdAt: p.created_at,
    allocations: allocations.map((a) => ({ allocationId: a.id, target: a.target as PayableTarget["target"], id: a.target_id, amountFils: a.amount_fils })),
    unallocatedFils: p.amount_fils - allocated,
  };
}
export type PaymentOut = ReturnType<typeof paymentOut>;

export function getPayment(db: Db, id: string): PaymentOut | null {
  const p = db.get<PaymentRow>(`${SELECT} WHERE p.id = ?`, [id]);
  return p ? paymentOut(db, p) : null;
}
export const listPayments = (db: Db, supplierId?: string) =>
  db.all<PaymentRow>(`${SELECT} WHERE (:s IS NULL OR p.supplier_id = :s) ORDER BY p.paid_at DESC, p.seq DESC LIMIT 500`, { s: supplierId ?? null })
    .map((p) => paymentOut(db, p));

/** Allocations checked against what each item still owes (this supplier's, not more than owed, not more than `left`). */
function checkAllocations(db: Db, supplierId: string, allocations: PayableTarget[], left: number): void {
  const items = new Map(supplierItems(db, supplierId).map((i) => [`${i.target}:${i.id}`, i]));
  const per = new Map<string, number>();
  for (const a of allocations) per.set(`${a.target}:${a.id}`, (per.get(`${a.target}:${a.id}`) ?? 0) + a.amountFils);
  for (const [key, amount] of per) {
    const item = items.get(key);
    if (!item) throw badRequest("That isn't one of this supplier's bills");
    if (amount > item.owedFils) throw badRequest(`${item.number} only owes ${formatAED(Math.max(item.owedFils, 0))}`);
  }
  if (allocations.reduce((s, a) => s + a.amountFils, 0) > left) throw badRequest("That's more than is left of the payment");
}

/** What's owed, oldest due first, up to `amount`. */
function oldestFirst(db: Db, supplierId: string, amount: number): PayableTarget[] {
  const out: PayableTarget[] = [];
  let left = amount;
  for (const i of supplierOpenItems(db, supplierId)) {
    if (left <= 0) break;
    const take = Math.min(left, i.owedFils);
    out.push({ target: i.target, id: i.id, amountFils: take });
    left -= take;
  }
  return out;
}

function insertAllocations(db: Db, paymentId: string, allocations: PayableTarget[], userId: string | null): void {
  const t = now();
  for (const a of allocations) {
    db.run("INSERT INTO supplier_allocations (id, payment_id, target, target_id, amount_fils, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      newId(), paymentId, a.target, a.id, a.amountFils, userId, t,
    ]);
  }
}

/** Pays a supplier: split across what's owed (given, or oldest due first); what's left is kept as an advance. */
export async function createPayment(db: Db, input: unknown, userId: string, numbers?: NumberSource): Promise<PaymentOut> {
  const p = supplierPaymentSchema.parse(input);
  if (!db.get("SELECT 1 FROM suppliers WHERE id = ?", [p.supplierId])) throw notFound("Supplier not found");
  const from = db.get<{ money_kind: string | null; active: number }>("SELECT money_kind, active FROM accounts WHERE id = ?", [p.paidFromAccountId]);
  if (!from?.money_kind || !from.active) throw badRequest("Pay from a bank or cash account");
  if (p.method === "cheque" && from.money_kind !== "bank") throw badRequest("A cheque is paid from a bank account");
  const paidAt = p.paidAt ?? dubaiDate(new Date().toISOString());
  checkNotLocked(db, paidAt);
  if (p.allocations) checkAllocations(db, p.supplierId, p.allocations, p.amountFils);
  const reserved = await reserveNumber(numbers, "supplier_payment");
  const id = db.tx(() => {
    const allocations = p.allocations ?? oldestFirst(db, p.supplierId, p.amountFils);
    const { series, seq } = takeNumber(db, "supplier_payment", reserved, numbers);
    const number = formatNumberOf("supplier_payment", seq, series, prefixOf(getSettings(db), "supplier_payment"));
    const paymentId = newId();
    db.run(
      `INSERT INTO supplier_payments (id, series, seq, number, supplier_id, amount_fils, method, paid_from_account_id, reference, cheque_no, cheque_date, paid_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, series, seq, number, p.supplierId, p.amountFils, p.method, p.paidFromAccountId, p.reference, p.chequeNo, p.chequeDate, paidAt, userId, now()],
    );
    insertAllocations(db, paymentId, allocations, userId);
    return paymentId;
  });
  return getPayment(db, id)!;
}

const allocationInput = z.object({ allocations: z.array(payableTargetSchema).min(1).max(200) });

/** Puts what's left of a payment (an advance) against the supplier's bills. */
export function allocatePayment(db: Db, id: string, input: unknown, userId: string): PaymentOut {
  const { allocations } = allocationInput.parse(input);
  return db.tx(() => {
    const p = getPayment(db, id);
    if (!p) throw notFound("Payment not found");
    checkAllocations(db, p.supplierId, allocations, p.unallocatedFils);
    insertAllocations(db, id, allocations, userId);
    return getPayment(db, id)!;
  });
}

/**
 * Puts what's left of a supplier's payments (advances, oldest first) against what they're owed (oldest due first).
 * Run when a bill or a goods receipt arrives, and from the supplier page.
 */
export function applyAdvances(db: Db, supplierId: string, userId: string | null): number {
  return db.tx(() => {
    let applied = 0;
    for (const p of listPayments(db, supplierId).filter((x) => x.unallocatedFils > 0).sort((a, b) => a.paidAt.localeCompare(b.paidAt))) {
      const allocations = oldestFirst(db, supplierId, p.unallocatedFils);
      if (!allocations.length) break;
      insertAllocations(db, p.id, allocations, userId);
      applied += allocations.reduce((s, a) => s + a.amountFils, 0);
    }
    return applied;
  });
}

