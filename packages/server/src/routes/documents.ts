import type { FastifyInstance } from "fastify";
import {
  type ApprovalInput, approvalSchema, can, CONVERTS_TO, creditNoteSchema, DOC_STATUSES, DOC_TYPES, docTotals, type DocType, documentCreateSchema, documentUpdateSchema, dubaiDate, dueDate, formatAED, formatDocNumber, formatNumberOf, issueSchema, type LineCondition, type LineInput, lineSchema, lineTotals, paymentSchema, prefixOf, promoShares, type PromoTerms, discountSchema, discountPct, needsConfirmation, warrantyUntil,
} from "@ffgp/shared";
import { z } from "zod";
import { audit } from "../audit";
import { phoneHas, phoneSearch } from "../phones";
import { checkNotLocked } from "../books/journals";
import { LoginThrottle, requireAction, sessionUser, verifyPassword, type SessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, HttpError, notFound, tooManyRequests } from "../errors";
import { recomputeInvoiceMoney, releaseOverpayment } from "../invoice-money";
import { customerBalance } from "../ledger";
import { checkStockAvailable, costTakenFor, documentCost, kitParts, kitPartsOf, postMovement, reconcileDocumentStock, unchargedPurchases } from "../stock";
import { chainOf, checkLineUnits, lineUnits, returnUnits } from "../units";
import { reserveNumber, takeNumber, type NumberSource, type Reserved } from "../numbering";
import { getSettings } from "../settings";
import { garage } from "./setup";
import { codeProblem, findCode } from "../promo/codes";

interface DocRow {
  id: string; type: DocType; seq: number; number: string; status: string; customer_id: string; vehicle_id: string | null;
  odometer: number | null; notes: string | null; source_id: string | null; issued_at: string | null; net_fils: number;
  vat_fils: number; gross_fils: number; paid_fils: number; created_by: string | null; created_at: string; updated_at: string;
  prices_include_vat: number; credited_fils: number; due_date: string | null; lpo_number: string | null; reason: string | null;
  driver_name: string | null; driver_phone: string | null;
  language: string;
  promo_code: string | null; promo_kind: "percent" | "amount" | null; promo_value: number | null; promo_applies: "all" | "labour" | "parts" | null;
  promo_discount_fils: number; promo_override_by: string | null;
  discount_kind: "percent" | "amount" | null; discount_value: number | null; discount_confirmed_by: string | null; discount_confirmed_at: string | null;
  discount_remark: string | null; discount_confirmed_pct: number | null;
}
interface LineRow {
  id: string; position: number; kind: string; description: string; qty: number; unit_price_fils: number;
  discount_pct: number; net_fils: number; vat_fils: number; gross_fils: number; part_id: string | null; supplied_by: string; part_name_ar?: string | null;
  promo_fils?: number; details?: string | null; unit?: string | null; condition: LineCondition;
  po_condition?: LineCondition | null; po_warranty_days?: number | null; po_purchased_on?: string | null;
  po_line_id: string | null; part_no?: string | null; part_stocked?: number | null; part_on_hand?: number | null; part_unit?: string | null; po_qty?: number | null; po_received?: number | null; po_number?: string | null;
  po_id?: string | null; po_status?: string | null; po_supplier_id?: string | null; po_requested_at?: string | null; po_ordered_at?: string | null; unit_ids_json?: string; part_tracking?: string | null; part_is_kit?: number | null; kit_json?: string | null;
}
const unitIdsOf = (l: { unit_ids_json?: string }) => JSON.parse(l.unit_ids_json || "[]") as string[];

/**
 * A job's part not yet with a vendor: on a request (no vendor), on an order not sent yet, or one that reached an order
 * after it was placed. The advisor sees "Requested" until the vendor has it.
 */
const awaitingVendor = (l: LineRow) =>
  !l.po_supplier_id || l.po_status === "draft" || (!!l.po_requested_at && !l.po_ordered_at && (l.po_received ?? 0) === 0);

/** Statuses a user may set by hand; the rest come from convert / issue / payments. */
const MANUAL_STATUSES: Record<DocType, readonly string[]> = {
  estimate: ["draft", "sent", "approved"],
  jobcard: ["open", "in_progress", "completed"],
  invoice: [],
  credit_note: [],
};

function linesEditable(doc: DocRow): boolean {
  if (doc.type === "credit_note") return false;
  if (doc.type === "invoice") return doc.status === "draft";
  return doc.status !== "converted";
}

export type DocumentOut = (id: string, user: SessionUser) => unknown;

