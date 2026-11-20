import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAction, sessionUser } from "../auth";
import { now as nowIso, type Db } from "../db";
import { badRequest, HttpError } from "../errors";
import { MAY_HAVE_GONE } from "../messages/outbox";
import { endpointsOf, getConfig, hookBase, saveConfig, statusOf, timedFetch, type IntegrationOptions } from "./store";

export interface WhatsAppConfig { phoneNumberId: string; businessAccountId: string; accessToken: string; appSecret: string; verifyToken: string; label: string | null }
export interface WaTemplate { name: string; language: string; params: string[] }
export const NOT_CONNECTED = "WhatsApp Business API isn't connected: Settings → Integrations";

const connectSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{3,30}$/, "The phone number ID is the long number Meta shows (digits only)"),
  businessAccountId: z.string().trim().regex(/^\d{3,30}$/, "The WhatsApp business account ID is digits only"),
  accessToken: z.string().trim().min(20, "Paste the permanent access token").max(1000),
  appSecret: z.string().trim().min(8, "Paste the app secret (Meta app → Settings → Basic)").max(200),
});

/** Digits only, with the country code (UAE mobiles may be typed the usual ways). */
export function waNumber(raw: string): string {
  const d = raw.replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/^00/, "");
  if (/^05\d{8}$/.test(d)) return `971${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `971${d}`;
  return d;
}

/** Meta's error, in a sentence for the card or the message log. */
async function graphError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; error_data?: { details?: string } } } | null;
  const text = body?.error?.error_data?.details ?? body?.error?.message ?? `HTTP ${res.status}`;
  return new Error(`WhatsApp said: ${text}`);
}

/** Meta's WhatsApp Cloud API (Graph): check the number, upload a PDF, send an approved template. */
export function waClient(cfg: Pick<WhatsAppConfig, "phoneNumberId" | "accessToken">, o: IntegrationOptions) {
  const base = `${endpointsOf(o).graph}/${cfg.phoneNumberId}`;
  const http = timedFetch(o);
  const auth = { authorization: `Bearer ${cfg.accessToken}` };
  return {
    async check(): Promise<string> {
      const res = await http(`${base}?fields=display_phone_number,verified_name`, { headers: auth });
      if (!res.ok) throw await graphError(res);
      const b = (await res.json()) as { display_phone_number?: string };
      return b.display_phone_number ?? cfg.phoneNumberId;
    },
    async upload(fileName: string, base64: string): Promise<string> {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", "application/pdf");
      form.append("file", new Blob([Buffer.from(base64, "base64")], { type: "application/pdf" }), fileName);
      const res = await http(`${base}/media`, { method: "POST", headers: auth, body: form });
      if (!res.ok) throw await graphError(res);
      return ((await res.json()) as { id: string }).id;
    },
    async sendTemplate(to: string, wa: WaTemplate, media?: { id: string; fileName: string }): Promise<string> {
      const components: unknown[] = [];
      if (media) components.push({ type: "header", parameters: [{ type: "document", document: { id: media.id, filename: media.fileName } }] });
      if (wa.params.length) components.push({ type: "body", parameters: wa.params.map((text) => ({ type: "text", text })) });
      const res = await http(`${base}/messages`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", recipient_type: "individual", to: waNumber(to), type: "template",
          template: { name: wa.name, language: { code: wa.language }, ...(components.length ? { components } : {}) },
        }),
      });
      if (!res.ok) throw await graphError(res);
      return ((await res.json()) as { messages: { id: string }[] }).messages[0]!.id;
    },
  };
}
export type WaClient = ReturnType<typeof waClient>;

export function whatsappFor(db: Db, o: IntegrationOptions): WaClient | null {
  const cfg = getConfig<WhatsAppConfig>(db, "whatsapp");
  return cfg ? waClient(cfg, o) : null;
}

interface DueRow { id: string; recipient: string; attempts: number; wa_json: string; file_name: string | null; data_base64: string | null }

/**
 * Sends the queued WhatsApp Business API messages that are due, like emails: claimed first (never sent twice after a
 * stop), retried after 1, 5 and 30 minutes, then failed. Not connected: failed at once with the reason.
 */
export async function sendWhatsAppDue(db: Db, client: WaClient | null, now: Date, place: string, retryMinutes: readonly number[] = [1, 5, 30]): Promise<{ sent: number; failed: number }> {
  const due = db.all<DueRow>(
    `SELECT m.id, m.recipient, m.attempts, m.wa_json, f.file_name, f.data_base64 FROM messages m LEFT JOIN message_files f ON f.message_id = m.id
     WHERE m.status = 'queued' AND m.channel = 'whatsapp' AND m.wa_json IS NOT NULL AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
     ORDER BY m.created_at, m.rowid LIMIT 50`,
    [now.toISOString()],
  );
  let sent = 0;
  let failed = 0;
  for (const m of due) {
    const t = now.toISOString();
    const attempts = m.attempts + 1;
    if (!client) {
      db.run("UPDATE messages SET status = 'failed', attempts = ?, error = ?, sender_place = ?, updated_at = ? WHERE id = ?", [attempts, NOT_CONNECTED, place, t, m.id]);
      failed++;
      continue;
    }
    const claimed = db.run("UPDATE messages SET status = 'sending', attempts = ?, sender_place = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [attempts, place, t, m.id]);
    if (!claimed) continue;
    let wamid: string | null = null;
    let error: unknown = null;
    try {
      const wa = JSON.parse(m.wa_json) as WaTemplate;
      const media = m.file_name && m.data_base64 ? { id: await client.upload(m.file_name, m.data_base64), fileName: m.file_name } : undefined;
      wamid = await client.sendTemplate(m.recipient, wa, media);
    } catch (e) {
      error = e ?? new Error("Unknown error");
    }
    if (error === null) {
      // The PDF's copy stays until WhatsApp says it was delivered: a "failed" status may still come, and a retry needs it.
      db.run("UPDATE messages SET status = 'sent', provider_id = ?, error = NULL, sent_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?", [wamid, t, t, m.id]);
      sent++;
      continue;
    }
    const text = String((error as Error)?.message ?? error).slice(0, 500);
    if (attempts > retryMinutes.length) {
      db.run("UPDATE messages SET status = 'failed', error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?", [text, t, m.id]);
      failed++;
    } else {
      const next = new Date(now.getTime() + retryMinutes[attempts - 1]! * 60_000).toISOString();
      db.run("UPDATE messages SET status = 'queued', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?", [text, next, t, m.id]);
    }
  }
  return { sent, failed };
}

/** After a stop mid-send: may have gone, so failed for a person to check (as for email). */
export const recoverWhatsApp = (db: Db) =>
  db.run("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE status = 'sending' AND channel = 'whatsapp'", [MAY_HAVE_GONE, nowIso()]);

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function whatsappRoutes(app: FastifyInstance, db: Db, o: IntegrationOptions): void {
  const webhookUrl = () => `${hookBase(o)}/whatsapp/webhook`;
  app.get("/api/integrations/whatsapp", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const cfg = getConfig<WhatsAppConfig>(db, "whatsapp");
    return { webhookUrl: webhookUrl(), verifyToken: cfg?.verifyToken ?? null, phoneNumberId: cfg?.phoneNumberId ?? null, businessAccountId: cfg?.businessAccountId ?? null };
  });
  app.post("/api/integrations/whatsapp/connect", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "settings.manage");
    const input = connectSchema.parse(req.body);
    let label: string;
    try {
      label = await waClient(input, o).check();
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const before = getConfig<WhatsAppConfig>(db, "whatsapp");
    saveConfig(db, user.id, "whatsapp", { ...input, verifyToken: before?.verifyToken ?? randomBytes(12).toString("hex"), label });
    return { status: statusOf(db), webhookUrl: webhookUrl() };
  });
  app.post("/api/integrations/whatsapp/test", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const input = z.object({ to: z.string().trim().min(8).max(30), templateName: z.string().trim().min(1).max(512), language: z.string().trim().min(2).max(15) }).parse(req.body);
    const client = whatsappFor(db, o);
    if (!client) throw badRequest(NOT_CONNECTED);
    try {
      return { id: await client.sendTemplate(input.to, { name: input.templateName, language: input.language, params: [] }) };
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  });

  // Meta's webhook: the verify handshake, then delivery statuses signed with the app secret (checked on the raw body).
  app.get<{ Querystring: Record<string, string> }>("/api/integrations/whatsapp/webhook", async (req, reply) => {
    const cfg = getConfig<WhatsAppConfig>(db, "whatsapp");
    const token = req.query["hub.verify_token"] ?? "";
    if (!cfg || req.query["hub.mode"] !== "subscribe" || !same(token, cfg.verifyToken)) return reply.status(403).send("Forbidden");
    return reply.type("text/plain").send(req.query["hub.challenge"] ?? "");
  });
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    scope.post("/api/integrations/whatsapp/webhook", async (req, reply) => {
      const cfg = getConfig<WhatsAppConfig>(db, "whatsapp");
      const raw = typeof req.body === "string" ? req.body : "";
      const sig = String(req.headers["x-hub-signature-256"] ?? "");
      if (!cfg || !sig || !same(sig, `sha256=${createHmac("sha256", cfg.appSecret).update(raw).digest("hex")}`)) {
        throw new HttpError(401, "Signature doesn't match");
      }
      let body: { entry?: { changes?: { value?: { statuses?: { id: string; status: string; errors?: { title?: string; message?: string }[] }[] } }[] }[] };
      try {
        body = JSON.parse(raw);
      } catch {
        return reply.status(400).send({ error: "Not JSON" });
      }
      const t = nowIso();
      for (const e of body.entry ?? []) for (const c of e.changes ?? []) for (const s of c.value?.statuses ?? []) {
        if (s.status === "delivered" || s.status === "read") {
          if (s.status === "delivered") db.run("UPDATE messages SET delivery = 'delivered', updated_at = ? WHERE provider_id = ? AND delivery IS NULL", [t, s.id]);
          else db.run("UPDATE messages SET delivery = 'read', updated_at = ? WHERE provider_id = ?", [t, s.id]);
          // It has arrived: the PDF's copy isn't needed (or backed up) any more; the log keeps its name.
          db.run("UPDATE message_files SET data_base64 = '' WHERE message_id IN (SELECT id FROM messages WHERE provider_id = ?)", [s.id]);
        }
        else if (s.status === "failed") {
          const why = s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? "Not delivered";
          db.run("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE provider_id = ?", [`WhatsApp: ${why}`, t, s.id]);
        }
      }
      return { ok: true };
    });
  });
}
