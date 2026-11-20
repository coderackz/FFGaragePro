import { dubaiDate } from "@ffgp/shared";
import type { Db } from "../db";
import { failureWaits, link, linked, recordFailure, type Provider } from "./store";

export interface PushCustomer { id: string; name: string; email: string | null; phone: string | null; trn: string | null }
export interface PushLine { kind: "labour" | "part" | "other"; description: string; qty: number; unitFils: number; discountPct: number; netFils: number; vatFils: number; grossFils: number }
/** `includeVat`: prices were typed including VAT (sent as tax-inclusive, so the provider's VAT is Fleetfix's). */
export interface PushDoc { id: string; number: string; date: string; dueDate: string | null; reference: string | null; lines: PushLine[]; grossFils: number; includeVat: boolean }
export interface PushReceipt { id: string; number: string; date: string; amountFils: number; method: string; reference: string | null }

/** One accounting provider's side of a push. Each call creates one record there and returns its id. */
export interface Pusher {
  customer(c: PushCustomer): Promise<string>;
  invoice(doc: PushDoc, customerExt: string): Promise<string>;
  creditNote(doc: PushDoc, customerExt: string, invoice: { ext: string; number: string }): Promise<string>;
  payment(r: PushReceipt, customerExt: string, allocs: { invoiceExt: string; amountFils: number }[]): Promise<string>;
}

/** Linked locally only: a document with nothing charged on it (nothing to send). */
export const NOTHING = "none";

/**
 * A line as the provider gets it: quantity × unit price when that's exactly the line's amount (`inclusive`: its
 * gross, prices typed with VAT; otherwise its net), else one of the line at that amount, with the quantity, price and
 * discount in the words.
 */
export function providerLine(l: PushLine, inclusive = false): { description: string; quantity: number; rateFils: number } {
  const amount = inclusive ? l.grossFils : l.netFils;
  // Exactly, with no rounding: providers check that quantity × price is the line's amount.
  const exact = l.qty * l.unitFils;
  if (!l.discountPct && Math.abs(exact - Math.round(exact)) < 1e-9 && amount === Math.round(exact)) return { description: l.description, quantity: l.qty, rateFils: l.unitFils };
  const aed = `AED ${(l.unitFils / 100).toFixed(2)}`;
  return { description: `${l.description} (${l.qty} × ${aed}${l.discountPct ? `, less ${l.discountPct}%` : ""})`, quantity: 1, rateFils: amount };
}

const day = (iso: string) => dubaiDate(iso);

function customerOf(db: Db, id: string): PushCustomer {
  const c = db.get<{ id: string; name: string; email: string | null; phone: string | null; trn: string | null }>("SELECT id, name, email, phone, trn FROM customers WHERE id = ?", [id])!;
  return c;
}
function docOf(db: Db, id: string): PushDoc {
  const d = db.get<{ id: string; number: string; issued_at: string; due_date: string | null; lpo_number: string | null; gross_fils: number; prices_include_vat: number }>(
    "SELECT id, number, issued_at, due_date, lpo_number, gross_fils, prices_include_vat FROM documents WHERE id = ?", [id],
  )!;
  const lines = db.all<{ kind: PushLine["kind"]; description: string; qty: number; unit_price_fils: number; discount_pct: number; net_fils: number; vat_fils: number; gross_fils: number }>(
    "SELECT kind, description, qty, unit_price_fils, discount_pct, net_fils, vat_fils, gross_fils FROM document_lines WHERE document_id = ? AND net_fils > 0 ORDER BY position", [id],
  ).map((l) => ({ kind: l.kind, description: l.description, qty: l.qty, unitFils: l.unit_price_fils, discountPct: l.discount_pct, netFils: l.net_fils, vatFils: l.vat_fils, grossFils: l.gross_fils }));
  return { id: d.id, number: d.number, date: day(d.issued_at), dueDate: d.due_date, reference: d.lpo_number, lines, grossFils: d.gross_fils, includeVat: !!d.prices_include_vat };
}

/**
 * Pushes what isn't there yet, oldest first: issued invoices, then credit notes (once their invoice is there), then
 * receipts (once every invoice they pay is there). Only from `fromDate` (Dubai), and at most `cap` per round (`more`:
 * there's still some to send). What's waiting after a failure, or can never go (paying or crediting an invoice from
 * before the start), is left out of the lists, so it never holds up what comes after. A failure waits (backoff) and is
 * shown on the card; what was already created (a customer) stays linked, so nothing is created twice.
 */
