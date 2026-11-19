import {
  fillTemplate, messageValues, recipientsFor, type MessageEvent, type MessageEventSettings, type Recipient, type Settings,
} from "@ffgp/shared";
import { toast } from "sonner";
import { get, post } from "../lib/api";
import { vehicleLabel } from "../lib/format";
import type { Contact, Customer, DocumentFull, Garage, Message, Receipt, Statement } from "../lib/types";
import { renderDocumentHtml, renderReceiptHtml, renderStatementHtml } from "../print/templates";
import { EVENT_LABELS } from "./labels";
import { makePdf } from "./pdf";
import { uaePhone } from "./whatsapp";

type ValuesInput = Parameters<typeof messageValues>[0];

/** A message to send about something that just happened (or that staff chose to send). */
export interface SendRequest {
  event: MessageEvent;
  customerId: string;
  documentId?: string | null;
  receiptId?: string | null;
  /** Job cards: the driver gets "vehicle received/ready". */
  driver?: { name: string | null; phone: string | null } | null;
  /** Placeholder values; {contact} and {balance} are filled in when sending. */
  values: Omit<ValuesInput, "contactName" | "balanceFils">;
  /** The PDF to attach, made only when it's needed. */
  pdf?: { fileName: string; html: () => string } | null;
  /** Staff pressed Send: every channel is offered, whatever the event's settings. */
  manual?: boolean;
  /** Automatic email already went; only the WhatsApp half is left to ask about. */
  whatsappOnly?: boolean;
}

// ── The Send dialog is opened from anywhere through this hook-up (SendDialogHost listens). ─────────────────────────
let asker: ((r: SendRequest) => void) | null = null;
export function onAskToSend(fn: (r: SendRequest) => void): () => void {
  asker = fn;
  return () => {
    if (asker === fn) asker = null;
  };
}
export const askToSend = (r: SendRequest) => asker?.(r);

/** "Ask first": a notification with a Send message button that opens the ready message. */
function offer(r: SendRequest, question: string, recipients: Recipient[]) {
  toast(`${EVENT_LABELS[r.event]}: ${question}`, {
    description: `To ${recipients.map((x) => x.name).join(", ")}`,
    duration: 20_000,
    action: { label: "Send message", onClick: () => askToSend(r) },
  });
}

/** Message logs on screen reload when a message is queued or logged. */
const changeListeners = new Set<() => void>();
export function onMessagesChanged(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => void changeListeners.delete(fn);
}
export const messagesChanged = () => changeListeners.forEach((fn) => fn());

// ── Building requests ──────────────────────────────────────────────────────────────────────────────────────────────
const garageValues = (garage: Garage) => ({ garageName: garage.name, garagePhone: garage.phone });

/** A message about an estimate, job card or invoice; estimates and invoices carry their PDF. */
export function documentRequest(event: MessageEvent, doc: DocumentFull, garage: Garage, settings: Settings, manual = false): SendRequest {
  const withPdf = event === "estimate_ready" || event === "estimate_resent" || event === "invoice_issued";
  return {
    event, customerId: doc.customer.id, documentId: doc.id, manual,
    driver: doc.driverPhone ? { name: doc.driverName ?? null, phone: doc.driverPhone } : null,
    values: {
      customerName: doc.customer.name, plate: doc.vehicle?.plate ?? null, vehicle: doc.vehicle ? vehicleLabel(doc.vehicle) : null,
      docNumber: doc.number, amountFils: doc.totals.grossFils, dueDate: doc.dueDate ?? null, ...garageValues(garage),
    },
    pdf: withPdf ? { fileName: `${doc.number}.pdf`, html: () => renderDocumentHtml(doc, garage, settings, { copy: false }) } : null,
  };
}

export function receiptRequest(r: Receipt, garage: Garage, settings: Settings, manual = false): SendRequest {
  return {
    event: "payment_received", customerId: r.customerId, receiptId: r.id, manual,
    values: { customerName: r.customerName, docNumber: r.number, amountFils: r.amountFils, ...garageValues(garage) },
    pdf: { fileName: `${r.number}.pdf`, html: () => renderReceiptHtml(r, garage, settings) },
  };
}

/** What a message to `customer` about `request` can go to, and the placeholder values for one recipient. */
export async function loadRecipients(r: SendRequest): Promise<{ customer: Customer; recipients: Recipient[] }> {
  const [{ customer }, { contacts }] = await Promise.all([
    get<{ customer: Customer }>(`/api/customers/${r.customerId}`),
    get<{ contacts: Contact[] }>(`/api/customers/${r.customerId}/contacts`),
  ]);
  const recipients = recipientsFor(
    r.event,
    { kind: customer.kind, name: customer.name, phone: customer.phone, email: customer.email, messageLanguage: customer.messageLanguage ?? "en" },
    contacts,
    r.driver,
  );
  return { customer, recipients };
}

