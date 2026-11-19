import type { FastifyInstance } from "fastify";
import {
  can, CONVERTS_TO, DOC_STATUSES, DOC_TYPES, documentCreateSchema, documentUpdateSchema, formatDocNumber, lineSchema, lineTotals,
  approvalSchema, paymentSchema, prefixOf, type ApprovalInput, type DocType, type LineInput,
} from "@ffgp/shared";
import { z } from "zod";
import { audit } from "../audit";
import { LoginThrottle, requireAction, sessionUser, verifyPassword, type SessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, HttpError, notFound, tooManyRequests } from "../errors";
import { documentCost, reconcileDocumentStock } from "../stock";
import { reserveNumber, takeNumber, type NumberSource, type Reserved } from "../numbering";
import { getSettings } from "../settings";
import { garage } from "./setup";

interface DocRow {
  id: string; type: DocType; seq: number; number: string; status: string; customer_id: string; vehicle_id: string | null;
  odometer: number | null; notes: string | null; source_id: string | null; issued_at: string | null; net_fils: number;
  vat_fils: number; gross_fils: number; paid_fils: number; created_by: string | null; created_at: string; updated_at: string;
  prices_include_vat: number;
}
interface LineRow {
  id: string; position: number; kind: string; description: string; qty: number; unit_price_fils: number;
  discount_pct: number; net_fils: number; vat_fils: number; gross_fils: number; part_id: string | null; supplied_by: string;
  po_line_id: string | null; part_no?: string | null; part_stocked?: number | null; part_on_hand?: number | null; part_unit?: string | null; po_qty?: number | null; po_received?: number | null; po_number?: string | null;
  po_id?: string | null; po_status?: string | null;
}

/** Statuses a user may set by hand; the rest come from convert / issue / payments. */
const MANUAL_STATUSES: Record<DocType, readonly string[]> = {
  estimate: ["draft", "sent", "approved"],
  jobcard: ["open", "in_progress", "completed"],
  invoice: [],
};

