import type { FastifyInstance } from "fastify";
import { can, formatPoNumber, poSchema, poUpdateSchema, receiveSchema, requestPartSchema, roundFils } from "@ffgp/shared";
import { z } from "zod";
import { requireAction, sessionUser, type SessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { postMovement, round3 } from "../stock";
import type { DocumentOut } from "./documents";
import { garage } from "./setup";

interface PoRow {
  id: string; seq: number; number: string; supplier_id: string; status: string; notes: string | null; net_fils: number; version: number;
  created_by: string | null; created_at: string; updated_at: string;
}
interface PoLineRow {
  id: string; po_id: string; position: number; part_id: string | null; description: string; qty: number; received_qty: number;
  unit_cost_fils: number; job_document_id: string | null;
}
type PoLineInput = z.infer<typeof poSchema>["lines"][number] & { id?: string };
type ReceiveInput = z.infer<typeof receiveSchema>;

const lineNet = (qty: number, costFils: number) => roundFils(qty * costFils);

/** Documents that may still change. Issued invoices and converted job cards are never touched. */
const EDITABLE_DOCS = `SELECT id FROM documents WHERE NOT ((type = 'jobcard' AND status = 'converted') OR (type = 'invoice' AND status <> 'draft'))`;

export function purchaseRoutes(app: FastifyInstance, db: Db, docs: { full: DocumentOut }): void {
  const getPo = (id: string) => db.get<PoRow>("SELECT * FROM purchase_orders WHERE id = ?", [id]);
  const poLines = (poId: string) => db.all<PoLineRow>("SELECT * FROM po_lines WHERE po_id = ? ORDER BY position", [poId]);

  function nextPoNumber(): { seq: number; number: string } {
    const row = db.get<{ next: number }>("SELECT next FROM counters WHERE type = 'purchase_order'");
    const seq = row?.next ?? 1;
    db.run("INSERT INTO counters (type, next) VALUES ('purchase_order', ?) ON CONFLICT(type) DO UPDATE SET next = excluded.next", [seq + 1]);
    return { seq, number: formatPoNumber(seq) };
  }

  function checkSupplier(id: string) {
    if (!db.get("SELECT 1 FROM suppliers WHERE id = ?", [id])) throw notFound("Supplier not found");
  }

  function checkLineRefs(line: PoLineInput) {
    if (line.partId && !db.get("SELECT 1 FROM parts WHERE id = ?", [line.partId])) throw badRequest("Part not found");
    if (line.jobDocumentId && !db.get("SELECT 1 FROM documents WHERE id = ?", [line.jobDocumentId])) throw badRequest("Job card not found");
  }

  /** Recomputes the PO total and bumps its version; every change to a PO ends here. */
  function updateNet(poId: string) {
    const net = poLines(poId).reduce((sum, l) => sum + lineNet(l.qty, l.unit_cost_fils), 0);
    db.run("UPDATE purchase_orders SET net_fils = ?, version = version + 1, updated_at = ? WHERE id = ?", [net, now(), poId]);
  }

  /** Unlinks job lines from PO lines, on documents that can still change only. */
  function unlinkJobs(poLineIdsSql: string, params: string[]) {
    db.run(`UPDATE document_lines SET po_line_id = NULL WHERE po_line_id IN (${poLineIdsSql}) AND document_id IN (${EDITABLE_DOCS})`, params);
  }

  function createPo(user: SessionUser, supplierId: string, notes: string | null): string {
    checkSupplier(supplierId);
    const { seq, number } = nextPoNumber();
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO purchase_orders (id, seq, number, supplier_id, status, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [id, seq, number, supplierId, notes, user.id, t, t],
    );
    return id;
  }

  function addLine(poId: string, line: PoLineInput): string {
    checkLineRefs(line);
    const position = (db.get<{ n: number | null }>("SELECT MAX(position) AS n FROM po_lines WHERE po_id = ?", [poId])?.n ?? -1) + 1;
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO po_lines (id, po_id, position, part_id, description, qty, unit_cost_fils, job_document_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, poId, position, line.partId ?? null, line.description, line.qty, line.unitCostFils, line.jobDocumentId ?? null, t, t],
    );
    return id;
  }

  /** Replaces a draft PO's lines, keeping the ids of lines that stay so job cards stay linked. */
  function replaceLines(poId: string, lines: PoLineInput[]) {
    const existing = new Map(poLines(poId).map((l) => [l.id, l]));
    const keep = new Set<string>();
    lines.forEach((line, i) => {
      checkLineRefs(line);
      if (line.id) {
        if (!existing.has(line.id)) throw badRequest("That line isn't on this purchase order");
        keep.add(line.id);
        db.run(
          `UPDATE po_lines SET position = ?, part_id = ?, description = ?, qty = ?, unit_cost_fils = ?, job_document_id = ?, updated_at = ?
           WHERE id = ?`,
          [i, line.partId ?? null, line.description, line.qty, line.unitCostFils, line.jobDocumentId ?? null, now(), line.id],
        );
      } else {
        const id = addLine(poId, line);
        db.run("UPDATE po_lines SET position = ? WHERE id = ?", [i, id]);
      }
    });
    for (const id of existing.keys()) {
      if (keep.has(id)) continue;
      unlinkJobs("?", [id]);
      if (db.get("SELECT 1 FROM document_lines WHERE po_line_id = ?", [id])) {
        throw conflict(`${existing.get(id)!.description} is on an invoiced job, so it can't be removed`);
      }
      db.run("DELETE FROM po_lines WHERE id = ?", [id]);
    }
  }

  /** Records a delivery: a goods receipt, received quantities and costs, and stock for stocked parts. */
  function receive(po: PoRow, input: ReceiveInput, user: SessionUser) {
    if (po.status === "cancelled") throw conflict(`${po.number} is cancelled`);
    const lines = new Map(poLines(po.id).map((l) => [l.id, l]));
    const incoming = new Map<string, number>();
    for (const r of input.lines) {
      const line = lines.get(r.poLineId);
      if (!line) throw badRequest("That line isn't on this purchase order");
      const total = round3((incoming.get(r.poLineId) ?? 0) + r.qty);
      if (total > round3(line.qty - line.received_qty)) throw badRequest(`Receiving more than ordered for ${line.description}`);
      incoming.set(r.poLineId, total);
    }
    const net = input.lines.reduce((sum, r) => sum + lineNet(r.qty, r.unitCostFils), 0);
    const receiptId = newId();
    const t = now();
    db.run(
      `INSERT INTO goods_receipts (id, po_id, supplier_invoice_no, supplier_invoice_date, net_fils, vat_fils, gross_fils, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [receiptId, po.id, input.supplierInvoiceNo ?? null, input.supplierInvoiceDate ?? null, net, input.vatFils, net + input.vatFils, user.id, t],
    );
    for (const r of input.lines) {
      const line = lines.get(r.poLineId)!;
      db.run("INSERT INTO goods_receipt_lines (id, receipt_id, po_line_id, qty, unit_cost_fils) VALUES (?, ?, ?, ?, ?)", [
        newId(), receiptId, line.id, r.qty, r.unitCostFils,
      ]);
      line.received_qty = round3(line.received_qty + r.qty);
      db.run("UPDATE po_lines SET received_qty = ?, unit_cost_fils = ?, updated_at = ? WHERE id = ?", [line.received_qty, r.unitCostFils, t, line.id]);
      const stocked = line.part_id ? db.get<{ stocked: number }>("SELECT stocked FROM parts WHERE id = ?", [line.part_id])?.stocked : 0;
      if (line.part_id && stocked) {
        postMovement(db, { partId: line.part_id, qty: r.qty, reason: "receive", unitCostFils: r.unitCostFils, poLineId: line.id, userId: user.id });
      }
    }
    const done = [...lines.values()].every((l) => l.received_qty >= l.qty);
    db.run("UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?", [done ? "received" : "part_received", t, po.id]);
    updateNet(po.id);
  }

  function full(id: string, user: SessionUser) {
    const po = getPo(id);
    if (!po) throw notFound("Purchase order not found");
    const showCost = can(user.role, "costs.view");
    const supplier = db.get<{ id: string; name: string; trn: string | null; phone: string | null; email: string | null; address: string | null; is_fleetfix: number }>(
      "SELECT * FROM suppliers WHERE id = ?",
      [po.supplier_id],
    )!;
    const lines = db.all<PoLineRow & { part_no: string | null; stocked: number | null; job_number: string | null }>(
      `SELECT pl.*, p.part_no, p.stocked, d.number AS job_number FROM po_lines pl
       LEFT JOIN parts p ON p.id = pl.part_id LEFT JOIN documents d ON d.id = pl.job_document_id
       WHERE pl.po_id = ? ORDER BY pl.position`,
      [id],
    );
    const receipts = db.all<{
      id: string; supplier_invoice_no: string | null; supplier_invoice_date: string | null; net_fils: number; vat_fils: number;
      gross_fils: number; created_at: string; created_by_name: string | null;
    }>(
      "SELECT r.*, u.name AS created_by_name FROM goods_receipts r LEFT JOIN users u ON u.id = r.created_by WHERE r.po_id = ? ORDER BY r.created_at",
      [id],
    );
    const createdBy = po.created_by ? db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", [po.created_by])?.name ?? null : null;
    return {
      id: po.id, number: po.number, status: po.status, version: po.version, notes: po.notes, createdAt: po.created_at, updatedAt: po.updated_at, createdBy,
      supplier: { id: supplier.id, name: supplier.name, trn: supplier.trn, phone: supplier.phone, email: supplier.email, address: supplier.address, isFleetfix: !!supplier.is_fleetfix },
      editable: po.status === "draft",
      lines: lines.map((l) => ({
        id: l.id, partId: l.part_id, partNo: l.part_no, stocked: l.stocked === null ? null : !!l.stocked, description: l.description,
        qty: l.qty, receivedQty: l.received_qty, jobDocumentId: l.job_document_id, jobDocumentNumber: l.job_number,
        ...(showCost ? { unitCostFils: l.unit_cost_fils, netFils: lineNet(l.qty, l.unit_cost_fils) } : {}),
      })),
      ...(showCost
        ? {
            netFils: po.net_fils,
            receipts: receipts.map((r) => ({
              id: r.id, supplierInvoiceNo: r.supplier_invoice_no, supplierInvoiceDate: r.supplier_invoice_date, netFils: r.net_fils,
              vatFils: r.vat_fils, grossFils: r.gross_fils, createdAt: r.created_at, createdBy: r.created_by_name,
            })),
          }
        : {}),
    };
  }

  app.get<{ Querystring: { status?: string; supplierId?: string } }>("/api/purchase-orders", async (req) => {
    const user = sessionUser(db, req);
    const rows = db.all<PoRow & { supplier_name: string; line_count: number }>(
      `SELECT po.*, s.name AS supplier_name, (SELECT COUNT(*) FROM po_lines WHERE po_id = po.id) AS line_count
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       WHERE (:status IS NULL OR po.status = :status) AND (:supplier IS NULL OR po.supplier_id = :supplier)
       ORDER BY po.seq DESC LIMIT 300`,
      { status: req.query.status ?? null, supplier: req.query.supplierId ?? null },
    );
    const showCost = can(user.role, "costs.view");
    return {
      purchaseOrders: rows.map((r) => ({
        id: r.id, number: r.number, status: r.status, supplierId: r.supplier_id, supplierName: r.supplier_name, lineCount: r.line_count,
        createdAt: r.created_at, ...(showCost ? { netFils: r.net_fils } : {}),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/purchase-orders/:id", async (req) => {
    const user = sessionUser(db, req);
    return { purchaseOrder: full(req.params.id, user) };
  });

  app.post("/api/purchase-orders", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const input = poSchema.parse(req.body);
    const id = db.tx(() => {
      const poId = createPo(user, input.supplierId, input.notes);
      for (const line of input.lines) addLine(poId, line);
      updateNet(poId);
      return poId;
    });
    return { purchaseOrder: full(id, user) };
  });

  app.patch<{ Params: { id: string } }>("/api/purchase-orders/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const input = poUpdateSchema.parse(req.body);
    db.tx(() => {
      const po = getPo(req.params.id);
      if (!po) throw notFound("Purchase order not found");
      if (input.version !== undefined && input.version !== po.version) {
        throw conflict(`${po.number} was changed on another PC. Reload it and try again.`);
      }
      if (input.lines) {
        if (po.status !== "draft") throw conflict(`${po.number} has been sent; its lines can't be changed`);
        replaceLines(po.id, input.lines);
        updateNet(po.id);
      }
      if (input.notes !== undefined) db.run("UPDATE purchase_orders SET notes = ? WHERE id = ?", [input.notes, po.id]);
      if (input.status && input.status !== po.status) {
        if (input.status === "sent" && po.status !== "draft") throw conflict(`${po.number} has already been sent`);
        if (input.status === "cancelled") {
          if (poLines(po.id).some((l) => l.received_qty > 0)) throw conflict(`Part of ${po.number} has been received, so it can't be cancelled`);
          unlinkJobs("SELECT id FROM po_lines WHERE po_id = ?", [po.id]);
        }
        db.run("UPDATE purchase_orders SET status = ? WHERE id = ?", [input.status, po.id]);
      }
      updateNet(po.id);
    });
    return { purchaseOrder: full(req.params.id, user) };
  });

  app.post<{ Params: { id: string } }>("/api/purchase-orders/:id/receive", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const input = receiveSchema.parse(req.body);
    db.tx(() => {
      const po = getPo(req.params.id);
      if (!po) throw notFound("Purchase order not found");
      receive(po, input, user);
    });
    return { purchaseOrder: full(req.params.id, user) };
  });

  /** "Request part" on a job-card line: adds it to the supplier's open draft PO, or buys and receives it in one step. */
  app.post("/api/purchase-requests", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const input = requestPartSchema.parse(req.body);
    if (input.alreadyBought) {
      requireAction(user, "purchases.manage");
      if (input.unitCostFils === undefined) throw badRequest("Enter what the part cost");
    }
    db.tx(() => {
      const doc = db.get<{ id: string; type: string; status: string }>("SELECT id, type, status FROM documents WHERE id = ?", [input.documentId]);
      if (!doc) throw notFound("Document not found");
      if (doc.type !== "jobcard" || doc.status === "converted") throw badRequest("Parts can only be requested from an open job card");
      const line = db.get<{ id: string; kind: string; supplied_by: string; part_id: string | null; description: string; po_line_id: string | null }>(
        "SELECT * FROM document_lines WHERE document_id = ? AND position = ?",
        [doc.id, input.position],
      );
      if (!line || line.kind !== "part" || line.supplied_by !== "garage") throw badRequest("Only parts the garage buys can be requested");
      if (line.po_line_id) throw badRequest("This line is already requested");
      if (input.description !== undefined && input.description !== line.description) {
        throw conflict("This job card was changed on another PC. Reload it and try again.");
      }
      checkSupplier(input.supplierId);

      const draft = input.alreadyBought
        ? undefined
        : db.get<{ id: string }>("SELECT id FROM purchase_orders WHERE supplier_id = ? AND status = 'draft' ORDER BY seq DESC LIMIT 1", [input.supplierId]);
      const poId = draft?.id ?? createPo(user, input.supplierId, null);
      const poLineId = addLine(poId, {
        // Only Owner/Accountant buying it now set a cost; a plain request is priced on the PO.
        partId: line.part_id, description: line.description, qty: input.qty, unitCostFils: input.alreadyBought ? input.unitCostFils! : 0, jobDocumentId: doc.id,
      });
      db.run("UPDATE document_lines SET po_line_id = ? WHERE id = ?", [poLineId, line.id]);
      updateNet(poId);
      if (input.alreadyBought) {
        const net = lineNet(input.qty, input.unitCostFils!);
        const vatFils = roundFils((net * (garage(db)?.vat_rate_bp ?? 500)) / 10000);
        receive(getPo(poId)!, {
          supplierInvoiceNo: input.supplierInvoiceNo, supplierInvoiceDate: now().slice(0, 10), vatFils,
          lines: [{ poLineId, qty: input.qty, unitCostFils: input.unitCostFils! }],
        }, user);
      }
    });
    return { document: docs.full(input.documentId, user) };
  });
}
