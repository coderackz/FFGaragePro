import type { Db } from "./db";

/** Ordered, append-only. Never edit a shipped migration; add a new one. */
const MIGRATIONS: { id: number; sql: string }[] = [
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
];

export function migrate(db: Db): void {
  db.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.all<{ id: number }>("SELECT id FROM schema_migrations").map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.tx(() => {
      db.raw.exec(m.sql);
      db.run("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [m.id, new Date().toISOString()]);
    });
  }
}