function linesEditable(doc: DocRow): boolean {
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
    const before = docId
      ? new Map(db.all<{ position: number; discount_pct: number }>("SELECT position, discount_pct FROM document_lines WHERE document_id = ?", [docId])
          .map((l) => [l.position, l.discount_pct]))
      : new Map<number, number>();
    const over = lines.filter((l, i) => l.discountPct > limit && !((before.get(i) ?? -1) >= l.discountPct));
    if (!over.length) return null;
    const refuse = () => new HttpError(403, `A discount over ${limit}% needs the Owner's approval`, "discount_approval");
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
    return { approvedBy: owner.name, lines: over.map((l) => ({ description: l.description, discountPct: l.discountPct })) };
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
    const existing = db.all<{ po_line_id: string; part_id: string | null; description: string }>(
      "SELECT po_line_id, part_id, description FROM document_lines WHERE document_id = ? AND po_line_id IS NOT NULL ORDER BY position",
      [docId],
    );
    for (const old of existing) {
      if (out.some((l) => l.poLineId === old.po_line_id) || !valid(old.po_line_id)) continue;
      const match = out.find((l) => l.kind === "part" && l.suppliedBy === "garage" && !l.poLineId &&
        (old.part_id ? l.partId === old.part_id : l.description.trim() === old.description));
      if (match) match.poLineId = old.po_line_id;
    }
    return out;
  }

  /** Replaces a document's lines. A job card's stock follows its lines straight away. */
  function writeLines(docId: string, input: LineInput[], userId: string): void {
    for (const l of input) if (l.partId && !db.get("SELECT 1 FROM parts WHERE id = ?", [l.partId])) throw badRequest("Part not found");
    const lines = resolvePoLinks(docId, input);
    db.run("DELETE FROM document_lines WHERE document_id = ?", [docId]);
    const rate = vatRate();
    // Fixed when the document was created, so changing the Tax setting never changes a document's totals.
    const includeVat = !!getDoc(docId)?.prices_include_vat;
    let net = 0, vat = 0, gross = 0;
    lines.forEach((input, i) => {
      // Parts Fleet Fix supplies are never charged to the customer.
      const line = input.suppliedBy === "fleetfix" ? { ...input, unitPriceFils: 0, discountPct: 0 } : input;
      const t = lineTotals(line, rate, includeVat);
      net += t.netFils; vat += t.vatFils; gross += t.grossFils;
      db.run(
        `INSERT INTO document_lines (id, document_id, position, kind, description, qty, unit_price_fils, discount_pct, net_fils, vat_fils, gross_fils,
           part_id, supplied_by, po_line_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(), docId, i, line.kind, line.description, line.qty, line.unitPriceFils, line.discountPct, t.netFils, t.vatFils, t.grossFils,
          line.partId ?? null, line.suppliedBy, line.poLineId ?? null,
        ],
      );
    });
    db.run("UPDATE documents SET net_fils = ?, vat_fils = ?, gross_fils = ?, updated_at = ? WHERE id = ?", [net, vat, gross, now(), docId]);
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
      `INSERT INTO documents (id, type, series, seq, number, status, customer_id, vehicle_id, odometer, notes, source_id, prices_include_vat,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, d.type, series, seq, number, DOC_STATUSES[d.type][0], d.customerId, d.vehicleId, d.odometer, d.notes, d.sourceId, d.pricesIncludeVat ? 1 : 0, user.id, t, t],
    );
    writeLines(id, lines, user.id);
    if (d.vehicleId && d.odometer) {
      db.run("UPDATE vehicles SET odometer = MAX(COALESCE(odometer, 0), ?), updated_at = ? WHERE id = ?", [d.odometer, t, d.vehicleId]);
    }
    return id;
  }

  function full(id: string, user: SessionUser) {
    const d = getDoc(id);
    if (!d) throw notFound("Document not found");
    const lines = db.all<LineRow>(
      `SELECT dl.*, p.part_no, p.stocked AS part_stocked, p.on_hand AS part_on_hand, p.unit AS part_unit, pl.qty AS po_qty, pl.received_qty AS po_received, po.number AS po_number, po.id AS po_id, po.status AS po_status
       FROM document_lines dl
       LEFT JOIN parts p ON p.id = dl.part_id
       LEFT JOIN po_lines pl ON pl.id = dl.po_line_id
       LEFT JOIN purchase_orders po ON po.id = pl.po_id
       WHERE dl.document_id = ? ORDER BY dl.position`,
      [id],
    );
    const cost = can(user.role, "costs.view") ? documentCost(db, id) : null;
    const payments = db.all<{ id: string; amount_fils: number; method: string; reference: string | null; paid_at: string; created_by_name: string | null }>(
      "SELECT p.*, u.name AS created_by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.document_id = ? ORDER BY p.paid_at",
      [id],
    );
    const customer = db.get<Record<string, unknown>>("SELECT id, kind, name, phone, email, trn, address FROM customers WHERE id = ?", [d.customer_id]);
    const vehicle = d.vehicle_id
      ? db.get<Record<string, unknown>>("SELECT id, plate, make, model, year, vin, colour, odometer FROM vehicles WHERE id = ?", [d.vehicle_id])
      : null;
    const source = d.source_id ? db.get<{ id: string; number: string; type: string }>("SELECT id, number, type FROM documents WHERE id = ?", [d.source_id]) : null;
    const derived = db.get<{ id: string; number: string; type: string }>("SELECT id, number, type FROM documents WHERE source_id = ?", [id]) ?? null;
    const createdBy = d.created_by ? db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", [d.created_by])?.name ?? null : null;
    return {
      id: d.id, type: d.type, number: d.number, status: d.status, odometer: d.odometer, notes: d.notes,
      issuedAt: d.issued_at, createdAt: d.created_at, updatedAt: d.updated_at, createdBy,
      editable: linesEditable(d),
      pricesIncludeVat: !!d.prices_include_vat,
      customer, vehicle, source, derived,
      lines: lines.map((l) => ({
        id: l.id, kind: l.kind, description: l.description, qty: l.qty, unitPriceFils: l.unit_price_fils,
        discountPct: l.discount_pct, netFils: l.net_fils, vatFils: l.vat_fils, grossFils: l.gross_fils,
        partId: l.part_id, partNo: l.part_no ?? null,
        partStocked: l.part_id ? !!l.part_stocked : null, partOnHand: l.part_id ? l.part_on_hand ?? null : null, partUnit: l.part_unit ?? null, suppliedBy: l.supplied_by, poLineId: l.po_line_id,
        purchaseOrderId: l.po_id ?? null, purchaseOrderNumber: l.po_number ?? null,
        orderStatus: !l.po_line_id || l.po_status === "cancelled" ? null : (l.po_received ?? 0) >= (l.po_qty ?? 0) ? "received" : "on_order",
        ...(cost ? { costFils: cost.lineCosts.get(l.id) ?? null } : {}),
      })),
      totals: { netFils: d.net_fils, vatFils: d.vat_fils, grossFils: d.gross_fils },
      ...(cost
        ? { partsCostFils: cost.partsCostFils, marginFils: d.net_fils - cost.partsCostFils, costPending: cost.costPending, uncostedLines: cost.uncostedLines }
        : {}),
      paidFils: d.paid_fils,
      balanceFils: d.type === "invoice" ? d.gross_fils - d.paid_fils : 0,
      payments: payments.map((p) => ({ id: p.id, amountFils: p.amount_fils, method: p.method, reference: p.reference, paidAt: p.paid_at, createdBy: p.created_by_name })),
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
         AND (:q IS NULL OR d.number LIKE :like OR c.name LIKE :like OR v.plate LIKE :like OR c.phone LIKE :like)
       ORDER BY d.created_at DESC, d.seq DESC LIMIT 500`,
      { type: type ?? null, status: status ?? null, customer: customerId ?? null, vehicle: vehicleId ?? null, q, like: `%${q ?? ""}%` },
    );
    return {
      documents: rows.map((d) => ({
        id: d.id, type: d.type, number: d.number, status: d.status, customerName: d.customer_name, plate: d.plate,
        grossFils: d.gross_fils, paidFils: d.paid_fils, balanceFils: d.type === "invoice" ? d.gross_fils - d.paid_fils : 0,
        createdAt: d.created_at, issuedAt: d.issued_at,
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
    const reserved = await reserveNumber(numbers, input.type);
    const id = db.tx(() => {
      checkVehicle(input.customerId, input.vehicleId);
      const approved = checkDiscounts(user, null, input.lines, input.approval);
      const docId = insertDoc(user, {
        type: input.type, customerId: input.customerId, vehicleId: input.vehicleId ?? null, odometer: input.odometer ?? null, notes: input.notes,
        sourceId: null, pricesIncludeVat: getSettings(db).tax.pricesIncludeVat,
      }, input.lines, reserved);
      logApproval(user, docId, approved);
      return docId;
    });
    return { document: full(id, user) };
  });

  app.patch<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const input = documentUpdateSchema.parse(req.body);
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      const changesContent = input.lines !== undefined || input.vehicleId !== undefined || input.odometer !== undefined || input.notes !== undefined;
      if (changesContent && !linesEditable(d)) throw conflict(`${d.number} can no longer be edited`);
      if (input.status !== undefined && input.status !== d.status) {
        if (!MANUAL_STATUSES[d.type].includes(input.status)) throw badRequest("That status can't be set directly");
        if (d.status === "converted") throw conflict(`${d.number} has already been converted`);
      }
      if (input.vehicleId !== undefined) checkVehicle(d.customer_id, input.vehicleId);
      db.run(
        `UPDATE documents SET vehicle_id = ?, odometer = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?`,
        [
          input.vehicleId !== undefined ? input.vehicleId : d.vehicle_id,
          input.odometer !== undefined ? input.odometer : d.odometer,
          input.notes !== undefined ? input.notes : d.notes,
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
        partId: l.part_id, suppliedBy: l.supplied_by as LineInput["suppliedBy"], poLineId: l.po_line_id,
      }));
      const newDocId = insertDoc(user, { type: target, customerId: d.customer_id, vehicleId: d.vehicle_id, odometer: d.odometer, notes: d.notes, sourceId: d.id, pricesIncludeVat: !!d.prices_include_vat }, lines, target === convertsTo ? reserved : null);
      db.run("UPDATE documents SET status = 'converted', updated_at = ? WHERE id = ?", [now(), d.id]);
      return newDocId;
    });
    return { document: full(id, user) };
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/issue", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "invoices.issue");
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (d.type !== "invoice") throw badRequest("Only invoices are issued");
      if (d.status !== "draft") throw conflict(`${d.number} is already issued`);
      if (d.gross_fils <= 0) throw badRequest("Add at least one charged line before issuing");
      reconcileDocumentStock(db, d.id, user.id, { block: blockStock() });
      const t = now();
      db.run("UPDATE documents SET status = 'issued', issued_at = ?, updated_at = ? WHERE id = ?", [t, t, d.id]);
    });
    return { document: full(req.params.id, user) };
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/payments", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payments.record");
    const input = paymentSchema.parse(req.body);
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (d.type !== "invoice" || !["issued", "part_paid"].includes(d.status)) throw badRequest("Payments can only be taken on issued, unpaid invoices");
      const balance = d.gross_fils - d.paid_fils;
      if (input.amountFils > balance) throw badRequest("Payment is more than the balance due");
      const t = now();
      db.run("INSERT INTO payments (id, document_id, amount_fils, method, reference, paid_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        newId(), d.id, input.amountFils, input.method, input.reference, input.paidAt ?? t, user.id, t,
      ]);
      const paid = d.paid_fils + input.amountFils;
      db.run("UPDATE documents SET paid_fils = ?, status = ?, updated_at = ? WHERE id = ?", [paid, paid >= d.gross_fils ? "paid" : "part_paid", t, d.id]);
    });
    return { document: full(req.params.id, user) };
  });
  return { full };
}
