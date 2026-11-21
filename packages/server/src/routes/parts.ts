import type { FastifyInstance } from "fastify";
import { adjustmentSchema, can, categorySchema, normalizeNumber, parseAED, partSchema, supplierSchema, type PartInput } from "@ffgp/shared";
import { addFitment, categoryOut, chainFrom, fitmentsOf, fitRank, getCategory, matchedBy, numbersOf, packsOf, saveCatalogue, supersede, type CategoryRow, type VehicleFit } from "../catalogue";
import { z } from "zod";
import { requireAction, sessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { parseCsv } from "../csv";
import { badRequest, conflict, HttpError, notFound } from "../errors";
import { postMovement } from "../stock";

export interface PartRow {
  id: string; part_no: string; name: string; brand: string | null; unit: string; stocked: number; sell_price_fils: number;
  avg_cost_fils: number; on_hand: number; reorder_level: number; location: string | null; fits: string | null; active: number;
  created_at: string; updated_at: string; name_ar: string | null;
  category_id: string | null; attributes_json: string; spec_text: string; superseded_by: string | null;
}
interface SupplierRow {
  id: string; name: string; trn: string | null; phone: string | null; email: string | null; address: string | null;
  notes: string | null; is_fleetfix: number; terms_days: number; opening_balance_fils: number; opening_balance_date: string | null;
}

export function partOut(p: PartRow, showCost: boolean) {
  return {
    id: p.id, partNo: p.part_no, name: p.name, nameAr: p.name_ar, brand: p.brand, unit: p.unit, stocked: !!p.stocked, sellPriceFils: p.sell_price_fils,
    onHand: p.on_hand, reorderLevel: p.reorder_level, location: p.location, fits: p.fits, active: !!p.active,
    lowStock: !!p.stocked && p.on_hand <= p.reorder_level,
    categoryId: p.category_id, attributes: JSON.parse(p.attributes_json || "{}") as Record<string, string | number>, supersededById: p.superseded_by,
    ...(showCost ? { avgCostFils: p.avg_cost_fils, stockValueFils: Math.round(Math.max(0, p.on_hand) * p.avg_cost_fils) } : {}),
  };
}
export const supplierOut = (s: SupplierRow) => ({
  id: s.id, name: s.name, trn: s.trn, phone: s.phone, email: s.email, address: s.address, notes: s.notes, isFleetfix: !!s.is_fleetfix,
  termsDays: s.terms_days, openingBalanceFils: s.opening_balance_fils, openingBalanceDate: s.opening_balance_date,
});

const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

/** A part with its catalogue: category, other numbers, fitment, packs, and what replaced it (the whole chain). */
export function partDetail(db: Db, p: PartRow, showCost: boolean) {
  const replacedBy = p.superseded_by ? db.get<{ id: string; part_no: string; name: string }>("SELECT id, part_no, name FROM parts WHERE id = ?", [p.superseded_by]) : null;
  const replaces = db.all<{ id: string; part_no: string; name: string }>("SELECT id, part_no, name FROM parts WHERE superseded_by = ? ORDER BY part_no", [p.id]);
  return {
    ...partOut(p, showCost),
    categoryName: getCategory(db, p.category_id)?.name ?? null,
    numbers: numbersOf(db, p.id), fitments: fitmentsOf(db, p.id), packs: packsOf(db, p.id),
    supersededBy: replacedBy ? { id: replacedBy.id, partNo: replacedBy.part_no, name: replacedBy.name } : null,
    replaces: replaces.map((r) => ({ id: r.id, partNo: r.part_no, name: r.name })),
    chain: chainFrom(db, p.id).map(({ id, partNo, name }) => ({ id, partNo, name })),
  };
}

export function partRoutes(app: FastifyInstance, db: Db): void {
  const getPart = (id: string) => db.get<PartRow>("SELECT * FROM parts WHERE id = ?", [id]);
  const getSupplier = (id: string) => db.get<SupplierRow>("SELECT * FROM suppliers WHERE id = ?", [id]);

  function assertUniquePartNo(partNo: string, exceptId: string | null) {
    if (db.get("SELECT 1 FROM parts WHERE active = 1 AND part_no = ? COLLATE NOCASE AND id IS NOT ?", [partNo, exceptId])) {
      throw conflict(`Part number ${partNo} is already in the parts list`);
    }
  }

  /**
   * Creates or updates a part's details (not its stock), and its catalogue. `present`: which catalogue parts were sent
   * (an older screen or a CSV without those columns leaves them as they are).
   */
  function savePart(input: PartInput, existing: PartRow | null, present: (k: "category" | "numbers" | "fitments" | "packs") => boolean = () => true): string {
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
      input.location ?? null, input.fits ?? null, input.active ? 1 : 0, input.nameAr ?? null, t,
    ];
    if (existing) {
      db.run(
        `UPDATE parts SET part_no = ?, name = ?, brand = ?, unit = ?, stocked = ?, sell_price_fils = ?, reorder_level = ?, location = ?,
         fits = ?, active = ?, name_ar = ?, updated_at = ? WHERE id = ?`,
        [...values, existing.id],
      );
      saveCatalogue(db, existing.id, input, present);
      return existing.id;
    }
    const id = newId();
    db.run(
      `INSERT INTO parts (part_no, name, brand, unit, stocked, sell_price_fils, reorder_level, location, fits, active, name_ar, updated_at, id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, id, t],
    );
    saveCatalogue(db, id, input, () => true);
    return id;
  }
  /** Which catalogue parts a request body carries. */
  const sent = (body: unknown) => (k: "category" | "numbers" | "fitments" | "packs") => {
    const b = (body ?? {}) as Record<string, unknown>;
    return k === "category" ? "categoryId" in b || "attributes" in b : k in b;
  };

  /**
   * The parts list and the part picker. `q` matches the part number, name, brand, notes and specs, and other numbers
   * (ignoring spaces and dashes); `matchedBy` says which other number matched. `vehicleId`: parts that fit it first
   * (`fitsVehicle`), and with nothing typed, only the parts that fit. `picker`: a replaced part with no stock gives way to
   * its newest replacement (`replaces`); with stock, it's offered first and its replacement after it.
   */
  app.get<{ Querystring: { q?: string; lowStock?: string; active?: string; categoryId?: string; vehicleId?: string; picker?: string } }>("/api/parts", async (req) => {
    const user = sessionUser(db, req);
    const q = req.query.q?.trim() || null;
    const nq = q ? normalizeNumber(q) : "";
    const vehicle = req.query.vehicleId
      ? db.get<VehicleFit>("SELECT make, model, year, engine FROM vehicles WHERE id = ?", [req.query.vehicleId]) ?? null
      : null;
    const fitOnly = !q && !!vehicle?.make;
    const squashed = "REPLACE(REPLACE(REPLACE(REPLACE(UPPER(part_no), ' ', ''), '-', ''), '.', ''), '/', '')";
    const rows = db.all<PartRow>(
      `SELECT * FROM parts
       WHERE (:q IS NULL OR part_no LIKE :like ESCAPE '\\' OR name LIKE :like ESCAPE '\\' OR brand LIKE :like ESCAPE '\\' OR fits LIKE :like ESCAPE '\\'
              OR spec_text LIKE :like ESCAPE '\\'
              OR (:nq <> '' AND (${squashed} LIKE :nlike ESCAPE '\\' OR spec_text LIKE :nlike ESCAPE '\\'
                  OR id IN (SELECT part_id FROM part_numbers WHERE normalized LIKE :nlike ESCAPE '\\'))))
         AND (:low = 0 OR (stocked = 1 AND on_hand <= reorder_level))
         AND (:active IS NULL OR active = :active)
         AND (:cat IS NULL OR category_id = :cat)
         AND (:fitOnly = 0 OR id IN (SELECT part_id FROM part_fitments WHERE make = :make COLLATE NOCASE))
       ORDER BY name COLLATE NOCASE, part_no COLLATE NOCASE LIMIT 300`,
      {
        q, like: like(q ?? ""), nq, nlike: like(nq), low: req.query.lowStock === "1" ? 1 : 0,
        active: req.query.active === "1" ? 1 : req.query.active === "0" ? 0 : null,
        cat: req.query.categoryId || null, fitOnly: fitOnly ? 1 : 0, make: vehicle?.make ?? "",
      },
    );
    const showCost = can(user.role, "costs.view");
    type Out = ReturnType<typeof partOut> & { matchedBy: string | null; fitsVehicle: boolean; replaces: string | null; rank: number };
    const out = (p: PartRow, replaces: string | null = null): Out => {
      const rank = vehicle?.make ? fitRank(db, p.id, vehicle) : 1;
      return { ...partOut(p, showCost), matchedBy: q ? matchedBy(db, p.id, q, [p.part_no, p.name, p.brand ?? "", p.fits ?? "", p.spec_text].join(" ")) : null, fitsVehicle: rank === 0, replaces, rank };
    };
    let list: Out[] = rows.map((p) => out(p));
    if (req.query.picker === "1") {
      const seen = new Set<string>();
      const expanded: Out[] = [];
      for (const p of list) {
        const row = rows.find((r) => r.id === p.id)!;
        const newest = row.superseded_by ? chainFrom(db, row.id).at(-1) : null;
        const inStock = row.stocked && row.on_hand > 0;
        if ((!newest || newest.id === row.id || inStock) && !seen.has(p.id)) { expanded.push(p); seen.add(p.id); }
        if (newest && newest.id !== row.id && !seen.has(newest.id)) {
          const n = db.get<PartRow>("SELECT * FROM parts WHERE id = ? AND active = 1", [newest.id]);
          if (n) { expanded.push(out(n, row.part_no)); seen.add(n.id); }
        }
      }
      list = expanded;
    }
    if (vehicle?.make) {
      list = list.map((p, i) => ({ p, i })).sort((a, b) => a.p.rank - b.p.rank || a.i - b.i).map((x) => x.p);
      if (fitOnly) list = list.filter((p) => p.fitsVehicle);
    }
    return { parts: list.map(({ rank: _rank, ...p }) => p) };
  });

  app.get<{ Params: { id: string } }>("/api/parts/:id", async (req) => {
    const user = sessionUser(db, req);
    const p = getPart(req.params.id);
    if (!p) throw notFound("Part not found");
    const showCost = can(user.role, "costs.view");
    const detail = partDetail(db, p, showCost);
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
      part: detail,
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
    return { part: partDetail(db, getPart(id)!, true) };
  });

  app.patch<{ Params: { id: string } }>("/api/parts/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "inventory.edit");
    const input = partSchema.parse(req.body);
    db.tx(() => {
      const p = getPart(req.params.id);
      if (!p) throw notFound("Part not found");
      savePart(input, p, sent(req.body));
    });
    return { part: partDetail(db, getPart(req.params.id)!, true) };
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

  app.post<{ Params: { id: string } }>("/api/parts/:id/supersede", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "inventory.edit");
    const { byPartId } = z.object({ byPartId: z.string().uuid().nullable() }).parse(req.body);
    db.tx(() => {
      if (!getPart(req.params.id)) throw notFound("Part not found");
      supersede(db, req.params.id, byPartId);
    });
    return { part: partDetail(db, getPart(req.params.id)!, can(user.role, "costs.view")) };
  });

  // "Fits this vehicle": the job's vehicle (make, model, its year, engine) added to the part's fitment.
  app.post<{ Params: { id: string } }>("/api/parts/:id/fitments/from-vehicle", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "inventory.edit");
    const { vehicleId } = z.object({ vehicleId: z.string().uuid() }).parse(req.body);
    db.tx(() => {
      if (!getPart(req.params.id)) throw notFound("Part not found");
      const v = db.get<{ make: string | null; model: string | null; year: number | null; engine: string | null }>("SELECT make, model, year, engine FROM vehicles WHERE id = ?", [vehicleId]);
      if (!v) throw notFound("Vehicle not found");
      if (!v.make) throw badRequest("Add the vehicle's make first");
      addFitment(db, req.params.id, { make: v.make, model: v.model, yearFrom: v.year, yearTo: v.year, engine: v.engine });
      db.run("UPDATE parts SET updated_at = ? WHERE id = ?", [now(), req.params.id]);
    });
    return { part: partDetail(db, getPart(req.params.id)!, can(user.role, "costs.view")) };
  });

  // ---- Categories (Settings → Inventory) ----
  app.get("/api/part-categories", async (req) => {
    sessionUser(db, req);
    return { categories: db.all<CategoryRow>("SELECT * FROM part_categories ORDER BY position, name COLLATE NOCASE").map(categoryOut) };
  });
  app.post("/api/part-categories", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const c = categorySchema.parse(req.body);
    const id = newId();
    const t = now();
    const pos = db.get<{ p: number }>("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM part_categories")!.p;
    db.run("INSERT INTO part_categories (id, name, parent_id, position, attributes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id, c.name, c.parentId, pos, JSON.stringify(c.attributes), t, t,
    ]);
    return { category: categoryOut(getCategory(db, id)!) };
  });
  app.patch<{ Params: { id: string } }>("/api/part-categories/:id", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const before = getCategory(db, req.params.id);
    if (!before) throw notFound("Category not found");
    const c = categorySchema.parse({ ...categoryOut(before), ...(req.body as object) });
    if (c.parentId === before.id) throw badRequest("A category can't be inside itself");
    db.run("UPDATE part_categories SET name = ?, parent_id = ?, attributes_json = ?, updated_at = ? WHERE id = ?", [c.name, c.parentId, JSON.stringify(c.attributes), now(), before.id]);
    return { category: categoryOut(getCategory(db, before.id)!) };
  });

  // ---- CSV import ----

  const COLUMNS = ["part_no", "name", "name_ar", "brand", "unit", "stocked", "sell_price", "cost", "qty", "reorder_level", "location", "fits"] as const;
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
              nameAr: text("name_ar", existing?.name_ar ?? null),
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
      `INSERT INTO suppliers (id, name, trn, phone, email, address, notes, terms_days, opening_balance_fils, opening_balance_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, s.name, s.trn, s.phone, s.email, s.address, s.notes, s.termsDays, s.openingBalanceFils, s.openingBalanceDate, t, t],
    );
    return { supplier: supplierOut(getSupplier(id)!) };
  });

  app.patch<{ Params: { id: string } }>("/api/suppliers/:id", async (req) => {
    requireAction(sessionUser(db, req), "purchases.manage");
    const current = getSupplier(req.params.id);
    if (!current) throw notFound("Supplier not found");
    // An edit changes what was sent; everything else stays as it is.
    const s = supplierSchema.parse({ ...supplierOut(current), ...(req.body as object) });
    db.tx(() => {
      const existing = getSupplier(req.params.id);
      if (!existing) throw notFound("Supplier not found");
      if (existing.is_fleetfix && s.name !== existing.name) throw conflict("Fleet Fix's name can't be changed");
      db.run(
        `UPDATE suppliers SET name = ?, trn = ?, phone = ?, email = ?, address = ?, notes = ?, terms_days = ?, opening_balance_fils = ?,
           opening_balance_date = ?, updated_at = ? WHERE id = ?`,
        [s.name, s.trn, s.phone, s.email, s.address, s.notes, s.termsDays, s.openingBalanceFils, s.openingBalanceDate, now(), existing.id],
      );
    });
    return { supplier: supplierOut(getSupplier(req.params.id)!) };
  });
}
