import type { FastifyInstance } from "fastify";
import { customerSchema, vehicleSchema } from "@ffgp/shared";
import { requireAction, sessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { conflict, notFound } from "../errors";

interface CustomerRow {
  id: string; kind: string; name: string; phone: string | null; email: string | null; trn: string | null;
  address: string | null; notes: string | null; created_at: string; plates?: string | null;
}
interface VehicleRow {
  id: string; customer_id: string; plate: string; make: string | null; model: string | null; year: number | null;
  vin: string | null; colour: string | null; odometer: number | null; created_at: string; customer_name?: string;
}

export const customerOut = (c: CustomerRow) => ({
  id: c.id, kind: c.kind, name: c.name, phone: c.phone, email: c.email, trn: c.trn, address: c.address, notes: c.notes,
  createdAt: c.created_at, plates: c.plates ? c.plates.split(",") : undefined,
});
export const vehicleOut = (v: VehicleRow) => ({
  id: v.id, customerId: v.customer_id, plate: v.plate, make: v.make, model: v.model, year: v.year, vin: v.vin,
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
    return { customers: rows.map(customerOut) };
  });

  app.get<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    sessionUser(db, req);
    const c = getCustomer(req.params.id);
    if (!c) throw notFound("Customer not found");
    const vehicles = db.all<VehicleRow>("SELECT * FROM vehicles WHERE customer_id = ? ORDER BY plate", [c.id]);
    return { customer: customerOut(c), vehicles: vehicles.map(vehicleOut) };
  });

  app.post("/api/customers", async (req) => {
    requireAction(sessionUser(db, req), "customers.edit");
    const input = customerSchema.parse(req.body);
    const id = newId();
    const t = now();
    db.run(
      "INSERT INTO customers (id, kind, name, phone, email, trn, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.kind, input.name, input.phone, input.email, input.trn, input.address, input.notes, t, t],
    );
    return { customer: customerOut(getCustomer(id)!) };
  });

  app.patch<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    requireAction(sessionUser(db, req), "customers.edit");
    const existing = getCustomer(req.params.id);
    if (!existing) throw notFound("Customer not found");
    const input = customerSchema.parse({ ...customerOut(existing), ...(req.body as object) });
    db.run("UPDATE customers SET kind = ?, name = ?, phone = ?, email = ?, trn = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?", [
      input.kind, input.name, input.phone, input.email, input.trn, input.address, input.notes, now(), existing.id,
    ]);
    return { customer: customerOut(getCustomer(existing.id)!) };
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
    const values = [input.customerId, input.plate, input.make, input.model, input.year ?? null, input.vin, input.colour, input.odometer ?? null];
    if (id) {
      db.run("UPDATE vehicles SET customer_id = ?, plate = ?, make = ?, model = ?, year = ?, vin = ?, colour = ?, odometer = ?, updated_at = ? WHERE id = ?", [...values, t, id]);
      return id;
    }
    const newVehicleId = newId();
    db.run(
      "INSERT INTO vehicles (customer_id, plate, make, model, year, vin, colour, odometer, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
