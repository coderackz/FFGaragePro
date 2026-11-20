import { z } from "zod";
import { formatAED } from "./money";

/** What a message is about. `estimate_resent` = "Extra work needs approval". */
export const MESSAGE_EVENTS = [
  "vehicle_received", "estimate_ready", "estimate_resent", "vehicle_ready", "invoice_issued", "payment_received",
  "payment_due", "payment_overdue", "statement", "payslip",
] as const;
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];

export const MESSAGE_CHANNELS = ["email", "whatsapp"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/** `sending`: handed to the mail server right now (if the app stops mid-send, it may have gone: never re-sent blindly). */
export const MESSAGE_STATUSES = ["queued", "sending", "sent", "failed", "opened"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_LANGUAGES = ["en", "ar"] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

export const PLACEHOLDERS = [
  "customer", "contact", "plate", "vehicle", "doc_number", "amount", "balance", "due_date", "garage", "garage_phone",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

/** Placeholder names in `text` that aren't one of PLACEHOLDERS, e.g. "Hi {name}" → ["name"]. */
export function unknownPlaceholders(text: string): string[] {
  const known = new Set<string>(PLACEHOLDERS);
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!).filter((n) => !known.has(n)))];
}

/** Fills known placeholders; a known one with no value becomes "", anything else is left as typed. */
export function fillTemplate(text: string, values: Partial<Record<Placeholder, string>>): string {
  const known = new Set<string>(PLACEHOLDERS);
  return text.replace(PLACEHOLDER_RE, (all, name: string) => (known.has(name) ? (values[name as Placeholder] ?? "") : all));
}

const optional = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const contactSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  phone: optional(40),
  email: optional(120).refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address"),
  language: z.enum(MESSAGE_LANGUAGES).default("en"),
  getsApprovals: z.boolean().default(false),
  getsInvoices: z.boolean().default(false),
  getsReady: z.boolean().default(false),
  getsStatements: z.boolean().default(false),
  /** Ticked: may get service reminders and offers (later); the date it was ticked is recorded. */
  marketingConsent: z.boolean().default(false),
});
export type ContactInput = z.infer<typeof contactSchema>;

export interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  language: MessageLanguage;
  getsApprovals: boolean;
  getsInvoices: boolean;
  getsReady: boolean;
  getsStatements: boolean;
  marketingConsentAt: string | null;
}

export interface Recipient {
  contactId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  language: MessageLanguage;
}

type Role = "getsApprovals" | "getsInvoices" | "getsReady" | "getsStatements";
const ROLE: Record<MessageEvent, Role> = {
  vehicle_received: "getsReady",
  vehicle_ready: "getsReady",
  estimate_ready: "getsApprovals",
  estimate_resent: "getsApprovals",
  invoice_issued: "getsInvoices",
  payment_received: "getsInvoices",
  payment_due: "getsInvoices",
  payment_overdue: "getsInvoices",
  statement: "getsStatements",
  // Payslips go to the employee (from the employee record), never to a customer's contacts.
  payslip: "getsStatements",
};

/**
 * Who gets a message about `event`:
 * - "vehicle received/ready" go to the job card's driver when one is named;
 * - otherwise, the contacts ticked for that kind of message;
 * - an individual's own phone/email count as one more contact that gets everything;
 * - a company's own phone/email (its office) are used only when no contact is ticked for it.
 * Anyone with neither phone nor email is left out.
 */
