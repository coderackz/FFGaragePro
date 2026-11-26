import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, customerSchema, dubaiDate, MAKE_NAMES, modelsOf, nameKey, samePlate, similarPlate, VEHICLE_FILE_KINDS, vehicleFileSchema, vehicleSchema, type CustomerInput, type VehicleFileKind } from "@ffgp/shared";
import { requireAction, sessionUser, type SessionUser } from "../auth";
import { customerBalance, customerLedger } from "../ledger";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../errors";
import { resolveAddress, saveAddress, sentAddress, shownAddress, type AddressRow } from "../address";
import { page, pageLimit } from "../paging";
import { phoneHas, phoneSearch } from "../phones";
import { mulkiyaOf } from "../requests";

interface CustomerRow extends AddressRow {
  id: string; kind: string; name: string; phone: string | null; email: string | null; trn: string | null;
  notes: string | null; created_at: string; plates?: string | null;
  credit_allowed: number; credit_limit_fils: number; terms_days: number | null; discount_bp: number; lpo_required: number;
  opening_balance_fils: number; opening_balance_date: string | null;
}
interface VehicleRow {
  id: string; customer_id: string; plate: string; make: string | null; model: string | null; year: number | null;
  vin: string | null; colour: string | null; odometer: number | null; created_at: string; customer_name?: string; engine?: string | null;
}

export const customerOut = (c: CustomerRow) => ({
  id: c.id, kind: c.kind, name: c.name, phone: c.phone, email: c.email, trn: c.trn, address: c.address, addressParts: shownAddress(c), notes: c.notes,
  createdAt: c.created_at, plates: c.plates ? c.plates.split(",") : undefined,
  creditAllowed: !!c.credit_allowed, creditLimitFils: c.credit_limit_fils, termsDays: c.terms_days, discountPct: c.discount_bp / 100,
  lpoRequired: !!c.lpo_required, openingBalanceFils: c.opening_balance_fils, openingBalanceDate: c.opening_balance_date,
});

/** A customer with where their account stands (balance, overdue, credit, over the credit limit). */
export function customerWithBalance(db: Db, c: CustomerRow) {
  const b = customerBalance(db, c.id);
  return { ...customerOut(c), ...b, overLimit: c.credit_limit_fils > 0 && b.balanceFils > c.credit_limit_fils };
}

const CREDIT_FIELDS = ["creditAllowed", "creditLimitFils", "termsDays", "discountPct", "lpoRequired", "openingBalanceFils", "openingBalanceDate"] as const;

/** Credit terms are money decisions: only the Owner or an Accountant may set or change them. */
function checkCreditChange(user: SessionUser, before: Partial<Record<keyof CustomerInput, unknown>>, after: CustomerInput): void {
  if (can(user.role, "payments.record")) return;
  if (CREDIT_FIELDS.some((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))) {
    throw forbidden("Only the Owner or an Accountant can change a customer's credit terms");
  }
}
const creditDefaults = customerSchema.parse({ name: "x" });
export const vehicleOut = (v: VehicleRow) => ({
  id: v.id, customerId: v.customer_id, plate: v.plate, make: v.make, model: v.model, year: v.year, vin: v.vin, engine: v.engine ?? null,
  colour: v.colour, odometer: v.odometer, createdAt: v.created_at, customerName: v.customer_name,
});

const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

