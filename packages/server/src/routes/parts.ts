import type { FastifyInstance } from "fastify";
import { resolveAddress, saveAddress, sentAddress, shownAddress, type AddressRow } from "../address";
import { adjustmentSchema, can, categorySchema, fitmentMatches, kitAvailable, normalizeNumber, parseAED, partSchema, supplierSchema, type PartInput } from "@ffgp/shared";
import { addFitment, categoryOut, chainFrom, fitmentsOf, getCategory, kitComponentsOf, saveKit, matchedBy, numbersOf, packsOf, saveCatalogue, supersede, type CategoryRow, type VehicleFit } from "../catalogue";
import { z } from "zod";
import { requireAction, sessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { parseCsv } from "../csv";
import { badRequest, conflict, HttpError, notFound } from "../errors";
import { page, pageLimit } from "../paging";
import { postMovement, round3 } from "../stock";
import { addUnits, checkIncomingCodes, unitOut, unitsOf, writeOffUnits, type UnitRow } from "../units";

export interface PartRow {
  id: string; part_no: string; name: string; brand: string | null; unit: string; stocked: number; sell_price_fils: number;
  avg_cost_fils: number; on_hand: number; reorder_level: number; location: string | null; fits: string | null; active: number;
  created_at: string; updated_at: string; name_ar: string | null;
  category_id: string | null; attributes_json: string; spec_text: string; superseded_by: string | null;
  tracking: "none" | "dot" | "serial"; warranty_months: number; is_kit: number;
  max_level: number; preferred_supplier_id: string | null; lead_time_days: number; core_fils: number;
}
interface SupplierRow extends AddressRow {
  id: string; name: string; trn: string | null; phone: string | null; email: string | null;
  notes: string | null; is_fleetfix: number; terms_days: number; opening_balance_fils: number; opening_balance_date: string | null;
}

export function partOut(p: PartRow, showCost: boolean) {
  return {
    id: p.id, partNo: p.part_no, name: p.name, nameAr: p.name_ar, brand: p.brand, unit: p.unit, stocked: !!p.stocked, sellPriceFils: p.sell_price_fils,
    onHand: p.on_hand, reorderLevel: p.reorder_level, location: p.location, fits: p.fits, active: !!p.active,
    lowStock: !!p.stocked && p.on_hand <= p.reorder_level,
    categoryId: p.category_id, attributes: JSON.parse(p.attributes_json || "{}") as Record<string, string | number>, supersededById: p.superseded_by,
    tracking: p.tracking ?? "none", warrantyMonths: p.warranty_months ?? 0, isKit: !!p.is_kit,
    maxLevel: p.max_level ?? 0, preferredSupplierId: p.preferred_supplier_id ?? null, leadTimeDays: p.lead_time_days ?? 7, coreFils: p.core_fils ?? 0,
    ...(showCost ? { avgCostFils: p.avg_cost_fils, stockValueFils: Math.round(Math.max(0, p.on_hand) * p.avg_cost_fils) } : {}),
  };
}
export const supplierOut = (s: SupplierRow) => ({
  id: s.id, name: s.name, trn: s.trn, phone: s.phone, email: s.email, address: s.address, addressParts: shownAddress(s), notes: s.notes, isFleetfix: !!s.is_fleetfix,
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
    ...kitInfo(db, p),
  };
}

/** A kit's parts, and how many whole kits the shelf can make. */
function kitInfo(db: Db, p: PartRow) {
  if (!p.is_kit) return { components: [], kitAvailable: null };
  const components = kitComponentsOf(db, p.id);
  return { components, kitAvailable: kitAvailable(components, new Map(components.map((c) => [c.partId, c.onHand]))) };
}

type Sent = "category" | "categoryId" | "numbers" | "fitments" | "packs" | "tracking" | "warrantyMonths" | "kit" | "maxLevel" | "preferredSupplierId" | "leadTimeDays" | "coreFils";

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
  function savePart(input: PartInput, existing: PartRow | null, present: (k: Sent) => boolean = () => true): string {
    if (input.active) assertUniquePartNo(input.partNo, existing?.id ?? null);
    if (existing && !!existing.stocked !== input.stocked) {
      if (existing.on_hand !== 0) throw conflict("Bring the stock to zero before changing this");
      const kit = db.get<{ part_no: string }>("SELECT p.part_no FROM kit_components k JOIN parts p ON p.id = k.kit_part_id WHERE k.component_part_id = ? LIMIT 1", [existing.id]);
      if (kit && !input.stocked) throw conflict(`This part is in the kit ${kit.part_no}: take it out of the kit first`);
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
      saveTracking(existing, input, present);
      return existing.id;
    }
    const id = newId();
    db.run(
      `INSERT INTO parts (part_no, name, brand, unit, stocked, sell_price_fils, reorder_level, location, fits, active, name_ar, updated_at, id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, id, t],
    );
    saveCatalogue(db, id, input, () => true);
    db.run("UPDATE parts SET tracking = ?, warranty_months = ? WHERE id = ?", [input.tracking, input.warrantyMonths, id]);
    saveKit(db, id, input.isKit, input.components);
    savePlanning(id, input, () => true);
    return id;
  }
  /**
   * Tracking one by one and the warranty, when sent (an older screen or the CSV leaves them). Switching tracking
   * on for a part with stock is allowed: units from before simply aren't listed.
   */
  function saveTracking(existing: PartRow, input: PartInput, present: (k: Sent) => boolean) {
    if (present("tracking") && input.tracking !== "none" && existing.tracking === "none") {
      const kit = db.get<{ part_no: string }>("SELECT p.part_no FROM kit_components k JOIN parts p ON p.id = k.kit_part_id WHERE k.component_part_id = ? LIMIT 1", [existing.id]);
      if (kit) throw conflict(`This part is in the kit ${kit.part_no}: take it out of the kit before tracking it one by one`);
    }
    if (present("tracking")) db.run("UPDATE parts SET tracking = ? WHERE id = ?", [input.tracking, existing.id]);
    if (present("warrantyMonths")) db.run("UPDATE parts SET warranty_months = ? WHERE id = ?", [input.warrantyMonths, existing.id]);
    if (present("kit")) saveKit(db, existing.id, input.isKit, input.components);
    savePlanning(existing.id, input, present);
  }
  /** Planning: order up to, preferred supplier, lead time (when sent). */
  function savePlanning(id: string, input: PartInput, present: (k: Sent) => boolean) {
    if (input.preferredSupplierId && !getSupplier(input.preferredSupplierId)) throw badRequest("That supplier doesn't exist");
    if (present("maxLevel")) db.run("UPDATE parts SET max_level = ? WHERE id = ?", [input.maxLevel, id]);
    if (present("preferredSupplierId")) db.run("UPDATE parts SET preferred_supplier_id = ? WHERE id = ?", [input.preferredSupplierId, id]);
    if (present("leadTimeDays")) db.run("UPDATE parts SET lead_time_days = ? WHERE id = ?", [input.leadTimeDays, id]);
    if (present("coreFils")) db.run("UPDATE parts SET core_fils = ? WHERE id = ?", [input.coreFils, id]);
  }
  /** Which catalogue parts a request body carries ("category": the category or its specs). */
  const sent = (body: unknown) => (k: Sent) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return k === "category" ? "categoryId" in b || "attributes" in b : k === "kit" ? "isKit" in b || "components" in b : k in b;
  };

  /**
   * The parts list and the part picker. `q` matches the part number, name, brand, notes and specs, and other numbers
   * (ignoring spaces and dashes); `matchedBy` says which other number matched. `vehicleId`: parts that fit it first
   * (`fitsVehicle`), and with nothing typed, only the parts that fit. `picker`: a replaced part with no stock gives way to
   * its newest replacement (`replaces`); with stock, it's offered first and its replacement after it.
   */
  app.get<{ Querystring: { q?: string; lowStock?: string; active?: string; categoryId?: string; vehicleId?: string; picker?: string; limit?: string } }>("/api/parts", async (req) => {
    const limit = pageLimit(req.query.limit);
    const user = sessionUser(db, req);
    const q = req.query.q?.trim() || null;
    const nq = q ? normalizeNumber(q) : "";
    const vehicle = req.query.vehicleId
      ? db.get<VehicleFit>("SELECT make, model, year, engine FROM vehicles WHERE id = ?", [req.query.vehicleId]) ?? null
      : null;
    // Nothing typed: the parts that fit the vehicle; a vehicle without a make fits nothing.
    if (!q && vehicle && !vehicle.make) return { parts: [], more: false };
    const fitOnly = !q && !!vehicle?.make;
    // The parts that fit (and those with fitment that doesn't) are worked out before the list is cut, so a
    // fitting part far down the alphabet still comes first.
    const fitting: string[] = [];
    const notFitting: string[] = [];
    if (vehicle?.make) {
      const byPart = new Map<string, boolean>();
      for (const f of db.all<{ part_id: string; make: string; model: string | null; year_from: number | null; year_to: number | null; engine: string | null }>(
        "SELECT part_id, make, model, year_from, year_to, engine FROM part_fitments",
      )) {
        const ok = fitmentMatches({ make: f.make, model: f.model, yearFrom: f.year_from, yearTo: f.year_to, engine: f.engine }, vehicle);
        byPart.set(f.part_id, (byPart.get(f.part_id) ?? false) || ok);
      }
      for (const [id, ok] of byPart) (ok ? fitting : notFitting).push(id);
    }
    const squashed = "REPLACE(REPLACE(REPLACE(REPLACE(UPPER(part_no), ' ', ''), '-', ''), '.', ''), '/', '')";
    const fetched = db.all<PartRow>(
      `SELECT * FROM parts
       WHERE (:q IS NULL OR part_no LIKE :like ESCAPE '\\' OR name LIKE :like ESCAPE '\\' OR brand LIKE :like ESCAPE '\\' OR fits LIKE :like ESCAPE '\\'
              OR spec_text LIKE :like ESCAPE '\\'
              OR (:nq <> '' AND (${squashed} LIKE :nlike ESCAPE '\\' OR spec_text LIKE :nlike ESCAPE '\\'
                  OR id IN (SELECT part_id FROM part_numbers WHERE normalized LIKE :nlike ESCAPE '\\'))))
         AND (:low = 0 OR (stocked = 1 AND on_hand <= reorder_level))
         AND (:active IS NULL OR active = :active)
         AND (:cat IS NULL OR category_id = :cat)
         AND (:fitOnly = 0 OR id IN (SELECT value FROM json_each(:fitting)))
       ORDER BY CASE WHEN id IN (SELECT value FROM json_each(:fitting)) THEN 0 WHEN id IN (SELECT value FROM json_each(:notFitting)) THEN 2 ELSE 1 END,
         name COLLATE NOCASE, part_no COLLATE NOCASE LIMIT :limit`,
      {
        q, like: like(q ?? ""), nq, nlike: like(nq), low: req.query.lowStock === "1" ? 1 : 0,
        active: req.query.active === "1" ? 1 : req.query.active === "0" ? 0 : null,
        limit: limit + 1, cat: req.query.categoryId || null, fitOnly: fitOnly ? 1 : 0, fitting: JSON.stringify(fitting), notFitting: JSON.stringify(notFitting),
      },
    );
    const { rows, more } = page(fetched, limit);
    const showCost = can(user.role, "costs.view");
    type Out = ReturnType<typeof partOut> & { kitAvailable: number | null; matchedBy: string | null; fitsVehicle: boolean; replacesPartNo: string | null; rank: number };
    const fitSet = new Set(fitting), notFitSet = new Set(notFitting);
    const out = (p: PartRow, replaces: string | null = null): Out => {
      const rank = fitSet.has(p.id) ? 0 : notFitSet.has(p.id) ? 2 : 1;
      return { ...partOut(p, showCost), kitAvailable: kitInfo(db, p).kitAvailable, matchedBy: q ? matchedBy(db, p.id, q, [p.part_no, p.name, p.brand ?? "", p.fits ?? "", p.spec_text].join(" ")) : null, fitsVehicle: rank === 0, replacesPartNo: replaces, rank };
    };
    let list: Out[] = rows.map((p) => out(p));
    if (req.query.picker === "1") {
      const seen = new Set<string>();
      const expanded: Out[] = [];
      for (const p of list) {
        const row = rows.find((r) => r.id === p.id)!;
        // The newest part in the chain that's still in use; with none, the old part stays on offer.
        const newer = row.superseded_by ? chainFrom(db, row.id).slice(1).reverse() : [];
        const n = newer.map((x) => db.get<PartRow>("SELECT * FROM parts WHERE id = ? AND active = 1", [x.id])).find(Boolean) ?? null;
        const inStock = row.stocked && row.on_hand > 0;
        if ((!n || inStock) && !seen.has(p.id)) { expanded.push(p); seen.add(p.id); }
        if (n && !seen.has(n.id)) { expanded.push(out(n, row.part_no)); seen.add(n.id); }
      }
      list = expanded;
    }
    if (vehicle?.make) {
      list = list.map((p, i) => ({ p, i })).sort((a, b) => a.p.rank - b.p.rank || a.i - b.i).map((x) => x.p);
      if (fitOnly) list = list.filter((p) => p.fitsVehicle);
    }
    return { parts: list.map(({ rank: _rank, ...p }) => p), more };
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
      // Tyres and batteries: the ones coming in are listed (DOT or serial), the ones going out chosen.
      const codes = input.qty > 0 ? checkIncomingCodes(db, p.id, input.qty, input.units, p.part_no) : [];
      if (input.qty < 0) writeOffUnits(db, p.id, -input.qty, input.unitIds, p.on_hand + input.qty);
      else if (input.unitIds.length) throw badRequest("Units are chosen only when stock goes down");
      postMovement(db, {
        partId: p.id, qty: input.qty, reason: input.reason === "opening" ? "opening" : "adjust",
        unitCostFils: input.unitCostFils, note: input.note ?? (input.reason === "opening" ? null : input.reason), userId: user.id,
      });
      if (codes.length) addUnits(db, p.id, codes, input.unitCostFils ?? getPart(p.id)!.avg_cost_fils, null);
    });
    return { part: partOut(getPart(req.params.id)!, true) };
  });

  /** A tracked part's units with a status (in stock: oldest DOT first). */
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/api/parts/:id/units", async (req) => {
    const user = sessionUser(db, req);
    if (!getPart(req.params.id)) throw notFound("Part not found");
    const status = z.enum(["in_stock", "fitted", "returned", "written_off"]).catch("in_stock").parse(req.query.status);
    const showCost = can(user.role, "costs.view");
    return { units: unitsOf(db, req.params.id, status).map((u) => unitOut(db, u, showCost)) };
  });

  /** Find a tyre or battery by its serial or DOT: the part, where it is or was fitted, the customer and vehicle. */
  app.get<{ Querystring: { q?: string } }>("/api/stock-units", async (req) => {
    const user = sessionUser(db, req);
    const q = req.query.q?.trim() ?? "";
    if (q.length < 2) return { units: [] };
    const rows = db.all<UnitRow & { part_no: string; part_name: string; customer_name: string | null; vehicle_plate: string | null }>(
      `SELECT u.*, p.part_no, p.name AS part_name, c.name AS customer_name, v.plate AS vehicle_plate
       FROM stock_units u JOIN parts p ON p.id = u.part_id
       LEFT JOIN documents d ON d.id = u.document_id LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
       WHERE u.code LIKE ? ESCAPE '\\' ORDER BY u.received_at DESC LIMIT 50`,
      [like(q)],
    );
    const showCost = can(user.role, "costs.view");
    return {
      units: rows.map((u) => ({ ...unitOut(db, u, showCost), partNo: u.part_no, partName: u.part_name, customerName: u.customer_name, vehiclePlate: u.vehicle_plate })),
    };
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
  /** A category's parent must exist and mustn't be the category itself or one inside it. */
  function checkParent(id: string | null, parentId: string | null) {
    const seen = new Set<string>();
    for (let p = parentId; p; ) {
      if (p === id) throw badRequest("A category can't be inside itself or one of its own");
      if (seen.has(p)) break;
      seen.add(p);
      const row = getCategory(db, p);
      if (!row) throw badRequest("That parent category doesn't exist");
      p = row.parent_id;
    }
  }
  app.get("/api/part-categories", async (req) => {
    sessionUser(db, req);
    return { categories: db.all<CategoryRow>("SELECT * FROM part_categories ORDER BY position, name COLLATE NOCASE").map(categoryOut) };
  });
  app.post("/api/part-categories", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const c = categorySchema.parse(req.body);
    checkParent(null, c.parentId);
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
    checkParent(before.id, c.parentId);
    db.run("UPDATE part_categories SET name = ?, parent_id = ?, attributes_json = ?, updated_at = ? WHERE id = ?", [c.name, c.parentId, JSON.stringify(c.attributes), now(), before.id]);
    return { category: categoryOut(getCategory(db, before.id)!) };
  });

  // ---- CSV import ----

  const COLUMNS = ["part_no", "name", "name_ar", "brand", "unit", "stocked", "sell_price", "cost", "qty", "reorder_level", "location", "fits", "category", "numbers", "fitment"] as const;
  const KINDS: Record<string, "oem" | "aftermarket" | "supplier" | "old"> = { OEM: "oem", AM: "aftermarket", AFTERMARKET: "aftermarket", SUP: "supplier", SUPPLIER: "supplier", OLD: "old" };
  /** "OEM:04152-YZZA1; AM:W 68/3" (no kind: OEM). */
  const csvNumbers = (cell: string) => cell.split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(x);
    const kind = m ? KINDS[m[1]!.toUpperCase()] : "oem";
    if (!kind) throw badRequest(`numbers: "${x}" — start with OEM:, AM:, SUP: or OLD:`);
    return { number: (m ? m[2]! : x).trim().slice(0, 60), kind, brand: null };
  });
  /** "Toyota|Land Cruiser|2016-2021|1GR-FE; Nissan|Patrol||" — years 2016-2021, 2016, 2016- or -2021, or blank. */
  const csvFitments = (cell: string) => cell.split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [make = "", model = "", years = "", engine = ""] = x.split("|").map((y) => y.trim());
    if (!make) throw badRequest(`fitment: "${x}" — start with the make`);
    const y = /^(\d{4})?\s*(-)?\s*(\d{4})?$/.exec(years);
    if (!y || (years && !y[1] && !y[3])) throw badRequest(`fitment: "${x}" — years should look like 2016-2021, 2016 or 2016-`);
    const from = y[1] ? Number(y[1]) : null;
    const to = y[3] ? Number(y[3]) : y[2] ? null : from;
    return { make, model: model || null, yearFrom: from, yearTo: to, engine: engine || null, note: null };
  });
  type Column = (typeof COLUMNS)[number];
  class RollBack extends Error {}

  app.post("/api/parts/import", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "inventory.edit");
    const { csv, dryRun, setCounts } = z
      .object({ csv: z.string().max(4_000_000), dryRun: z.boolean().default(false), setCounts: z.boolean().default(false) })
      .parse(req.body);
    const rows = parseCsv(csv);
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const col = new Map<Column, number>();
    COLUMNS.forEach((c) => { const i = header.indexOf(c); if (i >= 0) col.set(c, i); });
    if (!col.has("part_no") || !col.has("name")) {
      return { created: 0, updated: 0, countChanges: 0, errors: [{ row: 1, message: "The first row must name the columns, including part_no and name" }] };
    }
    const errors: { row: number; message: string }[] = [];
    let created = 0, updated = 0, countChanges = 0;
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
            let categoryId = existing?.category_id ?? null;
            if (has("category")) {
              const name = cell("category");
              const cat = name ? db.get<{ id: string }>("SELECT id FROM part_categories WHERE name = ? COLLATE NOCASE", [name]) : null;
              if (name && !cat) throw badRequest(`category: "${name}" isn't a category (Settings → Inventory)`);
              categoryId = cat?.id ?? null;
            }
            const parsed = partSchema.safeParse({
              categoryId,
              // Its specs stay while the category does.
              attributes: categoryId && categoryId === existing?.category_id ? JSON.parse(existing.attributes_json || "{}") : {},
              numbers: has("numbers") ? csvNumbers(cell("numbers")) : [],
              fitments: has("fitment") ? csvFitments(cell("fitment")) : [],
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
            const id = savePart(parsed.data, existing, (k) => (k === "category" || k === "categoryId" ? has("category") : k === "numbers" ? has("numbers") : k === "fitments" ? has("fitment") : false));
            if (existing) {
              updated++;
              // An existing part's qty is a shelf count: reported always, set only when asked (an old sheet
              // re-imported for its prices mustn't undo a month of sales). Kits have no shelf of their own.
              const diff = qty === undefined || !existing.stocked || existing.is_kit || !parsed.data.stocked ? 0 : round3(qty - existing.on_hand);
              if (diff !== 0) {
                countChanges++;
                if (setCounts) {
                  try {
                    if (diff < 0) writeOffUnits(db, id, -diff, [], qty!);
                  } catch (error) {
                    if (error instanceof HttpError) throw badRequest(`qty: ${existing.part_no} is tracked one by one — count it on the part's page`);
                    throw error;
                  }
                  postMovement(db, { partId: id, qty: diff, reason: "adjust", note: "count (CSV import)", userId: user.id });
                }
              }
            } else {
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
    return errors.length ? { created: 0, updated: 0, countChanges: 0, errors } : { created, updated, countChanges, errors };
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
    db.tx(() => {
      db.run(
        `INSERT INTO suppliers (id, name, trn, phone, email, address, notes, terms_days, opening_balance_fils, opening_balance_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, s.name, s.trn, s.phone, s.email, s.address, s.notes, s.termsDays, s.openingBalanceFils, s.openingBalanceDate, t, t],
      );
      if (s.addressParts) saveAddress(db, "suppliers", id, resolveAddress(null, s));
    });
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
        `UPDATE suppliers SET name = ?, trn = ?, phone = ?, email = ?, notes = ?, terms_days = ?, opening_balance_fils = ?,
           opening_balance_date = ?, updated_at = ? WHERE id = ?`,
        [s.name, s.trn, s.phone, s.email, s.notes, s.termsDays, s.openingBalanceFils, s.openingBalanceDate, now(), existing.id],
      );
      saveAddress(db, "suppliers", existing.id, resolveAddress(existing, sentAddress(req.body, s)));
    });
    return { supplier: supplierOut(getSupplier(req.params.id)!) };
  });
}
