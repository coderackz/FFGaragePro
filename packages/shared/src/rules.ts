export const ROLES = ["owner", "accountant", "advisor"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  accountant: "Admin / Accountant",
  advisor: "Service Advisor",
};

export const DOC_TYPES = ["estimate", "jobcard", "invoice"] as const;
export type DocType = (typeof DOC_TYPES)[number];

const PREFIX: Record<DocType, string> = { estimate: "EST", jobcard: "JC", invoice: "INV" };

/** Everything that takes a number from a series. */
export const NUMBER_KINDS = ["estimate", "jobcard", "invoice", "purchase_order"] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];

/** `INV-00012` in the main series, `INV-P1-00003` in an offline PC's own series; `prefix` is the garage's own. */
export function formatDocNumber(type: DocType, n: number, series = "", prefix = PREFIX[type]): string {
  return `${prefix}-${series ? `${series}-` : ""}${String(n).padStart(5, "0")}`;
}

export const DOC_LABELS: Record<DocType, string> = { estimate: "Estimate", jobcard: "Job Card", invoice: "Invoice" };

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
] as const;
export type Action = (typeof ACTIONS)[number];

const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set(ACTIONS),
  accountant: new Set<Action>([
    "customers.edit", "documents.edit", "invoices.issue", "payments.record", "costs.view", "reports.view", "inventory.edit", "purchases.manage",
  ]),
  advisor: new Set<Action>(["customers.edit", "documents.edit", "invoices.issue"]),
};

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[role].has(action);
}

/** Status values per document type, in workflow order. */
export const DOC_STATUSES = {
  estimate: ["draft", "sent", "approved", "converted"],
  jobcard: ["open", "in_progress", "completed", "converted"],
  invoice: ["draft", "issued", "part_paid", "paid"],
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

export function formatPoNumber(n: number, series = "", prefix = "PO"): string {
  return `${prefix}-${series ? `${series}-` : ""}${String(n).padStart(5, "0")}`;
}

/** The built-in Fleet Fix supplier (inserted by migration 3). */
export const FLEETFIX_SUPPLIER_ID = "00000000-0000-4000-8000-0000000f1ee7";
