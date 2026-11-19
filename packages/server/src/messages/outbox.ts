import { dubaiDate, type MessageInput } from "@ffgp/shared";
import { newId, now as nowIso, type Db } from "../db";
import { notFound } from "../errors";
import { getSettings } from "../settings";
import type { Mailer } from "./mailer";
import { queueReminders } from "./reminders";

export { queueReminders, statementsDue } from "./reminders";

/** Minutes to wait after the 1st, 2nd and 3rd failed try; the 4th failure is final (spec F). */
export const RETRY_MINUTES = [1, 5, 30];
export const NOT_SET_UP = "Email isn't set up: Settings → Messages";

interface MessageRow {
  id: string; customer_id: string | null; contact_id: string | null; document_id: string | null; receipt_id: string | null;
  event: string; channel: string; recipient: string; subject: string | null; body: string; status: string; attempts: number;
  next_attempt_at: string | null; error: string | null; sender_place: string | null; created_at: string; sent_at: string | null;
  created_by_name?: string | null; file_name?: string | null;
}

const SELECT = `SELECT m.*, u.name AS created_by_name, (SELECT file_name FROM message_files f WHERE f.message_id = m.id LIMIT 1) AS file_name
  FROM messages m LEFT JOIN users u ON u.id = m.created_by`;

export const messageOut = (m: MessageRow) => ({
  id: m.id, customerId: m.customer_id, contactId: m.contact_id, documentId: m.document_id, receiptId: m.receipt_id, event: m.event,
  channel: m.channel, recipient: m.recipient, subject: m.subject, body: m.body, status: m.status, attempts: m.attempts,
  nextAttemptAt: m.next_attempt_at, error: m.error, senderPlace: m.sender_place, createdBy: m.created_by_name ?? null,
  createdAt: m.created_at, sentAt: m.sent_at, fileName: m.file_name ?? null,
});
export type MessageOut = ReturnType<typeof messageOut>;

export function getMessage(db: Db, id: string): MessageOut | null {
  const m = db.get<MessageRow>(`${SELECT} WHERE m.id = ?`, [id]);
  return m ? messageOut(m) : null;
}

export function listMessages(db: Db, q: { customerId?: string; documentId?: string; receiptId?: string; status?: string }): MessageOut[] {
  return db
    .all<MessageRow>(
      `${SELECT} WHERE (:customer IS NULL OR m.customer_id = :customer) AND (:document IS NULL OR m.document_id = :document)
         AND (:receipt IS NULL OR m.receipt_id = :receipt) AND (:status IS NULL OR m.status = :status)
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT 200`,
      { customer: q.customerId ?? null, document: q.documentId ?? null, receipt: q.receiptId ?? null, status: q.status ?? null },
    )
    .map(messageOut);
}

/**
 * Queues an email (sent by this garage's one sender: the cloud when linked, else its server) or logs a WhatsApp
 * message opened on a PC. The same `dedupeKey` twice returns the first message: automatic messages never go twice.
 */