export function customerRoutes(app: FastifyInstance, db: Db): void {
  const getCustomer = (id: string) => db.get<CustomerRow>("SELECT * FROM customers WHERE id = ?", [id]);
  const getVehicle = (id: string) =>
    db.get<VehicleRow>("SELECT v.*, c.name AS customer_name FROM vehicles v JOIN customers c ON c.id = v.customer_id WHERE v.id = ?", [id]);

  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/customers", async (req) => {
    sessionUser(db, req);
    const q = req.query.q?.trim();
    const limit = pageLimit(req.query.limit);
    const fetched = db.all<CustomerRow>(
      `SELECT c.*, (SELECT group_concat(plate) FROM vehicles WHERE customer_id = c.id) AS plates
       FROM customers c
       WHERE :q IS NULL OR c.name LIKE :like ESCAPE '\\' OR c.phone LIKE :like ESCAPE '\\' OR ${phoneHas("c.phone")} OR c.email LIKE :like ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id AND v.plate LIKE :like ESCAPE '\\')
       ORDER BY c.name COLLATE NOCASE LIMIT :limit`,
      { q: q || null, like: like(q ?? ""), digits: phoneSearch(q), limit: limit + 1 },
    );
    const { rows, more } = page(fetched, limit);
    return { customers: rows.map((c) => customerWithBalance(db, c)), more };
  });

  app.get<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    sessionUser(db, req);
    const c = getCustomer(req.params.id);
    if (!c) throw notFound("Customer not found");
    const vehicles = db.all<VehicleRow>("SELECT * FROM vehicles WHERE customer_id = ? ORDER BY plate", [c.id]);
    return { customer: customerWithBalance(db, c), vehicles: vehicles.map(vehicleOut) };
  });

  app.post("/api/customers", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "customers.edit");
    const input = customerSchema.parse(req.body);
    checkCreditChange(user, creditDefaults, input);
    const id = newId();
    const t = now();
    db.tx(() => {
      db.run(
        `INSERT INTO customers (id, kind, name, phone, email, trn, address, notes, credit_allowed, credit_limit_fils, terms_days, discount_bp,
           lpo_required, opening_balance_fils, opening_balance_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.kind, input.name, input.phone, input.email, input.trn, input.address, input.notes, input.creditAllowed ? 1 : 0, input.creditLimitFils,
          input.termsDays, Math.round(input.discountPct * 100), input.lpoRequired ? 1 : 0, input.openingBalanceFils, input.openingBalanceDate,
          t, t],
      );
      if (input.addressParts) saveAddress(db, "customers", id, resolveAddress(null, input));
    });
    return { customer: customerWithBalance(db, getCustomer(id)!) };
  });

  app.patch<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "customers.edit");
    const existing = getCustomer(req.params.id);
    if (!existing) throw notFound("Customer not found");
    const before = customerOut(existing);
    const input = customerSchema.parse({ ...before, ...(req.body as object) });
    checkCreditChange(user, before, input);
    const address = resolveAddress(existing, sentAddress(req.body, input));
    db.tx(() => {
      db.run(
        `UPDATE customers SET kind = ?, name = ?, phone = ?, email = ?, trn = ?, notes = ?, credit_allowed = ?, credit_limit_fils = ?,
           terms_days = ?, discount_bp = ?, lpo_required = ?, opening_balance_fils = ?, opening_balance_date = ?,
           updated_at = ? WHERE id = ?`,
        [input.kind, input.name, input.phone, input.email, input.trn, input.notes, input.creditAllowed ? 1 : 0, input.creditLimitFils,
          input.termsDays, Math.round(input.discountPct * 100), input.lpoRequired ? 1 : 0, input.openingBalanceFils, input.openingBalanceDate,
          now(), existing.id],
      );
      saveAddress(db, "customers", existing.id, address);
    });
    return { customer: customerWithBalance(db, getCustomer(existing.id)!) };
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/customers/:id/statement", async (req) => {
    sessionUser(db, req);
    const c = getCustomer(req.params.id);
    if (!c) throw notFound("Customer not found");
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const to = req.query.to && ymd.test(req.query.to) ? req.query.to : dubaiDate(new Date().toISOString());
    const from = req.query.from && ymd.test(req.query.from) ? req.query.from : `${to.slice(0, 8)}01`;
    if (from > to) throw badRequest("The start date is after the end date");
    return { customer: customerWithBalance(db, c), from, to, statement: customerLedger(db, c.id, from, to) };
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/vehicles", async (req) => {
    sessionUser(db, req);
    const q = req.query.q?.trim();
    const limit = pageLimit(req.query.limit);
    const fetched = db.all<VehicleRow>(
      `SELECT v.*, c.name AS customer_name FROM vehicles v JOIN customers c ON c.id = v.customer_id
       WHERE :q IS NULL OR v.plate LIKE :like ESCAPE '\\' OR v.make LIKE :like ESCAPE '\\' OR v.model LIKE :like ESCAPE '\\'
          OR v.vin LIKE :like ESCAPE '\\' OR c.name LIKE :like ESCAPE '\\'
       ORDER BY v.plate LIMIT :limit`,
      { q: q || null, like: like(q ?? ""), limit: limit + 1 },
    );
    const { rows, more } = page(fetched, limit);
    return { vehicles: rows.map(vehicleOut), more };
  });

  // ---- The garage's makes and models: what its vehicles and parts' fitments use (the list's spelling when it's one of
  // the list's names, else the spelling used most). Suggested and corrected to on the screens; the owner tidies them.
  app.get("/api/vehicle-names", async (req) => {
    sessionUser(db, req);
    return vehicleNames();
  });

  function vehicleNames() {
    const rows = [
      ...db.all<{ make: string | null; model: string | null }>("SELECT make, model FROM vehicles").map((r) => ({ ...r, vehicle: 1 })),
      ...db.all<{ make: string | null; model: string | null }>("SELECT make, model FROM part_fitments").map((r) => ({ ...r, vehicle: 0 })),
    ].filter((r) => nameKey(r.make));
    /** The name to show for one key: the list's spelling, else the one used most. */
    const pick = (listed: string[], spellings: Map<string, number>) => {
      const k = nameKey([...spellings.keys()][0]);
      return listed.find((n) => nameKey(n) === k) ?? [...spellings.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    };
    const makes = new Map<string, { spellings: Map<string, number>; vehicles: number }>();
    const models = new Map<string, { makeKey: string; spellings: Map<string, number>; vehicles: number }>();
    const count = (m: Map<string, number>, s: string) => m.set(s, (m.get(s) ?? 0) + 1);
    for (const r of rows) {
      const mk = nameKey(r.make);
      const entry = makes.get(mk) ?? { spellings: new Map(), vehicles: 0 };
      count(entry.spellings, r.make!.trim());
      entry.vehicles += r.vehicle;
      makes.set(mk, entry);
      if (!nameKey(r.model)) continue;
      const key = `${mk}:${nameKey(r.model)}`;
      const m = models.get(key) ?? { makeKey: mk, spellings: new Map(), vehicles: 0 };
      count(m.spellings, r.model!.trim());
      m.vehicles += r.vehicle;
      models.set(key, m);
    }
    const makeName = new Map([...makes].map(([k, v]) => [k, pick(MAKE_NAMES, v.spellings)]));
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    return {
      makes: [...makes].map(([k, v]) => ({ name: makeName.get(k)!, vehicles: v.vehicles })).sort(byName),
      models: [...models.values()]
        .map((m) => ({ make: makeName.get(m.makeKey)!, name: pick(modelsOf(makeName.get(m.makeKey)!), m.spellings), vehicles: m.vehicles }))
        .sort((a, b) => a.make.localeCompare(b.make) || a.name.localeCompare(b.name)),
    };
  }

  /** The owner renames a make or a model (or merges one spelling into another): every vehicle and fitment with it. */
  app.post("/api/vehicle-names/rename", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const input = z.object({
      kind: z.enum(["make", "model"]), make: z.string().trim().max(60).optional(),
      from: z.string().trim().min(1).max(60), to: z.string().trim().min(1, "Enter the new name").max(60),
    }).parse(req.body);
    if (input.kind === "model" && !nameKey(input.make)) throw badRequest("Say which make the model is of");
    const hit = (r: { make: string | null; model: string | null }) =>
      input.kind === "make" ? nameKey(r.make) === nameKey(input.from) : nameKey(r.make) === nameKey(input.make) && nameKey(r.model) === nameKey(input.from);
    const column = input.kind === "make" ? "make" : "model";
    return db.tx(() => {
      const t = now();
      const vehicles = db.all<{ id: string; make: string | null; model: string | null }>("SELECT id, make, model FROM vehicles").filter(hit);
      for (const v of vehicles) db.run(`UPDATE vehicles SET ${column} = ?, updated_at = ? WHERE id = ?`, [input.to, t, v.id]);
      const fitments = db.all<{ id: string; make: string | null; model: string | null }>("SELECT id, make, model FROM part_fitments").filter(hit);
      for (const f of fitments) db.run(`UPDATE part_fitments SET ${column} = ? WHERE id = ?`, [input.to, f.id]);
      return { vehicles: vehicles.length, fitments: fitments.length, ...vehicleNames() };
    });
  });

  /** One vehicle as its own screen sees it: with which Mulkiya photos it has. */
  const vehicleFull = (v: VehicleRow) => ({ ...vehicleOut(v), mulkiya: mulkiyaOf(db, v.id) });

  app.get<{ Params: { id: string } }>("/api/vehicles/:id", async (req) => {
    sessionUser(db, req);
    const v = getVehicle(req.params.id);
    if (!v) throw notFound("Vehicle not found");
    return { vehicle: vehicleFull(v) };
  });

  // The Mulkiya (registration card), front and back: taken at intake, sent to vendors only when the buyer ticks it.
  const fileKind = (kind: string): VehicleFileKind => {
    if (!(VEHICLE_FILE_KINDS as readonly string[]).includes(kind)) throw notFound("No such photo");
    return kind as VehicleFileKind;
  };
  app.get<{ Params: { id: string; kind: string } }>("/api/vehicles/:id/files/:kind", async (req) => {
    sessionUser(db, req);
    const f = db.get<{ file_name: string; data_base64: string }>("SELECT file_name, data_base64 FROM vehicle_files WHERE id = ?", [`${req.params.id}:${fileKind(req.params.kind)}`]);
    if (!f) throw notFound("No photo saved");
    return { fileName: f.file_name, base64: f.data_base64 };
  });
  app.put<{ Params: { id: string; kind: string } }>("/api/vehicles/:id/files/:kind", { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    requireAction(sessionUser(db, req), "customers.edit");
    const kind = fileKind(req.params.kind);
    const v = getVehicle(req.params.id);
    if (!v) throw notFound("Vehicle not found");
    const input = vehicleFileSchema.parse(req.body);
    const t = now();
    db.run(
      `INSERT INTO vehicle_files (id, vehicle_id, kind, file_name, data_base64, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET file_name = excluded.file_name, data_base64 = excluded.data_base64, updated_at = excluded.updated_at`,
      [`${v.id}:${kind}`, v.id, kind, input.fileName, input.base64, t, t],
    );
    return { vehicle: vehicleFull(v) };
  });
  app.delete<{ Params: { id: string; kind: string } }>("/api/vehicles/:id/files/:kind", async (req) => {
    requireAction(sessionUser(db, req), "customers.edit");
    const v = getVehicle(req.params.id);
    if (!v) throw notFound("Vehicle not found");
    db.run("DELETE FROM vehicle_files WHERE id = ?", [`${v.id}:${fileKind(req.params.kind)}`]);
    return { vehicle: vehicleFull(v) };
  });

  const saveVehicle = (id: string | null, body: unknown) => {
    const input = vehicleSchema.parse(body);
    if (!getCustomer(input.customerId)) throw notFound("Customer not found");
    // A new or changed plate: not one already here, however it's written. One that only looks like it (an old record
    // without its emirate) is asked about, by forms that can ask.
    if (!id || getVehicle(id)?.plate !== input.plate) {
      const others = db.all<{ id: string; plate: string; owner: string }>("SELECT v.id, v.plate, c.name AS owner FROM vehicles v JOIN customers c ON c.id = v.customer_id").filter((v) => v.id !== id);
      const clash = others.find((v) => v.plate.toUpperCase() === input.plate || samePlate(v.plate, input.plate));
      if (clash) throw conflict(`Plate ${input.plate} is already registered to ${clash.owner}`);
      const similar = (body as { checkSimilar?: unknown } | null)?.checkSimilar === true ? others.find((v) => similarPlate(v.plate, input.plate)) : undefined;
      if (similar) throw new HttpError(409, `Plate ${similar.plate} is already registered to ${similar.owner}`, "plate_similar");
    }
    const t = now();
    // An older screen that doesn't send the engine leaves it as it was.
    const engine = body && typeof body === "object" && "engine" in body ? input.engine : id ? getVehicle(id)?.engine ?? null : null;
    const values = [input.customerId, input.plate, input.make, input.model, input.year ?? null, input.vin, input.colour, input.odometer ?? null, engine];
    if (id) {
      db.run("UPDATE vehicles SET customer_id = ?, plate = ?, make = ?, model = ?, year = ?, vin = ?, colour = ?, odometer = ?, engine = ?, updated_at = ? WHERE id = ?", [...values, t, id]);
      return id;
    }
    const newVehicleId = newId();
    db.run(
      "INSERT INTO vehicles (customer_id, plate, make, model, year, vin, colour, odometer, engine, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [...values, t, t, newVehicleId],
    );
    return newVehicleId;
  };

  app.post("/api/vehicles", async (req) => {
    requireAction(sessionUser(db, req), "customers.edit");
    const id = db.tx(() => saveVehicle(null, req.body));
    return { vehicle: vehicleOut(getVehicle(id)!) };
  });

  app.patch<{ Params: { id: string } }>("/api/vehicles/:id", async (req) => {
    requireAction(sessionUser(db, req), "customers.edit");
    const existing = getVehicle(req.params.id);
    if (!existing) throw notFound("Vehicle not found");
    const merged = { ...vehicleOut(existing), ...(req.body as object) };
    delete (merged as Record<string, unknown>).createdAt;
    delete (merged as Record<string, unknown>).customerName;
    delete (merged as Record<string, unknown>).id;
    db.tx(() => saveVehicle(existing.id, merged));
    return { vehicle: vehicleOut(getVehicle(existing.id)!) };
  });
}
