import { randomInt } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { hashPassword, LoginThrottle } from "@ffgp/server";
import { normalizeGarageCode } from "@ffgp/shared";
import type { AdminDb, GarageRow, StaffRow } from "./admin-db";
import type { GarageHost } from "./garages";
import { garageLicence } from "./server";

class AdminError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const createSchema = z.object({ code: z.string(), name: z.string().trim().min(1, "Name is required").max(200), notes: z.string().max(2000).nullish() });
const patchSchema = z.object({
  paidUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2027-12-31")
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, "That date doesn't exist")
    .nullish(),
  status: z.enum(["active", "paused"]).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(2000).nullish(),
});
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Fleet Fix staff API (`/admin/api/*`): create garages, set licences, help owners back in. */
export function adminRoutes(app: FastifyInstance, o: { admin: AdminDb; host: GarageHost; now: () => number }): void {
  const { admin, host, now } = o;
  const staffThrottle = new LoginThrottle();

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AdminError) return reply.status(error.status).send({ error: error.message });
    if (error instanceof ZodError) return reply.status(400).send({ error: error.issues[0]?.message ?? "Invalid input" });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (error as Error).message });
    console.error(error);
    return reply.status(500).send({ error: "Something went wrong. Please try again." });
  });

  const requireStaff = (req: FastifyRequest): StaffRow => {
    const auth = req.headers.authorization;
    const staff = auth?.startsWith("Bearer ") ? admin.staffForToken(auth.slice(7), now()) : undefined;
    if (!staff) throw new AdminError(401, "Please sign in");
    return staff;
  };
  const garageOr404 = (id: string): GarageRow => {
    const g = admin.garageById(id);
    if (!g) throw new AdminError(404, "Garage not found");
    return g;
  };

  async function garageOut(g: GarageRow) {
    const { db } = await host.get(g.id);
    const setUp = !!db.get("SELECT 1 FROM garage WHERE id = 1");
    const userCount = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE active = 1")?.n ?? 0;
    const l = garageLicence(g, now());
    return {
      id: g.id, code: g.garage_code, name: g.name, notes: g.notes, status: g.status, state: l.state, endsAt: l.endsAt,
      graceEndsAt: l.graceEndsAt, trialEndsAt: g.trial_ends_at, paidUntil: g.paid_until, pausedAt: g.paused_at,
      setUp, userCount, lastSyncAt: g.last_sync_at, createdAt: g.created_at,
      ...(setUp ? {} : { setupCode: g.setup_code, setupCodeExpiresAt: g.setup_code_expires_at }),
    };
  }

  app.post("/admin/api/login", async (req) => {
    const { username, password } = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const locked = staffThrottle.lockedMinutes(username.trim(), now());
    if (locked) throw new AdminError(429, `Too many wrong passwords. This login is locked — try again in ${locked} minute${locked === 1 ? "" : "s"}.`);
    const result = admin.staffLogin(username.trim(), password, now());
    if (!result) {
      staffThrottle.failed(username.trim(), now());
      throw new AdminError(401, "Wrong username or password");
    }
    staffThrottle.succeeded(username.trim());
    return { token: result.token, staff: { name: result.staff.name, username: result.staff.username } };
  });

  app.get("/admin/api/me", async (req) => {
    const s = requireStaff(req);
    return { staff: { name: s.name, username: s.username } };
  });

  app.get("/admin/api/garages", async (req) => {
    requireStaff(req);
    const garages = [];
    for (const g of admin.listGarages()) garages.push(await garageOut(g));
    return { garages };
  });

  app.post("/admin/api/garages", async (req) => {
    const staff = requireStaff(req);
    const input = createSchema.parse(req.body);
    const code = normalizeGarageCode(input.code);
    if (!code) throw new AdminError(400, "Garage ID: 3–40 lowercase letters, numbers or dashes, starting with a letter or number (e.g. alquoz-auto)");
    if (admin.garageByCode(code)) throw new AdminError(409, `The garage ID ${code} is already taken`);
    const g = admin.createGarage({ code, name: input.name, notes: input.notes ?? null, now: now() });
    admin.audit({ staffId: staff.id, garageId: g.id, action: "garage.create", detail: { code, name: input.name }, now: now() });
    return { garage: await garageOut(g) };
  });

  app.patch<{ Params: { id: string } }>("/admin/api/garages/:id", async (req) => {
    const staff = requireStaff(req);
    const input = patchSchema.parse(req.body);
    const g = garageOr404(req.params.id);
    const t = now();
    const patch: Parameters<AdminDb["updateGarage"]>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;
    if (input.paidUntil !== undefined) {
      patch.paid_until = input.paidUntil ?? null;
      if (input.paidUntil) Object.assign(patch, { status: "active", paused_at: null });
    }
    if (input.status === "paused") Object.assign(patch, { status: "paused", paused_at: new Date(t).toISOString() });
    if (input.status === "active") Object.assign(patch, { status: g.paid_until || patch.paid_until ? "active" : "trial", paused_at: null });
    admin.updateGarage(g.id, patch, t);
    admin.audit({ staffId: staff.id, garageId: g.id, action: "garage.update", detail: input, now: t });
    return { garage: await garageOut(admin.garageById(g.id)!) };
  });

  app.post<{ Params: { id: string } }>("/admin/api/garages/:id/setup-code", async (req) => {
    const staff = requireStaff(req);
    const g = garageOr404(req.params.id);
    if ((await garageOut(g)).setUp) throw new AdminError(409, "This garage is already set up");
    admin.newSetupCode(g.id, now());
    admin.audit({ staffId: staff.id, garageId: g.id, action: "garage.setup_code", now: now() });
    return { garage: await garageOut(admin.garageById(g.id)!) };
  });

  app.post<{ Params: { id: string } }>("/admin/api/garages/:id/reset-owner-password", async (req) => {
    const staff = requireStaff(req);
    const g = garageOr404(req.params.id);
    const { db } = await host.get(g.id);
    const owner = db.get<{ id: string; username: string }>("SELECT id, username FROM users WHERE role = 'owner' AND active = 1 ORDER BY created_at LIMIT 1");
    if (!owner) throw new AdminError(409, "This garage has no owner account yet");
    const temporaryPassword = Array.from({ length: 12 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");
    db.tx(() => {
      db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [hashPassword(temporaryPassword), new Date(now()).toISOString(), owner.id]);
      db.run("DELETE FROM sessions WHERE user_id = ?", [owner.id]);
    });
    admin.audit({ staffId: staff.id, garageId: g.id, action: "garage.reset_owner_password", detail: { username: owner.username }, now: now() });
    return { username: owner.username, temporaryPassword };
  });
}
