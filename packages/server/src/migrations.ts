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
