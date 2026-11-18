import type { FastifyInstance } from "fastify";
import {
  CONVERTS_TO, DOC_STATUSES, DOC_TYPES, documentCreateSchema, documentUpdateSchema, formatDocNumber, lineSchema, lineTotals,
  paymentSchema, type DocType, type LineInput,
} from "@ffgp/shared";
import { z } from "zod";
import { requireAction, sessionUser, type SessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { garage } from "./setup";

interface DocRow {
  id: string; type: DocType; seq: number; number: string; status: string; customer_id: string; vehicle_id: string | null;
  odometer: number | null; notes: string | null; source_id: string | null; issued_at: string | null; net_fils: number;
  vat_fils: number; gross_fils: number; paid_fils: number; created_by: string | null; created_at: string; updated_at: string;
}
interface LineRow {
  id: string; position: number; kind: string; description: string; qty: number; unit_price_fils: number;
  discount_pct: number; net_fils: number; vat_fils: number; gross_fils: number;
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

export function documentRoutes(app: FastifyInstance, db: Db): void {
  const vatRate = () => garage(db)?.vat_rate_bp ?? 500;
  const getDoc = (id: string) => db.get<DocRow>("SELECT * FROM documents WHERE id = ?", [id]);

  function nextNumber(type: DocType): { seq: number; number: string } {
    const row = db.get<{ next: number }>("SELECT next FROM counters WHERE type = ?", [type]);
    const seq = row?.next ?? 1;
    db.run("INSERT INTO counters (type, next) VALUES (?, ?) ON CONFLICT(type) DO UPDATE SET next = excluded.next", [type, seq + 1]);
    return { seq, number: formatDocNumber(type, seq) };
  }

  function writeLines(docId: string, lines: LineInput[]): void {
    db.run("DELETE FROM document_lines WHERE document_id = ?", [docId]);
    const rate = vatRate();
    let net = 0, vat = 0, gross = 0;
    lines.forEach((line, i) => {
      const t = lineTotals(line, rate);
      net += t.netFils; vat += t.vatFils; gross += t.grossFils;
      db.run(
        `INSERT INTO document_lines (id, document_id, position, kind, description, qty, unit_price_fils, discount_pct, net_fils, vat_fils, gross_fils)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), docId, i, line.kind, line.description, line.qty, line.unitPriceFils, line.discountPct, t.netFils, t.vatFils, t.grossFils],
      );
    });
    db.run("UPDATE documents SET net_fils = ?, vat_fils = ?, gross_fils = ?, updated_at = ? WHERE id = ?", [net, vat, gross, now(), docId]);
  }

  function checkVehicle(customerId: string, vehicleId: string | null | undefined): void {
    if (!db.get("SELECT 1 FROM customers WHERE id = ?", [customerId])) throw notFound("Customer not found");
    if (vehicleId && !db.get("SELECT 1 FROM vehicles WHERE id = ? AND customer_id = ?", [vehicleId, customerId])) {
      throw badRequest("That vehicle doesn't belong to this customer");
    }
  }

  function insertDoc(user: SessionUser, d: { type: DocType; customerId: string; vehicleId: string | null; odometer: number | null; notes: string | null; sourceId: string | null }, lines: LineInput[]): string {
    const id = newId();
    const { seq, number } = nextNumber(d.type);
    const t = now();
    db.run(
      `INSERT INTO documents (id, type, seq, number, status, customer_id, vehicle_id, odometer, notes, source_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, d.type, seq, number, DOC_STATUSES[d.type][0], d.customerId, d.vehicleId, d.odometer, d.notes, d.sourceId, user.id, t, t],
    );
    writeLines(id, lines);
    if (d.vehicleId && d.odometer) {
      db.run("UPDATE vehicles SET odometer = MAX(COALESCE(odometer, 0), ?), updated_at = ? WHERE id = ?", [d.odometer, t, d.vehicleId]);
    }
    return id;
  }

  function full(id: string) {
    const d = getDoc(id);
    if (!d) throw notFound("Document not found");
    const lines = db.all<LineRow>("SELECT * FROM document_lines WHERE document_id = ? ORDER BY position", [id]);
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
      customer, vehicle, source, derived,
      lines: lines.map((l) => ({
        id: l.id, kind: l.kind, description: l.description, qty: l.qty, unitPriceFils: l.unit_price_fils,
        discountPct: l.discount_pct, netFils: l.net_fils, vatFils: l.vat_fils, grossFils: l.gross_fils,
      })),
      totals: { netFils: d.net_fils, vatFils: d.vat_fils, grossFils: d.gross_fils },
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
    sessionUser(db, req);
    return { document: full(req.params.id) };
  });

  app.post("/api/documents", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const input = documentCreateSchema.parse(req.body);
    const id = db.tx(() => {
      checkVehicle(input.customerId, input.vehicleId);
      return insertDoc(user, { type: input.type, customerId: input.customerId, vehicleId: input.vehicleId ?? null, odometer: input.odometer ?? null, notes: input.notes, sourceId: null }, input.lines);
    });
    return { document: full(id) };
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
      if (input.lines) writeLines(d.id, input.lines);
    });
    return { document: full(req.params.id) };
  });

  app.put<{ Params: { id: string } }>("/api/documents/:id/lines", async (req) => {
    requireAction(sessionUser(db, req), "documents.edit");
    const { lines } = z.object({ lines: z.array(lineSchema).max(500) }).parse(req.body);
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (!linesEditable(d)) throw conflict(`${d.number} can no longer be edited`);
      writeLines(d.id, lines);
    });
    return { document: full(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/convert", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const id = db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      const target = CONVERTS_TO[d.type];
      if (!target) throw badRequest("Invoices can't be converted");
      if (d.status === "converted" || db.get("SELECT 1 FROM documents WHERE source_id = ?", [d.id])) {
        throw conflict(`${d.number} has already been converted`);
      }
      const lines = db.all<LineRow>("SELECT * FROM document_lines WHERE document_id = ? ORDER BY position", [d.id]).map((l) => ({
        kind: l.kind as LineInput["kind"], description: l.description, qty: l.qty, unitPriceFils: l.unit_price_fils, discountPct: l.discount_pct, suppliedBy: "garage" as const,
      }));
      const newDocId = insertDoc(user, { type: target, customerId: d.customer_id, vehicleId: d.vehicle_id, odometer: d.odometer, notes: d.notes, sourceId: d.id }, lines);
      db.run("UPDATE documents SET status = 'converted', updated_at = ? WHERE id = ?", [now(), d.id]);
      return newDocId;
    });
    return { document: full(id) };
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/issue", async (req) => {
    requireAction(sessionUser(db, req), "invoices.issue");
    db.tx(() => {
      const d = getDoc(req.params.id);
      if (!d) throw notFound("Document not found");
      if (d.type !== "invoice") throw badRequest("Only invoices are issued");
      if (d.status !== "draft") throw conflict(`${d.number} is already issued`);
      if (d.gross_fils <= 0) throw badRequest("Add at least one charged line before issuing");
      const t = now();
      db.run("UPDATE documents SET status = 'issued', issued_at = ?, updated_at = ? WHERE id = ?", [t, t, d.id]);
    });
    return { document: full(req.params.id) };
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
    return { document: full(req.params.id) };
  });
}
