import type { FastifyInstance } from "fastify";
import { applyAdvances } from "../payables/payments";
import { can, defaultPurchaseVat, dubaiDate, formatPoNumber, poLineNetFils, poLineTotalFils, prefixOf, poSchema, poUpdateSchema, receiveSchema, askVendorsSchema, orderRequestSchema, quotePricesSchema, requestPartSchema, requestPartsSchema, roundFils, usedPurchaseSchema, vendorMessageSchema } from "@ffgp/shared";
import { z } from "zod";
import { requireAction, sessionUser, type SessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { page, pageLimit } from "../paging";
import { badRequest, conflict, notFound } from "../errors";
import { addUnits, checkIncomingCodes } from "../units";
import { checkSeller, resolveSeller, usedPartsToBuy } from "../used";
import { postMovement, round3 } from "../stock";
import { orderPrice } from "../inventory/planning";
import type { DocumentOut } from "./documents";
import { getSettings } from "../settings";
import { reserveNumber, takeNumber, type NumberSource, type Reserved } from "../numbering";
import { garage } from "./setup";
import { queueMessage } from "../messages/outbox";
import { openRequests, requestJob, requestQuotes, resolveVendor, vendorMessages } from "../requests";

interface PoRow {
  /** Null: a request for a job card, its vendor not chosen yet. */
  id: string; seq: number; number: string; supplier_id: string | null; status: string; notes: string | null; net_fils: number; version: number;
  created_by: string | null; created_at: string; updated_at: string; job_document_id: string | null;
}
interface PoLineRow {
  id: string; po_id: string; position: number; part_id: string | null; description: string; qty: number; received_qty: number;
  unit_cost_fils: number; job_document_id: string | null; pack_name?: string | null; pack_size?: number | null; pack_cost_fils?: number | null;
  condition?: string; warranty_days?: number | null;
}
type PoLineInput = z.infer<typeof poSchema>["lines"][number] & { id?: string };
type ReceiveInput = z.infer<typeof receiveSchema>;

const lineNet = (qty: number, costFils: number) => roundFils(qty * costFils);
/** A PO line's amount: packs × the pack price when it's priced per pack (see poLineNetFils). */
const poLineNet = (l: Pick<PoLineRow, "qty" | "unit_cost_fils" | "pack_size" | "pack_cost_fils">) =>
  poLineNetFils({ qty: l.qty, unitCostFils: l.unit_cost_fils, packSize: l.pack_size, packCostFils: l.pack_cost_fils });
/** A line priced per pack: its unit cost follows from the pack price (rounded to the fil). */
const withPackCost = (line: PoLineInput): PoLineInput =>
  line.packCostFils !== null && line.packSize ? { ...line, unitCostFils: Math.round(line.packCostFils / line.packSize) } : { ...line, packCostFils: null };

/** Documents that may still change. Issued invoices and converted job cards are never touched. */
const EDITABLE_DOCS = `SELECT id FROM documents WHERE NOT ((type = 'jobcard' AND status = 'converted') OR (type = 'invoice' AND status <> 'draft'))`;

export function purchaseRoutes(app: FastifyInstance, db: Db, docs: { full: DocumentOut }, numbers?: NumberSource, onQueued: () => void = () => {}): void {
  const getPo = (id: string) => db.get<PoRow>("SELECT * FROM purchase_orders WHERE id = ?", [id]);
  const poLines = (poId: string) => db.all<PoLineRow>("SELECT * FROM po_lines WHERE po_id = ? ORDER BY position", [poId]);
  const deliveriesOf = (poLineId: string) =>
    db.all<{ qty: number; unitCostFils: number }>("SELECT qty, unit_cost_fils AS unitCostFils FROM goods_receipt_lines WHERE po_line_id = ?", [poLineId]);
  /** Delivered at what each delivery cost; the rest at the line's price. */
  const lineTotal = (l: PoLineRow) =>
    poLineTotalFils({ qty: l.qty, unitCostFils: l.unit_cost_fils, packSize: l.pack_size, packCostFils: l.pack_cost_fils }, deliveriesOf(l.id));

  function nextPoNumber(reserved: Reserved | null): { series: string; seq: number; number: string } {
    const { series, seq } = takeNumber(db, "purchase_order", reserved, numbers);
    return { series, seq, number: formatPoNumber(seq, series, prefixOf(getSettings(db), "purchase_order")) };
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
    const net = poLines(poId).reduce((sum, l) => sum + lineTotal(l), 0);
    db.run("UPDATE purchase_orders SET net_fils = ?, version = version + 1, updated_at = ? WHERE id = ?", [net, now(), poId]);
  }

  /** Unlinks job lines from PO lines, on documents that can still change only. */
  function unlinkJobs(poLineIdsSql: string, params: string[]) {
    db.run(`UPDATE document_lines SET po_line_id = NULL WHERE po_line_id IN (${poLineIdsSql}) AND document_id IN (${EDITABLE_DOCS})`, params);
  }

  /** A draft purchase order; with no vendor, a job card's request (`jobDocumentId`) waiting for the buyer to choose one. */
  function createPo(user: SessionUser, supplierId: string | null, notes: string | null, reserved: Reserved | null, jobDocumentId: string | null = null): string {
    if (supplierId) checkSupplier(supplierId);
    const { series, seq, number } = nextPoNumber(reserved);
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO purchase_orders (id, series, seq, number, supplier_id, status, notes, created_by, created_at, updated_at, job_document_id)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      [id, series, seq, number, supplierId, notes, user.id, t, t, jobDocumentId],
    );
    return id;
  }

  /** This job card's open request (no vendor yet, not ordered), if there is one. */
  const openRequest = (docId: string) =>
    db.get<{ id: string }>("SELECT id FROM purchase_orders WHERE supplier_id IS NULL AND job_document_id = ? AND status = 'draft' ORDER BY created_at, rowid LIMIT 1", [docId]);

  const NO_VENDOR = "Choose the vendor first";

  /** A job card's line was linked to a purchase: a screen opened before that can't save over it unseen. */
  const touchDocument = (id: string) => db.run("UPDATE documents SET updated_at = ? WHERE id = ?", [now(), id]);

  /** A purchase's day: as typed (not later than today in Dubai), else today. */
  function purchaseDay(typed: string | undefined): string {
    const today = dubaiDate(now());
    if (typed && typed > today) throw badRequest("The purchase date can't be after today");
    return typed ?? today;
  }

  /** The VAT a purchase from this supplier starts at, when none was given. */
  function startingVat(supplierId: string, net: number): number {
    const s = db.get<{ trn: string | null; is_fleetfix: number }>("SELECT trn, is_fleetfix FROM suppliers WHERE id = ?", [supplierId])!;
    return defaultPurchaseVat(net, { trn: s.trn, isFleetfix: !!s.is_fleetfix }, garage(db)?.vat_rate_bp ?? 500);
  }

  function addLine(poId: string, input: PoLineInput, used?: { warrantyDays: number | null }): string {
    checkLineRefs(input);
    const line = withPackCost(input);
    const position = (db.get<{ n: number | null }>("SELECT MAX(position) AS n FROM po_lines WHERE po_id = ?", [poId])?.n ?? -1) + 1;
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO po_lines (id, po_id, position, part_id, description, qty, unit_cost_fils, job_document_id, pack_name, pack_size, pack_cost_fils, condition, warranty_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, poId, position, line.partId ?? null, line.description, line.qty, line.unitCostFils, line.jobDocumentId ?? null, line.packName ?? null, line.packSize ?? null, line.packCostFils ?? null,
        used ? "used" : "new", used?.warrantyDays ?? null, t, t],
    );
    return id;
  }

  /** Replaces a draft PO's lines, keeping the ids of lines that stay so job cards stay linked. */
  function replaceLines(poId: string, lines: PoLineInput[]) {
    const existing = new Map(poLines(poId).map((l) => [l.id, l]));
    const keep = new Set<string>();
    lines.forEach((input, i) => {
      checkLineRefs(input);
      const line = withPackCost(input);
      if (line.id) {
        if (!existing.has(line.id)) throw badRequest("That line isn't on this purchase order");
        keep.add(line.id);
        db.run(
          `UPDATE po_lines SET position = ?, part_id = ?, description = ?, qty = ?, unit_cost_fils = ?, job_document_id = ?, pack_name = ?, pack_size = ?, pack_cost_fils = ?,
           updated_at = ? WHERE id = ?`,
          [i, line.partId ?? null, line.description, line.qty, line.unitCostFils, line.jobDocumentId ?? null, line.packName ?? null, line.packSize ?? null, line.packCostFils ?? null, now(), line.id],
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
    if (!po.supplier_id) throw conflict(NO_VENDOR);
    const lines = new Map(poLines(po.id).map((l) => [l.id, l]));
    const incoming = new Map<string, number>();
    for (const r of input.lines) {
      const line = lines.get(r.poLineId);
      if (!line) throw badRequest("That line isn't on this purchase order");
      const total = round3((incoming.get(r.poLineId) ?? 0) + r.qty);
      if (total > round3(line.qty - line.received_qty)) throw badRequest(`Receiving more than ordered for ${line.description}`);
      incoming.set(r.poLineId, total);
    }
    // Tyres and batteries: each one's DOT code or serial, checked before anything is written.
    const seenCodes = new Set<string>();
    const codes = input.lines.map((r) => {
      const line = lines.get(r.poLineId)!;
      return line.part_id ? checkIncomingCodes(db, line.part_id, r.qty, r.units, line.description, seenCodes) : r.units.length ? (() => { throw badRequest(`${line.description}: this line isn't a part`); })() : [];
    });
    // A part's core deposit (per unit) is part of the supplier's bill; it's owed back until the old unit returns.
    const cores = input.lines.map((r) => {
      const l = lines.get(r.poLineId)!;
      return r.coreFils ?? (l.part_id ? db.get<{ c: number }>("SELECT core_fils AS c FROM parts WHERE id = ?", [l.part_id])?.c ?? 0 : 0);
    });
    // Whole packs at the PO's price are packs × the pack price, like the PO itself.
    const net = input.lines.reduce((sum, r, i) => {
      const l = lines.get(r.poLineId)!;
      return sum + poLineNet({ qty: r.qty, unit_cost_fils: r.unitCostFils, pack_size: l.pack_size, pack_cost_fils: l.pack_cost_fils }) + roundFils(r.qty * cores[i]!);
    }, 0);
    const receiptId = newId();
    const t = now();
    db.run(
      `INSERT INTO goods_receipts (id, po_id, supplier_invoice_no, supplier_invoice_date, net_fils, vat_fils, gross_fils, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [receiptId, po.id, input.supplierInvoiceNo ?? null, input.supplierInvoiceDate ?? null, net, input.vatFils, net + input.vatFils, user.id, t],
    );
    for (const [i, r] of input.lines.entries()) {
      const line = lines.get(r.poLineId)!;
      db.run("INSERT INTO goods_receipt_lines (id, receipt_id, po_line_id, qty, unit_cost_fils, core_fils) VALUES (?, ?, ?, ?, ?, ?)", [
        newId(), receiptId, line.id, r.qty, r.unitCostFils, cores[i]!,
      ]);
      line.received_qty = round3(line.received_qty + r.qty);
      // The line keeps its ordered price for what's still to come (an unpriced line takes the delivery's). Once all
      // in, it shows what was paid on average; a price other than the pack's leaves it priced per unit.
      const all = deliveriesOf(line.id);
      const doneQty = all.reduce((n, d) => n + d.qty, 0);
      const unitCost = line.received_qty >= line.qty
        ? Math.round(all.reduce((s, d) => s + d.qty * d.unitCostFils, 0) / doneQty)
        : line.unit_cost_fils === 0 ? r.unitCostFils : line.unit_cost_fils;
      const packCost = unitCost === line.unit_cost_fils ? line.pack_cost_fils ?? null : null;
      line.unit_cost_fils = unitCost;
      line.pack_cost_fils = packCost;
      db.run("UPDATE po_lines SET received_qty = ?, unit_cost_fils = ?, pack_cost_fils = ?, updated_at = ? WHERE id = ?", [line.received_qty, unitCost, packCost, t, line.id]);
      const stocked = line.part_id ? db.get<{ stocked: number }>("SELECT stocked FROM parts WHERE id = ?", [line.part_id])?.stocked : 0;
      if (line.part_id && stocked) {
        postMovement(db, { partId: line.part_id, qty: r.qty, reason: "receive", unitCostFils: r.unitCostFils, poLineId: line.id, userId: user.id });
        addUnits(db, line.part_id, codes[i]!, r.unitCostFils, line.id);
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
    const supplier = po.supplier_id
      ? db.get<{ id: string; name: string; trn: string | null; phone: string | null; email: string | null; address: string | null; is_fleetfix: number }>(
        "SELECT * FROM suppliers WHERE id = ?",
        [po.supplier_id],
      )!
      : null;
    const lines = db.all<PoLineRow & { part_no: string | null; stocked: number | null; job_number: string | null; tracking: string | null; core_fils: number | null; on_job: number }>(
      `SELECT pl.*, p.part_no, p.stocked, p.tracking, p.core_fils, d.number AS job_number,
         EXISTS (SELECT 1 FROM document_lines dl WHERE dl.po_line_id = pl.id) AS on_job FROM po_lines pl
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
      supplier: supplier && { id: supplier.id, name: supplier.name, trn: supplier.trn, phone: supplier.phone, email: supplier.email, address: supplier.address, isFleetfix: !!supplier.is_fleetfix },
      editable: po.status === "draft",
      /** A job card's request: no vendor yet; the buyer asks vendors for prices, then orders. */
      request: !po.supplier_id && po.status === "draft",
      job: requestJob(db, po.job_document_id),
      quotes: requestQuotes(db, po.id, showCost),
      messages: vendorMessages(db, po.id),
      usedPart: lines.length > 0 && lines.every((l) => l.condition === "used"),
      lines: lines.map((l) => ({
        id: l.id, partId: l.part_id, partNo: l.part_no, stocked: l.stocked === null ? null : !!l.stocked, description: l.description,
        qty: l.qty, receivedQty: l.received_qty, jobDocumentId: l.job_document_id, jobDocumentNumber: l.job_number, onJob: !!l.on_job,
        condition: l.condition ?? "new", warrantyDays: l.warranty_days ?? null,
        packName: l.pack_name ?? null, packSize: l.pack_size ?? null, partTracking: l.part_id && l.stocked ? l.tracking ?? "none" : "none",
        ...(showCost ? { unitCostFils: l.unit_cost_fils, packCostFils: l.pack_cost_fils ?? null, netFils: lineTotal(l), coreFils: l.core_fils ?? 0 } : {}),
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

  app.get<{ Querystring: { status?: string; supplierId?: string; limit?: string } }>("/api/purchase-orders", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const limit = pageLimit(req.query.limit);
    const fetched = db.all<PoRow & { supplier_name: string | null; line_count: number; used_count: number }>(
      `SELECT po.*, s.name AS supplier_name, (SELECT COUNT(*) FROM po_lines WHERE po_id = po.id) AS line_count,
              (SELECT COUNT(*) FROM po_lines WHERE po_id = po.id AND condition = 'used') AS used_count
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE (:status IS NULL OR po.status = :status) AND (:supplier IS NULL OR po.supplier_id = :supplier)
       ORDER BY po.created_at DESC, po.rowid DESC LIMIT :limit`,
      { status: req.query.status ?? null, supplier: req.query.supplierId ?? null, limit: limit + 1 },
    );
    const { rows, more } = page(fetched, limit);
    const showCost = can(user.role, "costs.view");
    return {
      purchaseOrders: rows.map((r) => ({
        id: r.id, number: r.number, status: r.status, supplierId: r.supplier_id, supplierName: r.supplier_name, lineCount: r.line_count,
        usedPart: r.line_count > 0 && r.used_count === r.line_count,
        createdAt: r.created_at, ...(showCost ? { netFils: r.net_fils } : {}),
      })),
      more,
    };
  });

  app.get<{ Params: { id: string } }>("/api/purchase-orders/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    return { purchaseOrder: full(req.params.id, user) };
  });

  app.post("/api/purchase-orders", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const input = poSchema.parse(req.body);
    const reserved = await reserveNumber(numbers, "purchase_order");
    const id = db.tx(() => {
      const poId = createPo(user, input.supplierId, input.notes, reserved);
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
        if (input.status === "sent" && !po.supplier_id) throw conflict(NO_VENDOR);
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
      // An advance already paid to this supplier goes against the parts just received.
      applyAdvances(db, po.supplier_id!, user.id);
    });
    return { purchaseOrder: full(req.params.id, user) };
  });

  /**
   * Suggested orders made into draft purchase orders: one new draft per supplier, priced at the supplier's last
   * price (else the average cost). Returns the drafts made.
   */
  app.post("/api/inventory/suggested-orders", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const { lines } = z.object({
      lines: z.array(z.object({ partId: z.string().uuid(), supplierId: z.string().uuid(), qty: z.number().positive().max(100000) })).min(1, "Nothing to order").max(2000),
    }).parse(req.body);
    const bySupplier = new Map<string, typeof lines>();
    for (const l of lines) bySupplier.set(l.supplierId, [...(bySupplier.get(l.supplierId) ?? []), l]);
    const reserved: (Reserved | null)[] = [];
    for (let i = 0; i < bySupplier.size; i++) reserved.push(await reserveNumber(numbers, "purchase_order"));
    const made = db.tx(() => [...bySupplier.entries()].map(([supplierId, ls], i) => {
      checkSupplier(supplierId);
      const poId = createPo(user, supplierId, null, reserved[i] ?? null);
      for (const l of ls) {
        const p = db.get<{ name: string; part_no: string; stocked: number }>("SELECT name, part_no, stocked FROM parts WHERE id = ?", [l.partId]);
        if (!p) throw badRequest("Part not found");
        addLine(poId, { partId: l.partId, description: `${p.name} (${p.part_no})`, qty: l.qty, unitCostFils: orderPrice(db, l.partId, supplierId), jobDocumentId: null, packName: null, packSize: null, packCostFils: null });
      }
      updateNet(poId);
      return poId;
    }));
    return { purchaseOrders: made.map((id) => full(id, user)) };
  });

  /** A job card that parts can be requested for: open, not converted. */
  function requestableJob(documentId: string) {
    const doc = db.get<{ id: string; type: string; status: string }>("SELECT id, type, status FROM documents WHERE id = ?", [documentId]);
    if (!doc) throw notFound("Document not found");
    if (doc.type !== "jobcard" || doc.status === "converted") throw badRequest("Parts can only be requested from an open job card");
    return doc;
  }

  interface JobLine { id: string; kind: string; supplied_by: string; part_id: string | null; description: string; qty: number; po_line_id: string | null; condition: string; part_stocked: number | null; part_is_kit: number | null }
  const jobLines = (docId: string) => db.all<JobLine>(
    `SELECT dl.*, p.stocked AS part_stocked, p.is_kit AS part_is_kit FROM document_lines dl LEFT JOIN parts p ON p.id = dl.part_id
     WHERE dl.document_id = ? ORDER BY dl.position`, [docId],
  );

  /** Puts a job card's line on its open request (made now with `reserved` when there's none) and links it. */
  function requestLine(user: SessionUser, docId: string, line: JobLine, qty: number, reserved: Reserved | null) {
    const poId = openRequest(docId)?.id ?? createPo(user, null, null, reserved, docId);
    const poLineId = addLine(poId, {
      partId: line.part_id, description: line.description, qty, unitCostFils: 0, jobDocumentId: docId, packName: null, packSize: null, packCostFils: null,
    });
    db.run("UPDATE document_lines SET po_line_id = ? WHERE id = ?", [poLineId, line.id]);
    updateNet(poId);
  }

  /**
   * "Request part" on a job-card line: it goes on this job card's request, an order with no vendor that the buyer
   * prices with vendors (a vendor sent by an older screen is ignored). "Already bought" (Owner/Accountant): bought and
   * received in one step from the shop chosen.
   */
  app.post("/api/purchase-requests", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const input = requestPartSchema.parse(req.body);
    if (input.alreadyBought) {
      requireAction(user, "purchases.manage");
      if (input.unitCostFils === undefined) throw badRequest("Enter what the part cost");
    }
    // A number is only needed for a new order: bought now (its own), or the job card's first request.
    const needsPo = input.alreadyBought || !openRequest(input.documentId);
    const reserved = needsPo ? await reserveNumber(numbers, "purchase_order") : null;
    db.tx(() => {
      const doc = requestableJob(input.documentId);
      const line = db.get<JobLine>("SELECT *, NULL AS part_stocked, NULL AS part_is_kit FROM document_lines WHERE document_id = ? AND position = ?", [doc.id, input.position]);
      if (!line || line.kind !== "part" || line.supplied_by !== "garage") throw badRequest("Only parts the garage buys can be requested");
      if (line.condition === "used") throw badRequest("Use Buy used part");
      if (line.po_line_id) throw badRequest("This line is already requested");
      if (input.description !== undefined && input.description !== line.description) {
        throw conflict("This job card was changed on another PC. Reload it and try again.");
      }
      if (!input.alreadyBought) {
        requestLine(user, doc.id, line, input.qty, reserved);
        touchDocument(doc.id);
        return;
      }
      const supplierId = input.supplierId!;
      checkSupplier(supplierId);
      const poId = createPo(user, supplierId, null, reserved);
      const poLineId = addLine(poId, {
        partId: line.part_id, description: line.description, qty: input.qty, unitCostFils: input.unitCostFils!, jobDocumentId: doc.id,
        packName: null, packSize: null, packCostFils: null,
      });
      db.run("UPDATE document_lines SET po_line_id = ? WHERE id = ?", [poLineId, line.id]);
      touchDocument(doc.id);
      updateNet(poId);
      const net = lineNet(input.qty, input.unitCostFils!);
      const vatFils = input.vatFils ?? startingVat(supplierId, net);
      receive(getPo(poId)!, {
        supplierInvoiceNo: input.supplierInvoiceNo, supplierInvoiceDate: purchaseDay(input.purchasedOn), vatFils,
        lines: [{ poLineId, qty: input.qty, unitCostFils: input.unitCostFils!, units: input.units }],
      }, user);
    });
    return { document: docs.full(input.documentId, user) };
  });

  /** A line "Request parts" takes: a part the garage buys, new, not ordered, with a description, not shelf stock or a kit. */
  const toRequest = (l: JobLine) =>
    l.kind === "part" && l.supplied_by === "garage" && l.condition !== "used" && !l.po_line_id && l.description.trim() !== "" && !l.part_stocked && !l.part_is_kit;

  /** "Request parts" on a job card: every line still to request, on its request, at the line's quantity. */
  app.post("/api/purchase-requests/all", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "documents.edit");
    const { documentId } = requestPartsSchema.parse(req.body);
    requestableJob(documentId);
    if (!jobLines(documentId).some(toRequest)) throw badRequest("Nothing to request");
    const reserved = openRequest(documentId) ? null : await reserveNumber(numbers, "purchase_order");
    db.tx(() => {
      requestableJob(documentId);
      const lines = jobLines(documentId).filter(toRequest);
      if (!lines.length) throw badRequest("Nothing to request");
      for (const l of lines) requestLine(user, documentId, l, l.qty, reserved);
      touchDocument(documentId);
    });
    return { document: docs.full(documentId, user) };
  });

  /**
   * A message to a vendor about this order: asking for prices on a request (the vendor is then one of those asked), or
   * sending the order to its vendor (a draft is then sent). Email is queued; a WhatsApp chat opened on this PC is logged.
   */
  app.post<{ Params: { id: string } }>("/api/purchase-orders/:id/messages", { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const input = vendorMessageSchema.parse(req.body);
    const message = db.tx(() => {
      const po = getPo(req.params.id);
      if (!po) throw notFound("Purchase order not found");
      if (po.status === "cancelled") throw conflict(`${po.number} is cancelled`);
      checkSupplier(input.supplierId);
      if (po.supplier_id && po.supplier_id !== input.supplierId) throw badRequest("That isn't this order's vendor");
      const t = now();
      if (!po.supplier_id) {
        db.run(
          `INSERT INTO po_quotes (id, po_id, supplier_id, asked_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET asked_at = excluded.asked_at, updated_at = excluded.updated_at`,
          [`${po.id}:${input.supplierId}`, po.id, input.supplierId, t, user.id, t, t],
        );
      } else if (po.status === "draft") {
        db.run("UPDATE purchase_orders SET status = 'sent', updated_at = ? WHERE id = ?", [t, po.id]);
        updateNet(po.id);
      }
      return queueMessage(db, {
        event: po.supplier_id ? "purchase_order" : "parts_request", channel: input.channel, customerId: null, employeeId: null, contactId: null,
        documentId: null, receiptId: null, recipient: input.recipient, subject: input.subject, body: input.body, attachment: input.attachment, dedupeKey: null,
        poId: po.id, supplierId: input.supplierId,
      }, user.id);
    });
    if (message.status === "queued") onQueued();
    return { message, purchaseOrder: full(req.params.id, user) };
  });

  /** A job card's request as it stands: refused once it has a vendor or is no longer a draft. */
  function getRequest(id: string) {
    const po = getPo(id);
    if (!po) throw notFound("Purchase order not found");
    if (po.supplier_id || po.status !== "draft") throw conflict(`${po.number} isn't a request any more`);
    return po;
  }

  /** Requests waiting for a vendor, oldest first: nothing requested is forgotten. */
  app.get("/api/parts-requests", async (req) => {
    requireAction(sessionUser(db, req), "purchases.manage");
    return { requests: openRequests(db) };
  });

  /** Vendors to ask for prices on a request (new ones are saved); asking one twice is the same vendor. */
  app.post<{ Params: { id: string } }>("/api/purchase-orders/:id/quotes", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const { vendors } = askVendorsSchema.parse(req.body);
    db.tx(() => {
      const po = getRequest(req.params.id);
      const t = now();
      for (const v of vendors) {
        const supplierId = resolveVendor(db, v);
        db.run("INSERT INTO po_quotes (id, po_id, supplier_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING", [
          `${po.id}:${supplierId}`, po.id, supplierId, user.id, t, t,
        ]);
      }
      db.run("UPDATE purchase_orders SET updated_at = ? WHERE id = ?", [t, po.id]);
    });
    return { purchaseOrder: full(req.params.id, user) };
  });

  /** Vendors' prices on a request, per part (null: they don't have it). */
  app.put<{ Params: { id: string } }>("/api/purchase-orders/:id/quote-prices", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const { prices } = quotePricesSchema.parse(req.body);
    db.tx(() => {
      const po = getRequest(req.params.id);
      const lines = new Set(poLines(po.id).map((l) => l.id));
      const t = now();
      for (const p of prices) {
        const quoteId = `${po.id}:${p.supplierId}`;
        if (!db.get("SELECT 1 FROM po_quotes WHERE id = ?", [quoteId])) throw badRequest("Ask that vendor for prices first");
        if (!lines.has(p.poLineId)) throw badRequest("That line isn't on this request");
        db.run(
          `INSERT INTO po_quote_prices (id, quote_id, po_line_id, unit_cost_fils, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET unit_cost_fils = excluded.unit_cost_fils, updated_at = excluded.updated_at`,
          [`${quoteId}:${p.poLineId}`, quoteId, p.poLineId, p.unitCostFils, t, t],
        );
      }
      db.run("UPDATE purchase_orders SET updated_at = ? WHERE id = ?", [t, po.id]);
    });
    return { purchaseOrder: full(req.params.id, user) };
  });

  /**
   * Orders a request: each vendor's chosen parts become that vendor's order (a draft until it's sent), at its price.
   * The request keeps its number for the vendor of the first part; other vendors get new numbers; parts not chosen
   * move to a new request to ask again.
   */
  app.post<{ Params: { id: string } }>("/api/purchase-orders/:id/order", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const input = orderRequestSchema.parse(req.body);
    /** Vendors in the order of their first part; each with its lines and prices. Refuses what can't be ordered. */
    const plan = () => {
      const po = getRequest(req.params.id);
      if (po.version !== input.version) throw conflict(`${po.number} was changed on another PC. Reload it and try again.`);
      const lines = poLines(po.id);
      const chosen = new Map<string, string>();
      for (const c of input.choices) {
        if (!lines.some((l) => l.id === c.poLineId)) throw badRequest("That line isn't on this request");
        chosen.set(c.poLineId, c.supplierId);
      }
      const groups = new Map<string, { line: PoLineRow; costFils: number }[]>();
      for (const line of lines) {
        const supplierId = chosen.get(line.id);
        if (!supplierId) continue;
        const price = db.get<{ unit_cost_fils: number | null }>("SELECT unit_cost_fils FROM po_quote_prices WHERE id = ?", [`${po.id}:${supplierId}:${line.id}`]);
        if (price?.unit_cost_fils == null) {
          const name = db.get<{ name: string }>("SELECT name FROM suppliers WHERE id = ?", [supplierId])?.name ?? "That vendor";
          throw badRequest(`${name} has no price for ${line.description}`);
        }
        groups.set(supplierId, [...(groups.get(supplierId) ?? []), { line, costFils: price.unit_cost_fils }]);
      }
      return { po, groups: [...groups.entries()], left: lines.filter((l) => !chosen.has(l.id)) };
    };
    const first = plan();
    const reserved: (Reserved | null)[] = [];
    for (let i = 1; i < first.groups.length + (first.left.length ? 1 : 0); i++) reserved.push(await reserveNumber(numbers, "purchase_order"));
    const ids = db.tx(() => {
      const { po, groups, left } = plan();
      if (groups.length + (left.length ? 1 : 0) - 1 > reserved.length) throw conflict(`${po.number} was changed on another PC. Reload it and try again.`);
      const t = now();
      const made: string[] = [];
      const move = (poId: string, line: PoLineRow, position: number, costFils: number | null) =>
        db.run("UPDATE po_lines SET po_id = ?, position = ?, unit_cost_fils = COALESCE(?, unit_cost_fils), pack_cost_fils = NULL, updated_at = ? WHERE id = ?", [poId, position, costFils, t, line.id]);
      groups.forEach(([supplierId, ls], g) => {
        const poId = g === 0 ? po.id : createPo(user, supplierId, null, reserved.shift() ?? null, po.job_document_id);
        if (g === 0) db.run("UPDATE purchase_orders SET supplier_id = ?, updated_at = ? WHERE id = ?", [supplierId, t, po.id]);
        ls.forEach(({ line, costFils }, i) => move(poId, line, i, costFils));
        made.push(poId);
      });
      if (left.length) {
        const again = createPo(user, null, null, reserved.shift() ?? null, po.job_document_id);
        left.forEach((line, i) => move(again, line, i, null));
        made.push(again);
      }
      for (const id of made) updateNet(id);
      if (po.job_document_id) touchDocument(po.job_document_id);
      return made;
    });
    return { purchaseOrders: ids.map((id) => full(id, user)) };
  });

  app.get("/api/used-parts-to-buy", async (req) => {
    requireAction(sessionUser(db, req), "purchases.manage");
    return { items: usedPartsToBuy(db) };
  });

  /** "Buy used part": a used line of an open job card, bought for that job — its own purchase order, already received. */
  app.post("/api/used-purchases", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    const input = usedPurchaseSchema.parse(req.body);
    const purchasedOn = purchaseDay(input.purchasedOn);
    // Everything that can refuse it runs before a number is taken (on a linked PC, from the cloud's series) and again inside.
    const usedLine = () => {
      const doc = db.get<{ id: string; type: string; status: string }>("SELECT id, type, status FROM documents WHERE id = ?", [input.documentId]);
      if (!doc) throw notFound("Document not found");
      if (doc.type !== "jobcard" || doc.status === "converted") throw badRequest("Used parts are bought for an open job card");
      const line = db.get<{ id: string; qty: number; description: string; condition: string; po_line_id: string | null }>(
        "SELECT id, qty, description, condition, po_line_id FROM document_lines WHERE document_id = ? AND position = ?", [doc.id, input.position],
      );
      if (!line || line.description.trim() !== input.description) throw conflict("This job card was changed on another PC. Reload it and try again.");
      if (line.condition !== "used") throw badRequest("Tick Used on this line first");
      if (line.po_line_id) throw badRequest("This part is already bought");
      if (round3(input.qty) < round3(line.qty)) throw badRequest(`Buy at least the ${line.qty} on the job card`);
      return line;
    };
    usedLine();
    checkSeller(db, input.seller, input.bill);
    const reserved = await reserveNumber(numbers, "purchase_order");
    db.tx(() => {
      const line = usedLine();
      const supplierId = resolveSeller(db, input.seller, input.bill);
      const poId = createPo(user, supplierId, null, reserved);
      const poLineId = addLine(poId, {
        partId: null, description: line.description, qty: input.qty, unitCostFils: input.unitCostFils, jobDocumentId: input.documentId,
        packName: null, packSize: null, packCostFils: null,
      }, { warrantyDays: input.warrantyDays });
      db.run("UPDATE document_lines SET po_line_id = ? WHERE id = ?", [poLineId, line.id]);
      touchDocument(input.documentId);
      updateNet(poId);
      receive(getPo(poId)!, {
        supplierInvoiceNo: input.bill?.invoiceNo ?? null, supplierInvoiceDate: purchasedOn, vatFils: input.bill?.vatFils ?? 0,
        lines: [{ poLineId, qty: input.qty, unitCostFils: input.unitCostFils, units: [] }],
      }, user);
      // An advance already paid to this seller goes against it.
      applyAdvances(db, supplierId, user.id);
    });
    return { document: docs.full(input.documentId, user) };
  });
}
