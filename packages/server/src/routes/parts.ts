import type { FastifyInstance } from "fastify";
import { adjustmentSchema, can, parseAED, partSchema, supplierSchema, type PartInput } from "@ffgp/shared";
import { z } from "zod";
import { requireAction, sessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { parseCsv } from "../csv";
import { badRequest, conflict, HttpError, notFound } from "../errors";
import { postMovement } from "../stock";

export interface PartRow {
  id: string; part_no: string; name: string; brand: string | null; unit: string; stocked: number; sell_price_fils: number;
  avg_cost_fils: number; on_hand: number; reorder_level: number; location: string | null; fits: string | null; active: number;
  created_at: string; updated_at: string;
}
interface SupplierRow {
  id: string; name: string; trn: string | null; phone: string | null; email: string | null; address: string | null;
  notes: string | null; is_fleetfix: number;
}

export function partOut(p: PartRow, showCost: boolean) {
  return {
    id: p.id, partNo: p.part_no, name: p.name, brand: p.brand, unit: p.unit, stocked: !!p.stocked, sellPriceFils: p.sell_price_fils,
    onHand: p.on_hand, reorderLevel: p.reorder_level, location: p.location, fits: p.fits, active: !!p.active,
    lowStock: !!p.stocked && p.on_hand <= p.reorder_level,
    ...(showCost ? { avgCostFils: p.avg_cost_fils, stockValueFils: Math.round(Math.max(0, p.on_hand) * p.avg_cost_fils) } : {}),
  };
}
export const supplierOut = (s: SupplierRow) => ({
  id: s.id, name: s.name, trn: s.trn, phone: s.phone, email: s.email, address: s.address, notes: s.notes, isFleetfix: !!s.is_fleetfix,
});

const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

export function partRoutes(app: FastifyInstance, db: Db): void {
  const getPart = (id: string) => db.get<PartRow>("SELECT * FROM parts WHERE id = ?", [id]);
  const getSupplier = (id: string) => db.get<SupplierRow>("SELECT * FROM suppliers WHERE id = ?", [id]);

  function assertUniquePartNo(partNo: string, exceptId: string | null) {
    if (db.get("SELECT 1 FROM parts WHERE active = 1 AND part_no = ? COLLATE NOCASE AND id IS NOT ?", [partNo, exceptId])) {
      throw conflict(`Part number ${partNo} is already in the parts list`);
    }
  }

  /** Creates or updates a part's details (not its stock). */
  function savePart(input: PartInput, existing: PartRow | null): string {
    if (input.active) assertUniquePartNo(input.partNo, existing?.id ?? null);
    if (existing && !!existing.stocked !== input.stocked) {
      if (existing.on_hand !== 0) throw conflict("Bring the stock to zero before changing this");
      // Open jobs still hold (or would take) this part's stock; switching now would strand it.
      const open = db.all<{ number: string }>(
        `SELECT DISTINCT d.number FROM document_lines dl JOIN documents d ON d.id = dl.document_id
         WHERE dl.part_id = ? AND ((d.type = 'jobcard' AND d.status <> 'converted') OR (d.type = 'invoice' AND d.status = 'draft'))
         ORDER BY d.number LIMIT 5`,
        [existing.id],
      );
      if (open.length) throw conflict(`This part is on ${open.map((o) => o.number).join(", ")}. Finish those or take the part off them first`);
    }
    const t = now();
    const values = [
      input.partNo, input.name, input.brand ?? null, input.unit, input.stocked ? 1 : 0, input.sellPriceFils, input.reorderLevel,
      input.location ?? null, input.fits ?? null, input.active ? 1 : 0, t,
    ];
    if (existing) {
      db.run(
        `UPDATE parts SET part_no = ?, name = ?, brand = ?, unit = ?, stocked = ?, sell_price_fils = ?, reorder_level = ?, location = ?,
         fits = ?, active = ?, updated_at = ? WHERE id = ?`,
        [...values, existing.id],
      );
      return existing.id;
    }
    const id = newId();
    db.run(
      `INSERT INTO parts (part_no, name, brand, unit, stocked, sell_price_fils, reorder_level, location, fits, active, updated_at, id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, id, t],
    );
    return id;
  }

  app.get<{ Querystring: { q?: string; lowStock?: string; active?: string } }>("/api/parts", async (req) => {
    const user = sessionUser(db, req);
    const q = req.query.q?.trim() || null;
    const rows = db.all<PartRow>(
      `SELECT * FROM parts
       WHERE (:q IS NULL OR part_no LIKE :like ESCAPE '\\' OR name LIKE :like ESCAPE '\\' OR brand LIKE :like ESCAPE '\\' OR fits LIKE :like ESCAPE '\\')
         AND (:low = 0 OR (stocked = 1 AND on_hand <= reorder_level))
         AND (:active IS NULL OR active = :active)
       ORDER BY name COLLATE NOCASE, part_no COLLATE NOCASE LIMIT 300`,
      {
        q, like: like(q ?? ""), low: req.query.lowStock === "1" ? 1 : 0,
        active: req.query.active === "1" ? 1 : req.query.active === "0" ? 0 : null,
      },
    );
    const showCost = can(user.role, "costs.view");
    return { parts: rows.map((p) => partOut(p, showCost)) };
  });

  app.get<{ Params: { id: string } }>("/api/parts/:id", async (req) => {
    const user = sessionUser(db, req);
    const p = getPart(req.params.id);
    if (!p) throw notFound("Part not found");
    const showCost = can(user.role, "costs.view");
    const movements = db.all<{
      id: string; qty: number; unit_cost_fils: number; reason: string; note: string | null; created_at: string;
      document_id: string | null; document_number: string | null; po_number: string | null; po_id: string | null; created_by_name: string | null;
    }>(
      `SELECT m.*, d.number AS document_number, po.number AS po_number, po.id AS po_id, u.name AS created_by_name
       FROM stock_movements m
       LEFT JOIN documents d ON d.id = m.document_id
       LEFT JOIN po_lines pl ON pl.id = m.po_line_id
       LEFT JOIN purchase_orders po ON po.id = pl.po_id
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.part_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 200`,
      [p.id],
    );
    return {
      part: partOut(p, showCost),
      movements: movements.map((m) => ({
        id: m.id, qty: m.qty, reason: m.reason, note: m.note, createdAt: m.created_at, createdBy: m.created_by_name,
        documentId: m.document_id, documentNumber: m.document_number, purchaseOrderId: m.po_id, purchaseOrderNumber: m.po_number,
        ...(showCost ? { unitCostFils: m.unit_cost_fils } : {}),
      })),
    };
  });

  app.post("/api/parts", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "inventory.edit");
    const input = partSchema.parse(req.body);
    const id = db.tx(() => savePart(input, null));
    return { part: partOut(getPart(id)!, true) };
  });

  app.patch<{ Params: { id: string } }>("/api/parts/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "inventory.edit");
    const input = partSchema.parse(req.body);
    db.tx(() => {
      const p = getPart(req.params.id);
      if (!p) throw notFound("Part not found");
      savePart(input, p);
    });
    return { part: partOut(getPart(req.params.id)!, true) };
  });

  app.post<{ Params: { id: string } }>("/api/parts/:id/adjustments", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "inventory.edit");
    const input = adjustmentSchema.parse(req.body);
    db.tx(() => {
      const p = getPart(req.params.id);
      if (!p) throw notFound("Part not found");
      if (!p.stocked) throw badRequest("Only stocked parts have a shelf count");
      if (input.reason === "opening" && (input.qty < 0 || input.unitCostFils === undefined)) {
        throw badRequest("Opening stock needs a quantity in and a cost");
      }
      postMovement(db, {
        partId: p.id, qty: input.qty, reason: input.reason === "opening" ? "opening" : "adjust",
        unitCostFils: input.unitCostFils, note: input.note ?? (input.reason === "opening" ? null : input.reason), userId: user.id,
      });
    });
    return { part: partOut(getPart(req.params.id)!, true) };
  });

  // ---- CSV import ----

  const COLUMNS = ["part_no", "name", "brand", "unit", "stocked", "sell_price", "cost", "qty", "reorder_level", "location", "fits"] as const;
  type Column = (typeof COLUMNS)[number];
  class RollBack extends Error {}

  app.post("/api/parts/import", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "inventory.edit");
    const { csv, dryRun } = z.object({ csv: z.string().max(4_000_000), dryRun: z.boolean().default(false) }).parse(req.body);
    const rows = parseCsv(csv);
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const col = new Map<Column, number>();
    COLUMNS.forEach((c) => { const i = header.indexOf(c); if (i >= 0) col.set(c, i); });
    if (!col.has("part_no") || !col.has("name")) {
      return { created: 0, updated: 0, errors: [{ row: 1, message: "The first row must name the columns, including part_no and name" }] };
    }
    const errors: { row: number; message: string }[] = [];
    let created = 0, updated = 0;
    const seen = new Set<string>();
    try {
      db.tx(() => {
        rows.slice(1).forEach((cells, i) => {
          const rowNo = i + 2;
          const has = (c: Column) => col.has(c);
          const cell = (c: Column) => (cells[col.get(c)!] ?? "").trim();
          const money = (c: Column): number | undefined => {
            if (!has(c) || cell(c) === "") return undefined;
            const v = parseAED(cell(c));
            if (v === null || v < 0) throw badRequest(`${c}: "${cell(c)}" is not an amount`);
            return v;
          };
          const num = (c: Column): number | undefined => {
            if (!has(c) || cell(c) === "") return undefined;
            const v = Number(cell(c));
            if (!Number.isFinite(v) || v < 0) throw badRequest(`${c}: "${cell(c)}" is not a number`);
            return v;
          };
          try {
            const partNo = cell("part_no");
            if (seen.has(partNo.toLowerCase())) throw badRequest(`part_no ${partNo} appears twice in the file`);
            seen.add(partNo.toLowerCase());
            const existing = partNo ? db.get<PartRow>("SELECT * FROM parts WHERE active = 1 AND part_no = ? COLLATE NOCASE", [partNo]) ?? null : null;
            const stockedText = has("stocked") ? cell("stocked").toLowerCase() : "";
            if (stockedText && !["yes", "no", "y", "n", "1", "0", "true", "false"].includes(stockedText)) {
              throw badRequest(`stocked: "${cell("stocked")}" should be yes or no`);
            }
            const text = (c: Column, keep: string | null) => (has(c) ? cell(c) || null : keep);
            const parsed = partSchema.safeParse({
              partNo, name: cell("name"),
              brand: text("brand", existing?.brand ?? null),
              unit: text("unit", existing?.unit ?? null) ?? "each",
              stocked: stockedText ? ["yes", "y", "1", "true"].includes(stockedText) : existing ? !!existing.stocked : true,
              sellPriceFils: money("sell_price") ?? existing?.sell_price_fils ?? 0,
              reorderLevel: num("reorder_level") ?? existing?.reorder_level ?? 0,
              location: text("location", existing?.location ?? null),
              fits: text("fits", existing?.fits ?? null),
              active: true,
            });
            if (!parsed.success) {
              const issue = parsed.error.issues[0];
              throw badRequest(`${String(issue?.path[0] ?? "row")}: ${issue?.message ?? "invalid"}`);
            }
            const cost = money("cost");
            const qty = num("qty");
            const id = savePart(parsed.data, existing);
            if (existing) updated++;
            else {
              created++;
              if (parsed.data.stocked && qty) {
                postMovement(db, { partId: id, qty, reason: "opening", unitCostFils: cost ?? 0, note: "CSV import", userId: user.id });
              }
            }
          } catch (error) {
            if (error instanceof HttpError) errors.push({ row: rowNo, message: error.message });
            else throw error;
          }
        });
        if (errors.length || dryRun) throw new RollBack();
      });
    } catch (error) {
      if (!(error instanceof RollBack)) throw error;
    }
    return errors.length ? { created: 0, updated: 0, errors } : { created, updated, errors };
  });

  // ---- Suppliers ----

  app.get("/api/suppliers", async (req) => {
    sessionUser(db, req);
    const rows = db.all<SupplierRow>("SELECT * FROM suppliers ORDER BY is_fleetfix DESC, name COLLATE NOCASE");
    return { suppliers: rows.map(supplierOut) };
  });

  app.post("/api/suppliers", async (req) => {
    requireAction(sessionUser(db, req), "purchases.manage");
    const s = supplierSchema.parse(req.body);
    const id = newId();
    const t = now();
    db.run(
      "INSERT INTO suppliers (id, name, trn, phone, email, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, s.name, s.trn, s.phone, s.email, s.address, s.notes, t, t],
    );
    return { supplier: supplierOut(getSupplier(id)!) };
  });

  app.patch<{ Params: { id: string } }>("/api/suppliers/:id", async (req) => {
    requireAction(sessionUser(db, req), "purchases.manage");
    const s = supplierSchema.parse(req.body);
    db.tx(() => {
      const existing = getSupplier(req.params.id);
      if (!existing) throw notFound("Supplier not found");
      if (existing.is_fleetfix && s.name !== existing.name) throw conflict("Fleet Fix's name can't be changed");
      db.run(
        "UPDATE suppliers SET name = ?, trn = ?, phone = ?, email = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?",
        [s.name, s.trn, s.phone, s.email, s.address, s.notes, now(), existing.id],
      );
    });
    return { supplier: supplierOut(getSupplier(req.params.id)!) };
  });
}
