import { phoneDigits, type VehicleFileKind } from "@ffgp/shared";
import type { z } from "zod";
import type { vendorSchema } from "@ffgp/shared";
import { newId, now, type Db } from "./db";
import { notFound } from "./errors";
import { listMessages } from "./messages/outbox";

/** A request's job card and its vehicle, as the buyer sees it (and what goes to vendors: never the customer). */
export function requestJob(db: Db, jobDocumentId: string | null) {
  if (!jobDocumentId) return null;
  const d = db.get<{ id: string; number: string; vehicle_id: string | null }>("SELECT id, number, vehicle_id FROM documents WHERE id = ?", [jobDocumentId]);
  if (!d) return null;
  const v = d.vehicle_id
    ? db.get<{ id: string; plate: string; make: string | null; model: string | null; year: number | null; engine: string | null; vin: string | null }>(
      "SELECT id, plate, make, model, year, engine, vin FROM vehicles WHERE id = ?", [d.vehicle_id],
    )
    : undefined;
  // Its estimate (made for it, or the one it came from): the buyer is warned before ordering work not approved yet.
  const e = db.get<{ number: string; status: string }>(
    `SELECT number, status FROM documents WHERE type = 'estimate' AND (for_job_id = :job OR id = (SELECT source_id FROM documents WHERE id = :job))
     ORDER BY (for_job_id = :job) DESC LIMIT 1`, { job: d.id },
  );
  return {
    id: d.id, number: d.number, estimate: e ? { number: e.number, status: e.status } : null,
    vehicle: v ? { id: v.id, plate: v.plate, make: v.make, model: v.model, year: v.year, engine: v.engine ?? null, vin: v.vin, mulkiya: mulkiyaOf(db, v.id) } : null,
  };
}

/** Which Mulkiya photos a vehicle has. */
export function mulkiyaOf(db: Db, vehicleId: string): Record<"front" | "back", boolean> {
  const kinds = new Set(db.all<{ kind: VehicleFileKind }>("SELECT kind FROM vehicle_files WHERE vehicle_id = ?", [vehicleId]).map((r) => r.kind));
  return { front: kinds.has("mulkiya_front"), back: kinds.has("mulkiya_back") };
}

/** The vendors asked for prices on a request, in the order asked; their prices only for those who see costs. */
export function requestQuotes(db: Db, poId: string, showCost: boolean) {
  const quotes = db.all<{ id: string; supplier_id: string; name: string; phone: string | null; email: string | null; asked_at: string | null }>(
    `SELECT q.id, q.supplier_id, s.name, s.phone, s.email, q.asked_at FROM po_quotes q JOIN suppliers s ON s.id = q.supplier_id
     WHERE q.po_id = ? ORDER BY q.created_at, q.rowid`, [poId],
  );
  // Parts requested after a vendor was last sent the request: that vendor hasn't seen them (blank isn't "not available").
  const lines = db.all<{ id: string; at: string }>("SELECT id, COALESCE(requested_at, created_at) AS at FROM po_lines WHERE po_id = ? ORDER BY position", [poId]);
  return quotes.map((q) => ({
    supplierId: q.supplier_id, name: q.name, phone: q.phone, email: q.email, askedAt: q.asked_at,
    notSent: q.asked_at ? lines.filter((l) => l.at > q.asked_at!).map((l) => l.id) : [],
    ...(showCost
      ? { prices: db.all<{ poLineId: string; unitCostFils: number | null }>("SELECT po_line_id AS poLineId, unit_cost_fils AS unitCostFils FROM po_quote_prices WHERE quote_id = ?", [q.id]) }
      : {}),
  }));
}

/** What was sent to vendors about this order: requests for prices and the order itself. */
export const vendorMessages = (db: Db, poId: string) => listMessages(db, { purchaseOrderId: poId }, { payslips: false, vendors: true });

