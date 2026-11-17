import type { FastifyInstance } from "fastify";
import { garageSchema, loginSchema, setupSchema } from "@ffgp/shared";
import { createSession, endSession, bearer, hashPassword, requireAction, sessionUser, verifyPassword } from "../auth";
import { newId, now, type Db } from "../db";
import { conflict, unauthorized } from "../errors";

export interface GarageRow {
  name: string;
  trn: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  vat_rate_bp: number;
}

export function garage(db: Db): GarageRow | undefined {
  return db.get<GarageRow>("SELECT name, trn, address, phone, email, vat_rate_bp FROM garage WHERE id = 1");
}

const garageOut = (g: GarageRow) => ({ name: g.name, trn: g.trn, address: g.address, phone: g.phone, email: g.email, vatRateBp: g.vat_rate_bp });

export function setupRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/setup/status", async () => ({ configured: garage(db) !== undefined }));

  app.post("/api/setup", async (req) => {
    const input = setupSchema.parse(req.body);
    const result = db.tx(() => {
      if (garage(db)) throw conflict("This garage is already set up");
      const t = now();
      db.run("INSERT INTO garage (id, name, trn, address, phone, email, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)", [
        input.garage.name, input.garage.trn, input.garage.address, input.garage.phone, input.garage.email, t, t,
      ]);
      const id = newId();
      db.run("INSERT INTO users (id, name, username, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?, ?)", [
        id, input.owner.name, input.owner.username, hashPassword(input.owner.password), t, t,
      ]);
      return { id };
    });
    const token = createSession(db, result.id);
    return { token, user: { id: result.id, name: input.owner.name, username: input.owner.username, role: "owner" } };
  });

  app.post("/api/auth/login", async (req) => {
    const input = loginSchema.parse(req.body);
    const row = db.get<{ id: string; name: string; username: string; role: string; password_hash: string; active: number }>(
      "SELECT id, name, username, role, password_hash, active FROM users WHERE username = ?",
      [input.username],
    );
    if (!row || !row.active || !verifyPassword(input.password, row.password_hash)) throw unauthorized("Wrong username or password");
    return { token: createSession(db, row.id), user: { id: row.id, name: row.name, username: row.username, role: row.role } };
  });

  app.post("/api/auth/logout", async (req) => {
    const token = bearer(req);
    if (token) endSession(db, token);
    return { ok: true };
  });

  app.get("/api/me", async (req) => ({ user: sessionUser(db, req) }));

  app.get("/api/settings", async (req) => {
    sessionUser(db, req);
    const g = garage(db);
    return { garage: g ? garageOut(g) : null };
  });

  app.patch("/api/settings", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const input = garageSchema.parse(req.body);
    db.run("UPDATE garage SET name = ?, trn = ?, address = ?, phone = ?, email = ?, updated_at = ? WHERE id = 1", [
      input.name, input.trn, input.address, input.phone, input.email, now(),
    ]);
    return { garage: garageOut(garage(db)!) };
  });
}