export function queueMessage(db: Db, input: MessageInput, userId: string | null): MessageOut {
  return db.tx(() => {
    if (input.dedupeKey) {
      const existing = db.get<{ id: string }>("SELECT id FROM messages WHERE dedupe_key = ?", [input.dedupeKey]);
      if (existing) return getMessage(db, existing.id)!;
    }
    if (input.customerId && !db.get("SELECT 1 FROM customers WHERE id = ?", [input.customerId])) throw notFound("Customer not found");
    if (input.documentId && !db.get("SELECT 1 FROM documents WHERE id = ?", [input.documentId])) throw notFound("Document not found");
    if (input.receiptId && !db.get("SELECT 1 FROM receipts WHERE id = ?", [input.receiptId])) throw notFound("Receipt not found");
    const id = newId();
    const t = nowIso();
    const email = input.channel === "email";
    db.run(
      `INSERT INTO messages (id, customer_id, contact_id, document_id, receipt_id, event, channel, recipient, subject, body, status, dedupe_key,
         created_by, created_at, sent_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.customerId, input.contactId, input.documentId, input.receiptId, input.event, input.channel, input.recipient, input.subject,
        input.body, email ? "queued" : "opened", input.dedupeKey, userId, t, email ? null : t, t],
    );
    if (input.attachment) {
      db.run("INSERT INTO message_files (id, message_id, file_name, data_base64, created_at) VALUES (?, ?, ?, ?, ?)", [
        newId(), id, input.attachment.fileName, input.attachment.base64, t,
      ]);
    }
    return getMessage(db, id)!;
  });
}

/** A failed message back in the queue, tried again from the start. */
export function retryMessage(db: Db, id: string): MessageOut {
  const m = getMessage(db, id);
  if (!m) throw notFound("Message not found");
  if (m.status === "failed") {
    db.run("UPDATE messages SET status = 'queued', attempts = 0, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), id]);
  }
  return getMessage(db, id)!;
}

/**
 * Sends the queued emails that are due, oldest first. A failure is tried again after 1, 5 and 30 minutes, then the
 * message is marked failed (shown on the dashboard). No mailbox set up: failed at once (retrying can't help).
 */
export async function sendDue(
  db: Db, mailer: Mailer | null, now: Date, place: string, retryMinutes: readonly number[] = RETRY_MINUTES,
): Promise<{ sent: number; failed: number }> {
  const due = db.all<MessageRow & { data_base64: string | null }>(
    `SELECT m.*, f.file_name, f.data_base64 FROM messages m LEFT JOIN message_files f ON f.message_id = m.id
     WHERE m.status = 'queued' AND m.channel = 'email' AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
     ORDER BY m.created_at, m.rowid LIMIT 50`,
    [now.toISOString()],
  );
  const { fromName, fromAddress } = getSettings(db).messages;
  const from = fromAddress ? (fromName ? `"${fromName.replace(/["\\\r\n]/g, "")}" <${fromAddress}>` : fromAddress) : null;
  let sent = 0;
  let failed = 0;
  for (const m of due) {
    const t = now.toISOString();
    const attempts = m.attempts + 1;
    if (!mailer || !from) {
      db.run("UPDATE messages SET status = 'failed', attempts = ?, error = ?, sender_place = ?, updated_at = ? WHERE id = ?", [attempts, NOT_SET_UP, place, t, m.id]);
      failed++;
      continue;
    }
    try {
      await mailer.send({
        from, to: m.recipient, subject: m.subject ?? "", text: m.body,
        attachments: m.file_name && m.data_base64 ? [{ filename: m.file_name, content: Buffer.from(m.data_base64, "base64") }] : [],
      });
      db.run("UPDATE messages SET status = 'sent', attempts = ?, error = NULL, sent_at = ?, sender_place = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?", [
        attempts, t, place, t, m.id,
      ]);
      sent++;
    } catch (error) {
      const text = String((error as Error)?.message ?? error).slice(0, 500);
      if (attempts > retryMinutes.length) {
        db.run("UPDATE messages SET status = 'failed', attempts = ?, error = ?, sender_place = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?", [
          attempts, text, place, t, m.id,
        ]);
        failed++;
      } else {
        const next = new Date(now.getTime() + retryMinutes[attempts - 1]! * 60_000).toISOString();
        db.run("UPDATE messages SET attempts = ?, error = ?, next_attempt_at = ?, sender_place = ?, updated_at = ? WHERE id = ?", [attempts, text, next, place, t, m.id]);
      }
    }
  }
  return { sent, failed };
}

/**
 * The garage's sender loop (only where this garage's messages are sent from): every `everyMs` sends what's due, and
 * once per Dubai day queues payment reminders. Returns a stop function.
 */
export function startOutbox(
  db: Db,
  o: { mailerFor: () => Mailer | null; place: string; now?: () => number; everyMs?: number; retryMinutes?: readonly number[] },
): () => void {
  const clock = o.now ?? Date.now;
  let running = false;
  let stopped = false;
  let lastDay = "";
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const t = new Date(clock());
      const day = dubaiDate(t.toISOString());
      if (day !== lastDay) {
        queueReminders(db, day);
        lastDay = day;
      }
      await sendDue(db, o.mailerFor(), t, o.place, o.retryMinutes);
    } catch (error) {
      if (!stopped) console.error("Messages:", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), o.everyMs ?? 30_000);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
