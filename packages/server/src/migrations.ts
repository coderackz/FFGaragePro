import { DEFAULT_CHART } from "@ffgp/shared";
import type { Db } from "./db";

/** Ordered, append-only. Never edit a shipped migration; add a new one. */
/**
 * `foreignKeysOff`: the migration rebuilds tables, so it runs with foreign keys off and then checks the references
 * of the listed tables (the rebuilt ones and the tables that point at them) before committing.
 */
/** The default chart as it was when migration 11 shipped (later changes to the chart need a migration of their own). */
const CHART_SQL = DEFAULT_CHART.map(
  (a) =>
    `INSERT INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('${a.id}', '${a.code}', '${a.name.replace(/'/g, "''")}', '${a.type}', ${
      a.systemKey ? `'${a.systemKey}'` : "NULL"
    }, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
).join("\n");

const MIGRATIONS: { id: number; sql: string; foreignKeysOff?: string[] }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE garage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  trn TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  vat_rate_bp INTEGER NOT NULL DEFAULT 500,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner','accountant','advisor')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE counters (
  type TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('individual','company')),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  trn TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX customers_name ON customers(name COLLATE NOCASE);
CREATE INDEX customers_phone ON customers(phone);

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  plate TEXT NOT NULL UNIQUE COLLATE NOCASE,
  make TEXT,
  model TEXT,
  year INTEGER,
  vin TEXT,
  colour TEXT,
  odometer INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX vehicles_customer ON vehicles(customer_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('estimate','jobcard','invoice')),
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  odometer INTEGER,
  notes TEXT,
  source_id TEXT REFERENCES documents(id),
  issued_at TEXT,
  net_fils INTEGER NOT NULL DEFAULT 0,
  vat_fils INTEGER NOT NULL DEFAULT 0,
  gross_fils INTEGER NOT NULL DEFAULT 0,
  paid_fils INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (type, seq)
);
CREATE INDEX documents_type_status ON documents(type, status);
CREATE INDEX documents_customer ON documents(customer_id);
CREATE UNIQUE INDEX documents_one_conversion ON documents(source_id) WHERE source_id IS NOT NULL;

CREATE TABLE document_lines (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('labour','part','other')),
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price_fils INTEGER NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  net_fils INTEGER NOT NULL,
  vat_fils INTEGER NOT NULL,
  gross_fils INTEGER NOT NULL
);
CREATE INDEX document_lines_doc ON document_lines(document_id, position);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  amount_fils INTEGER NOT NULL CHECK (amount_fils > 0),
  method TEXT NOT NULL,
  reference TEXT,
  paid_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX payments_doc ON payments(document_id);
`,
  },
  {
    id: 2,
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
`,
  },
  {
    id: 3,
    sql: `
CREATE TABLE parts (
  id TEXT PRIMARY KEY,
  part_no TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  unit TEXT NOT NULL DEFAULT 'each',
  stocked INTEGER NOT NULL DEFAULT 1,
  sell_price_fils INTEGER NOT NULL DEFAULT 0,
  avg_cost_fils INTEGER NOT NULL DEFAULT 0,
  on_hand REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  location TEXT,
  fits TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX parts_part_no ON parts(part_no COLLATE NOCASE) WHERE active = 1;
CREATE INDEX parts_name ON parts(name COLLATE NOCASE);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trn TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  is_fleetfix INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO suppliers (id, name, is_fleetfix, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000f1ee7', 'Fleet Fix', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  number TEXT NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL CHECK (status IN ('draft','sent','part_received','received','cancelled')),
  notes TEXT,
  net_fils INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX purchase_orders_supplier ON purchase_orders(supplier_id, status);

CREATE TABLE po_lines (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  position INTEGER NOT NULL,
  part_id TEXT REFERENCES parts(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  received_qty REAL NOT NULL DEFAULT 0,
  unit_cost_fils INTEGER NOT NULL DEFAULT 0,
  job_document_id TEXT REFERENCES documents(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX po_lines_po ON po_lines(po_id, position);
CREATE INDEX po_lines_job ON po_lines(job_document_id);

CREATE TABLE goods_receipts (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  supplier_invoice_no TEXT,
  supplier_invoice_date TEXT,
  net_fils INTEGER NOT NULL,
  vat_fils INTEGER NOT NULL,
  gross_fils INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE goods_receipt_lines (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES goods_receipts(id),
  po_line_id TEXT NOT NULL REFERENCES po_lines(id),
  qty REAL NOT NULL,
  unit_cost_fils INTEGER NOT NULL
);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty REAL NOT NULL,
  unit_cost_fils INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('receive','job','invoice','adjust','opening')),
  document_id TEXT REFERENCES documents(id),
  po_line_id TEXT REFERENCES po_lines(id),
  note TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX stock_movements_part ON stock_movements(part_id, created_at);
CREATE INDEX stock_movements_doc ON stock_movements(document_id);

ALTER TABLE document_lines ADD COLUMN part_id TEXT REFERENCES parts(id);
ALTER TABLE document_lines ADD COLUMN supplied_by TEXT NOT NULL DEFAULT 'garage';
ALTER TABLE document_lines ADD COLUMN po_line_id TEXT REFERENCES po_lines(id);
`,
  },
  {
    id: 4,
    sql: `
-- Bumped on every change, so a PO saved from a stale screen is refused instead of overwriting.
ALTER TABLE purchase_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 5,
    // Number series: the cloud's main series is '', an offline PC numbers from its own ('P1', 'P2'…), so the
    // uniqueness of a number becomes (type, series, seq). SQLite can't change a UNIQUE constraint in place, so
    // both tables are rebuilt (with foreign keys off, as SQLite's ALTER TABLE guide prescribes).
    foreignKeysOff: ["documents", "purchase_orders", "document_lines", "payments", "stock_movements", "po_lines", "goods_receipts"],
    sql: `
CREATE TABLE documents_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('estimate','jobcard','invoice')),
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  odometer INTEGER,
  notes TEXT,
  source_id TEXT REFERENCES documents(id),
  issued_at TEXT,
  net_fils INTEGER NOT NULL DEFAULT 0,
  vat_fils INTEGER NOT NULL DEFAULT 0,
  gross_fils INTEGER NOT NULL DEFAULT 0,
  paid_fils INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (type, series, seq)
);
INSERT INTO documents_new (id, type, series, seq, number, status, customer_id, vehicle_id, odometer, notes, source_id, issued_at,
  net_fils, vat_fils, gross_fils, paid_fils, created_by, created_at, updated_at)
SELECT id, type, '', seq, number, status, customer_id, vehicle_id, odometer, notes, source_id, issued_at,
  net_fils, vat_fils, gross_fils, paid_fils, created_by, created_at, updated_at FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX documents_type_status ON documents(type, status);
CREATE INDEX documents_customer ON documents(customer_id);
CREATE UNIQUE INDEX documents_one_conversion ON documents(source_id) WHERE source_id IS NOT NULL;

CREATE TABLE purchase_orders_new (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL CHECK (status IN ('draft','sent','part_received','received','cancelled')),
  notes TEXT,
  net_fils INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  UNIQUE (series, seq)
);
INSERT INTO purchase_orders_new (id, series, seq, number, supplier_id, status, notes, net_fils, created_by, created_at, updated_at, version)
SELECT id, '', seq, number, supplier_id, status, notes, net_fils, created_by, created_at, updated_at, version FROM purchase_orders;
DROP TABLE purchase_orders;
ALTER TABLE purchase_orders_new RENAME TO purchase_orders;
CREATE INDEX purchase_orders_supplier ON purchase_orders(supplier_id, status);
`,
  },
  {
    id: 6,
    // Cloud sync. Triggers (installed by @ffgp/sync only on a linked PC or in the cloud) write change_log; a
    // never-linked PC has these tables but writes nothing to them.
    sql: `
CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  origin_seq INTEGER,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert','update','delete','set')),
  data TEXT,
  changed TEXT,
  at TEXT NOT NULL
);
CREATE INDEX change_log_origin ON change_log(origin, origin_seq);
CREATE INDEX change_log_row ON change_log(table_name, row_id);

-- Who the next change_log rows belong to: this database ('local' on a PC, 'cloud' in the cloud) or, while a
-- peer's changes are applied, that peer.
CREATE TABLE sync_ctx (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  origin TEXT NOT NULL DEFAULT 'local',
  origin_seq INTEGER
);
INSERT INTO sync_ctx (id) VALUES (1);

CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE sync_issues (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unique_rename','frozen_invoice','apply_failed')),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  dismissed_at TEXT,
  -- Cloud only: the PC whose changes caused it, so that PC is told on its next pull.
  for_device TEXT
);
CREATE INDEX sync_issues_device ON sync_issues(for_device);

-- Cloud only: the last change applied from each PC, so a re-sent page is applied once.
CREATE TABLE sync_peers (device_code TEXT PRIMARY KEY, last_origin_seq INTEGER NOT NULL);
`,
  },
  {
    id: 7,
    // Settings Part 1: prices typed including VAT (fixed per document when it is created), invoice prints
    // (insert-only rows, so prints on two PCs add up and an issued invoice is never touched), and the activity log.
    sql: `
ALTER TABLE documents ADD COLUMN prices_include_vat INTEGER NOT NULL DEFAULT 0;
CREATE TABLE document_prints (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  user_id TEXT REFERENCES users(id),
  printed_at TEXT NOT NULL
);
CREATE INDEX document_prints_doc ON document_prints(document_id);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before TEXT,
  after TEXT,
  user_id TEXT REFERENCES users(id),
  device TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_log_created ON audit_log(created_at);
`,
  },
  {
    id: 8,
    // Settings Part 2 (credit customers and credit notes). documents is rebuilt so its type can be 'credit_note';
    // payments become receipts (one each, same id) with one allocation each (id + '-a'). Each is numbered from its
    // own id (series = id, number RCT-<first 10 of the id>), never from a counter, so a PC and the cloud give the same
    // payment the same receipt whatever payments each had, and the main series (RCT-00001…) is left for new ones.
    // Old payments still waiting to sync are turned into the same receipts when they arrive (legacyPaymentReceipt).
    foreignKeysOff: ["documents", "document_lines", "payments", "stock_movements", "po_lines", "document_prints", "receipts", "receipt_allocations"],
    sql: `
ALTER TABLE customers ADD COLUMN credit_allowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN credit_limit_fils INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN terms_days INTEGER;
ALTER TABLE customers ADD COLUMN discount_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN lpo_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN opening_balance_fils INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN opening_balance_date TEXT;

ALTER TABLE document_lines ADD COLUMN source_line_id TEXT;

CREATE TABLE documents_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('estimate','jobcard','invoice','credit_note')),
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  odometer INTEGER,
  notes TEXT,
  source_id TEXT REFERENCES documents(id),
  issued_at TEXT,
  net_fils INTEGER NOT NULL DEFAULT 0,
  vat_fils INTEGER NOT NULL DEFAULT 0,
  gross_fils INTEGER NOT NULL DEFAULT 0,
  paid_fils INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  prices_include_vat INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  lpo_number TEXT,
  reason TEXT,
  credited_fils INTEGER NOT NULL DEFAULT 0,
  UNIQUE (type, series, seq)
);
INSERT INTO documents_new (id, type, series, seq, number, status, customer_id, vehicle_id, odometer, notes, source_id, issued_at,
  net_fils, vat_fils, gross_fils, paid_fils, created_by, created_at, updated_at, prices_include_vat, due_date)
SELECT id, type, series, seq, number, status, customer_id, vehicle_id, odometer, notes, source_id, issued_at,
  net_fils, vat_fils, gross_fils, paid_fils, created_by, created_at, updated_at, prices_include_vat,
  CASE WHEN type = 'invoice' AND issued_at IS NOT NULL THEN date(issued_at, '+4 hours') END
FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX documents_type_status ON documents(type, status);
CREATE INDEX documents_customer ON documents(customer_id);
CREATE INDEX documents_source ON documents(source_id);
-- One conversion per document (estimate → job card → invoice); credit notes against an invoice don't count.
CREATE UNIQUE INDEX documents_one_conversion ON documents(source_id) WHERE source_id IS NOT NULL AND type <> 'credit_note';

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  amount_fils INTEGER NOT NULL CHECK (amount_fils <> 0),
  method TEXT NOT NULL,
  reference TEXT,
  cheque_date TEXT,
  received_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
CREATE INDEX receipts_customer ON receipts(customer_id);
CREATE TABLE receipt_allocations (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  amount_fils INTEGER NOT NULL CHECK (amount_fils <> 0),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX receipt_allocations_receipt ON receipt_allocations(receipt_id);
CREATE INDEX receipt_allocations_document ON receipt_allocations(document_id);

INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, reference, cheque_date, received_at, created_by, created_at)
SELECT p.id, p.id, 1, 'RCT-' || upper(substr(replace(p.id, '-', ''), 1, 10)), d.customer_id, p.amount_fils, p.method, p.reference, NULL, p.paid_at,
  p.created_by, p.created_at
FROM payments p JOIN documents d ON d.id = p.document_id;
INSERT INTO receipt_allocations (id, receipt_id, document_id, amount_fils, created_by, created_at)
SELECT id || '-a', id, document_id, amount_fils, created_by, created_at FROM payments;
`,
  },
  {
    id: 9,
    // Settings Part 3a (English + Arabic documents): Arabic names, the customer's document language, and the
    // language a document was created in (so a reprint looks the same after the customer's setting changes).
    sql: `
ALTER TABLE customers ADD COLUMN name_ar TEXT;
ALTER TABLE customers ADD COLUMN address_ar TEXT;
ALTER TABLE customers ADD COLUMN doc_language TEXT NOT NULL DEFAULT 'en' CHECK (doc_language IN ('en', 'en_ar'));
ALTER TABLE parts ADD COLUMN name_ar TEXT;
ALTER TABLE documents ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'en_ar'));
`,
  },
  {
    id: 10,
    // Settings Part 3b (messages): customer contacts, the job card's driver, and the message outbox and log.
    sql: `
ALTER TABLE customers ADD COLUMN message_language TEXT NOT NULL DEFAULT 'en' CHECK (message_language IN ('en', 'ar'));
ALTER TABLE documents ADD COLUMN driver_name TEXT;
ALTER TABLE documents ADD COLUMN driver_phone TEXT;
CREATE TABLE customer_contacts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  gets_approvals INTEGER NOT NULL DEFAULT 0,
  gets_invoices INTEGER NOT NULL DEFAULT 0,
  gets_ready INTEGER NOT NULL DEFAULT 0,
  gets_statements INTEGER NOT NULL DEFAULT 0,
  marketing_consent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX customer_contacts_customer ON customer_contacts(customer_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  contact_id TEXT,
  document_id TEXT REFERENCES documents(id),
  receipt_id TEXT REFERENCES receipts(id),
  event TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'opened')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error TEXT,
  sender_place TEXT,
  dedupe_key TEXT UNIQUE,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX messages_customer ON messages(customer_id);
CREATE INDEX messages_document ON messages(document_id);
CREATE INDEX messages_status ON messages(status);
CREATE TABLE message_files (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  file_name TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX message_files_message ON message_files(message_id);
`,
  },
  {
    id: 11,
    // Accounting Part 1 (the books): the chart of accounts (seeded with fixed ids, the same on every PC and the cloud),
    // posted journal entries and their lines (insert-only: never edited or deleted), and editable drafts.
    sql: `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'cost_of_sales', 'expense')),
  system_key TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
${CHART_SQL}
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  narration TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'credit_note', 'receipt', 'goods_receipt', 'stock', 'cogs', 'customer_opening',
    'opening', 'manual', 'reversal', 'year_close', 'revaluation')),
  source_id TEXT,
  post_key TEXT UNIQUE,
  reverses_id TEXT REFERENCES journal_entries(id),
  original_date TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
CREATE INDEX journal_entries_date ON journal_entries(date);
CREATE INDEX journal_entries_source ON journal_entries(source_type, source_id);
CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  position INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  debit_fils INTEGER NOT NULL DEFAULT 0 CHECK (debit_fils >= 0),
  credit_fils INTEGER NOT NULL DEFAULT 0 CHECK (credit_fils >= 0),
  customer_id TEXT,
  supplier_id TEXT,
  document_id TEXT,
  memo TEXT
);
CREATE INDEX journal_lines_entry ON journal_lines(entry_id, position);
CREATE INDEX journal_lines_account ON journal_lines(account_id);
CREATE INDEX journal_lines_customer ON journal_lines(customer_id);
CREATE INDEX journal_lines_document ON journal_lines(document_id);
-- This server's own posting bookkeeping (not synced): events that couldn't post, and why.
CREATE TABLE book_failures (
  post_key TEXT PRIMARY KEY,
  error TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE journal_drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'opening')),
  date TEXT NOT NULL,
  narration TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    id: 12,
    // Accounting Part 2 (suppliers, expenses and bank). journal_entries is rebuilt to accept the new kinds of entry.
    foreignKeysOff: ["journal_entries", "journal_lines"],
    sql: `
CREATE TABLE journal_entries_new (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  narration TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'credit_note', 'receipt', 'goods_receipt', 'stock', 'cogs', 'customer_opening',
    'opening', 'manual', 'reversal', 'year_close', 'revaluation', 'supplier_bill', 'bill_cancel', 'supplier_payment', 'supplier_opening', 'expense',
    'transfer', 'cheque_deposit', 'cheque_clear')),
  source_id TEXT,
  post_key TEXT UNIQUE,
  reverses_id TEXT REFERENCES journal_entries(id),
  original_date TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
INSERT INTO journal_entries_new SELECT id, series, seq, number, date, narration, source_type, source_id, post_key, reverses_id, original_date, created_by, created_at
  FROM journal_entries;
DROP TABLE journal_entries;
ALTER TABLE journal_entries_new RENAME TO journal_entries;
CREATE INDEX journal_entries_date ON journal_entries(date);
CREATE INDEX journal_entries_source ON journal_entries(source_type, source_id);

ALTER TABLE accounts ADD COLUMN money_kind TEXT CHECK (money_kind IN ('cash', 'bank', 'card_clearing', 'cheques_in_hand'));
ALTER TABLE accounts ADD COLUMN bank_mapping TEXT;
-- Reconciliation starts here: the statement's first date and its balance before that day.
ALTER TABLE accounts ADD COLUMN reconcile_from TEXT;
ALTER TABLE accounts ADD COLUMN reconcile_opening_fils INTEGER;
UPDATE accounts SET money_kind = 'cash' WHERE system_key = 'cash';
UPDATE accounts SET money_kind = 'bank' WHERE system_key = 'bank';
UPDATE accounts SET money_kind = 'card_clearing' WHERE system_key = 'card_clearing';
UPDATE accounts SET money_kind = 'cheques_in_hand' WHERE system_key = 'cheques_in_hand';
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000a2010', '2010', 'Cheques issued', 'liability', 'cheques_issued', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

ALTER TABLE suppliers ADD COLUMN terms_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE suppliers ADD COLUMN opening_balance_fils INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN opening_balance_date TEXT;

CREATE TABLE supplier_bills (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  supplier_invoice_no TEXT NOT NULL,
  bill_date TEXT NOT NULL,
  due_date TEXT,
  notes TEXT,
  net_fils INTEGER NOT NULL,
  vat_fils INTEGER NOT NULL,
  gross_fils INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  cancel_reason TEXT,
  cancelled_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX supplier_bills_supplier ON supplier_bills(supplier_id);
CREATE TABLE supplier_bill_lines (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES supplier_bills(id),
  position INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  description TEXT NOT NULL,
  net_fils INTEGER NOT NULL,
  vat TEXT NOT NULL CHECK (vat IN ('standard', 'none')),
  vat_fils INTEGER NOT NULL
);
CREATE INDEX supplier_bill_lines_bill ON supplier_bill_lines(bill_id, position);
CREATE TABLE supplier_payments (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  amount_fils INTEGER NOT NULL CHECK (amount_fils > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'card', 'cheque')),
  paid_from_account_id TEXT NOT NULL REFERENCES accounts(id),
  reference TEXT,
  cheque_no TEXT,
  cheque_date TEXT,
  paid_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
CREATE INDEX supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE TABLE supplier_allocations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES supplier_payments(id),
  target TEXT NOT NULL CHECK (target IN ('bill', 'goods_receipt', 'opening')),
  target_id TEXT NOT NULL,
  amount_fils INTEGER NOT NULL CHECK (amount_fils <> 0),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX supplier_allocations_payment ON supplier_allocations(payment_id);
CREATE INDEX supplier_allocations_target ON supplier_allocations(target, target_id);
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  description TEXT NOT NULL,
  net_fils INTEGER NOT NULL,
  vat TEXT NOT NULL CHECK (vat IN ('standard', 'none')),
  vat_fils INTEGER NOT NULL,
  gross_fils INTEGER NOT NULL,
  paid_from_account_id TEXT NOT NULL REFERENCES accounts(id),
  payee TEXT,
  reference TEXT,
  photo TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
CREATE INDEX expenses_date ON expenses(date);
CREATE TABLE money_transfers (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  to_account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_fils INTEGER NOT NULL CHECK (amount_fils > 0),
  reference TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE cheque_deposits (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES receipts(id),
  -- Cheques paid in on one slip: one line on the bank statement, so one bank line in the books.
  batch_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE cheque_clearances (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES supplier_payments(id),
  date TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE bank_imports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  file_name TEXT NOT NULL,
  added INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE bank_lines (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  import_id TEXT REFERENCES bank_imports(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_fils INTEGER NOT NULL,
  reference TEXT,
  line_key TEXT NOT NULL,
  matched_line_id TEXT,
  matched_at TEXT,
  -- An expense entered from this line (bank charges): never entered twice.
  expense_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, line_key)
);
CREATE INDEX bank_lines_account ON bank_lines(account_id, date);
CREATE UNIQUE INDEX bank_lines_matched ON bank_lines(matched_line_id) WHERE matched_line_id IS NOT NULL;
`,
  },
  {
    id: 13,
    // Accounting Part 3 (VAT return): VAT box tags on journal lines, the settlement entry kind, filed returns.
    foreignKeysOff: ["journal_entries", "journal_lines", "vat_returns"],
    sql: `
CREATE TABLE journal_entries_new (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  narration TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'credit_note', 'receipt', 'goods_receipt', 'stock', 'cogs', 'customer_opening',
    'opening', 'manual', 'reversal', 'year_close', 'revaluation', 'supplier_bill', 'bill_cancel', 'supplier_payment', 'supplier_opening', 'expense',
    'transfer', 'cheque_deposit', 'cheque_clear', 'vat_return')),
  source_id TEXT,
  post_key TEXT UNIQUE,
  reverses_id TEXT REFERENCES journal_entries(id),
  original_date TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
INSERT INTO journal_entries_new SELECT id, series, seq, number, date, narration, source_type, source_id, post_key, reverses_id, original_date, created_by, created_at
  FROM journal_entries;
DROP TABLE journal_entries;
ALTER TABLE journal_entries_new RENAME TO journal_entries;
CREATE INDEX journal_entries_date ON journal_entries(date);
CREATE INDEX journal_entries_source ON journal_entries(source_type, source_id);

-- The VAT return box a manual journal line belongs to (zero-rated, exempt, reverse charge, adjustments…).
ALTER TABLE journal_lines ADD COLUMN vat_box TEXT;

-- A VAT return as filed: its figures are kept as they were when it was filed.
CREATE TABLE vat_returns (
  id TEXT PRIMARY KEY,
  period_from TEXT NOT NULL UNIQUE,
  period_to TEXT NOT NULL,
  figures_json TEXT NOT NULL,
  reference TEXT,
  entry_id TEXT REFERENCES journal_entries(id),
  filed_by TEXT REFERENCES users(id),
  filed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 14,
    // Accounting Part 4a (payroll): employees, leave, advances, monthly runs; the payroll accounts; new entry kinds.
    foreignKeysOff: ["journal_entries", "journal_lines", "vat_returns"],
    sql: `
CREATE TABLE journal_entries_new (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  narration TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'credit_note', 'receipt', 'goods_receipt', 'stock', 'cogs', 'customer_opening',
    'opening', 'manual', 'reversal', 'year_close', 'revaluation', 'supplier_bill', 'bill_cancel', 'supplier_payment', 'supplier_opening', 'expense',
    'transfer', 'cheque_deposit', 'cheque_clear', 'vat_return', 'payroll_run', 'wps_paid', 'bonus_paid', 'staff_advance', 'payroll_opening')),
  source_id TEXT,
  post_key TEXT UNIQUE,
  reverses_id TEXT REFERENCES journal_entries(id),
  original_date TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
INSERT INTO journal_entries_new SELECT id, series, seq, number, date, narration, source_type, source_id, post_key, reverses_id, original_date, created_by, created_at
  FROM journal_entries;
DROP TABLE journal_entries;
ALTER TABLE journal_entries_new RENAME TO journal_entries;
CREATE INDEX journal_entries_date ON journal_entries(date);
CREATE INDEX journal_entries_source ON journal_entries(source_type, source_id);

-- The payroll accounts: 6000 Salaries and 2200 Salaries payable already exist; the rest are new. A garage's own
-- account that already took one of the new codes keeps its name and moves to the code with ".1" after it.
UPDATE accounts SET code = code || '.1', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE code IN ('1410', '2210', '6001', '6002', '6003') AND system_key IS NULL
    AND id NOT IN ('00000000-0000-4000-8000-0000000a1410', '00000000-0000-4000-8000-0000000a2210', '00000000-0000-4000-8000-0000000a6001',
                   '00000000-0000-4000-8000-0000000a6002', '00000000-0000-4000-8000-0000000a6003');
UPDATE accounts SET system_key = 'salaries' WHERE id = '00000000-0000-4000-8000-0000000a6000';
UPDATE accounts SET system_key = 'salaries_payable' WHERE id = '00000000-0000-4000-8000-0000000a2200';
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a1410', '1410', 'Staff advances', 'asset', 'staff_advances', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a2210', '2210', 'Gratuity provision', 'liability', 'gratuity_provision', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a6001', '6001', 'Allowances', 'expense', 'allowances', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a6002', '6002', 'Staff bonus', 'expense', 'staff_bonus', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a6003', '6003', 'End-of-service gratuity', 'expense', 'gratuity_expense', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_ar TEXT,
  job TEXT NOT NULL,
  nationality TEXT,
  join_date TEXT NOT NULL,
  left_date TEXT,
  basic_fils INTEGER NOT NULL,
  housing_fils INTEGER NOT NULL DEFAULT 0,
  transport_fils INTEGER NOT NULL DEFAULT 0,
  other_allowance_fils INTEGER NOT NULL DEFAULT 0,
  pay_method TEXT NOT NULL CHECK (pay_method IN ('bank', 'salary_card')),
  iban TEXT,
  card_number TEXT,
  routing_code TEXT,
  person_id TEXT,
  emirates_id TEXT, emirates_id_expiry TEXT,
  labour_card TEXT, labour_card_expiry TEXT,
  passport TEXT, passport_expiry TEXT,
  visa TEXT, visa_expiry TEXT,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'en_ar')),
  phone TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE employee_leave (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL CHECK (kind IN ('annual', 'sick', 'unpaid')),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  note TEXT,
  -- Entered by mistake: cancelled leave counts for nothing (pay, service, the leave balance).
  cancelled_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX employee_leave_employee ON employee_leave(employee_id, from_date);
CREATE TABLE staff_advances (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  amount_fils INTEGER NOT NULL CHECK (amount_fils > 0),
  paid_on TEXT NOT NULL,
  paid_from_account_id TEXT NOT NULL REFERENCES accounts(id),
  instalment_fils INTEGER NOT NULL CHECK (instalment_fils > 0),
  note TEXT,
  -- Paid by mistake and given back before any of it was taken from salary: the payment is reversed.
  cancelled_on TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX staff_advances_employee ON staff_advances(employee_id);
-- A month's payroll while it's prepared. Its id comes from the month, so two places opening the same month make one run.
CREATE TABLE payroll_runs (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE payroll_lines (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  worked_days INTEGER NOT NULL,
  basic_fils INTEGER NOT NULL,
  allowances_fils INTEGER NOT NULL,
  unpaid_days INTEGER NOT NULL DEFAULT 0,
  unpaid_deduction_fils INTEGER NOT NULL DEFAULT 0,
  advance_repayment_fils INTEGER NOT NULL DEFAULT 0,
  -- 1 once the accountant typed the repayment: a refresh keeps it; otherwise the instalments are proposed afresh.
  advance_typed INTEGER NOT NULL DEFAULT 0,
  extras_fils INTEGER NOT NULL DEFAULT 0,
  extras_note TEXT,
  bonus_fils INTEGER NOT NULL DEFAULT 0,
  net_fils INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, employee_id)
);
-- The owner's approval, with the payroll exactly as approved: the books, the WPS file and the payslips read this, so
-- nothing that changes the draft afterwards (a late edit from another place) changes what was approved. Once per run.
CREATE TABLE payroll_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES payroll_runs(id),
  snapshot_json TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT NOT NULL
);
-- Salaries paid through WPS, and the cash bonus handed out: each once per run (the first place to record it wins).
CREATE TABLE payroll_payments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('wps', 'bonus')),
  paid_on TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_fils INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, kind)
);

-- Sync issues gain "an approved payroll was kept".
CREATE TABLE sync_issues_new (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unique_rename','frozen_invoice','apply_failed','frozen_payroll')),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  dismissed_at TEXT,
  for_device TEXT
);
INSERT INTO sync_issues_new SELECT id, at, kind, table_name, row_id, message, detail, dismissed_at, for_device FROM sync_issues;
DROP TABLE sync_issues;
ALTER TABLE sync_issues_new RENAME TO sync_issues;
CREATE INDEX sync_issues_device ON sync_issues(for_device);
`,
  },
  {
    id: 15,
    // Accounting Part 4b (leavers, payslips by message): final settlements, their approval and payment; messages for an employee.
    foreignKeysOff: ["journal_entries", "journal_lines", "vat_returns"],
    sql: `
CREATE TABLE journal_entries_new (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  narration TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'credit_note', 'receipt', 'goods_receipt', 'stock', 'cogs', 'customer_opening',
    'opening', 'manual', 'reversal', 'year_close', 'revaluation', 'supplier_bill', 'bill_cancel', 'supplier_payment', 'supplier_opening', 'expense',
    'transfer', 'cheque_deposit', 'cheque_clear', 'vat_return', 'payroll_run', 'wps_paid', 'bonus_paid', 'staff_advance', 'payroll_opening',
    'final_settlement', 'settlement_paid')),
  source_id TEXT,
  post_key TEXT UNIQUE,
  reverses_id TEXT REFERENCES journal_entries(id),
  original_date TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
INSERT INTO journal_entries_new SELECT id, series, seq, number, date, narration, source_type, source_id, post_key, reverses_id, original_date, created_by, created_at
  FROM journal_entries;
DROP TABLE journal_entries;
ALTER TABLE journal_entries_new RENAME TO journal_entries;
CREATE INDEX journal_entries_date ON journal_entries(date);
CREATE INDEX journal_entries_source ON journal_entries(source_type, source_id);

-- A leaver's final settlement while it's prepared: the accountant's changed amounts (with reasons). One per employee
-- (its id comes from the employee, so two places make one).
CREATE TABLE final_settlements (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),
  -- The accountant's change to each amount ({"amountFils","reason"}), one column each: edits to different items merge.
  edit_salary TEXT,
  edit_leave TEXT,
  edit_gratuity TEXT,
  edit_advances TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- The owner's approval, with the settlement exactly as approved (the books and the letter read this). Once.
CREATE TABLE settlement_approvals (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL UNIQUE REFERENCES final_settlements(id),
  snapshot_json TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT NOT NULL
);
-- Paid out: once (the first place to record it wins).
CREATE TABLE settlement_payments (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL UNIQUE REFERENCES final_settlements(id),
  paid_on TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_fils INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
-- Payslips are messages to an employee (only people who run payroll see them).
ALTER TABLE messages ADD COLUMN employee_id TEXT;
-- Annual leave owed on a date from before the app (leave builds from there).
ALTER TABLE employees ADD COLUMN leave_balance_days REAL;
ALTER TABLE employees ADD COLUMN leave_balance_date TEXT;
`,
  },
  {
    id: 16,
    // Accounting Part 5 (fixed assets): the register, depreciation and disposals; asset ids on journal lines.
    foreignKeysOff: ["journal_entries", "journal_lines", "vat_returns"],
    sql: `
CREATE TABLE journal_entries_new (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  narration TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'credit_note', 'receipt', 'goods_receipt', 'stock', 'cogs', 'customer_opening',
    'opening', 'manual', 'reversal', 'year_close', 'revaluation', 'supplier_bill', 'bill_cancel', 'supplier_payment', 'supplier_opening', 'expense',
    'transfer', 'cheque_deposit', 'cheque_clear', 'vat_return', 'payroll_run', 'wps_paid', 'bonus_paid', 'staff_advance', 'payroll_opening',
    'final_settlement', 'settlement_paid', 'depreciation', 'asset_disposal')),
  source_id TEXT,
  post_key TEXT UNIQUE,
  reverses_id TEXT REFERENCES journal_entries(id),
  original_date TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
INSERT INTO journal_entries_new SELECT id, series, seq, number, date, narration, source_type, source_id, post_key, reverses_id, original_date, created_by, created_at
  FROM journal_entries;
DROP TABLE journal_entries;
ALTER TABLE journal_entries_new RENAME TO journal_entries;
CREATE INDEX journal_entries_date ON journal_entries(date);
CREATE INDEX journal_entries_source ON journal_entries(source_type, source_id);

-- Which fixed asset a depreciation or disposal line is for (what has been posted per asset).
ALTER TABLE journal_lines ADD COLUMN asset_id TEXT;
CREATE INDEX journal_lines_asset ON journal_lines(asset_id) WHERE asset_id IS NOT NULL;

-- The asset accounts: 1590 Accumulated depreciation becomes one the app keeps; the rest are new (a garage's own
-- account on one of these codes keeps its name and moves to the code with ".1" after it).
UPDATE accounts SET code = code || '.1', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE code IN ('1520', '6070', '4030', '6080') AND system_key IS NULL
    AND id NOT IN ('00000000-0000-4000-8000-0000000a1520', '00000000-0000-4000-8000-0000000a6070', '00000000-0000-4000-8000-0000000a4030',
                   '00000000-0000-4000-8000-0000000a6080');
UPDATE accounts SET system_key = 'accumulated_depreciation' WHERE id = '00000000-0000-4000-8000-0000000a1590';
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a1520', '1520', 'Fit-out and furniture', 'asset', NULL, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a6070', '6070', 'Depreciation', 'expense', 'depreciation', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a4030', '4030', 'Gain on disposal of assets', 'income', 'disposal_gain', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a6080', '6080', 'Loss on disposal of assets', 'expense', 'disposal_loss', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- The fixed asset register. Its cost reaches the books through the bill or journal that paid for it; the register
-- depreciates it monthly and disposes of it.
CREATE TABLE fixed_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('tools', 'equipment', 'vehicle', 'fit_out')),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  cost_fils INTEGER NOT NULL,
  in_use_from TEXT NOT NULL,
  life_months INTEGER NOT NULL,
  residual_fils INTEGER NOT NULL DEFAULT 0,
  opening_depreciation_fils INTEGER NOT NULL DEFAULT 0,
  serial TEXT,
  note TEXT,
  disposed_on TEXT,
  proceeds_fils INTEGER,
  proceeds_account_id TEXT REFERENCES accounts(id),
  disposal_note TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Sync issues gain "a sold asset was kept".
CREATE TABLE sync_issues_new (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unique_rename','frozen_invoice','apply_failed','frozen_payroll','frozen_asset')),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  dismissed_at TEXT,
  for_device TEXT
);
INSERT INTO sync_issues_new SELECT id, at, kind, table_name, row_id, message, detail, dismissed_at, for_device FROM sync_issues;
DROP TABLE sync_issues;
ALTER TABLE sync_issues_new RENAME TO sync_issues;
CREATE INDEX sync_issues_device ON sync_issues(for_device);
`,
  },
  {
    id: 17,
    // Message templates (the garage's own), promo codes.
    sql: `
CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'both')),
  subject_en TEXT,
  subject_ar TEXT,
  text_en TEXT NOT NULL,
  text_ar TEXT NOT NULL,
  wa_template_name TEXT,
  wa_language TEXT,
  wa_params_json TEXT NOT NULL DEFAULT '[]',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Promo codes, and the one applied to a document (its terms kept on the document; each line's share of the discount).
CREATE TABLE promo_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('percent', 'amount')),
  value REAL NOT NULL,
  applies_to TEXT NOT NULL CHECK (applies_to IN ('all', 'labour', 'parts')),
  valid_from TEXT,
  valid_to TEXT,
  min_net_fils INTEGER,
  max_uses INTEGER,
  once_per_customer INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE documents ADD COLUMN promo_code TEXT;
ALTER TABLE documents ADD COLUMN promo_kind TEXT;
ALTER TABLE documents ADD COLUMN promo_value REAL;
ALTER TABLE documents ADD COLUMN promo_applies TEXT;
ALTER TABLE documents ADD COLUMN promo_discount_fils INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN promo_override_by TEXT;
ALTER TABLE document_lines ADD COLUMN promo_fils INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 18,
    // Integrations (WhatsApp Business API, Zoho Books, QuickBooks Online). These two tables aren't synced: they live
    // only where integrations run (the cloud).
    sql: `
CREATE TABLE integration_links (
  provider TEXT NOT NULL,
  -- The company it was sent to (Zoho organization; QuickBooks company, sandbox apart): another company starts afresh.
  account TEXT NOT NULL,
  kind TEXT NOT NULL,
  local_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, account, kind, local_id)
);
CREATE TABLE integration_failures (
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  local_id TEXT NOT NULL,
  label TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at TEXT,
  error TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, kind, local_id)
);
ALTER TABLE messages ADD COLUMN wa_json TEXT;
ALTER TABLE messages ADD COLUMN provider_id TEXT;
ALTER TABLE messages ADD COLUMN delivery TEXT;
`,
  },
  {
    id: 19,
    // Inventory v2, the catalogue: categories with attributes, other numbers, vehicle fitment, purchase packs,
    // supersession; a vehicle's engine. The seeded categories have fixed ids (every device makes the same rows).
    sql: `
CREATE TABLE part_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES part_categories(id),
  position INTEGER NOT NULL DEFAULT 0,
  attributes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO part_categories (id, name, parent_id, position, attributes_json, created_at, updated_at) VALUES
('00000000-0000-4000-8000-0000000ca001', 'Oils & fluids', NULL, 0, '[{"key": "grade", "label": "Grade", "type": "text"}, {"key": "spec", "label": "Specification", "type": "text"}]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca002', 'Filters', NULL, 1, '[{"key": "filter_type", "label": "Filter type", "type": "choice", "options": ["Oil", "Air", "Cabin", "Fuel", "Transmission"]}]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca003', 'Brakes', NULL, 2, '[{"key": "position", "label": "Position", "type": "choice", "options": ["Front", "Rear"]}, {"key": "brake_type", "label": "Type", "type": "choice", "options": ["Pads", "Discs", "Shoes", "Drums"]}]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca004', 'Tyres', NULL, 3, '[{"key": "width", "label": "Width", "type": "number", "unit": "mm"}, {"key": "profile", "label": "Profile", "type": "number"}, {"key": "rim", "label": "Rim", "type": "number", "unit": "in"}, {"key": "load", "label": "Load index", "type": "text"}, {"key": "speed", "label": "Speed rating", "type": "text"}]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca005', 'Batteries', NULL, 4, '[{"key": "ah", "label": "Capacity", "type": "number", "unit": "Ah"}, {"key": "cca", "label": "Cold cranking", "type": "number", "unit": "A"}, {"key": "group", "label": "Group / size", "type": "text"}, {"key": "terminal", "label": "Terminal", "type": "choice", "options": ["Left +", "Right +"]}]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca006', 'Spark plugs & ignition', NULL, 5, '[]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca007', 'Suspension & steering', NULL, 6, '[{"key": "position", "label": "Position", "type": "choice", "options": ["Front", "Rear", "Front left", "Front right", "Rear left", "Rear right"]}]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca008', 'Engine', NULL, 7, '[]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca009', 'Electrical & lighting', NULL, 8, '[]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca010', 'Cooling & A/C', NULL, 9, '[]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca011', 'Body & glass', NULL, 10, '[]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca012', 'Accessories', NULL, 11, '[]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'),
('00000000-0000-4000-8000-0000000ca013', 'Other', NULL, 12, '[]', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
ALTER TABLE parts ADD COLUMN category_id TEXT REFERENCES part_categories(id);
ALTER TABLE parts ADD COLUMN attributes_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE parts ADD COLUMN spec_text TEXT NOT NULL DEFAULT '';
ALTER TABLE parts ADD COLUMN superseded_by TEXT REFERENCES parts(id);
CREATE TABLE part_numbers (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL REFERENCES parts(id),
  number TEXT NOT NULL,
  normalized TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('oem', 'aftermarket', 'supplier', 'old')),
  brand TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX part_numbers_part ON part_numbers(part_id);
CREATE INDEX part_numbers_normalized ON part_numbers(normalized);
CREATE TABLE part_fitments (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL REFERENCES parts(id),
  make TEXT NOT NULL,
  model TEXT,
  year_from INTEGER,
  year_to INTEGER,
  engine TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX part_fitments_part ON part_fitments(part_id);
CREATE INDEX part_fitments_make ON part_fitments(make COLLATE NOCASE);
CREATE TABLE part_packs (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL REFERENCES parts(id),
  name TEXT NOT NULL,
  size REAL NOT NULL CHECK (size > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX part_packs_part ON part_packs(part_id);
ALTER TABLE vehicles ADD COLUMN engine TEXT;
ALTER TABLE po_lines ADD COLUMN pack_name TEXT;
ALTER TABLE po_lines ADD COLUMN pack_size REAL;
`,
  },
  {
    id: 20,
    // A purchase order line priced per pack keeps the price as typed (3 boxes at AED 10.00 = AED 30.00).
    sql: `
ALTER TABLE po_lines ADD COLUMN pack_cost_fils INTEGER;
`,
  },
  {
    id: 21,
    // Inventory v2, Part 2: tyres tracked by DOT and batteries by serial (one stock_units row per unit, kept in step
    // with the shelf count, never moving it), and kits made of other parts.
    sql: `
ALTER TABLE parts ADD COLUMN tracking TEXT NOT NULL DEFAULT 'none' CHECK (tracking IN ('none','dot','serial'));
ALTER TABLE parts ADD COLUMN warranty_months INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parts ADD COLUMN is_kit INTEGER NOT NULL DEFAULT 0;
CREATE TABLE stock_units (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL REFERENCES parts(id),
  code TEXT NOT NULL,
  unit_cost_fils INTEGER NOT NULL DEFAULT 0,
  po_line_id TEXT REFERENCES po_lines(id),
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','fitted','returned','written_off')),
  document_id TEXT REFERENCES documents(id),
  fitted_at TEXT,
  warranty_ends TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX stock_units_part ON stock_units(part_id, status);
CREATE INDEX stock_units_code ON stock_units(code COLLATE NOCASE);
CREATE INDEX stock_units_doc ON stock_units(document_id);
CREATE TABLE kit_components (
  id TEXT PRIMARY KEY,
  kit_part_id TEXT NOT NULL REFERENCES parts(id),
  component_part_id TEXT NOT NULL REFERENCES parts(id),
  qty REAL NOT NULL CHECK (qty > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX kit_components_kit ON kit_components(kit_part_id);
ALTER TABLE document_lines ADD COLUMN unit_ids_json TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    id: 22,
    // A kit line keeps the parts the kit was made of when it was written (so changing the kit later never changes
    // what an invoice sold), and sync issues gain "a tyre or battery was fitted elsewhere first".
    sql: `
ALTER TABLE document_lines ADD COLUMN kit_json TEXT;
CREATE TABLE sync_issues_new (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unique_rename','frozen_invoice','apply_failed','frozen_payroll','frozen_asset','unit_taken')),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  dismissed_at TEXT,
  for_device TEXT
);
INSERT INTO sync_issues_new SELECT id, at, kind, table_name, row_id, message, detail, dismissed_at, for_device FROM sync_issues;
DROP TABLE sync_issues;
ALTER TABLE sync_issues_new RENAME TO sync_issues;
CREATE INDEX sync_issues_device ON sync_issues(for_device);
`,
  },
  {
    id: 23,
    // Inventory v2, Part 3: planning. The reorder level is the minimum; order up to a maximum, from a preferred
    // supplier, who takes so many days to deliver.
    sql: `
ALTER TABLE parts ADD COLUMN max_level REAL NOT NULL DEFAULT 0;
ALTER TABLE parts ADD COLUMN preferred_supplier_id TEXT REFERENCES suppliers(id);
ALTER TABLE parts ADD COLUMN lead_time_days INTEGER NOT NULL DEFAULT 7;
`,
  },
  {
    id: 24,
    // Inventory v2, Part 4: returns to the supplier and cores going back (debit notes, RTS), core write-offs,
    // warranty claims (WC), core deposits on parts and deliveries, and the Core deposits account (a garage's own
    // account on 1220 keeps its name and moves to "1220.1"). Journal entries gain the two new sources.
    foreignKeysOff: ["journal_entries", "journal_lines", "vat_returns"],
    sql: `
CREATE TABLE journal_entries_new (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  narration TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'credit_note', 'receipt', 'goods_receipt', 'stock', 'cogs', 'customer_opening',
    'opening', 'manual', 'reversal', 'year_close', 'revaluation', 'supplier_bill', 'bill_cancel', 'supplier_payment', 'supplier_opening', 'expense',
    'transfer', 'cheque_deposit', 'cheque_clear', 'vat_return', 'payroll_run', 'wps_paid', 'bonus_paid', 'staff_advance', 'payroll_opening',
    'final_settlement', 'settlement_paid', 'depreciation', 'asset_disposal', 'supplier_return', 'core_writeoff')),
  source_id TEXT,
  post_key TEXT UNIQUE,
  reverses_id TEXT REFERENCES journal_entries(id),
  original_date TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (series, seq)
);
INSERT INTO journal_entries_new SELECT id, series, seq, number, date, narration, source_type, source_id, post_key, reverses_id, original_date, created_by, created_at
  FROM journal_entries;
DROP TABLE journal_entries;
ALTER TABLE journal_entries_new RENAME TO journal_entries;
CREATE INDEX journal_entries_date ON journal_entries(date);
CREATE INDEX journal_entries_source ON journal_entries(source_type, source_id);

ALTER TABLE parts ADD COLUMN core_fils INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goods_receipt_lines ADD COLUMN core_fils INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN supplier_return_id TEXT;
UPDATE accounts SET code = code || '.1', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE code = '1220' AND system_key IS NULL AND id <> '00000000-0000-4000-8000-0000000a1220';
INSERT OR IGNORE INTO accounts (id, code, name, type, system_key, active, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000a1220', '1220', 'Core deposits', 'asset', 'core_deposits', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE supplier_returns (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  kind TEXT NOT NULL CHECK (kind IN ('return','core','warranty')),
  return_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  supplier_ref TEXT,
  net_fils INTEGER NOT NULL,
  vat_fils INTEGER NOT NULL,
  gross_fils INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX supplier_returns_supplier ON supplier_returns(supplier_id, return_date);
CREATE TABLE supplier_return_lines (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES supplier_returns(id),
  position INTEGER NOT NULL,
  part_id TEXT NOT NULL REFERENCES parts(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_credit_fils INTEGER NOT NULL,
  unit_cost_fils INTEGER NOT NULL DEFAULT 0,
  net_fils INTEGER NOT NULL,
  unit_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX supplier_return_lines_return ON supplier_return_lines(return_id);
CREATE TABLE core_writeoffs (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL,
  value_fils INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE warranty_claims (
  id TEXT PRIMARY KEY,
  series TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  number TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  part_id TEXT NOT NULL REFERENCES parts(id),
  unit_id TEXT REFERENCES stock_units(id),
  document_id TEXT REFERENCES documents(id),
  qty INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','replaced','credited','rejected')),
  outcome_note TEXT,
  return_id TEXT REFERENCES supplier_returns(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX warranty_claims_supplier ON warranty_claims(supplier_id, status);
`,
  },
];

/** The newest migration this code knows: the garage database's schema version. */
export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.id));

export function migrate(db: Db, upTo = Infinity): void {
  db.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.all<{ id: number }>("SELECT id FROM schema_migrations").map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id) || m.id > upTo) continue;
    const apply = () =>
      db.tx(() => {
        db.raw.exec(m.sql);
        if (m.foreignKeysOff) {
          // Checked before COMMIT, so a rebuild that broke a reference rolls back.
          // Only what the rebuild could have broken: an old, unrelated bad reference elsewhere mustn't stop the app.
          const broken = m.foreignKeysOff.flatMap((table) => db.all(`PRAGMA foreign_key_check("${table}")`));
          if (broken.length) throw new Error(`Migration ${m.id} would leave ${broken.length} broken references`);
        }
        db.run("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [m.id, new Date().toISOString()]);
      });
    if (!m.foreignKeysOff) {
      apply();
      continue;
    }
    // PRAGMA foreign_keys is ignored inside a transaction, so it is switched around it.
    db.raw.exec("PRAGMA foreign_keys = OFF");
    try {
      apply();
    } finally {
      db.raw.exec("PRAGMA foreign_keys = ON");
    }
  }
}
