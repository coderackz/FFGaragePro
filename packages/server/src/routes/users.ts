import type { FastifyInstance } from "fastify";
import { userCreateSchema, userUpdateSchema } from "@ffgp/shared";
import { audit } from "../audit";
import { hashPassword, requireAction, sessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";

interface UserRow { id: string; name: string; username: string; role: string; active: number; created_at: string }
const out = (u: UserRow) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: !!u.active, createdAt: u.created_at });

export function userRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/users", async (req) => {
    requireAction(sessionUser(db, req), "users.manage");
    return { users: db.all<UserRow>("SELECT id, name, username, role, active, created_at FROM users ORDER BY name").map(out) };
  });

  app.post("/api/users", async (req) => {
    const me = sessionUser(db, req);
    requireAction(me, "users.manage");
    const input = userCreateSchema.parse(req.body);
    if (db.get("SELECT 1 FROM users WHERE username = ?", [input.username])) throw conflict("That username is taken");
    const id = newId();
    const t = now();
    db.tx(() => {
      db.run("INSERT INTO users (id, name, username, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        id, input.name, input.username, input.role, hashPassword(input.password), t, t,
      ]);
      audit(db, { action: "user.create", entity: "user", entityId: id, after: { name: input.name, username: input.username, role: input.role }, userId: me.id });
    });
    return { user: out(db.get<UserRow>("SELECT id, name, username, role, active, created_at FROM users WHERE id = ?", [id])!) };
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const me = sessionUser(db, req);
    requireAction(me, "users.manage");
    const input = userUpdateSchema.parse(req.body);
    return db.tx(() => {
      const user = db.get<UserRow>("SELECT id, name, username, role, active, created_at FROM users WHERE id = ?", [req.params.id]);
      if (!user) throw notFound("User not found");
      const losingOwner = user.role === "owner" && ((input.role && input.role !== "owner") || input.active === false);
      if (losingOwner) {
        const owners = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1")!.n;
        if (owners <= 1) throw badRequest("There must be at least one active owner");
      }
      db.run(
        `UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active),
         password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?`,
        [input.name ?? null, input.role ?? null, input.active === undefined ? null : input.active ? 1 : 0,
         input.password ? hashPassword(input.password) : null, now(), user.id],
      );
      if (input.active === false || input.password) db.run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (input.name !== undefined && input.name !== user.name) { before.name = user.name; after.name = input.name; }
      if (input.role !== undefined && input.role !== user.role) { before.role = user.role; after.role = input.role; }
      if (input.active !== undefined && input.active !== !!user.active) { before.active = !!user.active; after.active = input.active; }
      if (input.password) after.passwordChanged = true;
      if (Object.keys(after).length) {
        audit(db, { action: "user.update", entity: "user", entityId: user.id, before: { username: user.username, ...before }, after, userId: me.id });
      }
      return { user: out(db.get<UserRow>("SELECT id, name, username, role, active, created_at FROM users WHERE id = ?", [user.id])!) };
    });
  });
}