export async function pushPending(
  db: Db, p: Provider, pusher: Pusher, now: Date, fromDate: string, o: { account?: string; cap?: number } = {},
): Promise<{ pushed: number; failed: number; more: boolean }> {
  const account = o.account ?? "";
  const cap = o.cap ?? 20;
  let pushed = 0;
  let failed = 0;
  let tried = 0;
  const t = now.toISOString();
  const customer = async (customerId: string) => {
    const have = linked(db, p, "customer", customerId, account);
    if (have) return have;
    const ext = await pusher.customer(customerOf(db, customerId));
    link(db, p, "customer", customerId, ext, account);
    return ext;
  };
  const attempt = async (kind: string, localId: string, label: string, fn: () => Promise<string>) => {
    if (failureWaits(db, p, kind, localId, now) || linked(db, p, kind, localId, account)) return;
    tried++;
    try {
      const ext = await fn();
      link(db, p, kind, localId, ext, account);
      if (ext !== NOTHING) pushed++;
    } catch (e) {
      recordFailure(db, p, kind, localId, label, String((e as Error)?.message ?? e), now);
      failed++;
    }
  };
  const open = (kind: string, col: string) => `${col} NOT IN (SELECT local_id FROM integration_links WHERE provider = '${p}' AND account = :account AND kind = '${kind}')
    AND NOT EXISTS (SELECT 1 FROM integration_failures f WHERE f.provider = '${p}' AND f.kind = '${kind}' AND f.local_id = ${col}
      AND f.attempts > 0 AND (f.next_attempt_at IS NULL OR f.next_attempt_at > :now))`;
  const args = { from: fromDate, account, now: t };
  const full = () => tried >= cap;

  for (const d of db.all<{ id: string; number: string; customer_id: string }>(
    `SELECT id, number, customer_id FROM documents WHERE type = 'invoice' AND status <> 'draft' AND date(issued_at, '+4 hours') >= :from AND ${open("invoice", "id")}
     ORDER BY issued_at, seq`, args,
  )) {
    if (full()) return { pushed, failed, more: true };
    const doc = docOf(db, d.id);
    await attempt("invoice", d.id, d.number, async () => (doc.lines.length ? pusher.invoice(doc, await customer(d.customer_id)) : NOTHING));
  }

  for (const d of db.all<{ id: string; number: string; customer_id: string; source_id: string; source_number: string }>(
    `SELECT d.id, d.number, d.customer_id, d.source_id, s.number AS source_number FROM documents d JOIN documents s ON s.id = d.source_id
     WHERE d.type = 'credit_note' AND d.status = 'issued' AND date(d.issued_at, '+4 hours') >= :from AND date(s.issued_at, '+4 hours') >= :from
       AND ${open("credit_note", "d.id")} ORDER BY d.issued_at, d.seq`, args,
  )) {
    const invExt = linked(db, p, "invoice", d.source_id, account);
    if (!invExt) continue;
    if (full()) return { pushed, failed, more: true };
    const doc = docOf(db, d.id);
    await attempt("credit_note", d.id, d.number, async () =>
      (invExt === NOTHING || !doc.lines.length ? NOTHING : pusher.creditNote(doc, await customer(d.customer_id), { ext: invExt, number: d.source_number })));
  }

  for (const r of db.all<{ id: string; number: string; customer_id: string; received_at: string; amount_fils: number; method: string; reference: string | null }>(
    `SELECT r.id, r.number, r.customer_id, r.received_at, r.amount_fils, r.method, r.reference FROM receipts r
     WHERE r.amount_fils > 0 AND date(r.received_at, '+4 hours') >= :from AND ${open("receipt", "r.id")}
       AND NOT EXISTS (SELECT 1 FROM receipt_allocations ra JOIN documents i ON i.id = ra.document_id
         WHERE ra.receipt_id = r.id AND ra.amount_fils > 0 AND date(i.issued_at, '+4 hours') < :from)
     ORDER BY r.received_at`, args,
  )) {
    const allocs = db.all<{ document_id: string; amount: number }>(
      "SELECT document_id, SUM(amount_fils) AS amount FROM receipt_allocations WHERE receipt_id = ? GROUP BY document_id HAVING SUM(amount_fils) > 0", [r.id],
    );
    const exts = allocs.map((a) => ({ invoiceExt: linked(db, p, "invoice", a.document_id, account), amountFils: a.amount }));
    // Paying an invoice that isn't there yet: waits.
    if (exts.some((a) => !a.invoiceExt)) continue;
    if (full()) return { pushed, failed, more: true };
    await attempt("receipt", r.id, r.number, async () =>
      pusher.payment({ id: r.id, number: r.number, date: day(r.received_at), amountFils: r.amount_fils, method: r.method, reference: r.reference }, await customer(r.customer_id),
        // An invoice with nothing on it isn't there: that part of the payment goes unapplied (customer credit).
        exts.filter((a) => a.invoiceExt !== NOTHING) as { invoiceExt: string; amountFils: number }[]));
  }
  return { pushed, failed, more: false };
}
