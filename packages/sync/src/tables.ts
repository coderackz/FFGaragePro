export interface SyncTable {
  name: string;
  /** Primary key column; for document_lines, the document the set of lines belongs to. */
  key: string;
  /** Rows are only ever added (never conflict). */
  insertOnly?: boolean;
  /** Recomputed on each side after applying, never sent. */
  derived?: string[];
  /** Synced as the whole set of a document's lines. */
  set?: boolean;
}

/** In foreign-key order: a table only refers to tables above it (documents also to itself). */
export const SYNC_TABLES: SyncTable[] = [
  { name: "garage", key: "id" },
  { name: "settings", key: "key" },
  { name: "users", key: "id" },
  { name: "accounts", key: "id" },
  { name: "customers", key: "id" },
  { name: "vehicles", key: "id" },
  { name: "vehicle_files", key: "id" },
  { name: "part_categories", key: "id" },
  { name: "parts", key: "id", derived: ["on_hand", "avg_cost_fils"] },
  { name: "part_numbers", key: "id" },
  { name: "part_fitments", key: "id" },
  { name: "part_packs", key: "id" },
  { name: "kit_components", key: "id" },
  { name: "suppliers", key: "id" },
  { name: "documents", key: "id", derived: ["net_fils", "vat_fils", "gross_fils", "paid_fils", "credited_fils"] },
  { name: "purchase_orders", key: "id", derived: ["net_fils", "version"] },
  { name: "po_lines", key: "id", derived: ["received_qty"] },
  // Vendors asked for prices on a request, and their prices.
  { name: "po_quotes", key: "id" },
  { name: "po_quote_prices", key: "id" },
  { name: "document_lines", key: "document_id", set: true },
  // Tyres and batteries one by one: after the documents and PO lines they point to.
  { name: "stock_units", key: "id" },
  // Returns, cores and warranty claims (debit notes): after suppliers, parts, documents and units.
  { name: "supplier_returns", key: "id", insertOnly: true },
  { name: "supplier_return_lines", key: "id", insertOnly: true },
  { name: "core_writeoffs", key: "id", insertOnly: true },
  { name: "warranty_claims", key: "id" },
  // Old-style payments (before migration 8) still syncing after an upgrade; each becomes a receipt on arrival.
  { name: "payments", key: "id", insertOnly: true },
  { name: "receipts", key: "id", insertOnly: true },
  { name: "receipt_allocations", key: "id", insertOnly: true },
  { name: "customer_contacts", key: "id" },
  { name: "messages", key: "id" },
  { name: "message_files", key: "id", insertOnly: true },
  { name: "journal_drafts", key: "id" },
  { name: "journal_entries", key: "id", insertOnly: true },
  { name: "journal_lines", key: "id", insertOnly: true },
  { name: "vat_returns", key: "id", insertOnly: true },
  { name: "employees", key: "id" },
  { name: "employee_leave", key: "id" },
  { name: "staff_advances", key: "id" },
  { name: "payroll_runs", key: "id" },
  { name: "payroll_lines", key: "id" },
  { name: "payroll_approvals", key: "id", insertOnly: true },
  { name: "payroll_payments", key: "id", insertOnly: true },
  { name: "final_settlements", key: "id" },
  { name: "settlement_approvals", key: "id", insertOnly: true },
  { name: "settlement_payments", key: "id", insertOnly: true },
  { name: "fixed_assets", key: "id" },
  { name: "message_templates", key: "id" },
  { name: "promo_codes", key: "id" },
  { name: "supplier_bills", key: "id" },
  { name: "supplier_bill_lines", key: "id", insertOnly: true },
  { name: "supplier_payments", key: "id", insertOnly: true },
  { name: "supplier_allocations", key: "id", insertOnly: true },
  { name: "expenses", key: "id", insertOnly: true },
  { name: "money_transfers", key: "id", insertOnly: true },
  { name: "cheque_deposits", key: "id", insertOnly: true },
  { name: "cheque_clearances", key: "id", insertOnly: true },
  { name: "bank_imports", key: "id", insertOnly: true },
  { name: "bank_lines", key: "id" },
  { name: "goods_receipts", key: "id", insertOnly: true },
  { name: "goods_receipt_lines", key: "id", insertOnly: true },
  { name: "stock_movements", key: "id", insertOnly: true },
  { name: "document_prints", key: "id", insertOnly: true },
  { name: "audit_log", key: "id", insertOnly: true },
];

export const tableInfo = (name: string) => SYNC_TABLES.find((t) => t.name === name);

/** Settings that belong to one PC (network sharing, backup folder): never captured, never sent. */
export { LOCAL_SETTING_PREFIXES } from "@ffgp/shared";
