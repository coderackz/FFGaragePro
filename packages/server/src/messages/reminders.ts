import { fillTemplate, messageValues, recipientsFor, type MessageLanguage, type Recipient } from "@ffgp/shared";
import type { Db } from "../db";
import { customerBalance } from "../ledger";
import { contactsOf } from "../routes/contacts";
import { garage } from "../routes/setup";
import { getSettings } from "../settings";
import { queueMessage } from "./outbox";

interface CustomerRow { id: string; kind: "individual" | "company"; name: string; phone: string | null; email: string | null; message_language: string }

const customerOf = (db: Db, id: string) => db.get<CustomerRow>("SELECT id, kind, name, phone, email, message_language FROM customers WHERE id = ?", [id]);
const asCustomer = (c: CustomerRow) => ({ ...c, messageLanguage: c.message_language as MessageLanguage });
/** Days past the overdue threshold an invoice still gets its overdue reminder. */
const OVERDUE_WINDOW = 30;
const addDays = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Payment reminders for `today` (a Dubai date), to the customer's invoices contacts that have an email: "due soon"
 * for unpaid invoices due within `dueSoonDays`, "overdue" for invoices at least `overdueDays` past due (but no more
 * than OVERDUE_WINDOW days past that, so turning reminders on doesn't email very old invoices). Windows, not exact
 * days: a PC that was off on the day still sends it. An invoice gets each reminder at most once (dedupe key).
 */
export function queueReminders(db: Db, today: string): number {
  const m = getSettings(db).messages;
  const g = garage(db);
  let queued = 0;
  const kinds = [
    ["payment_due", today, addDays(today, m.dueSoonDays)],
    ["payment_overdue", addDays(today, -m.overdueDays - OVERDUE_WINDOW), addDays(today, -m.overdueDays)],
  ] as const;
  for (const [event, from, to] of kinds) {
    const settings = m[event];
    if (!settings.on) continue;
    const invoices = db.all<{ id: string; number: string; customer_id: string; due_date: string; owed: number; plate: string | null; make: string | null; model: string | null }>(
      `SELECT d.id, d.number, d.customer_id, d.due_date, d.gross_fils - d.credited_fils - d.paid_fils AS owed, v.plate, v.make, v.model
       FROM documents d LEFT JOIN vehicles v ON v.id = d.vehicle_id
       WHERE d.type = 'invoice' AND d.status IN ('issued', 'part_paid') AND d.due_date BETWEEN ? AND ?
         AND d.gross_fils - d.credited_fils - d.paid_fils > 0`,
      [from, to],
    );
    for (const inv of invoices) {
      const c = customerOf(db, inv.customer_id);
      if (!c) continue;
      const balance = customerBalance(db, c.id, today).balanceFils;
      for (const r of recipientsFor(event, asCustomer(c), contactsOf(db, c.id)).filter((x): x is Recipient & { email: string } => !!x.email)) {
        const dedupeKey = `${event}:${inv.id}:${r.email}`;
        if (db.get("SELECT 1 FROM messages WHERE dedupe_key = ?", [dedupeKey])) continue;
        const values = messageValues({
          customerName: c.name, contactName: r.name, plate: inv.plate, vehicle: [inv.make, inv.model].filter(Boolean).join(" "),
          docNumber: inv.number, amountFils: inv.owed, balanceFils: balance, dueDate: inv.due_date, garageName: g?.name ?? "", garagePhone: g?.phone,
        });
        const ar = r.language === "ar";
        queueMessage(db, {
          event, channel: "email", customerId: c.id, contactId: r.contactId, documentId: inv.id, receiptId: null, recipient: r.email,
          subject: fillTemplate(ar ? settings.subjectAr : settings.subjectEn, values), body: fillTemplate(ar ? settings.textAr : settings.textEn, values),
          attachment: null, dedupeKey,
        }, null);
        queued++;
      }
    }
  }
  return queued;
}

/**
 * Customers to send a monthly statement to: someone to send it to, a balance that isn't zero, and no statement
 * message since the 1st of this month (Dubai).
 */
export function statementsDue(db: Db, today: string) {
  const monthStart = new Date(`${today.slice(0, 8)}01T00:00:00+04:00`).toISOString();
  const sent = new Set(
    db.all<{ customer_id: string }>("SELECT DISTINCT customer_id FROM messages WHERE event = 'statement' AND created_at >= ? AND customer_id IS NOT NULL", [monthStart])
      .map((r) => r.customer_id),
  );
  const out: { id: string; name: string; balanceFils: number; recipients: Recipient[] }[] = [];
  for (const c of db.all<CustomerRow>("SELECT id, kind, name, phone, email, message_language FROM customers ORDER BY name COLLATE NOCASE")) {
    if (sent.has(c.id)) continue;
    const balance = customerBalance(db, c.id, today).balanceFils;
    if (balance === 0) continue;
    const recipients = recipientsFor("statement", asCustomer(c), contactsOf(db, c.id));
    if (recipients.length) out.push({ id: c.id, name: c.name, balanceFils: balance, recipients });
  }
  return out;
}
