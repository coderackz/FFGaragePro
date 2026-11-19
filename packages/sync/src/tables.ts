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
  { name: "customers", key: "id" },
  { name: "vehicles", key: "id" },
  { name: "parts", key: "id", derived: ["on_hand", "avg_cost_fils"] },
  { name: "suppliers", key: "id" },
  { name: "documents", key: "id", derived: ["net_fils", "vat_fils", "gross_fils", "paid_fils"] },
  { name: "purchase_orders", key: "id", derived: ["net_fils", "version"] },
  { name: "po_lines", key: "id", derived: ["received_qty"] },
  { name: "document_lines", key: "document_id", set: true },
  { name: "payments", key: "id", insertOnly: true },
  { name: "goods_receipts", key: "id", insertOnly: true },
  { name: "goods_receipt_lines", key: "id", insertOnly: true },
  { name: "stock_movements", key: "id", insertOnly: true },
  { name: "document_prints", key: "id", insertOnly: true },
  { name: "audit_log", key: "id", insertOnly: true },
];

export const tableInfo = (name: string) => SYNC_TABLES.find((t) => t.name === name);

/** Settings that belong to one PC (network sharing, backup folder): never captured, never sent. */
export { LOCAL_SETTING_PREFIXES } from "@ffgp/shared";
