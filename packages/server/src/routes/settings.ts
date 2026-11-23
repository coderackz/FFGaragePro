import type { FastifyInstance } from "fastify";
import { garageEmirate, recomposeAddress, resolveAddress, saveAddress, sentAddress } from "../address";
import { garageSchema, SETTINGS_SECTIONS, type SettingsSection } from "@ffgp/shared";
import { z } from "zod";
import { audit } from "../audit";
import { requireAction, sessionUser } from "../auth";
import { now, type Db } from "../db";
import { notFound } from "../errors";
import { diff, emailReady, getSecret, getSettings, nextNumbers, saveSection, setSecret } from "../settings";
import { garage, garageOut } from "./setup";

const auditQuery = z.object({
  userId: z.string().optional(),
  action: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const passwordInput = z.object({ password: z.string().min(1, "Enter the password").max(200).nullable() });

interface AuditRow {
  id: string; action: string; entity: string; entity_id: string | null; before: string | null; after: string | null;
  user_name: string | null; device: string | null; created_at: string;
}

export function settingsRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/settings", async (req) => {
    sessionUser(db, req);
    const g = garage(db);
    return { garage: g ? garageOut(db, g) : null, settings: getSettings(db) };
  });

  app.patch("/api/settings", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "settings.manage");
    const input = garageSchema.parse(req.body);
    db.tx(() => {
      const row = garage(db)!;
      const before = garageOut(db, row);
      const address = resolveAddress(row, sentAddress(req.body, input), garageEmirate(db));
      db.run("UPDATE garage SET name = ?, trn = ?, phone = ?, email = ?, updated_at = ? WHERE id = 1", [
        input.name, input.trn, input.phone, input.email, now(),
      ]);
      saveAddress(db, "garage", 1, address);
      const { vatRateBp: _a, addressParts: _p, ...b } = before;
      const changed = diff(b, { name: input.name, trn: input.trn, address: address.address, phone: input.phone, email: input.email });
      if (changed) audit(db, { action: "settings.change", entity: "settings", entityId: "profile", ...changed, userId: user.id });
    });
    return { garage: garageOut(db, garage(db)!) };
  });

  /** The SMTP password: write-only (no route ever returns it). */
  app.put("/api/settings/messages/password", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "settings.manage");
    const { password } = passwordInput.parse(req.body ?? {});
    setSecret(db, user.id, "smtp.password", password);
    return { ok: true, passwordSet: password !== null };
  });

  app.put<{ Params: { section: string } }>("/api/settings/:section", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "settings.manage");
    const section = req.params.section as SettingsSection;
    if (!SETTINGS_SECTIONS.includes(section)) throw notFound("Unknown settings section");
    return db.tx(() => {
      const settings = saveSection(db, user.id, section, req.body ?? {});
      if (section === "garage") recomposeAddress(db, "garage", 1);
      return { settings };
    });
  });

  app.get("/api/settings/overview", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return {
      nextNumbers: nextNumbers(db),
      users: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE active = 1")!.n,
      changesThisWeek: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ?", [weekAgo])!.n,
      messages: { emailReady: emailReady(db), passwordSet: getSecret(db, "smtp.password") !== null },
      failedMessages: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed'")!.n,
    };
  });

  app.get("/api/audit", async (req) => {
    requireAction(sessionUser(db, req), "audit.view");
    const q = auditQuery.parse(req.query);
    const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00.000Z`) + 86_400_000).toISOString();
    const rows = db.all<AuditRow>(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE (:user IS NULL OR a.user_id = :user) AND (:action IS NULL OR a.action = :action)
         AND (:from IS NULL OR a.created_at >= :from) AND (:to IS NULL OR a.created_at < :to)
       ORDER BY a.created_at DESC, a.rowid DESC LIMIT 500`,
      { user: q.userId ?? null, action: q.action ?? null, from: q.from ? `${q.from}T00:00:00.000Z` : null, to: q.to ? nextDay(q.to) : null },
    );
    const parse = (v: string | null) => (v === null ? null : JSON.parse(v));
    return {
      entries: rows.map((r) => ({
        id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id, before: parse(r.before), after: parse(r.after),
        user: r.user_name, device: r.device, createdAt: r.created_at,
      })),
    };
  });
}
