import type { FastifyInstance } from "fastify";
import {
  allocateOldestFirst, allocationSchema, dubaiDate, formatAED, formatNumberOf, prefixOf, receiptSchema, type ReceiptInput,
} from "@ffgp/shared";
import { audit } from "../audit";
import { checkNotLocked } from "../books/journals";
import { requireAction, sessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { badRequest, notFound } from "../errors";
import { recomputeInvoiceMoney } from "../invoice-money";
import { customerBalance } from "../ledger";
import { reserveNumber, takeNumber, type NumberSource } from "../numbering";
import { getSettings } from "../settings";

interface ReceiptRow {
  id: string; number: string; customer_id: string; customer_name: string; amount_fils: number; method: string; reference: string | null;
  cheque_date: string | null; received_at: string; created_by_name: string | null; created_at: string;
  customer_name_ar: string | null; customer_language: string;
}
interface InvoiceRow { id: string; number: string; type: string; status: string; customer_id: string; owed: number; due_date: string | null; issued_at: string | null }

type Allocation = { documentId: string; amountFils: number };
const OPENING = "opening-balance";

const invoiceOf = (db: Db, id: string) =>
  db.get<InvoiceRow>(
    "SELECT id, number, type, status, customer_id, gross_fils - credited_fils - paid_fils AS owed, due_date, issued_at FROM documents WHERE id = ?",
    [id],
  );

/** A receipt with what it was put against and what's left of it (the customer's credit from it). */
export function receiptOut(db: Db, id: string) {
  const r = db.get<ReceiptRow>(
    `SELECT r.*, c.name AS customer_name, c.name_ar AS customer_name_ar, c.doc_language AS customer_language, u.name AS created_by_name FROM receipts r JOIN customers c ON c.id = r.customer_id
     LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?`,
    [id],
  );
  if (!r) return null;
  const allocations = db.all<{ id: string; document_id: string; number: string; amount_fils: number; created_at: string }>(
    `SELECT a.id, a.document_id, d.number, a.amount_fils, a.created_at FROM receipt_allocations a JOIN documents d ON d.id = a.document_id
     WHERE a.receipt_id = ? ORDER BY a.created_at, a.rowid`,
    [id],
  );
  const allocated = allocations.reduce((s, a) => s + a.amount_fils, 0);
  return {
    id: r.id, number: r.number, customerId: r.customer_id, customerName: r.customer_name,
    customerNameAr: r.customer_name_ar, customerLanguage: r.customer_language, amountFils: r.amount_fils, method: r.method,
    reference: r.reference, chequeDate: r.cheque_date, receivedAt: r.received_at, createdBy: r.created_by_name,
    allocations: allocations.map((a) => ({ id: a.id, documentId: a.document_id, number: a.number, amountFils: a.amount_fils, createdAt: a.created_at })),
    allocatedFils: allocated,
    unallocatedFils: r.amount_fils > 0 ? r.amount_fils - allocated : 0,
  };
}

/**
 * What a payment is put against: given allocations are checked (each to this customer's issued invoices, never more
 * than an invoice owes, together never more than the payment); none given → oldest due first. A refund (negative
 * amount) is paid out of the customer's credit and goes against nothing. Throws a plain 400 on anything wrong.
 */
function planAllocations(db: Db, input: ReceiptInput): Allocation[] {
  if (input.amountFils < 0) {
    if (input.allocations?.length) throw badRequest("A refund can't be put against invoices");
    const credit = customerBalance(db, input.customerId).creditFils;
    if (-input.amountFils > credit) throw badRequest(`The refund is more than the customer's credit of ${formatAED(credit)}`);
    return [];
  }
  if (!input.allocations) {
    const open = db.all<{ id: string; due_date: string | null; issued_at: string; owed: number }>(
      `SELECT id, due_date, issued_at, gross_fils - credited_fils - paid_fils AS owed FROM documents
       WHERE customer_id = ? AND type = 'invoice' AND status IN ('issued', 'part_paid')`,
      [input.customerId],
    );
    // An opening balance still owed is the oldest debt: what goes to it stays off the invoices (it has no invoice).
    const c = db.get<{ opening_balance_date: string | null }>("SELECT opening_balance_date FROM customers WHERE id = ?", [input.customerId]);
    const openingDue = customerBalance(db, input.customerId).openingDueFils;
    const items = open.map((d) => ({ id: d.id, dueDate: d.due_date ?? d.issued_at.slice(0, 10), issuedAt: d.issued_at, owedFils: d.owed }));
    if (openingDue > 0) items.push({ id: OPENING, dueDate: c?.opening_balance_date ?? "0000-00-00", issuedAt: "", owedFils: openingDue });
    return allocateOldestFirst(input.amountFils, items).filter((a) => a.documentId !== OPENING);
  }
  checkAllocations(db, input.customerId, input.allocations);
  if (input.allocations.reduce((s, a) => s + a.amountFils, 0) > input.amountFils) {
    throw badRequest("The amounts put against invoices add up to more than the payment");
  }
  return input.allocations;
}

/** Each positive allocation: to one of this customer's issued invoices, at most what it still owes. */
function checkAllocations(db: Db, customerId: string, allocations: Allocation[]): void {
  const perInvoice = new Map<string, number>();
  for (const a of allocations) perInvoice.set(a.documentId, (perInvoice.get(a.documentId) ?? 0) + a.amountFils);
  for (const [documentId, amount] of perInvoice) {
    if (amount <= 0) continue;
    const inv = invoiceOf(db, documentId);
    if (!inv || inv.type !== "invoice") throw badRequest("That isn't an invoice");
    if (inv.customer_id !== customerId) throw badRequest(`${inv.number} is another customer's invoice`);
    if (inv.status === "draft") throw badRequest(`${inv.number} hasn't been issued`);
    if (amount > inv.owed) throw badRequest(`${inv.number} only owes ${formatAED(Math.max(inv.owed, 0))}`);
  }
}

function insertAllocations(db: Db, receiptId: string, allocations: Allocation[], userId: string): void {
  const t = now();
  for (const a of allocations) {
    db.run("INSERT INTO receipt_allocations (id, receipt_id, document_id, amount_fils, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      newId(), receiptId, a.documentId, a.amountFils, userId, t,
    ]);
  }
  for (const id of new Set(allocations.map((a) => a.documentId))) recomputeInvoiceMoney(db, id);
}