export function documentRoutes(
  app: FastifyInstance,
  db: Db,
  numbers?: NumberSource,
  auth: { throttle: LoginThrottle; clock: () => number } = { throttle: new LoginThrottle(), clock: Date.now },
): { full: DocumentOut } {
  const vatRate = () => garage(db)?.vat_rate_bp ?? 500;
  const blockStock = () => getSettings(db).inventory.belowZero === "block";

  /**
   * Discounts above the user's limit (Settings -> Pricing) need the Owner's username and password. A line that
   * was already on the document at the same position with the same or a bigger discount was approved before.
   * Returns what was approved (for the activity log), or null when nothing needed approving.
   */
  function checkDiscounts(user: SessionUser, docId: string | null, lines: LineInput[], approval: ApprovalInput | undefined) {
    if (user.role === "owner") return null;
    const pricing = getSettings(db).pricing;
    const limit = user.role === "accountant" ? pricing.maxDiscountAccountantPct : pricing.maxDiscountAdvisorPct;
    // Already approved: the very same line (same work or part, quantity and price) at the same place, with the
    // same or a smaller discount. Any other line over the limit, even in an approved line's place, needs approval.
    type Saved = { position: number; kind: string; description: string; qty: number; unit_price_fils: number; part_id: string | null; discount_pct: number };
    const before = docId
      ? new Map(db.all<Saved>("SELECT position, kind, description, qty, unit_price_fils, part_id, discount_pct FROM document_lines WHERE document_id = ?", [docId])
          .map((l) => [l.position, l]))
      : new Map<number, Saved>();
    const approvedBefore = (l: LineInput, i: number) => {
      const b = before.get(i);
      return !!b && b.kind === l.kind && b.description === l.description.trim() && b.qty === l.qty && b.unit_price_fils === l.unitPriceFils &&
        (b.part_id ?? null) === (l.partId ?? null) && b.discount_pct >= l.discountPct;
    };
    const over = lines.filter((l, i) => l.discountPct > limit && !approvedBefore(l, i));
    if (!over.length) return null;
    const approvedBy = ownerApproval(approval, () => new HttpError(403, `A discount over ${limit}% needs the Owner's approval`, "discount_approval"));
    return { approvedBy, lines: over.map((l) => ({ description: l.description, discountPct: l.discountPct })) };
  }

  /**
   * The Owner's username and password typed on the spot (same lockout as signing in). Returns the Owner's name, or
   * throws `refuse()` when missing or wrong.
   */
  function ownerApproval(approval: ApprovalInput | undefined, refuse: () => HttpError): string {
    if (!approval) throw refuse();
    const locked = auth.throttle.lockedMinutes(approval.username, auth.clock());
    if (locked) throw tooManyRequests(`Too many wrong passwords. This login is locked — try again in ${locked} minute${locked === 1 ? "" : "s"}.`);
    const owner = db.get<{ name: string; password_hash: string }>(
      "SELECT name, password_hash FROM users WHERE username = ? AND role = 'owner' AND active = 1",
      [approval.username],
    );
    if (!owner || !verifyPassword(approval.password, owner.password_hash)) {
      auth.throttle.failed(approval.username, auth.clock());
      throw refuse();
    }
    auth.throttle.succeeded(approval.username);
    return owner.name;
  }

  interface CreditCustomer { credit_allowed: number; credit_limit_fils: number; terms_days: number | null; lpo_required: number }
  const creditCustomer = (id: string) =>
    db.get<CreditCustomer>("SELECT credit_allowed, credit_limit_fils, terms_days, lpo_required FROM customers WHERE id = ?", [id]);

  /**
   * Settings → Customers & credit: adding `addFils` to the customer's balance over their credit limit (0 = none)
   * warns, is refused, or needs the Owner's approval. Owners pass themselves. Returns the warning to show and who
   * approved, if anyone.
   */
  function checkCreditLimit(user: SessionUser, customerId: string, addFils: number, approval: ApprovalInput | undefined): { warning?: string; approvedBy?: string } {
    const c = creditCustomer(customerId);
    if (!c || c.credit_limit_fils <= 0) return {};
    const over = customerBalance(db, customerId).balanceFils + addFils - c.credit_limit_fils;
    if (over <= 0) return {};
    const message = `Over the credit limit by ${formatAED(over)}`;
    const rule = getSettings(db).credit.overLimit;
    if (rule === "warn") return { warning: message };
    if (rule === "block") throw new HttpError(409, message, "over_limit");
    if (user.role === "owner") return { warning: message };
    return { approvedBy: ownerApproval(approval, () => new HttpError(403, `${message}. The Owner needs to approve it.`, "credit_approval")) };
  }

  function logApproval(user: SessionUser, docId: string, approved: ReturnType<typeof checkDiscounts>): void {
    if (!approved) return;
    const number = getDoc(docId)?.number ?? null;
    audit(db, { action: "discount.approve", entity: "document", entityId: docId, after: { document: number, ...approved }, userId: user.id });
  }
  const getDoc = (id: string) => db.get<DocRow>("SELECT * FROM documents WHERE id = ?", [id]);

  function nextNumber(type: DocType, reserved: Reserved | null): { series: string; seq: number; number: string } {
    const { series, seq } = takeNumber(db, type, reserved, numbers);
    return { series, seq, number: formatDocNumber(type, seq, series, prefixOf(getSettings(db), type)) };
  }

  /**
   * The server owns each line's link to its purchase-order line: a link the client sends is kept only if it is
   * one of this job's own, live PO lines; a link the client didn't know about (requested on another PC) is
   * carried over to the matching line rather than lost.
   */
  function resolvePoLinks(docId: string, lines: LineInput[]): LineInput[] {
    const doc = getDoc(docId);
    const jobs = [docId, doc?.source_id ?? docId];
    const valid = (poLineId: string) =>
      !!db.get(
        `SELECT 1 FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
         WHERE pl.id = ? AND pl.job_document_id IN (?, ?) AND po.status <> 'cancelled'`,
        [poLineId, ...jobs],
      );
    const out = lines.map((l) => ({ ...l, poLineId: l.kind === "part" && l.suppliedBy === "garage" && l.poLineId && valid(l.poLineId) ? l.poLineId : null }));
    const existing = db.all<{ po_line_id: string; part_id: string | null; description: string; po_condition: string }>(
      `SELECT dl.po_line_id, dl.part_id, dl.description, pl.condition AS po_condition FROM document_lines dl JOIN po_lines pl ON pl.id = dl.po_line_id
       WHERE dl.document_id = ? ORDER BY dl.position`,
      [docId],
    );
    for (const old of existing) {
      if (out.some((l) => l.poLineId === old.po_line_id) || !valid(old.po_line_id)) continue;
      // A used purchase only onto a line that may be used; an ordinary order never onto a line sent as used.
      const fits = (l: LineInput) => (old.po_condition === "used" ? l.condition !== "new" && !l.partId : l.condition !== "used");
      const match = out.find((l) => l.kind === "part" && l.suppliedBy === "garage" && !l.poLineId && fits(l) &&
        (old.part_id ? l.partId === old.part_id : l.description.trim() === old.description));
      if (match) match.poLineId = old.po_line_id;
    }
    return out;
  }

  /**
   * A line's description and unit as they'll be stored: what was sent, or (left out by an older screen) what the
   * line at the same position had, if it is the same line (kind and title). Part lines have no description. Its
   * condition the same way; a line linked to a used purchase is always used (and so has no part of its own).
   */
  function keepDetails<T extends LineInput>(docId: string, lines: T[]): (T & { condition: LineCondition })[] {
    const old = db.all<{ position: number; kind: string; description: string; details: string | null; unit: string | null; condition: LineCondition }>(
      "SELECT position, kind, description, details, unit, condition FROM document_lines WHERE document_id = ?", [docId],
    );
    const same = (o: (typeof old)[number], l: T) => o.kind === l.kind && o.description.trim() === l.description.trim();
    return lines.map((l, i) => {
      // In its place, else moved: the only line with its text (an older screen adding or removing a line above it).
      const moved = old.filter((o) => same(o, l));
      const was = old.find((o) => o.position === i && same(o, l)) ?? (moved.length === 1 && lines.filter((n) => same(moved[0]!, n)).length === 1 ? moved[0] : undefined);
      const details = l.details !== undefined ? l.details : was?.details ?? null;
      const bought = !!l.poLineId && db.get<{ condition: string }>("SELECT condition FROM po_lines WHERE id = ?", [l.poLineId])?.condition === "used";
      const kept = l.condition ?? (l.partId || l.suppliedBy !== "garage" ? "new" : was?.condition ?? "new");
      const condition: LineCondition = l.kind === "part" && (bought || kept === "used") ? "used" : "new";
      return {
        ...l, details: l.kind === "part" ? null : details, unit: l.unit !== undefined ? l.unit : was?.unit ?? null, condition,
        ...(condition === "used" ? { partId: null, unitIds: [] } : {}),
      };
    });
  }

  /** What's spread over the lines: the promo code, else the overall discount, else nothing. */
  function discountTerms(d: DocRow): PromoTerms | null {
    if (d.promo_code && d.promo_kind && d.promo_value !== null && d.promo_applies) return { kind: d.promo_kind, value: d.promo_value, appliesTo: d.promo_applies };
    if (d.discount_kind && d.discount_value !== null) return { kind: d.discount_kind, value: d.discount_value, appliesTo: "all" };
    return null;
  }

  /** A discount's share of the bill (after line discounts; Fleet Fix parts aren't charged) and the garage's limit. */
  function discountShare(d: DocRow, lines: LineInput[], terms: PromoTerms) {
    const charged = lines.map((l) => (l.suppliedBy === "fleetfix" ? { ...l, unitPriceFils: 0, discountPct: 0 } : l));
    const s = promoShares(charged, terms, !!d.prices_include_vat);
    // A percentage is what was typed: rounding to whole fils on a small bill must not push it past the limit.
    const pct = terms.kind === "percent" ? terms.value : discountPct(s.discountFils, s.baseFils);
    return { discountFils: s.discountFils, pct, limit: getSettings(db).pricing.discountConfirmAbovePct };
  }

  /** The overall discount as the screens see it; not applied while a promo code is on the document. */
  function discountInfo(d: DocRow) {
    if (!d.discount_kind || d.discount_value === null) return null;
    const applied = !d.promo_code;
    const { discountFils, pct, limit } = discountShare(d, currentLines(d.id), { kind: d.discount_kind, value: d.discount_value, appliesTo: "all" });
    const confirmedBy = d.discount_confirmed_by ? db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", [d.discount_confirmed_by])?.name ?? null : null;
    return {
      kind: d.discount_kind, value: d.discount_value, discountFils: applied ? discountFils : 0, pct: applied ? pct : 0, applied,
      confirmedBy, confirmedAt: d.discount_confirmed_at, remark: d.discount_remark,
      // A confirmation covers up to the share that was confirmed.
      needsConfirmation: applied && needsConfirmation(pct, limit) && !(d.discount_confirmed_at && pct <= (d.discount_confirmed_pct ?? 0)),
    };
  }

  /** Replaces a document's lines. A job card's stock follows its lines straight away. */
  /** A line as written: a kit line copied from another document keeps the parts its kit had there (kitJson). */
  type LineWrite = LineInput & { kitJson?: string | null };
  function writeLines(docId: string, input: LineWrite[], userId: string): void {
    for (const l of input) if (l.partId && !db.get("SELECT 1 FROM parts WHERE id = ?", [l.partId])) throw badRequest("Part not found");
    const doc = getDoc(docId);
    // Estimates never fit anything; on other documents the tyres and batteries named must be free for this work.
    const withUnits = doc?.type === "estimate" ? input.map((l) => ({ ...l, unitIds: [] })) : input;
    checkLineUnits(db, chainOf(db, docId), withUnits);
    // A kit line keeps the kit's parts as they are now (or as on the line it was copied from), so a later change
    // to the kit never changes what this document took or cost.
    const kitJsons = withUnits.map((l) => {
      if (!l.partId || !db.get<{ is_kit: number }>("SELECT is_kit FROM parts WHERE id = ?", [l.partId])?.is_kit) return l.kitJson ?? null;
      return l.kitJson ?? JSON.stringify(kitParts(db, l.partId));
    });
    const lines = keepDetails(docId, resolvePoLinks(docId, withUnits));
    db.run("DELETE FROM document_lines WHERE document_id = ?", [docId]);
    const rate = vatRate();
    // Fixed when the document was created, so changing the Tax setting never changes a document's totals.
    const includeVat = !!doc?.prices_include_vat;
    // Parts Fleet Fix supplies are never charged to the customer.
    const charged = lines.map((l) => (l.suppliedBy === "fleetfix" ? { ...l, unitPriceFils: 0, discountPct: 0 } : l));
    // A promo code on the document: its discount spread over the lines it applies to, before VAT.
    // Or the document's overall discount, spread the same way over every line (a promo code wins if both arrived).
    const terms = doc ? discountTerms(doc) : null;
    const promo = terms ? promoShares(charged, terms, includeVat) : null;
    let net = 0, vat = 0, gross = 0;
    charged.forEach((base, i) => {
      const line = { ...base, promoFils: promo?.shares[i] ?? 0 };
      const t = lineTotals(line, rate, includeVat);
      net += t.netFils; vat += t.vatFils; gross += t.grossFils;
      db.run(
        `INSERT INTO document_lines (id, document_id, position, kind, description, qty, unit_price_fils, discount_pct, net_fils, vat_fils, gross_fils,
           part_id, supplied_by, po_line_id, promo_fils, unit_ids_json, kit_json, details, unit, condition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(), docId, i, line.kind, line.description, line.qty, line.unitPriceFils, line.discountPct, t.netFils, t.vatFils, t.grossFils,
          line.partId ?? null, line.suppliedBy, line.poLineId ?? null, line.promoFils, JSON.stringify(line.unitIds ?? []),
          line.condition === "used" ? null : kitJsons[i] ?? null, line.details ?? null, line.unit ?? null, line.condition,
        ],
      );
    });
    db.run("UPDATE documents SET net_fils = ?, vat_fils = ?, gross_fils = ?, promo_discount_fils = ?, updated_at = ? WHERE id = ?", [
      net, vat, gross, promo?.discountFils ?? 0, now(), docId,
    ]);
    if (getDoc(docId)?.type === "jobcard") reconcileDocumentStock(db, docId, userId, { block: blockStock() });
  }

  function checkVehicle(customerId: string, vehicleId: string | null | undefined): void {
    if (!db.get("SELECT 1 FROM customers WHERE id = ?", [customerId])) throw notFound("Customer not found");
    if (vehicleId && !db.get("SELECT 1 FROM vehicles WHERE id = ? AND customer_id = ?", [vehicleId, customerId])) {
      throw badRequest("That vehicle doesn't belong to this customer");
    }
  }

  function insertDoc(
    user: SessionUser,
    d: {
      type: DocType; customerId: string; vehicleId: string | null; odometer: number | null; notes: string | null; sourceId: string | null;
      pricesIncludeVat: boolean;
    },
    lines: LineInput[],
    reserved: Reserved | null,
  ): string {
    const id = newId();
    const { series, seq, number } = nextNumber(d.type, reserved);
    const t = now();
    db.run(
      // A new document (converted ones too) is printed in the customer's language as it is now, and keeps it.
      `INSERT INTO documents (id, type, series, seq, number, status, customer_id, vehicle_id, odometer, notes, source_id, prices_include_vat,
         created_by, created_at, updated_at, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT doc_language FROM customers WHERE id = ?))`,
      [id, d.type, series, seq, number, DOC_STATUSES[d.type][0], d.customerId, d.vehicleId, d.odometer, d.notes, d.sourceId, d.pricesIncludeVat ? 1 : 0, user.id, t, t, d.customerId],
    );
    writeLines(id, lines, user.id);
    if (d.vehicleId && d.odometer) {
      db.run("UPDATE vehicles SET odometer = MAX(COALESCE(odometer, 0), ?), updated_at = ? WHERE id = ?", [d.odometer, t, d.vehicleId]);
    }
    return id;
  }

  /** A bought used line's purchase date and warranty (no seller, no cost: every role sees these). */
  function usedWarranty(l: LineRow) {
    const purchasedOn = l.condition === "used" && l.po_condition === "used" ? l.po_purchased_on ?? null : null;
    const warrantyDays = purchasedOn === null ? null : l.po_warranty_days ?? null;
    return { purchasedOn, warrantyDays, warrantyUntil: purchasedOn === null ? null : warrantyUntil(purchasedOn, warrantyDays) };
  }

  function full(id: string, user: SessionUser) {
    const d = getDoc(id);
    if (!d) throw notFound("Document not found");
    const lines = db.all<LineRow>(
      `SELECT dl.*, p.part_no, p.name_ar AS part_name_ar, p.stocked AS part_stocked, p.tracking AS part_tracking, p.is_kit AS part_is_kit, p.on_hand AS part_on_hand, p.unit AS part_unit, pl.qty AS po_qty, pl.received_qty AS po_received, po.number AS po_number, po.id AS po_id, po.status AS po_status, po.supplier_id AS po_supplier_id, pl.requested_at AS po_requested_at, pl.ordered_at AS po_ordered_at,
         pl.condition AS po_condition, pl.warranty_days AS po_warranty_days,
         (SELECT MAX(g.supplier_invoice_date) FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id WHERE gl.po_line_id = pl.id) AS po_purchased_on
       FROM document_lines dl
       LEFT JOIN parts p ON p.id = dl.part_id
       LEFT JOIN po_lines pl ON pl.id = dl.po_line_id
       LEFT JOIN purchase_orders po ON po.id = pl.po_id
       WHERE dl.document_id = ? ORDER BY dl.position`,
      [id],
    );
    const cost = can(user.role, "costs.view") ? documentCost(db, id) : null;
    // Payments on this invoice: its receipt allocations (an undone allocation shows as a negative line).
    const payments = db.all<{ id: string; amount_fils: number; method: string; reference: string | null; paid_at: string; created_by_name: string | null; receipt_number: string; receipt_id: string }>(
      `SELECT a.id, a.amount_fils, r.method, r.reference, r.received_at AS paid_at, r.number AS receipt_number, r.id AS receipt_id, u.name AS created_by_name
       FROM receipt_allocations a JOIN receipts r ON r.id = a.receipt_id LEFT JOIN users u ON u.id = a.created_by
       WHERE a.document_id = ? ORDER BY r.received_at, a.created_at, a.rowid`,
      [id],
    );
    const customer = db.get<Record<string, unknown>>(
      "SELECT id, kind, name, phone, email, trn, address, name_ar AS nameAr, address_ar AS addressAr, doc_language AS docLanguage FROM customers WHERE id = ?",
      [d.customer_id],
    );
    const vehicle = d.vehicle_id
      ? db.get<Record<string, unknown>>("SELECT id, plate, make, model, year, vin, colour, odometer FROM vehicles WHERE id = ?", [d.vehicle_id])
      : null;
    const source = d.source_id
      ? db.get<{ id: string; number: string; type: string; issuedAt: string | null }>("SELECT id, number, type, issued_at AS issuedAt FROM documents WHERE id = ?", [d.source_id])
      : null;
    const derived = db.get<{ id: string; number: string; type: string }>("SELECT id, number, type FROM documents WHERE source_id = ? AND type <> 'credit_note'", [id]) ?? null;
    const creditNotes = d.type === "invoice"
      ? db.all<{ id: string; number: string; gross_fils: number }>("SELECT id, number, gross_fils FROM documents WHERE source_id = ? AND type = 'credit_note' ORDER BY seq", [id])
          .map((c) => ({ id: c.id, number: c.number, grossFils: c.gross_fils }))
      : [];
    const createdBy = d.created_by ? db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", [d.created_by])?.name ?? null : null;
    return {
      id: d.id, type: d.type, number: d.number, status: d.status, odometer: d.odometer, notes: d.notes,
      issuedAt: d.issued_at, createdAt: d.created_at, updatedAt: d.updated_at, createdBy,
      editable: linesEditable(d),
      pricesIncludeVat: !!d.prices_include_vat,
      dueDate: d.due_date, lpoNumber: d.lpo_number, reason: d.reason, language: d.language,
      driverName: d.driver_name, driverPhone: d.driver_phone,
      creditedFils: d.credited_fils,
      owedFils: d.type === "invoice" && d.status !== "draft" ? d.gross_fils - d.credited_fils - d.paid_fils : 0,
      customerBalanceFils: customerBalance(db, d.customer_id).balanceFils,
      printCount: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM document_prints WHERE document_id = ?", [id])!.n,
      customer, vehicle, source, derived, creditNotes,
      lines: lines.map((l) => ({
        id: l.id, kind: l.kind, condition: l.condition, ...usedWarranty(l), description: l.description, details: l.details ?? null, unit: l.unit ?? null, qty: l.qty, unitPriceFils: l.unit_price_fils,
        discountPct: l.discount_pct, netFils: l.net_fils, vatFils: l.vat_fils, grossFils: l.gross_fils, promoFils: l.promo_fils ?? 0,
        partId: l.part_id, partNo: l.part_no ?? null, partNameAr: l.part_name_ar ?? null,
        partStocked: l.part_id ? !!l.part_stocked : null, partOnHand: l.part_id ? l.part_on_hand ?? null : null, partUnit: l.part_unit ?? null, suppliedBy: l.supplied_by, poLineId: l.po_line_id,
        purchaseOrderId: l.po_id ?? null, purchaseOrderNumber: l.po_number ?? null,
        orderStatus: !l.po_line_id || l.po_status === "cancelled" ? null : (l.po_received ?? 0) >= (l.po_qty ?? 0) && (l.po_qty ?? 0) > 0 ? "received" : awaitingVendor(l) ? "requested" : "on_order",
        receivedQty: !l.po_line_id || l.po_status === "cancelled" ? null : l.po_received ?? 0,
        unitIds: unitIdsOf(l), units: lineUnits(db, l.unit_ids_json),
        partTracking: l.part_id && l.part_stocked ? l.part_tracking ?? "none" : "none", partIsKit: !!l.part_is_kit,
        ...(cost ? { costFils: cost.lineCosts.get(l.id) ?? null } : {}),
      })),
      uncharged: unchargedPurchases(db, id).map(({ costFils, ...u }) => (cost ? { ...u, costFils } : u)),
      totals: { netFils: d.net_fils, vatFils: d.vat_fils, grossFils: d.gross_fils },
      promo: d.promo_code ? { code: d.promo_code, kind: d.promo_kind, value: d.promo_value, appliesTo: d.promo_applies, discountFils: d.promo_discount_fils } : null,
      discount: discountInfo(d),
      ...(cost
        ? { partsCostFils: cost.partsCostFils, marginFils: d.net_fils - cost.partsCostFils, costPending: cost.costPending, uncostedLines: cost.uncostedLines }
        : {}),
      paidFils: d.paid_fils,
      balanceFils: d.type === "invoice" ? d.gross_fils - d.credited_fils - d.paid_fils : 0,
      payments: payments.map((p) => ({
        id: p.id, amountFils: p.amount_fils, method: p.method, reference: p.reference, paidAt: p.paid_at, createdBy: p.created_by_name, receiptNumber: p.receipt_number,
        receiptId: p.receipt_id,
      })),
    };
  }

  app.get<{ Querystring: { type?: string; status?: string; q?: string; customerId?: string; vehicleId?: string } }>("/api/documents", async (req) => {
    sessionUser(db, req);
    const { type, status, customerId, vehicleId } = req.query;
    if (type && !DOC_TYPES.includes(type as DocType)) throw badRequest("Unknown document type");
    const q = req.query.q?.trim() || null;
    const rows = db.all<DocRow & { customer_name: string; plate: string | null }>(
      `SELECT d.*, c.name AS customer_name, v.plate FROM documents d
       JOIN customers c ON c.id = d.customer_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
       WHERE (:type IS NULL OR d.type = :type) AND (:status IS NULL OR d.status = :status)
         AND (:customer IS NULL OR d.customer_id = :customer) AND (:vehicle IS NULL OR d.vehicle_id = :vehicle)
         AND (:q IS NULL OR d.number LIKE :like OR c.name LIKE :like OR v.plate LIKE :like OR c.phone LIKE :like OR ${phoneHas("c.phone")})
       ORDER BY d.created_at DESC, d.seq DESC LIMIT 500`,
      { type: type ?? null, status: status ?? null, customer: customerId ?? null, vehicle: vehicleId ?? null, q, like: `%${q ?? ""}%`, digits: phoneSearch(q) },
    );
    return {
      documents: rows.map((d) => ({
        id: d.id, type: d.type, number: d.number, status: d.status, customerName: d.customer_name, plate: d.plate,
        grossFils: d.gross_fils, paidFils: d.paid_fils, balanceFils: d.type === "invoice" ? d.gross_fils - d.credited_fils - d.paid_fils : 0,
        createdAt: d.created_at, issuedAt: d.issued_at, dueDate: d.due_date, creditedFils: d.credited_fils,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const user = sessionUser(db, req);
    return { document: full(req.params.id, user) };
  });

  app.post("/api/documents", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const input = documentCreateSchema.parse(req.body);
    // Everything that can refuse the save runs before a number is taken (on a linked PC, from the cloud's series).
    checkVehicle(input.customerId, input.vehicleId);
    const approved = checkDiscounts(user, null, input.lines, input.approval);
    if (input.type === "jobcard" && blockStock()) checkStockAvailable(db, input.lines, []);
    const limit = input.type === "jobcard"
      ? checkCreditLimit(user, input.customerId, docTotals(input.lines, vatRate(), getSettings(db).tax.pricesIncludeVat).grossFils, input.approval)
      : {};
    const reserved = await reserveNumber(numbers, input.type);
    const id = db.tx(() => {
      checkVehicle(input.customerId, input.vehicleId);
      const docId = insertDoc(user, {
        type: input.type, customerId: input.customerId, vehicleId: input.vehicleId ?? null, odometer: input.odometer ?? null, notes: input.notes,
        sourceId: null, pricesIncludeVat: getSettings(db).tax.pricesIncludeVat,
      }, input.lines, reserved);
      if (input.driverName || input.driverPhone) {
        db.run("UPDATE documents SET driver_name = ?, driver_phone = ? WHERE id = ?", [input.driverName, input.driverPhone, docId]);
      }
      logApproval(user, docId, approved);
      if (limit.approvedBy) {
        const number = getDoc(docId)?.number ?? null;
        audit(db, { action: "credit.override", entity: "document", entityId: docId, after: { document: number, approvedBy: limit.approvedBy }, userId: user.id });
      }
      return docId;
    });
    return { document: full(id, user), ...(limit.warning ? { warning: limit.warning } : {}) };
  });

  app.patch<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const input = documentUpdateSchema.parse(req.body);
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (input.baseUpdatedAt !== undefined && input.baseUpdatedAt !== d.updated_at) {
        throw conflict("This document was changed on another computer. Reload it to see the changes.");
      }
      const changesContent = input.lines !== undefined || input.vehicleId !== undefined || input.odometer !== undefined || input.notes !== undefined
        || input.lpoNumber !== undefined || input.language !== undefined || input.driverName !== undefined || input.driverPhone !== undefined;
      if (changesContent && !linesEditable(d)) throw conflict(`${d.number} can no longer be edited`);
      if (input.status !== undefined && input.status !== d.status) {
        if (!MANUAL_STATUSES[d.type].includes(input.status)) throw badRequest("That status can't be set directly");
        if (d.status === "converted") throw conflict(`${d.number} has already been converted`);
      }
      if (input.vehicleId !== undefined) checkVehicle(d.customer_id, input.vehicleId);
      db.run(
        `UPDATE documents SET vehicle_id = ?, odometer = ?, notes = ?, lpo_number = ?, language = ?, driver_name = ?, driver_phone = ?, status = ?,
           updated_at = ? WHERE id = ?`,
        [
          input.vehicleId !== undefined ? input.vehicleId : d.vehicle_id,
          input.odometer !== undefined ? input.odometer : d.odometer,
          input.notes !== undefined ? input.notes : d.notes,
          input.lpoNumber !== undefined ? input.lpoNumber : d.lpo_number,
          input.language ?? d.language,
          input.driverName !== undefined ? input.driverName : d.driver_name,
          input.driverPhone !== undefined ? input.driverPhone : d.driver_phone,
          input.status ?? d.status,
          now(),
          d.id,
        ],
      );
      if (input.lines) {
        const approved = checkDiscounts(user, d.id, input.lines, input.approval);
        writeLines(d.id, input.lines, user.id);
        logApproval(user, d.id, approved);
      }
    });
    return { document: full(req.params.id, user) };
  });

  app.put<{ Params: { id: string } }>("/api/documents/:id/lines", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const { lines, approval } = z.object({ lines: z.array(lineSchema).max(500), approval: approvalSchema.optional() }).parse(req.body);
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (!linesEditable(d)) throw conflict(`${d.number} can no longer be edited`);
      const approved = checkDiscounts(user, d.id, lines, approval);
      writeLines(d.id, lines, user.id);
      logApproval(user, d.id, approved);
    });
    return { document: full(req.params.id, user) };
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/convert", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const before = getDoc(req.params.id);
    const convertsTo = before && CONVERTS_TO[before.type as DocType];
    if (before && convertsTo === "jobcard" && blockStock()) {
      const lines = db.all<{ kind: string; part_id: string | null; qty: number; supplied_by: string }>(
        "SELECT kind, part_id, qty, supplied_by FROM document_lines WHERE document_id = ?", [before.id],
      ).map((l) => ({ kind: l.kind, partId: l.part_id, qty: l.qty, suppliedBy: l.supplied_by }));
      checkStockAvailable(db, lines, [before.id]);
    }
    // An estimate becoming a job card is where most jobs start: the credit limit applies here too, before a number.
    const { approval } = z.object({ approval: approvalSchema.optional() }).parse(req.body ?? {});
    const limit = before && convertsTo === "jobcard" ? checkCreditLimit(user, before.customer_id, before.gross_fils, approval) : {};
    const reserved = convertsTo ? await reserveNumber(numbers, convertsTo) : null;
    const id = db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      const target = CONVERTS_TO[d.type];
      if (!target) throw badRequest("Invoices can't be converted");
      if (d.status === "converted" || db.get("SELECT 1 FROM documents WHERE source_id = ?", [d.id])) {
        throw conflict(`${d.number} has already been converted`);
      }
      const lines = db.all<LineRow>("SELECT * FROM document_lines WHERE document_id = ? ORDER BY position", [d.id]).map((l) => ({
        kind: l.kind as LineInput["kind"], description: l.description, qty: l.qty, unitPriceFils: l.unit_price_fils, discountPct: l.discount_pct,
        partId: l.part_id, suppliedBy: l.supplied_by as LineInput["suppliedBy"], poLineId: l.po_line_id, unitIds: unitIdsOf(l), kitJson: l.kit_json ?? null,
        details: l.details ?? null, unit: l.unit ?? null, condition: l.condition,
      }));
      const newDocId = insertDoc(user, { type: target, customerId: d.customer_id, vehicleId: d.vehicle_id, odometer: d.odometer, notes: d.notes, sourceId: d.id, pricesIncludeVat: !!d.prices_include_vat }, lines, target === convertsTo ? reserved : null);
      // The overall discount goes with the work, with its confirmation.
      if (d.discount_kind) {
        db.run(
          `UPDATE documents SET discount_kind = ?, discount_value = ?, discount_confirmed_by = ?, discount_confirmed_at = ?, discount_remark = ?,
             discount_confirmed_pct = ? WHERE id = ?`,
          [d.discount_kind, d.discount_value, d.discount_confirmed_by, d.discount_confirmed_at, d.discount_remark, d.discount_confirmed_pct, newDocId],
        );
        if (!d.promo_code) writeLines(newDocId, lines, user.id);
      }
      // The promo code goes with the work (it's checked again when the invoice is issued).
      if (d.promo_code) {
        db.run("UPDATE documents SET promo_code = ?, promo_kind = ?, promo_value = ?, promo_applies = ? WHERE id = ?", [d.promo_code, d.promo_kind, d.promo_value, d.promo_applies, newDocId]);
        writeLines(newDocId, lines, user.id);
      }
      db.run("UPDATE documents SET status = 'converted', updated_at = ? WHERE id = ?", [now(), d.id]);
      if (limit.approvedBy) {
        audit(db, { action: "credit.override", entity: "document", entityId: newDocId, after: { document: getDoc(newDocId)?.number ?? null, approvedBy: limit.approvedBy }, userId: user.id });
      }
      return newDocId;
    });
    return { document: full(id, user), ...(limit.warning ? { warning: limit.warning } : {}) };
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/issue", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "invoices.issue");
    const input = issueSchema.parse(req.body ?? {});
    const result = db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (d.type !== "invoice") throw badRequest("Only invoices are issued");
      if (d.status !== "draft") throw conflict(`${d.number} is already issued`);
      if (d.gross_fils <= 0 && d.promo_code && d.promo_discount_fils > 0) {
        throw badRequest(`Promo ${d.promo_code} takes the whole bill to AED 0.00, and an invoice needs something to charge. Remove the promo, or add a charged line.`);
      }
      if (d.gross_fils <= 0) throw badRequest("Add at least one charged line before issuing");
      if (discountInfo(d)?.needsConfirmation) throw conflict("The discount is above the limit: confirm it with a remark first");
      const c = creditCustomer(d.customer_id)!;
      const lpo = input.lpoNumber ?? d.lpo_number;
      if (c.lpo_required && !lpo) throw badRequest("This customer needs an LPO number on the invoice");
      // A promo code is checked again now: it may have expired or been used up since it was applied.
      if (d.promo_code) {
        const code = findCode(db, d.promo_code);
        // The same base as when it was applied: the matching lines before the promo, before VAT.
        const base = code ? promoShares(currentLines(d.id), { kind: code.kind, value: code.value, appliesTo: code.applies_to }, !!d.prices_include_vat).baseNetFils : 0;
        const problem = code ? codeProblem(db, code, d, base) : "No such code any more";
        if (problem) {
          if (!input.promoOverride || !can(user.role, "credit.override")) throw conflict(`Promo ${d.promo_code}: ${problem}`);
          db.run("UPDATE documents SET promo_override_by = ? WHERE id = ?", [user.id, d.id]);
          audit(db, { action: "promo.override", entity: "document", entityId: d.id, after: { document: d.number, code: d.promo_code, problem }, userId: user.id });
        }
      }
      const limit = checkCreditLimit(user, d.customer_id, d.gross_fils, input.approval);
      // The tyres and batteries named may have been fitted elsewhere since the draft was saved.
      checkLineUnits(db, chainOf(db, d.id), currentLines(d.id));
      reconcileDocumentStock(db, d.id, user.id, { block: blockStock() });
      const t = now();
      const due = dueDate(t, c.terms_days ?? getSettings(db).credit.defaultTermsDays, !!c.credit_allowed);
      db.run("UPDATE documents SET status = 'issued', issued_at = ?, due_date = ?, lpo_number = ?, updated_at = ? WHERE id = ?", [t, due, lpo, t, d.id]);
      if (limit.approvedBy) {
        audit(db, { action: "credit.override", entity: "document", entityId: d.id, after: { document: d.number, approvedBy: limit.approvedBy }, userId: user.id });
      }
      return limit;
    });
    return { document: full(req.params.id, user), ...(result.warning ? { warning: result.warning } : {}) };
  });

  type SourceLine = {
    id: string; position: number; kind: string; description: string; qty: number; unit_price_fils: number; discount_pct: number; part_id: string | null; supplied_by: string;
    part_stocked: number | null; net_fils: number; vat_fils: number; promo_fils: number; unit_ids_json?: string; kit_json?: string | null; part_is_kit?: number | null;
    details: string | null; unit: string | null; condition: LineCondition;
  };

  /**
   * The lines a credit note would take: chosen invoice lines and quantities (or everything still uncredited), each
   * no more than what's left after earlier credit notes. Throws a plain 400 otherwise.
   */
  function creditLines(inv: DocRow, chosen: { lineId: string; qty: number; unitIds?: string[] }[] | undefined): { line: SourceLine; qty: number; unitIds: string[] }[] {
    const lines = db.all<SourceLine>(
      "SELECT dl.*, p.stocked AS part_stocked, p.is_kit AS part_is_kit FROM document_lines dl LEFT JOIN parts p ON p.id = dl.part_id WHERE dl.document_id = ? ORDER BY dl.position",
      [inv.id],
    );
    const left = (l: SourceLine) => {
      const credited = db.get<{ q: number }>(
        `SELECT COALESCE(SUM(cl.qty), 0) AS q FROM document_lines cl JOIN documents c ON c.id = cl.document_id
         WHERE cl.source_line_id = ? AND c.type = 'credit_note' AND c.status = 'issued'`,
        [l.id],
      )!.q;
      return Math.round((l.qty - credited) * 1000) / 1000;
    };
    if (!chosen) {
      const all = lines.map((line) => ({ line, qty: left(line), unitIds: [] as string[] })).filter((x) => x.qty > 0);
      if (!all.length) throw badRequest(`Everything on ${inv.number} has already been credited`);
      return all;
    }
    return chosen.map((c) => {
      const line = lines.find((l) => l.id === c.lineId);
      if (!line) throw badRequest("That line isn't on the invoice");
      const remaining = left(line);
      if (c.qty > remaining) throw badRequest(`Only ${remaining} left to credit on line ${line.position + 1}`);
      return { line, qty: c.qty, unitIds: c.unitIds ?? [] };
    });
  }

  /**
   * A tax credit note against an issued invoice, created and issued in one step. Paid beyond what's now owed, the
   * excess is taken back off the invoice (negative allocations) and becomes the customer's credit; stocked parts
   * go back on the shelf unless the garage says not.
   */
  app.post<{ Params: { id: string } }>("/api/documents/:id/credit-notes", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "credit_notes.issue");
    const input = creditNoteSchema.parse(req.body ?? {});
    const check = () => {
      const inv = getDoc(req.params.id);
      if (!inv) throw notFound("Document not found");
      if (inv.type !== "invoice" || inv.status === "draft") throw badRequest("Only issued invoices can have a credit note");
      return { inv, lines: creditLines(inv, input.lines) };
    };
    check();
    const reserved = await reserveNumber(numbers, "credit_note");
    const id = db.tx(() => {
      const { inv, lines } = check();
      const { series, seq, number } = nextNumber("credit_note", reserved);
      const cnId = newId();
      const t = now();
      db.run(
        `INSERT INTO documents (id, type, series, seq, number, status, customer_id, vehicle_id, odometer, source_id, issued_at, prices_include_vat, reason,
           created_by, created_at, updated_at, language)
         VALUES (?, 'credit_note', ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cnId, series, seq, number, inv.customer_id, inv.vehicle_id, inv.odometer, inv.id, t, inv.prices_include_vat, input.reason, user.id, t, t, inv.language],
      );
      const rate = vatRate();
      let net = 0, vat = 0, gross = 0;
      lines.forEach(({ line, qty, unitIds }, i) => {
        // A line with a promo share credits its own (discounted) amounts in proportion, never the list price; the
        // credit that takes the line's last quantity takes exactly what's left of it (no fil over or short).
        const before = db.get<{ q: number; n: number; v: number }>(
          `SELECT COALESCE(SUM(cl.qty), 0) AS q, COALESCE(SUM(cl.net_fils), 0) AS n, COALESCE(SUM(cl.vat_fils), 0) AS v FROM document_lines cl
           JOIN documents c ON c.id = cl.document_id WHERE cl.source_line_id = ? AND c.type = 'credit_note' AND c.status = 'issued'`, [line.id],
        )!;
        const lastOfLine = Math.round((before.q + qty) * 1000) >= Math.round(line.qty * 1000);
        const share = (v: number, done: number) => (lastOfLine ? v - done : Math.round((v * qty) / line.qty));
        const pn = share(line.net_fils, before.n);
        const pv = share(line.vat_fils, before.v);
        const tt = line.promo_fils > 0
          ? { netFils: pn, vatFils: pv, grossFils: pn + pv }
          : lineTotals({ qty, unitPriceFils: line.unit_price_fils, discountPct: line.discount_pct }, rate, !!inv.prices_include_vat);
        net += tt.netFils; vat += tt.vatFils; gross += tt.grossFils;
        // Tyres and batteries coming back: the ones named (or the line's last ones) go back on the shelf.
        const back = input.returnToStock && line.kind === "part" && line.part_id && line.part_stocked && line.supplied_by === "garage"
          ? returnUnits(db, inv.id, unitIdsOf(line), qty, unitIds, line.description) : [];
        if (unitIds.length && !back.length) throw badRequest("Only parts going back on the shelf take units");
        db.run(
          `INSERT INTO document_lines (id, document_id, position, kind, description, qty, unit_price_fils, discount_pct, net_fils, vat_fils, gross_fils,
             part_id, supplied_by, source_line_id, unit_ids_json, details, unit, condition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId(), cnId, i, line.kind, line.description, qty, line.unit_price_fils, line.discount_pct, tt.netFils, tt.vatFils, tt.grossFils,
            line.part_id, line.supplied_by, line.id, JSON.stringify(back), line.details ?? null, line.unit ?? null, line.condition],
        );
        // Back on the shelf: the part, or a kit's parts (as the kit was when sold).
        const kit = line.kind === "part" && line.part_id && line.supplied_by === "garage" && !line.part_stocked && (line.kit_json || line.part_is_kit) ? kitPartsOf(db, line.part_id, line.kit_json) : [];
        const returns = input.returnToStock && line.kind === "part" && line.part_id && line.supplied_by === "garage"
          ? line.part_stocked ? [{ partId: line.part_id, qty }] : kit.map((c) => ({ partId: c.partId, qty: c.qty * qty }))
          : [];
        for (const r of returns) {
          if (!db.get<{ stocked: number }>("SELECT stocked FROM parts WHERE id = ?", [r.partId])?.stocked) continue;
          const cost = costTakenFor(db, inv.id, r.partId) ?? db.get<{ c: number }>("SELECT avg_cost_fils AS c FROM parts WHERE id = ?", [r.partId])!.c;
          postMovement(db, { partId: r.partId, qty: r.qty, reason: "adjust", unitCostFils: cost, documentId: cnId, note: `Returned on ${number}`, userId: user.id });
        }
      });
      db.run("UPDATE documents SET net_fils = ?, vat_fils = ?, gross_fils = ? WHERE id = ?", [net, vat, gross, cnId]);
      recomputeInvoiceMoney(db, inv.id);
      // Paid more than is now owed: take the excess back off the invoice, newest payments first, as customer credit.
      releaseOverpayment(db, inv.id, user.id);
      audit(db, {
        action: "credit_note.issue", entity: "document", entityId: cnId, userId: user.id,
        after: { creditNote: number, invoice: inv.number, reason: input.reason, amountFils: gross },
      });
      return cnId;
    });
    return { document: full(id, user) };
  });

  /**
   * Records a print of an issued invoice, so the second and later prints say COPY. Prints are rows of their own
   * (an issued invoice is never changed, and prints on two PCs add up). Anything else isn't counted.
   */
  app.post<{ Params: { id: string } }>("/api/documents/:id/prints", async (req) => {
    const user = sessionUser(db, req);
    return db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (!((d.type === "invoice" && d.status !== "draft") || d.type === "credit_note")) return { count: 0 };
      db.run("INSERT INTO document_prints (id, document_id, user_id, printed_at) VALUES (?, ?, ?, ?)", [newId(), d.id, user.id, now()]);
      return { count: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM document_prints WHERE document_id = ?", [d.id])!.n };
    });
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/payments", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payments.record");
    const input = paymentSchema.parse(req.body);
    // A payment dated back into a locked period of the books (or before they start) is refused.
    if (input.paidAt) checkNotLocked(db, dubaiDate(input.paidAt));
    // The invoice screen's "Record payment": a receipt allocated wholly to this invoice.
    const check = () => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (d.type !== "invoice" || !["issued", "part_paid"].includes(d.status)) throw badRequest("Payments can only be taken on issued, unpaid invoices");
      if (input.amountFils > d.gross_fils - d.credited_fils - d.paid_fils) throw badRequest("Payment is more than the balance due");
      return d;
    };
    check();
    const reserved = await reserveNumber(numbers, "receipt");
    db.tx(() => {
      const d = check();
      const { series, seq } = takeNumber(db, "receipt", reserved, numbers);
      const t = now();
      const receiptId = newId();
      db.run(
        `INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, reference, cheque_date, received_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [receiptId, series, seq, formatNumberOf("receipt", seq, series, prefixOf(getSettings(db), "receipt")), d.customer_id, input.amountFils,
          input.method, input.reference, input.paidAt ?? t, user.id, t],
      );
      db.run("INSERT INTO receipt_allocations (id, receipt_id, document_id, amount_fils, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
        newId(), receiptId, d.id, input.amountFils, user.id, t,
      ]);
      recomputeInvoiceMoney(db, d.id);
      db.run("UPDATE documents SET updated_at = ? WHERE id = ?", [t, d.id]);
      const customer = db.get<{ name: string }>("SELECT name FROM customers WHERE id = ?", [d.customer_id])!.name;
      audit(db, {
        action: "receipt.create", entity: "receipt", entityId: receiptId, userId: user.id,
        after: { receipt: formatNumberOf("receipt", seq, series, prefixOf(getSettings(db), "receipt")), customer, amountFils: input.amountFils, allocations: [{ document: d.number, amountFils: input.amountFils }] },
      });
    });
    return { document: full(req.params.id, user) };
  });
  // ── Promo codes on a draft document ─────────────────────────────────────────────────────────────────────────────
  const currentLines = (docId: string): LineWrite[] =>
    db.all<LineRow>("SELECT * FROM document_lines WHERE document_id = ? ORDER BY position", [docId]).map((l) => ({
      kind: l.kind as LineInput["kind"], description: l.description, qty: l.qty, unitPriceFils: l.unit_price_fils, discountPct: l.discount_pct,
      partId: l.part_id, suppliedBy: l.supplied_by as LineInput["suppliedBy"], poLineId: l.po_line_id, unitIds: unitIdsOf(l), kitJson: l.kit_json ?? null,
      details: l.details ?? null, unit: l.unit ?? null, condition: l.condition,
    }));

  app.post<{ Params: { id: string } }>("/api/documents/:id/promo", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const { code } = z.object({ code: z.string().trim().min(1, "Type the code").max(30) }).parse(req.body);
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (!linesEditable(d)) throw conflict(`${d.number} can no longer be edited`);
      if (d.discount_kind) throw conflict("Remove the discount first: a document has a promo code or a discount, not both");
      const r = findCode(db, code);
      if (!r) throw badRequest(`No such code: ${code.toUpperCase()}`);
      const lines = currentLines(d.id);
      const { baseFils, baseNetFils } = promoShares(lines, { kind: r.kind, value: r.value, appliesTo: r.applies_to }, !!d.prices_include_vat);
      if (!baseFils) throw badRequest(`${r.code} applies to ${r.applies_to === "labour" ? "labour" : "parts"}, and there's none on ${d.number}`);
      const problem = codeProblem(db, r, d, baseNetFils);
      if (problem) throw badRequest(`${r.code}: ${problem}`);
      db.run("UPDATE documents SET promo_code = ?, promo_kind = ?, promo_value = ?, promo_applies = ?, promo_override_by = NULL WHERE id = ?", [r.code, r.kind, r.value, r.applies_to, d.id]);
      writeLines(d.id, lines, user.id);
    });
    return { document: full(req.params.id, user) };
  });

  app.delete<{ Params: { id: string } }>("/api/documents/:id/promo", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (!linesEditable(d)) throw conflict(`${d.number} can no longer be edited`);
      db.run("UPDATE documents SET promo_code = NULL, promo_kind = NULL, promo_value = NULL, promo_applies = NULL, promo_override_by = NULL WHERE id = ?", [d.id]);
      writeLines(d.id, currentLines(d.id), user.id);
    });
    return { document: full(req.params.id, user) };
  });

  // ── Overall discount on a document that can still change ───────────────────────────────────────────────────────
  app.put<{ Params: { id: string } }>("/api/documents/:id/discount", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const input = discountSchema.parse(req.body);
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (!linesEditable(d) || d.type === "credit_note") throw conflict(`${d.number} can no longer be edited`);
      if (d.promo_code) throw conflict("Remove the promo code first: a document has a promo code or a discount, not both");
      const lines = currentLines(d.id);
      const { pct, limit } = discountShare(d, lines, { kind: input.kind, value: input.value, appliesTo: "all" });
      const above = needsConfirmation(pct, limit);
      if (above && !(input.confirmed && input.remark)) {
        throw badRequest(`A discount above ${limit}% needs the confirmation ticked and a remark`);
      }
      const t = now();
      db.run(
        `UPDATE documents SET discount_kind = ?, discount_value = ?, discount_confirmed_by = ?, discount_confirmed_at = ?, discount_remark = ?,
           discount_confirmed_pct = ?, updated_at = ? WHERE id = ?`,
        [input.kind, input.value, above ? user.id : null, above ? t : null, above ? input.remark! : null, above ? pct : null, t, d.id],
      );
      writeLines(d.id, lines, user.id);
      if (above) audit(db, { action: "discount.confirm", entity: "document", entityId: d.id, after: { document: d.number, pct, remark: input.remark }, userId: user.id });
    });
    return { document: full(req.params.id, user) };
  });

  app.delete<{ Params: { id: string } }>("/api/documents/:id/discount", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (!linesEditable(d)) throw conflict(`${d.number} can no longer be edited`);
      db.run(
        `UPDATE documents SET discount_kind = NULL, discount_value = NULL, discount_confirmed_by = NULL, discount_confirmed_at = NULL, discount_remark = NULL,
           discount_confirmed_pct = NULL, updated_at = ? WHERE id = ?`,
        [now(), d.id],
      );
      writeLines(d.id, currentLines(d.id), user.id);
    });
    return { document: full(req.params.id, user) };
  });

  return { full };
}