export function recipientsFor(
  event: MessageEvent,
  customer: { kind: "individual" | "company"; name: string; phone: string | null; email: string | null; messageLanguage: MessageLanguage },
  contacts: Contact[],
  driver?: { name: string | null; phone: string | null } | null,
): Recipient[] {
  const role = ROLE[event];
  const reachable = (r: Recipient) => !!(r.phone || r.email);
  if (role === "getsReady" && driver?.phone) {
    return [{ contactId: null, name: driver.name || "Driver", phone: driver.phone, email: null, language: customer.messageLanguage }];
  }
  const own: Recipient = { contactId: null, name: customer.name, phone: customer.phone, email: customer.email, language: customer.messageLanguage };
  const ticked = contacts
    .filter((c) => c[role])
    .map((c): Recipient => ({ contactId: c.id, name: c.name, phone: c.phone, email: c.email, language: c.language }))
    .filter(reachable);
  if (customer.kind === "individual") return [own, ...ticked].filter(reachable);
  return ticked.length ? ticked : [own].filter(reachable);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Base64 of a PDF of at most 6 MB (a long statement made in the browser app is page images). */
export const MAX_ATTACHMENT_BASE64 = 8 * 1024 * 1024;

/** A message to queue (email) or to log (WhatsApp, opened on this PC). */
export const messageInputSchema = z
  .object({
    event: z.enum([...MESSAGE_EVENTS, "test"]),
    channel: z.enum(MESSAGE_CHANNELS),
    customerId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    /** Payslips: the employee it's for (only people who run payroll see these messages). */
    employeeId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    contactId: z.string().nullable().optional().transform((v) => v ?? null),
    documentId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    receiptId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
    recipient: z.string().trim().min(1).max(120),
    subject: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
    body: z.string().trim().min(1, "The message is empty").max(4000),
    attachment: z
      .object({
        fileName: z.string().trim().min(1).max(150).regex(/^[^\\/:*?"<>|]+$/, "That file name can't be used"),
        base64: z.string().max(MAX_ATTACHMENT_BASE64, "The attachment is over 6 MB").regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    dedupeKey: z.string().max(300).nullable().optional().transform((v) => v ?? null),
    /** WhatsApp Business API: send as this Meta-approved template (queued and sent by the cloud). */
    wa: z
      .object({
        name: z.string().trim().min(1).max(512), language: z.string().trim().min(2).max(15),
        // Meta refuses an empty body parameter: say so now, not half an hour later.
        params: z.array(z.string().trim().min(1, "A value in the WhatsApp template is empty for this message").max(1024)).max(20),
      })
      .nullable()
      .optional()
      .transform((v) => v ?? null),
  })
  .refine((m) => !m.wa || m.channel === "whatsapp", { message: "A WhatsApp template goes on a WhatsApp message", path: ["wa"] })
  .refine((m) => m.channel !== "email" || EMAIL_RE.test(m.recipient), { message: "Enter a valid email address", path: ["recipient"] })
  .refine((m) => m.channel !== "email" || !!m.subject, { message: "An email needs a subject", path: ["subject"] });
export type MessageInput = z.infer<typeof messageInputSchema>;

const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/** The placeholder values for a message, formatted the way documents print them. */
export function messageValues(v: {
  customerName: string;
  contactName?: string | null;
  plate?: string | null;
  vehicle?: string | null;
  docNumber?: string | null;
  amountFils?: number | null;
  balanceFils?: number | null;
  /** YYYY-MM-DD */
  dueDate?: string | null;
  garageName: string;
  garagePhone?: string | null;
}): Partial<Record<Placeholder, string>> {
  return {
    customer: v.customerName,
    contact: v.contactName || v.customerName,
    plate: v.plate ?? "",
    vehicle: v.vehicle ?? "",
    doc_number: v.docNumber ?? "",
    amount: v.amountFils == null ? "" : formatAED(v.amountFils),
    balance: v.balanceFils == null ? "" : formatAED(v.balanceFils),
    due_date: v.dueDate ? dayFmt.format(new Date(`${v.dueDate}T00:00:00Z`)) : "",
    garage: v.garageName,
    garage_phone: v.garagePhone ?? "",
  };
}

// ── The garage's own message templates (picked in the Send dialog) ─────────────────────────────────────────────────
export const TEMPLATE_CHANNELS = ["email", "whatsapp", "both"] as const;
const templateText = (max: number, label: string) =>
  z.string().trim().max(max).superRefine((v, ctx) => {
    const unknown = unknownPlaceholders(v);
    if (unknown.length) ctx.addIssue({ code: "custom", message: `${label}: ${unknown.map((n) => `{${n}}`).join(", ")} isn't a placeholder the app knows` });
  });
export const messageTemplateSchema = z
  .object({
    name: z.string().trim().min(1, "Name the template").max(80),
    channel: z.enum(TEMPLATE_CHANNELS),
    subjectEn: templateText(200, "Subject").nullable().optional().transform((v) => v || null),
    subjectAr: templateText(200, "Arabic subject").nullable().optional().transform((v) => v || null),
    textEn: templateText(1000, "Text").pipe(z.string().min(1, "Write the text")),
    textAr: templateText(1000, "Arabic text").pipe(z.string().min(1, "Write the Arabic text")),
    /** WhatsApp Business API: the Meta-approved template this one sends as, its language and its body parameters in order. */
    waTemplateName: z.string().trim().max(512).nullable().optional().transform((v) => v || null),
    waLanguage: z.string().trim().max(15).nullable().optional().transform((v) => v || null),
    waParams: z.array(z.enum(PLACEHOLDERS)).max(20).default([]),
  })
  .refine((t) => t.channel === "whatsapp" || !!t.subjectEn, { message: "An email template needs a subject", path: ["subjectEn"] });
export type MessageTemplateInput = z.infer<typeof messageTemplateSchema>;