const numberOf = (db: Db, id: string) => db.get<{ number: string }>("SELECT number FROM documents WHERE id = ?", [id])?.number ?? null;

export function receiptRoutes(app: FastifyInstance, db: Db, numbers?: NumberSource): void {
  app.get<{ Querystring: { customerId?: string; q?: string } }>("/api/receipts", async (req) => {
    sessionUser(db, req);
    const q = req.query.q?.trim() || null;
    const rows = db.all<{ id: string }>(
      `SELECT r.id FROM receipts r JOIN customers c ON c.id = r.customer_id
       WHERE (:customer IS NULL OR r.customer_id = :customer) AND (:q IS NULL OR r.number LIKE :like OR c.name LIKE :like OR r.reference LIKE :like)
       ORDER BY r.received_at DESC, r.seq DESC LIMIT 500`,
      { customer: req.query.customerId ?? null, q, like: `%${q ?? ""}%` },
    );
    return { receipts: rows.map((r) => receiptOut(db, r.id)!) };
  });

  app.get<{ Params: { id: string } }>("/api/receipts/:id", async (req) => {
    sessionUser(db, req);
    const r = receiptOut(db, req.params.id);
    if (!r) throw notFound("Receipt not found");
    return { receipt: r };
  });

  app.post("/api/receipts", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payments.record");
    const input = receiptSchema.parse(req.body);
    if (!db.get("SELECT 1 FROM customers WHERE id = ?", [input.customerId])) throw notFound("Customer not found");
    // A payment dated back into a locked period of the books is refused (the owner locks finished months).
    if (input.receivedAt) checkNotLocked(db, dubaiDate(input.receivedAt));
    // Everything that can refuse it runs before a number is taken (on a linked PC, from the cloud's series).
    planAllocations(db, input);
    const reserved = await reserveNumber(numbers, "receipt");
    const id = db.tx(() => {
      const allocations = planAllocations(db, input);
      const { series, seq } = takeNumber(db, "receipt", reserved, numbers);
      const receiptId = newId();
      const t = now();
      const number = formatNumberOf("receipt", seq, series, prefixOf(getSettings(db), "receipt"));
      db.run(
        `INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, reference, cheque_date, received_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [receiptId, series, seq, number, input.customerId, input.amountFils, input.method, input.reference, input.chequeDate ?? null,
          input.receivedAt ?? t, user.id, t],
      );
      insertAllocations(db, receiptId, allocations, user.id);
      const customer = db.get<{ name: string }>("SELECT name FROM customers WHERE id = ?", [input.customerId])!.name;
      audit(db, {
        action: "receipt.create", entity: "receipt", entityId: receiptId, userId: user.id,
        after: { receipt: number, customer, amountFils: input.amountFils, allocations: allocations.map((a) => ({ document: numberOf(db, a.documentId), amountFils: a.amountFils })) },
      });
      return receiptId;
    });
    return { receipt: receiptOut(db, id) };
  });

  /** More of a receipt put against invoices (from what's left of it), or an earlier allocation undone (negative). */
  app.post<{ Params: { id: string } }>("/api/receipts/:id/allocations", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payments.record");
    const { allocations } = allocationSchema.parse(req.body);
    db.tx(() => {
      const r = receiptOut(db, req.params.id);
      if (!r) throw notFound("Receipt not found");
      if (r.amountFils < 0) throw badRequest("A refund can't be put against invoices");
      checkAllocations(db, r.customerId, allocations);
      for (const [documentId, amount] of allocations.reduce((m, a) => m.set(a.documentId, (m.get(a.documentId) ?? 0) + a.amountFils), new Map<string, number>())) {
        if (amount >= 0) continue;
        const onIt = r.allocations.filter((a) => a.documentId === documentId).reduce((s, a) => s + a.amountFils, 0);
        if (-amount > onIt) throw badRequest(`Only ${formatAED(onIt)} of ${r.number} is on ${numberOf(db, documentId) ?? "that invoice"}`);
      }
      const added = allocations.reduce((s, a) => s + a.amountFils, 0);
      if (added > r.unallocatedFils) throw badRequest(`Only ${formatAED(r.unallocatedFils)} of ${r.number} is left to put against invoices`);
      // A receipt's leftover may already have paid the opening balance or been refunded: only real credit can be used.
      const credit = customerBalance(db, r.customerId).creditFils;
      if (added > 0 && added > credit) throw badRequest(`Only ${formatAED(credit)} of the customer's credit is left`);
      insertAllocations(db, r.id, allocations, user.id);
      audit(db, {
        action: "receipt.allocate", entity: "receipt", entityId: r.id, userId: user.id,
        after: { receipt: r.number, allocations: allocations.map((a) => ({ document: numberOf(db, a.documentId), amountFils: a.amountFils })) },
      });
    });
    return { receipt: receiptOut(db, req.params.id) };
  });
}
