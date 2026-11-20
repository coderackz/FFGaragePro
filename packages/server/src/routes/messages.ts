import type { FastifyInstance } from "fastify";
import { can, dubaiDate, MESSAGE_STATUSES, messageInputSchema, type Role } from "@ffgp/shared";
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
  // Payslips carry salaries: only people who run payroll see or send them.
  const seesPayslips = (user: { role: Role }) => can(user.role, "payroll.manage");
  app.get("/api/messages", async (req) => {
    const user = sessionUser(db, req);
    return { messages: listMessages(db, listQuery.parse(req.query), { payslips: seesPayslips(user) }) };
  });

  app.get("/api/messages/statements-due", async (req) => {
    sessionUser(db, req);
    return { customers: statementsDue(db, dubaiDate(new Date().toISOString())) };
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const user = sessionUser(db, req);
    const m = getMessage(db, req.params.id);
    if (!m || (m.event === "payslip" && !seesPayslips(user))) throw notFound("Message not found");
    return { message: m };
  });

  // Room for a 6 MB PDF as base64, above the app's usual 5 MB request limit.
  app.post("/api/messages", { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "messages.send");
    const input = messageInputSchema.parse(req.body);
    if (input.event === "payslip") requireAction(user, "payroll.manage");
    const message = queueMessage(db, input, user.id);
    if (message.status === "queued") onQueued();
    return { message };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/retry", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "messages.send");
    if (getMessage(db, req.params.id)?.event === "payslip") requireAction(user, "payroll.manage");
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
      event: "test", channel: "email", customerId: null, employeeId: null, contactId: null, documentId: null, receiptId: null, recipient: to,
      subject: `Test email from ${name}`,
      body: `This is a test email from ${name}, sent by Fleetfix Garage Pro. If you can read it, email is set up correctly.`,
      attachment: null, dedupeKey: null,
    }, user.id);
    onQueued();
    return { message };
  });
}