/** Subject and text in `language`, filled for `to`. */
export function compose(r: SendRequest, ev: MessageEventSettings, to: Recipient, language: "en" | "ar", balanceFils: number | null) {
  const values = messageValues({ ...r.values, contactName: to.name, balanceFils });
  const ar = language === "ar";
  return { subject: fillTemplate(ar ? ev.subjectAr : ev.subjectEn, values), body: fillTemplate(ar ? ev.textAr : ev.textEn, values) };
}

export async function queueEmail(
  r: SendRequest, to: Recipient & { email: string }, text: { subject: string; body: string }, pdf: { fileName: string; base64: string } | null, dedupe: boolean,
): Promise<Message> {
  const key = r.documentId ?? r.receiptId;
  const { message } = await post<{ message: Message }>("/api/messages", {
    event: r.event, channel: "email", customerId: r.customerId, contactId: to.contactId, documentId: r.documentId ?? null, receiptId: r.receiptId ?? null,
    recipient: to.email, subject: text.subject, body: text.body, attachment: pdf, dedupeKey: dedupe && key ? `${r.event}:${key}:${to.email}` : null,
  });
  messagesChanged();
  return message;
}

export async function logWhatsApp(r: SendRequest, to: Recipient, phone: string, body: string): Promise<void> {
  await post("/api/messages", {
    event: r.event, channel: "whatsapp", customerId: r.customerId, contactId: to.contactId, documentId: r.documentId ?? null, receiptId: r.receiptId ?? null,
    recipient: phone, body,
  });
  messagesChanged();
}

/**
 * Runs an event's message after the action that causes it (issue, payment, job card opened or completed). Off:
 * nothing. Automatic: emails go now (with the PDF made here) and WhatsApp, if also chosen, is offered. Ask: a
 * notification offers "Send message", which opens the ready message: work is never interrupted by a pop-up.
 */
export async function afterAction(r: SendRequest, settings: Settings): Promise<void> {
  const ev = settings.messages[r.event];
  if (!ev.on) return;
  try {
    const { customer, recipients } = await loadRecipients(r);
    if (!recipients.length) {
      toast.warning(`No phone or email on file for ${customer.name}: nothing was sent`);
      return;
    }
    if (ev.mode === "auto" && ev.channel !== "whatsapp") {
      const emails = recipients.filter((x): x is Recipient & { email: string } => !!x.email);
      if (emails.length) {
        const pdf = r.pdf ? { fileName: r.pdf.fileName, base64: await makePdf(r.pdf.html()) } : null;
        for (const to of emails) await queueEmail(r, to, compose(r, ev, to, to.language, customer.balanceFils ?? null), pdf, true);
        toast.success(`Emailed to ${emails.map((x) => x.name).join(", ")}`);
      } else {
        toast.warning(`No email address on file for ${customer.name}: the email wasn't sent`);
      }
      if (ev.channel === "both" && recipients.some((x) => x.phone && uaePhone(x.phone))) offer({ ...r, whatsappOnly: true }, "WhatsApp too?", recipients);
      return;
    }
    offer(r, "Send a message?", recipients);
  } catch (err) {
    toast.error(`Message not sent: ${(err as Error).message}`);
  }
}

/** A customer's statement of account for `range`, with its PDF. */
export function statementRequest(
  s: Statement, customer: Customer, garage: Garage, settings: Settings, range: { from: string; to: string }, manual = false,
): SendRequest {
  const name = `Statement ${range.from} to ${range.to} - ${customer.name}`.replace(/[\\/:*?"<>|]+/g, " ").trim();
  return {
    event: "statement", customerId: customer.id, manual,
    values: { customerName: customer.name, ...garageValues(garage) },
    pdf: { fileName: `${name}.pdf`, html: () => renderStatementHtml(s, customer, garage, settings, range) },
  };
}

/** The monthly statement's range: from the 1st of last month to today (Dubai). */
export function monthlyStatementRange(today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return { from: `${prev}-01`, to: today };
}

/** Emails a customer's monthly statement to every statements contact with an email. Returns how many went. */
export async function emailStatement(customerId: string, garage: Garage, settings: Settings, today: string): Promise<number> {
  const range = monthlyStatementRange(today);
  const s = await get<{ customer: Customer; statement: Statement; from: string; to: string }>(`/api/customers/${customerId}/statement?from=${range.from}&to=${range.to}`);
  const r = statementRequest(s.statement, s.customer, garage, settings, { from: s.from, to: s.to });
  const { customer, recipients } = await loadRecipients(r);
  const emails = recipients.filter((x): x is Recipient & { email: string } => !!x.email);
  if (!emails.length) return 0;
  const pdf = { fileName: r.pdf!.fileName, base64: await makePdf(r.pdf!.html()) };
  for (const to of emails) await queueEmail(r, to, compose(r, settings.messages.statement, to, to.language, customer.balanceFils ?? null), pdf, false);
  return emails.length;
}
