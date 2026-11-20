import { dubaiDate, lineTotals, promoProblem, promoSchema, type PromoInput } from "@ffgp/shared";
import { newId, now, type Db } from "../db";
import { conflict, notFound } from "../errors";

export interface PromoRow {
  id: string; code: string; description: string | null; kind: "percent" | "amount"; value: number; applies_to: "all" | "labour" | "parts"; valid_from: string | null;
  valid_to: string | null; min_net_fils: number | null; max_uses: number | null; once_per_customer: number; active: number; created_at: string; updated_at: string;
}
export const promoOut = (r: PromoRow) => ({
  id: r.id, code: r.code, description: r.description, kind: r.kind, value: r.value, appliesTo: r.applies_to, validFrom: r.valid_from, validTo: r.valid_to,
  minNetFils: r.min_net_fils, maxUses: r.max_uses, oncePerCustomer: !!r.once_per_customer, active: !!r.active,
});
const asInput = (r: PromoRow): PromoInput => ({ ...promoOut(r), description: r.description }) as PromoInput;

export const findCode = (db: Db, code: string) => db.get<PromoRow>("SELECT * FROM promo_codes WHERE code = ?", [code.trim().toUpperCase()]);
export const listCodes = (db: Db, activeOnly = false) =>
  db.all<PromoRow>(`SELECT * FROM promo_codes ${activeOnly ? "WHERE active = 1" : ""} ORDER BY code`).map(promoOut);

const COLS = ["code", "description", "kind", "value", "applies_to", "valid_from", "valid_to", "min_net_fils", "max_uses", "once_per_customer", "active"];
const vals = (p: PromoInput) => [p.code, p.description, p.kind, p.value, p.appliesTo, p.validFrom, p.validTo, p.minNetFils, p.maxUses, p.oncePerCustomer ? 1 : 0, p.active ? 1 : 0];

export function createCode(db: Db, input: unknown) {
  const p = promoSchema.parse(input);
  if (findCode(db, p.code)) throw conflict(`${p.code} already exists`);
  const id = newId();
  const t = now();
  db.run(`INSERT INTO promo_codes (id, ${COLS.join(", ")}, created_at, updated_at) VALUES (?, ${COLS.map(() => "?").join(", ")}, ?, ?)`, [id, ...vals(p), t, t]);
  return promoOut(db.get<PromoRow>("SELECT * FROM promo_codes WHERE id = ?", [id])!);
}

export function updateCode(db: Db, id: string, input: unknown) {
  const r = db.get<PromoRow>("SELECT * FROM promo_codes WHERE id = ?", [id]);
  if (!r) throw notFound("Promo code not found");
  const p = promoSchema.parse({ ...asInput(r), ...(input as object) });
  // Documents carry the code by name: renaming it would lose its uses and orphan its invoices.
  if (p.code !== r.code && db.get("SELECT 1 FROM documents WHERE promo_code = ?", [r.code])) {
    throw conflict(`${r.code} is already on documents, so its code can't change. Make a new code instead (and switch this one off).`);
  }
  const other = findCode(db, p.code);
  if (other && other.id !== id) throw conflict(`${p.code} already exists`);
  db.run(`UPDATE promo_codes SET ${COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...vals(p), now(), id]);
  return promoOut(db.get<PromoRow>("SELECT * FROM promo_codes WHERE id = ?", [id])!);
}

/** Invoices that used a code: issued, and not fully credited (a full credit note gives the use back). */
const usesSql = `SELECT id, number, customer_id, issued_at, promo_discount_fils FROM documents
  WHERE type = 'invoice' AND status <> 'draft' AND promo_code = ? AND credited_fils < gross_fils`;
export const usesOf = (db: Db, code: string, exceptDocId?: string) =>
  db.all<{ id: string; number: string; customer_id: string; issued_at: string; promo_discount_fils: number }>(usesSql, [code]).filter((u) => u.id !== exceptDocId);

/** Why `code` can't go on this document now, or null. */
export function codeProblem(db: Db, r: PromoRow, doc: { id: string; customer_id: string }, baseFils: number): string | null {
  const uses = usesOf(db, r.code, doc.id);
  return promoProblem(asInput(r), {
    today: dubaiDate(new Date().toISOString()), baseFils, uses: uses.length, usedByCustomer: uses.some((u) => u.customer_id === doc.customer_id),
  });
}

/** The discount an invoice gave, before VAT (its promo lines' net before the promo, less their net now). */
function netDiscount(db: Db, docId: string): number {
  const d = db.get<{ inc: number }>("SELECT prices_include_vat AS inc FROM documents WHERE id = ?", [docId])!;
  return db.all<{ qty: number; unit_price_fils: number; discount_pct: number; net_fils: number }>(
    "SELECT qty, unit_price_fils, discount_pct, net_fils FROM document_lines WHERE document_id = ? AND promo_fils > 0", [docId],
  ).reduce((s, l) => s + lineTotals({ qty: l.qty, unitPriceFils: l.unit_price_fils, discountPct: l.discount_pct }, 500, !!d.inc).netFils - l.net_fils, 0);
}

/** Each code's use: invoices, discount given (before VAT, so documents typed with and without VAT add up). */
export function promoReport(db: Db) {
  return listCodes(db).map((c) => {
    const uses = usesOf(db, c.code).map((u) => ({ ...u, promo_discount_fils: netDiscount(db, u.id) }));
    return {
      ...c, uses: uses.length, discountFils: uses.reduce((s, u) => s + u.promo_discount_fils, 0),
      // An offline PC can issue past the limit; the invoice stands, and the report says so.
      overLimit: (!!c.maxUses && uses.length > c.maxUses) || (c.oncePerCustomer && new Set(uses.map((u) => u.customer_id)).size < uses.length),
      invoices: uses.map((u) => ({ id: u.id, number: u.number, issuedAt: u.issued_at, discountFils: u.promo_discount_fils })),
    };
  });
}
