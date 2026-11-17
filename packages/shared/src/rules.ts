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

export function formatDocNumber(type: DocType, n: number): string {
  return `${PREFIX[type]}-${String(n).padStart(5, "0")}`;
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
] as const;
export type Action = (typeof ACTIONS)[number];

const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set(ACTIONS),
  accountant: new Set<Action>(["customers.edit", "documents.edit", "invoices.issue", "payments.record", "costs.view", "reports.view"]),
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
};

/** Next document in the chain: estimate → job card → invoice. */
export const CONVERTS_TO: Partial<Record<DocType, DocType>> = { estimate: "jobcard", jobcard: "invoice" };
