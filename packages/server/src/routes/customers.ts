import type { FastifyInstance } from "fastify";
import { can, customerSchema, dubaiDate, vehicleSchema, type CustomerInput } from "@ffgp/shared";
import { requireAction, sessionUser, type SessionUser } from "../auth";
import { customerBalance, customerLedger } from "../ledger";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../errors";

interface CustomerRow {
  id: string; kind: string; name: string; phone: string | null; email: string | null; trn: string | null;
  address: string | null; notes: string | null; created_at: string; plates?: string | null;
  credit_allowed: number; credit_limit_fils: number; terms_days: number | null; discount_bp: number; lpo_required: number;
  opening_balance_fils: number; opening_balance_date: string | null;
  name_ar: string | null; address_ar: string | null; doc_language: string; message_language: string;
}
interface VehicleRow {
  id: string; customer_id: string; plate: string; make: string | null; model: string | null; year: number | null;
  vin: string | null; colour: string | null; odometer: number | null; created_at: string; customer_name?: string; engine?: string | null;
}

export const customerOut = (c: CustomerRow) => ({
  id: c.id, kind: c.kind, name: c.name, phone: c.phone, email: c.email, trn: c.trn, address: c.address, notes: c.notes,
  createdAt: c.created_at, plates: c.plates ? c.plates.split(",") : undefined,
  creditAllowed: !!c.credit_allowed, creditLimitFils: c.credit_limit_fils, termsDays: c.terms_days, discountPct: c.discount_bp / 100,
  lpoRequired: !!c.lpo_required, openingBalanceFils: c.opening_balance_fils, openingBalanceDate: c.opening_balance_date,
  nameAr: c.name_ar, addressAr: c.address_ar, docLanguage: c.doc_language, messageLanguage: c.message_language,
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

  app.get<{ Querystring: { q?: string } }>("/api/customers", async (req) => {
    sessionUser(db, req);
    const q = req.query.q?.trim();
    const rows = db.all<CustomerRow>(
      `SELECT c.*, (SELECT group_concat(plate) FROM vehicles WHERE customer_id = c.id) AS plates
       FROM customers c
       WHERE :q IS NULL OR c.name LIKE :like ESCAPE '\\' OR c.phone LIKE :like ESCAPE '\\' OR c.email LIKE :like ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id AND v.plate LIKE :like ESCAPE '\\')
       ORDER BY c.name COLLATE NOCASE LIMIT 300`,
      { q: q || null, like: like(q ?? "") },
    );
    return { customers: rows.map((c) => customerWithBalance(db, c)) };
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
    db.run(
      `INSERT INTO customers (id, kind, name, phone, email, trn, address, notes, credit_allowed, credit_limit_fils, terms_days, discount_bp,
         lpo_required, opening_balance_fils, opening_balance_date, name_ar, address_ar, doc_language, message_language, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.kind, input.name, input.phone, input.email, input.trn, input.address, input.notes, input.creditAllowed ? 1 : 0, input.creditLimitFils,
        input.termsDays, Math.round(input.discountPct * 100), input.lpoRequired ? 1 : 0, input.openingBalanceFils, input.openingBalanceDate,
        input.nameAr, input.addressAr, input.docLanguage, input.messageLanguage, t, t],
    );
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
    db.run(
      `UPDATE customers SET kind = ?, name = ?, phone = ?, email = ?, trn = ?, address = ?, notes = ?, credit_allowed = ?, credit_limit_fils = ?,
         terms_days = ?, discount_bp = ?, lpo_required = ?, opening_balance_fils = ?, opening_balance_date = ?, name_ar = ?, address_ar = ?,
         doc_language = ?, message_language = ?, updated_at = ? WHERE id = ?`,
      [input.kind, input.name, input.phone, input.email, input.trn, input.address, input.notes, input.creditAllowed ? 1 : 0, input.creditLimitFils,
        input.termsDays, Math.round(input.discountPct * 100), input.lpoRequired ? 1 : 0, input.openingBalanceFils, input.openingBalanceDate,
        input.nameAr, input.addressAr, input.docLanguage, input.messageLanguage, now(), existing.id],
    );
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

  app.get<{ Querystring: { q?: string } }>("/api/vehicles", async (req) => {
    sessionUser(db, req);
    const q = req.query.q?.trim();
    const rows = db.all<VehicleRow>(
      `SELECT v.*, c.name AS customer_name FROM vehicles v JOIN customers c ON c.id = v.customer_id
       WHERE :q IS NULL OR v.plate LIKE :like ESCAPE '\\' OR v.make LIKE :like ESCAPE '\\' OR v.model LIKE :like ESCAPE '\\'
          OR v.vin LIKE :like ESCAPE '\\' OR c.name LIKE :like ESCAPE '\\'
       ORDER BY v.plate LIMIT 300`,
      { q: q || null, like: like(q ?? "") },
    );
    return { vehicles: rows.map(vehicleOut) };
  });

  app.get<{ Params: { id: string } }>("/api/vehicles/:id", async (req) => {
    sessionUser(db, req);
    const v = getVehicle(req.params.id);
    if (!v) throw notFound("Vehicle not found");
    return { vehicle: vehicleOut(v) };
  });

  const saveVehicle = (id: string | null, body: unknown) => {
    const input = vehicleSchema.parse(body);
    if (!getCustomer(input.customerId)) throw notFound("Customer not found");
    const clash = db.get<{ id: string }>("SELECT id FROM vehicles WHERE plate = ?", [input.plate]);
    if (clash && clash.id !== id) throw conflict(`Plate ${input.plate} is already registered`);
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
