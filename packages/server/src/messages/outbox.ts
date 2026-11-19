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

/** Errors that mean the mail server itself can't be used right now: no point trying this garage's other emails. */
const SERVER_DOWN = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "EAUTH", "ETLS", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND"]);
export const MAY_HAVE_GONE = "Stopped while sending: it may have gone. Check with the customer before trying again.";

/**
 * Sends the queued emails that are due, oldest first. Each is claimed (`sending`) before it goes, so an app stopped
 * mid-send never sends it twice. A failure is tried again after 1, 5 and 30 minutes, then the message is marked
 * failed (shown on the dashboard). No mailbox set up: failed at once. A mail server that can't be reached ends the
 * round for this garage (its other emails wait, uncounted).
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
    // Claimed first: if the app stops while the mail server has it, it is never re-sent blindly.
    const claimed = db.run("UPDATE messages SET status = 'sending', attempts = ?, sender_place = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [
      attempts, place, t, m.id,
    ]);
    if (!claimed) continue;
    let error: unknown = null;
    try {
      await mailer.send({
        from, to: m.recipient, subject: m.subject ?? "", text: m.body,
        attachments: m.file_name && m.data_base64 ? [{ filename: m.file_name, content: Buffer.from(m.data_base64, "base64") }] : [],
      });
    } catch (e) {
      error = e ?? new Error("Unknown error");
    }
    if (error === null) {
      // Outside the try: a database error here must not be taken for a failed send (and resent).
      db.run("UPDATE messages SET status = 'sent', error = NULL, sent_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?", [t, t, m.id]);
      // The PDF has gone with it: don't keep (and back up) its copy; the log keeps the file name.
      db.run("UPDATE message_files SET data_base64 = '' WHERE message_id = ?", [m.id]);
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
    if (SERVER_DOWN.has(String((error as { code?: unknown }).code ?? ""))) break;
  }
  return { sent, failed };
}

/** After a stop in the middle of sending: those emails may have gone, so they are failed for a person to check. */
export function recoverInterrupted(db: Db): number {
  return db.run("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE status = 'sending' AND channel = 'email'", [MAY_HAVE_GONE, nowIso()]);
}

/**
 * When this server stops being the garage's sender (unlinked from the cloud, which may still send them): its queued
 * emails become failed, for a person to check and Try again, rather than going twice.
 */
export function abandonQueuedEmails(db: Db, reason: string): number {
  return db.run("UPDATE messages SET status = 'failed', error = ?, next_attempt_at = NULL, updated_at = ? WHERE status = 'queued' AND channel = 'email'", [
    `Not sent: ${reason}. Check, then Try again.`, nowIso(),
  ]);
}

/**
 * The garage's sender loop (only where this garage's messages are sent from): every `everyMs` sends what's due, and
 * once per Dubai day queues payment reminders. `kick()` runs a round now (a message was just queued).
 */
export function startOutbox(
  db: Db,
  o: { mailerFor: () => Mailer | null; place: string; now?: () => number; everyMs?: number; retryMinutes?: readonly number[] },
): { stop(): Promise<void>; kick(): void } {
  const clock = o.now ?? Date.now;
  recoverInterrupted(db);
  let current: Promise<void> | null = null;
  let running = false;
  let again = false;
  let stopped = false;
  let lastDay = "";
  const tick = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    const p: Promise<void> = round().finally(() => {
      if (current === p) current = null;
    });
    current = p;
  };
  const round = async () => {
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
      if (again && !stopped) {
        again = false;
        queueMicrotask(tick);
      }
    }
  };
  const timer = setInterval(tick, o.everyMs ?? 30_000);
  timer.unref?.();
  tick();
  return {
    /** Stops the loop and waits for an email already with the mail server, so its result is written. */
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await current;
    },
    kick: tick,
  };
}
