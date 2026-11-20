import { dubaiDate } from "@ffgp/shared";
import type { Db } from "../db";
import { failureWaits, link, linked, recordFailure, type Provider } from "./store";

export interface PushCustomer { id: string; name: string; email: string | null; phone: string | null; trn: string | null }
export interface PushLine { kind: "labour" | "part" | "other"; description: string; qty: number; unitFils: number; discountPct: number; netFils: number; vatFils: number }
export interface PushDoc { id: string; number: string; date: string; dueDate: string | null; reference: string | null; lines: PushLine[]; grossFils: number }
export interface PushReceipt { id: string; number: string; date: string; amountFils: number; method: string; reference: string | null }

/** One accounting provider's side of a push. Each call creates one record there and returns its id. */
export interface Pusher {
  customer(c: PushCustomer): Promise<string>;
  invoice(doc: PushDoc, customerExt: string): Promise<string>;
  creditNote(doc: PushDoc, customerExt: string, invoice: { ext: string; number: string }): Promise<string>;
  payment(r: PushReceipt, customerExt: string, allocs: { invoiceExt: string; amountFils: number }[]): Promise<string>;
}

/**
 * A line as the provider gets it: quantity × unit price when that's exactly the line's net, otherwise one of the
 * line at its net (discounts and promo shares are inside it), with the quantity, price and discount in the words.
 */
export function providerLine(l: PushLine): { description: string; quantity: number; rateFils: number } {
  // Exactly, with no rounding: providers check that quantity × price is the line's amount.
  const exact = l.qty * l.unitFils;
  if (!l.discountPct && Math.abs(exact - Math.round(exact)) < 1e-9 && l.netFils === Math.round(exact)) return { description: l.description, quantity: l.qty, rateFils: l.unitFils };
  const aed = `AED ${(l.unitFils / 100).toFixed(2)}`;
  return { description: `${l.description} (${l.qty} × ${aed}${l.discountPct ? `, less ${l.discountPct}%` : ""})`, quantity: 1, rateFils: l.netFils };
}

const day = (iso: string) => dubaiDate(iso);

function customerOf(db: Db, id: string): PushCustomer {
  const c = db.get<{ id: string; name: string; email: string | null; phone: string | null; trn: string | null }>("SELECT id, name, email, phone, trn FROM customers WHERE id = ?", [id])!;
  return c;
}
function docOf(db: Db, id: string): PushDoc {
  const d = db.get<{ id: string; number: string; issued_at: string; due_date: string | null; lpo_number: string | null; gross_fils: number }>(
    "SELECT id, number, issued_at, due_date, lpo_number, gross_fils FROM documents WHERE id = ?", [id],
  )!;
  const lines = db.all<{ kind: PushLine["kind"]; description: string; qty: number; unit_price_fils: number; discount_pct: number; net_fils: number; vat_fils: number }>(
    "SELECT kind, description, qty, unit_price_fils, discount_pct, net_fils, vat_fils FROM document_lines WHERE document_id = ? AND net_fils > 0 ORDER BY position", [id],
  ).map((l) => ({ kind: l.kind, description: l.description, qty: l.qty, unitFils: l.unit_price_fils, discountPct: l.discount_pct, netFils: l.net_fils, vatFils: l.vat_fils }));
  return { id: d.id, number: d.number, date: day(d.issued_at), dueDate: d.due_date, reference: d.lpo_number, lines, grossFils: d.gross_fils };
}

/**
 * Pushes what isn't there yet, oldest first: issued invoices, then credit notes (once their invoice is there), then
 * receipts (once every invoice they pay is there). Only from `fromDate` (Dubai). A failure waits (backoff) and is
 * shown on the card; what was already created (a customer) stays linked, so nothing is created twice.
 */
export async function pushPending(db: Db, p: Provider, pusher: Pusher, now: Date, fromDate: string): Promise<{ pushed: number; failed: number }> {
  let pushed = 0;
  let failed = 0;
  const customer = async (customerId: string) => {
    const have = linked(db, p, "customer", customerId);
    if (have) return have;
    const ext = await pusher.customer(customerOf(db, customerId));
    link(db, p, "customer", customerId, ext);
    return ext;
  };
  const attempt = async (kind: string, localId: string, label: string, fn: () => Promise<string>) => {
    if (failureWaits(db, p, kind, localId, now)) return;
    try {
      const ext = await fn();
      link(db, p, kind, localId, ext);
      pushed++;
    } catch (e) {
      recordFailure(db, p, kind, localId, label, String((e as Error)?.message ?? e), now);
      failed++;
    }
  };
  const notLinked = (kind: string) => `id NOT IN (SELECT local_id FROM integration_links WHERE provider = '${p}' AND kind = '${kind}')`;

  for (const d of db.all<{ id: string; number: string; customer_id: string }>(
    `SELECT id, number, customer_id FROM documents WHERE type = 'invoice' AND status <> 'draft' AND date(issued_at, '+4 hours') >= ? AND ${notLinked("invoice")}
     ORDER BY issued_at, seq LIMIT 100`, [fromDate],
  )) await attempt("invoice", d.id, d.number, async () => pusher.invoice(docOf(db, d.id), await customer(d.customer_id)));

  for (const d of db.all<{ id: string; number: string; customer_id: string; source_id: string; source_number: string }>(
    `SELECT d.id, d.number, d.customer_id, d.source_id, s.number AS source_number FROM documents d JOIN documents s ON s.id = d.source_id
     WHERE d.type = 'credit_note' AND d.status = 'issued' AND date(d.issued_at, '+4 hours') >= ? AND d.${notLinked("credit_note")}
     ORDER BY d.issued_at, d.seq LIMIT 100`, [fromDate],
  )) {
    const invExt = linked(db, p, "invoice", d.source_id);
    if (!invExt) continue;
    await attempt("credit_note", d.id, d.number, async () => pusher.creditNote(docOf(db, d.id), await customer(d.customer_id), { ext: invExt, number: d.source_number }));
  }

  for (const r of db.all<{ id: string; number: string; customer_id: string; received_at: string; amount_fils: number; method: string; reference: string | null }>(
    `SELECT id, number, customer_id, received_at, amount_fils, method, reference FROM receipts
     WHERE amount_fils > 0 AND date(received_at, '+4 hours') >= ? AND ${notLinked("receipt")} ORDER BY received_at LIMIT 100`, [fromDate],
  )) {
    const allocs = db.all<{ document_id: string; amount: number }>(
      "SELECT document_id, SUM(amount_fils) AS amount FROM receipt_allocations WHERE receipt_id = ? GROUP BY document_id HAVING SUM(amount_fils) > 0", [r.id],
    );
    const exts = allocs.map((a) => ({ invoiceExt: linked(db, p, "invoice", a.document_id), amountFils: a.amount }));
    // Paying an invoice that isn't there (yet, or from before the start): waits.
    if (exts.some((a) => !a.invoiceExt)) continue;
    await attempt("receipt", r.id, r.number, async () =>
      pusher.payment({ id: r.id, number: r.number, date: day(r.received_at), amountFils: r.amount_fils, method: r.method, reference: r.reference }, await customer(r.customer_id),
        exts as { invoiceExt: string; amountFils: number }[]));
  }
  return { pushed, failed };
}
