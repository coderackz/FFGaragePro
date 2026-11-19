import { formatAED, ROLE_LABELS, type Role } from "@ffgp/shared";

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  user: string | null;
  device: string | null;
  createdAt: string;
}

export const SECTION_NAMES: Record<string, string> = {
  profile: "Garage details",
  garage: "Garage details",
  documents: "Documents & printing",
  numbering: "Numbering",
  tax: "Tax",
  pricing: "Pricing",
  inventory: "Inventory",
  security: "Security",
  credit: "Customers & credit",
};

const FIELD_NAMES: Record<string, string> = {
  name: "Garage name", trn: "VAT TRN", address: "Address", phone: "Phone", email: "Email",
  tradeLicence: "Trade licence", bankName: "Bank", accountName: "Account name", iban: "IBAN",
  logo: "Logo", stamp: "Stamp", signature: "Signature", paper: "Paper", letterheadTopMm: "Letterhead space (mm)", terms: "Invoice terms",
  warranty: "Warranty line", estimateValidDays: "Estimates valid for (days)", showPartNumbers: "Show part numbers",
  showLabourHours: "Show labour hours", jobCardSignature: "Customer signature on job cards",
  estimatePrefix: "Estimate prefix", jobcardPrefix: "Job card prefix", invoicePrefix: "Invoice prefix", purchaseOrderPrefix: "Purchase order prefix",
  estimateStart: "Next estimate number", jobcardStart: "Next job card number", invoiceStart: "Next invoice number", purchaseOrderStart: "Next purchase order number",
  pricesIncludeVat: "Prices include VAT", returnPeriod: "VAT return period", firstPeriodStart: "First VAT period starts",
  labourRateFils: "Labour rate", partsMarkupPct: "Parts markup", maxDiscountAccountantPct: "Largest discount (Admin / Accountant)",
  maxDiscountAdvisorPct: "Largest discount (Service Advisor)", belowZero: "Stock below zero", defaultReorderLevel: "Default reorder level",
  idleLockMinutes: "Lock screen after (minutes)", defaultTermsDays: "Default payment terms (days)", overLimit: "Over the credit limit",
  creditNotePrefix: "Credit note prefix", receiptPrefix: "Receipt prefix", creditNoteStart: "Next credit note number", receiptStart: "Next receipt number", role: "Role", active: "Active", passwordChanged: "Password",
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function value(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "not set";
  if (v === "(image)") return "new image";
  if (typeof v === "boolean") return field === "passwordChanged" ? "changed" : v ? "Yes" : "No";
  if (field.endsWith("Fils") && typeof v === "number") return formatAED(v);
  if (field.endsWith("Pct") && typeof v === "number") return `${v}%`;
  if (field === "role" && typeof v === "string" && v in ROLE_LABELS) return ROLE_LABELS[v as Role];
  if (typeof v === "string" && ["warn", "block", "approve", "plain", "letterhead", "quarterly", "monthly"].includes(v)) return capital(v);
  return String(v);
}

function changes(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  return Object.keys(after ?? {})
    .map((k) => (k === "passwordChanged" ? "Password changed" : `${FIELD_NAMES[k] ?? k}: ${value(k, before?.[k])} → ${value(k, after?.[k])}`))
    .join("; ");
}

/** One line in plain words for the activity log. */
export function describeAudit(e: AuditEntry): string {
  const after = e.after ?? {};
  switch (e.action) {
    case "settings.change":
      return `Changed ${SECTION_NAMES[e.entityId ?? ""] ?? "settings"} — ${changes(e.before, e.after)}`;
    case "discount.approve": {
      const lines = (after.lines as { discountPct: number }[] | undefined) ?? [];
      const top = Math.max(0, ...lines.map((l) => l.discountPct));
      return `Approved a ${top}% discount on ${after.document ?? "a document"}`;
    }
    case "user.create":
      return `Added user ${after.name} (${value("role", after.role)})`;
    case "user.update": {
      const { username, ...rest } = e.before ?? {};
      return `Changed user ${username ?? ""} — ${changes(rest, e.after)}`;
    }
    case "credit.override":
      return `Approved going over the credit limit on ${after.document ?? "a document"}`;
    case "receipt.create": {
      const amount = Number(after.amountFils ?? 0);
      return amount < 0
        ? `Refunded ${after.receipt} to ${after.customer}: ${formatAED(-amount)}`
        : `Received ${after.receipt} from ${after.customer}: ${formatAED(amount)}`;
    }
    case "receipt.allocate": {
      const list = (after.allocations as { document: string; amountFils: number }[] | undefined) ?? [];
      const only = list.length === 1 ? list[0]! : null;
      if (only && only.amountFils > 0) return `Allocated ${formatAED(only.amountFils)} of ${after.receipt} to ${only.document}`;
      const parts = list.map((a) => (a.amountFils < 0 ? `took ${formatAED(-a.amountFils)} back off ${a.document}` : `${formatAED(a.amountFils)} to ${a.document}`));
      return `Allocated from ${after.receipt}: ${parts.join(", ")}`;
    }
    case "credit_note.issue":
      return `Issued ${after.creditNote} against ${after.invoice}: ${after.reason}`;
    case "backup.restore":
      return after.file ? `Restored a backup (${after.file})` : "Restored a backup";
    default:
      return e.action;
  }
}
