import type { FastifyInstance } from "fastify";
import { messageTemplateSchema } from "@ffgp/shared";
import { requireAction, sessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { notFound } from "../errors";

interface Row {
  id: string; name: string; channel: string; subject_en: string | null; text_en: string;
  wa_template_name: string | null; wa_language: string | null; wa_params_json: string; archived_at: string | null; created_at: string; updated_at: string;
}
const out = (r: Row) => ({
  id: r.id, name: r.name, channel: r.channel as "email" | "whatsapp" | "both", subjectEn: r.subject_en, textEn: r.text_en,
  waTemplateName: r.wa_template_name, waLanguage: r.wa_language, waParams: JSON.parse(r.wa_params_json) as string[], archived: !!r.archived_at,
});
export type TemplateOut = ReturnType<typeof out>;
const row = (db: Db, id: string) => db.get<Row>("SELECT * FROM message_templates WHERE id = ?", [id]);
const COLS = "name = ?, channel = ?, subject_en = ?, text_en = ?, wa_template_name = ?, wa_language = ?, wa_params_json = ?";
const vals = (t: ReturnType<typeof messageTemplateSchema.parse>) =>
  [t.name, t.channel, t.subjectEn, t.textEn, t.waTemplateName, t.waLanguage, JSON.stringify(t.waParams)];

/** Active templates for a channel ("both" fits either), by name. */
export const templatesFor = (db: Db, channel?: "email" | "whatsapp", archived = false) =>
  db.all<Row>(
    `SELECT * FROM message_templates WHERE (? = 1 OR archived_at IS NULL) AND (? IS NULL OR channel = ? OR channel = 'both') ORDER BY name COLLATE NOCASE, created_at`,
    [archived ? 1 : 0, channel ?? null, channel ?? null],
  ).map(out);
export const getTemplate = (db: Db, id: string) => { const r = row(db, id); return r ? out(r) : null; };

/** The garage's own message templates: everyone sending messages picks from them; the owner keeps them. */
export function templateRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: { channel?: string; archived?: string } }>("/api/message-templates", async (req) => {
    const user = sessionUser(db, req);
    const channel = req.query.channel === "email" || req.query.channel === "whatsapp" ? req.query.channel : undefined;
    const archived = req.query.archived === "1";
    if (archived) requireAction(user, "settings.manage");
    return { templates: templatesFor(db, channel, archived) };
  });
  app.post("/api/message-templates", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const t = messageTemplateSchema.parse(req.body);
    const id = newId();
    const ts = now();
    db.run(`INSERT INTO message_templates (id, name, channel, subject_en, text_en, wa_template_name, wa_language, wa_params_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, ...vals(t), ts, ts]);
    return { template: getTemplate(db, id) };
  });
  app.patch<{ Params: { id: string } }>("/api/message-templates/:id", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const r = row(db, req.params.id);
    if (!r) throw notFound("Template not found");
    const t = messageTemplateSchema.parse({ ...out(r), ...(req.body as object) });
    db.run(`UPDATE message_templates SET ${COLS}, updated_at = ? WHERE id = ?`, [...vals(t), now(), r.id]);
    return { template: getTemplate(db, r.id) };
  });
  app.post<{ Params: { id: string } }>("/api/message-templates/:id/archive", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const r = row(db, req.params.id);
    if (!r) throw notFound("Template not found");
    db.run("UPDATE message_templates SET archived_at = ?, updated_at = ? WHERE id = ?", [now(), now(), r.id]);
    return { template: getTemplate(db, r.id) };
  });
}
