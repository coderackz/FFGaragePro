import { z } from "zod";

/** What a message is about. `estimate_resent` = "Extra work needs approval". */
export const MESSAGE_EVENTS = [
  "vehicle_received", "estimate_ready", "estimate_resent", "vehicle_ready", "invoice_issued", "payment_received",
  "payment_due", "payment_overdue", "statement",
] as const;
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];

export const MESSAGE_CHANNELS = ["email", "whatsapp"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_STATUSES = ["queued", "sent", "failed", "opened"] as const;
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