/** Open requests (no vendor yet), oldest first, with how far each has got: for the buyer's list. */
export function openRequests(db: Db) {
  const rows = db.all<{ id: string; number: string; created_at: string; job_document_id: string | null; line_count: number; asked: number; priced: number; not_sent: number }>(
    `SELECT po.id, po.number, po.created_at, po.job_document_id,
       (SELECT COUNT(*) FROM po_lines WHERE po_id = po.id) AS line_count,
       (SELECT COUNT(*) FROM po_quotes WHERE po_id = po.id AND asked_at IS NOT NULL) AS asked,
       (SELECT COUNT(DISTINCT q.id) FROM po_quotes q JOIN po_quote_prices p ON p.quote_id = q.id WHERE q.po_id = po.id AND p.unit_cost_fils IS NOT NULL) AS priced,
       (SELECT COUNT(*) FROM po_lines l WHERE l.po_id = po.id AND EXISTS (
          SELECT 1 FROM po_quotes q WHERE q.po_id = po.id AND q.asked_at IS NOT NULL AND q.asked_at < COALESCE(l.requested_at, l.created_at))) AS not_sent
     FROM purchase_orders po WHERE po.supplier_id IS NULL AND po.status = 'draft' ORDER BY po.created_at, po.rowid`,
  );
  return rows.map((r) => {
    const job = requestJob(db, r.job_document_id);
    return {
      id: r.id, number: r.number, createdAt: r.created_at, jobDocumentId: job?.id ?? null, jobDocumentNumber: job?.number ?? null,
      vehicle: job?.vehicle ? { plate: job.vehicle.plate, make: job.vehicle.make, model: job.vehicle.model, year: job.vehicle.year } : null,
      lineCount: r.line_count, asked: r.asked, priced: r.priced, notSent: r.not_sent,
    };
  });
}

/** Orders made from job cards' requests and not sent to their vendor yet: the advisor still sees them as requested. */
export const unsentOrders = (db: Db) =>
  db.all<{ id: string; number: string; supplierName: string; lineCount: number; createdAt: string; jobDocumentNumber: string | null }>(
    `SELECT po.id, po.number, s.name AS supplierName, (SELECT COUNT(*) FROM po_lines WHERE po_id = po.id) AS lineCount, po.created_at AS createdAt,
       d.number AS jobDocumentNumber
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN documents d ON d.id = po.job_document_id
     WHERE po.status = 'draft' AND po.job_document_id IS NOT NULL ORDER BY po.created_at, po.rowid`,
  );

/** Parts that reached an order after it was placed (requested on another computer meanwhile): never ordered from the vendor. */
export const lateParts = (db: Db) =>
  db.all<{ poLineId: string; purchaseOrderId: string; purchaseOrderNumber: string; supplierName: string; description: string; qty: number; jobDocumentNumber: string | null }>(
    `SELECT pl.id AS poLineId, po.id AS purchaseOrderId, po.number AS purchaseOrderNumber, s.name AS supplierName, pl.description, pl.qty,
       d.number AS jobDocumentNumber
     FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN documents d ON d.id = pl.job_document_id
     WHERE po.status <> 'cancelled' AND pl.requested_at IS NOT NULL AND pl.ordered_at IS NULL AND pl.received_qty = 0
     ORDER BY pl.requested_at, pl.rowid`,
  );

type Vendor = z.infer<typeof vendorSchema>;
interface SupplierRow { id: string; name: string; phone: string | null; email: string | null }

/**
 * The saved vendor this is: picked, or the one with the same phone (however it's written), or one of the same name
 * without a phone; a new one is saved. A phone or email typed for a saved vendor without one is kept. Call inside db.tx.
 */
export function resolveVendor(db: Db, vendor: Vendor): string {
  const t = now();
  if ("supplierId" in vendor) {
    if (!db.get("SELECT 1 FROM suppliers WHERE id = ?", [vendor.supplierId])) throw notFound("Supplier not found");
    return vendor.supplierId;
  }
  const all = db.all<SupplierRow>("SELECT id, name, phone, email FROM suppliers WHERE is_fleetfix = 0 ORDER BY created_at, rowid");
  const digits = phoneDigits(vendor.phone ?? "");
  const named = (s: SupplierRow) => s.name.trim().toLowerCase() === vendor.name.trim().toLowerCase();
  const saved = (digits ? all.find((s) => phoneDigits(s.phone ?? "") === digits) : undefined) ?? all.find((s) => named(s) && (!digits || !s.phone?.trim()));
  if (saved) {
    if (digits && !saved.phone?.trim()) db.run("UPDATE suppliers SET phone = ?, updated_at = ? WHERE id = ?", [vendor.phone, t, saved.id]);
    if (vendor.email && !saved.email?.trim()) db.run("UPDATE suppliers SET email = ?, updated_at = ? WHERE id = ?", [vendor.email, t, saved.id]);
    return saved.id;
  }
  const id = newId();
  db.run("INSERT INTO suppliers (id, name, phone, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [id, vendor.name, vendor.phone, vendor.email, t, t]);
  return id;
}
