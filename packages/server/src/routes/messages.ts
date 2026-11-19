import type { FastifyInstance } from "fastify";
import { dubaiDate, MESSAGE_STATUSES, messageInputSchema } from "@ffgp/shared";
import { z } from "zod";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { notFound } from "../errors";
import { getMessage, listMessages, queueMessage, retryMessage, statementsDue } from "../messages/outbox";
import { garage } from "./setup";

const listQuery = z.object({
  customerId: z.string().optional(),
  documentId: z.string().optional(),
  receiptId: z.string().optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
});
const testInput = z.object({ to: z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address") });

/** Messages: queue an email or log a WhatsApp message, the log, retry, test email, and statements to send. */
export function messageRoutes(app: FastifyInstance, db: Db, onQueued: () => void = () => {}): void {
  app.get("/api/messages", async (req) => {
    sessionUser(db, req);
    return { messages: listMessages(db, listQuery.parse(req.query)) };
  });

  app.get("/api/messages/statements-due", async (req) => {
    sessionUser(db, req);
    return { customers: statementsDue(db, dubaiDate(new Date().toISOString())) };
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    sessionUser(db, req);
    const m = getMessage(db, req.params.id);
    if (!m) throw notFound("Message not found");
    return { message: m };
  });

  // Room for a 6 MB PDF as base64, above the app's usual 5 MB request limit.
  app.post("/api/messages", { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "messages.send");
    const message = queueMessage(db, messageInputSchema.parse(req.body), user.id);
    if (message.status === "queued") onQueued();
    return { message };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/retry", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "messages.send");
    const message = retryMessage(db, req.params.id);
    if (message.status === "queued") onQueued();
    return { message };
  });

  /** A real message through the real sender (the cloud too, when linked), so it proves the whole path works. */
  app.post("/api/messages/test", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "settings.manage");
    const { to } = testInput.parse(req.body);
    const name = garage(db)?.name ?? "your garage";
    const message = queueMessage(db, {
      event: "test", channel: "email", customerId: null, contactId: null, documentId: null, receiptId: null, recipient: to,
      subject: `Test email from ${name}`,
      body: `This is a test email from ${name}, sent by Fleetfix Garage Pro. If you can read it, email is set up correctly.`,
      attachment: null, dedupeKey: null,
    }, user.id);
    onQueued();
    return { message };
  });
}
