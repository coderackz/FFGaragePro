export const ROLES = ["owner", "accountant", "advisor"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  accountant: "Admin / Accountant",
  advisor: "Service Advisor",
};

export const DOC_TYPES = ["estimate", "jobcard", "invoice", "credit_note"] as const;
export type DocType = (typeof DOC_TYPES)[number];

const PREFIX: Record<DocType, string> = { estimate: "EST", jobcard: "JC", invoice: "INV", credit_note: "CN" };

/** Everything that takes a number from a series. */
export const NUMBER_KINDS = ["estimate", "jobcard", "invoice", "purchase_order", "credit_note", "receipt", "journal", "supplier_payment", "expense"] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];

/** `INV-00012` in the main series, `INV-P1-00003` in an offline PC's own series; `prefix` is the garage's own. */
export function formatDocNumber(type: DocType, n: number, series = "", prefix = PREFIX[type]): string {
  return `${prefix}-${series ? `${series}-` : ""}${String(n).padStart(5, "0")}`;
}

export const DOC_LABELS: Record<DocType, string> = { estimate: "Estimate", jobcard: "Job Card", invoice: "Invoice", credit_note: "Credit Note" };

export const ACTIONS = [
  "users.manage",
  "settings.manage",
  "customers.edit",
  "documents.edit",
  "invoices.issue",
  "payments.record",
  "costs.view",
  "reports.view",
  "inventory.edit",
  "purchases.manage",
  "audit.view",
  "credit_notes.issue",
  "credit.override",
  "messages.send",
  "books.view",
  "books.post",
  "books.lock",
  "payables.manage",
  "payroll.manage",
  "payroll.approve",
] as const;
export type Action = (typeof ACTIONS)[number];

const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set(ACTIONS),
  accountant: new Set<Action>([
    "customers.edit", "documents.edit", "invoices.issue", "payments.record", "costs.view", "reports.view", "inventory.edit", "purchases.manage",
    "credit_notes.issue", "messages.send", "books.view", "books.post", "payables.manage", "payroll.manage",
  ]),
  advisor: new Set<Action>(["customers.edit", "documents.edit", "invoices.issue", "messages.send"]),
};

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[role].has(action);
}

/** Status values per document type, in workflow order. */
export const DOC_STATUSES = {
  estimate: ["draft", "sent", "approved", "converted"],
  jobcard: ["open", "in_progress", "completed", "converted"],
  invoice: ["draft", "issued", "part_paid", "paid"],
  credit_note: ["issued"],
} as const satisfies Record<DocType, readonly string[]>;

export type DocStatus = (typeof DOC_STATUSES)[DocType][number];

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  converted: "Converted",
  open: "Open",
  in_progress: "In Progress",
  completed: "Completed",
  issued: "Issued",
  part_paid: "Part Paid",
  paid: "Paid",
  part_received: "Part Received",
  received: "Received",
  cancelled: "Cancelled",
};

/** Next document in the chain: estimate → job card → invoice. */
export const CONVERTS_TO: Partial<Record<DocType, DocType>> = { estimate: "jobcard", jobcard: "invoice" };

export const PO_STATUSES = ["draft", "sent", "part_received", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/** `RCT-00012`, or `RCT-P1-00003` from an offline PC's own series. */
export function formatReceiptNumber(n: number, series = "", prefix = "RCT"): string {
  return `${prefix}-${series ? `${series}-` : ""}${String(n).padStart(5, "0")}`;
}

/** Any kind of number, e.g. ("receipt", 12) → "RCT-00012" with the default prefix, or the garage's own. */
export function formatNumberOf(kind: NumberKind, n: number, series = "", prefix?: string): string {
  if (kind === "purchase_order") return formatPoNumber(n, series, prefix);
  if (kind === "receipt") return formatReceiptNumber(n, series, prefix);
  if (kind === "journal") return formatPoNumber(n, series, prefix ?? "JV");
  if (kind === "supplier_payment") return formatPoNumber(n, series, prefix ?? "PV");
  if (kind === "expense") return formatPoNumber(n, series, prefix ?? "EX");
  return formatDocNumber(kind, n, series, prefix);
}

export function formatPoNumber(n: number, series = "", prefix = "PO"): string {
  return `${prefix}-${series ? `${series}-` : ""}${String(n).padStart(5, "0")}`;
}

/** The built-in Fleet Fix supplier (inserted by migration 3). */
export const FLEETFIX_SUPPLIER_ID = "00000000-0000-4000-8000-0000000f1ee7";
