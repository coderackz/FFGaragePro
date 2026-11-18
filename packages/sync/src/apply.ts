import { newId, type Db } from "@ffgp/server";
import { changesSince, columns, ownOrigin, syncedColumns, type ChangeEntry, type Row } from "./capture";
import { recomputeDocument, recomputePart, recomputePurchaseOrder } from "./recompute";
import { numState, setState } from "./state";
import { tableInfo, type SyncTable } from "./tables";

export type IssueKind = "unique_rename" | "frozen_invoice" | "apply_failed";

export interface SyncIssue {
  id: string;
  at: string;
  kind: IssueKind;
  table: string;
  rowId: string;
  message: string;
  detail: unknown;
}

export interface ApplyResult {
  applied: number;
  issues: SyncIssue[];
}

/** Values that must stay unique in a garage, and how the owner knows them. */
const UNIQUE: Record<string, { col: string; label: string; activeOnly?: boolean }> = {
  vehicles: { col: "plate", label: "Vehicle plate" },
  users: { col: "username", label: "Username" },
  parts: { col: "part_no", label: "Part number", activeOnly: true },
};

/** What may still change on an issued invoice when it arrives from elsewhere (the issue itself, payments' status). */
const ISSUED_INVOICE_FIELDS = new Set(["status", "issued_at", "updated_at"]);

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

interface Ctx {
  db: Db;
  mode: "cloud" | "pc";
  /** Who the changes came from, for messages: a PC's code, or "Fleetfix cloud". */
  from: string;
  own: string;
  issues: SyncIssue[];
  touched: { parts: Set<string>; docs: Set<string>; pos: Set<string> };
}

function addIssue(c: Ctx, kind: IssueKind, table: string, rowId: string, message: string, detail: unknown = null): void {
  const issue: SyncIssue = { id: newId(), at: new Date().toISOString(), kind, table, rowId, message, detail };
  storeIssue(c.db, issue);
  c.issues.push(issue);
}

function storeIssue(db: Db, i: SyncIssue): void {
  db.run(
    "INSERT OR IGNORE INTO sync_issues (id, at, kind, table_name, row_id, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [i.id, i.at, i.kind, i.table, i.rowId, i.message, i.detail == null ? null : JSON.stringify(i.detail)],
  );
}

/** A PC keeps the issues the cloud reported for its changes, so the owner sees them on the PC too. */
export function recordIssues(db: Db, issues: SyncIssue[]): void {
  db.tx(() => issues.forEach((i) => storeIssue(db, i)));
}

const getRow = (db: Db, t: SyncTable, id: unknown) => db.get<Row>(`SELECT * FROM ${q(t.name)} WHERE ${q(t.key)} = ?`, [id as string]);

/** Logs a row's current state as this database's own change, so it reaches the place the refused/renamed change came from. */
function logOwn(c: Ctx, t: SyncTable, rowId: string, changed: string[]): void {
  const row = getRow(c.db, t, rowId);
  if (!row) return;
  const data = Object.fromEntries(syncedColumns(c.db, t).map((k) => [k, row[k]]));
  c.db.run(
    "INSERT INTO change_log (origin, origin_seq, table_name, row_id, op, data, changed, at) VALUES (?, NULL, ?, ?, 'update', ?, ?, ?)",
    [c.own, t.name, rowId, JSON.stringify(data), JSON.stringify(changed), new Date().toISOString()],
  );
}

function logOwnSet(c: Ctx, docId: string): void {
  const t = tableInfo("document_lines")!;
  const cols = syncedColumns(c.db, t);
  const lines = c.db.all<Row>("SELECT * FROM document_lines WHERE document_id = ? ORDER BY position", [docId]).map((r) => Object.fromEntries(cols.map((k) => [k, r[k]])));
  c.db.run("DELETE FROM change_log WHERE op = 'set' AND table_name = 'document_lines' AND row_id = ?", [docId]);
  c.db.run(
    "INSERT INTO change_log (origin, origin_seq, table_name, row_id, op, data, changed, at) VALUES (?, NULL, 'document_lines', ?, 'set', ?, NULL, ?)",
    [c.own, docId, JSON.stringify(lines), new Date().toISOString()],
  );
}

/** Runs `fn` with change_log attributed to `origin` (then back to what it was). */
function as<T>(db: Db, origin: string, originSeq: number | null, fn: () => T): T {
  const before = db.get<{ origin: string; origin_seq: number | null }>("SELECT origin, origin_seq FROM sync_ctx")!;
  db.run("UPDATE sync_ctx SET origin = ?, origin_seq = ?", [origin, originSeq]);
  try {
    return fn();
  } finally {
    db.run("UPDATE sync_ctx SET origin = ?, origin_seq = ?", [before.origin, before.origin_seq]);
  }
}

/** Columns this PC changed that haven't gone to the cloud yet: the PC's values win for those until it pushes. */
function unpushedColumns(db: Db, own: string, table: string, rowId: string): Set<string> | "all" {
  const rows = db.all<{ op: string; changed: string | null }>(
    "SELECT op, changed FROM change_log WHERE origin = ? AND table_name = ? AND row_id = ? AND seq > ?",
    [own, table, rowId, numState(db, "last_pushed_seq")],
  );
  const cols = new Set<string>();
  for (const r of rows) {
    if (r.op === "insert") return "all";
    for (const col of JSON.parse(r.changed ?? "[]") as string[]) cols.add(col);
  }
  return cols;
}

function hasUnpushedSet(db: Db, own: string, docId: string): boolean {
  return !!db.get("SELECT 1 FROM change_log WHERE origin = ? AND op = 'set' AND row_id = ? AND seq > ?", [own, docId, numState(db, "last_pushed_seq")]);
}

function freeValue(db: Db, table: string, col: string, base: string, activeOnly?: boolean): string {
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!db.get(`SELECT 1 FROM ${q(table)} WHERE ${q(col)} = ? COLLATE NOCASE${activeOnly ? " AND active = 1" : ""}`, [candidate])) return candidate;
  }
}

/** The other row that already holds this unique value, if any. */
function clash(db: Db, table: string, id: string, values: Row, current: Row | undefined): string | null {
  const u = UNIQUE[table];
  if (!u) return null;
  const value = (values[u.col] ?? current?.[u.col]) as string | undefined;
  const active = values.active ?? current?.active ?? 1;
  if (value == null || (u.activeOnly && !active)) return null;
  const other = db.get<{ id: string }>(
    `SELECT id FROM ${q(table)} WHERE ${q(u.col)} = ? COLLATE NOCASE AND id <> ?${u.activeOnly ? " AND active = 1" : ""}`,
    [value, id],
  );
  return other?.id ?? null;
}

function writeRow(c: Ctx, t: SyncTable, id: string, data: Row, values: Row, current: Row | undefined): void {
  const local = new Set(columns(c.db, t.name));
  const pick = (r: Row) => Object.entries(r).filter(([k]) => local.has(k));
  if (current) {
    const set = pick(values).filter(([k, v]) => k !== t.key && !same(current[k], v));
    if (!set.length) return;
    c.db.run(`UPDATE ${q(t.name)} SET ${set.map(([k]) => `${q(k)} = ?`).join(", ")} WHERE ${q(t.key)} = ?`, [
      ...set.map(([, v]) => v as string),
      id,
    ]);
  } else {
    const row = pick({ ...data, ...values });
    c.db.run(`INSERT INTO ${q(t.name)} (${row.map(([k]) => q(k)).join(", ")}) VALUES (${row.map(() => "?").join(", ")})`, row.map(([, v]) => v as string));
  }
}

/** Applies a row change, keeping unique values unique: the cloud renames the incoming row, a PC renames its own. */
function upsert(c: Ctx, t: SyncTable, id: string, data: Row, values: Row, current: Row | undefined): void {
  const u = UNIQUE[t.name];
  const other = u && u.col in values ? clash(c.db, t.name, id, values, current) : null;
  if (!other || !u) return writeRow(c, t, id, data, values, current);
  const taken = String(values[u.col]);
  if (c.mode === "cloud") {
    // Keep the one that arrived first; the incoming one gets " (2)" and the rename goes back to where it came from.
    const renamed = freeValue(c.db, t.name, u.col, taken, u.activeOnly);
    writeRow(c, t, id, data, { ...values, [u.col]: renamed }, current);
    logOwn(c, t, id, [u.col]);
    addIssue(c, "unique_rename", t.name, id, `${u.label} "${taken}" was added in two places. The one from ${c.from} is now "${renamed}".`, {
      kept: other,
      value: taken,
      renamed,
    });
    return;
  }
  // On a PC the cloud's copy is the agreed one, so this PC's own row moves aside.
  const otherRow = getRow(c.db, t, other)!;
  const renamed = freeValue(c.db, t.name, u.col, String(otherRow[u.col]), u.activeOnly);
  const unpushed = unpushedColumns(c.db, c.own, t.name, other);
  const pushed = unpushed !== "all" && unpushed.size === 0;
  const rename = () => c.db.run(`UPDATE ${q(t.name)} SET ${q(u.col)} = ? WHERE id = ?`, [renamed, other]);
  if (pushed) {
    // The cloud already has this row and renames it itself; that rename is on its way, so this one isn't sent.
    rename();
  } else {
    as(c.db, c.own, null, rename);
    addIssue(c, "unique_rename", t.name, other, `${u.label} "${otherRow[u.col]}" was also added in ${c.from}. The one on this PC is now "${renamed}".`, {
      kept: id,
      value: otherRow[u.col],
      renamed,
    });
  }
  writeRow(c, t, id, data, values, current);
}

function invoiceNumber(c: Ctx, docId: string): string {
  return c.db.get<{ number: string }>("SELECT number FROM documents WHERE id = ?", [docId])?.number ?? "An invoice";
}

const isFrozen = (db: Db, docId: string) =>
  !!db.get("SELECT 1 FROM documents WHERE id = ? AND type = 'invoice' AND status <> 'draft'", [docId]);

function touch(c: Ctx, table: string, row: Row | null, rowId: string): void {
  const s = c.touched;
  if (table === "parts") s.parts.add(rowId);
  if (table === "stock_movements" && row?.part_id) s.parts.add(String(row.part_id));
  if (table === "documents") s.docs.add(rowId);
  if (table === "document_lines") s.docs.add(rowId);
  if (table === "payments" && row?.document_id) s.docs.add(String(row.document_id));
  if (table === "purchase_orders") s.pos.add(rowId);
  if ((table === "po_lines" || table === "goods_receipts") && row?.po_id) s.pos.add(String(row.po_id));
  if (table === "goods_receipt_lines" && row?.po_line_id) {
    const po = c.db.get<{ po_id: string }>("SELECT po_id FROM po_lines WHERE id = ?", [String(row.po_line_id)]);
    if (po) s.pos.add(po.po_id);
  }
}

/** Applies one entry. Returns false when it was deliberately not applied. */
function applyEntry(c: Ctx, e: ChangeEntry): boolean {
  const t = tableInfo(e.table);
  if (!t) throw new Error(`Unknown table ${e.table}`);

  if (t.set) {
    const docId = e.rowId;
    const incoming = (e.data ?? []) as Row[];
    if (c.mode === "pc") {
      // The cloud's lines win on a PC, unless this PC has newer ones to send, or issued the invoice and hasn't said so yet.
      if (hasUnpushedSet(c.db, c.own, docId)) return false;
      const mine = unpushedColumns(c.db, c.own, "documents", docId);
      if (isFrozen(c.db, docId) && (mine === "all" || mine.has("status"))) return false;
    } else if (isFrozen(c.db, docId)) {
      const cols = syncedColumns(c.db, t);
      const now = c.db.all<Row>("SELECT * FROM document_lines WHERE document_id = ? ORDER BY position", [docId]);
      const key = (rows: Row[]) => JSON.stringify(rows.map((r) => cols.filter((k) => k !== "id").map((k) => r[k] ?? null)));
      if (key(now) === key(incoming)) return false;
      logOwnSet(c, docId);
      addIssue(c, "frozen_invoice", "documents", docId, `${invoiceNumber(c, docId)} had already been issued, so line changes from ${c.from} were not applied.`, {
        lines: incoming,
      });
      return false;
    }
    c.db.run("DELETE FROM document_lines WHERE document_id = ?", [docId]);
    for (const line of incoming) writeRow(c, t, String(line.id), line, line, undefined);
    touch(c, t.name, null, docId);
    return true;
  }

  const data = (e.data ?? {}) as Row;
  const current = getRow(c.db, t, e.rowId);
  if (e.op === "delete") {
    if (!current) return false;
    c.db.run(`DELETE FROM ${q(t.name)} WHERE ${q(t.key)} = ?`, [e.rowId]);
    touch(c, t.name, current, e.rowId);
    return true;
  }
  if (t.insertOnly && current) return false;

  // Which fields to take: at the cloud, what the change changed (or everything for a new row); at a PC, the
  // cloud's fields that nothing later changed, except ones this PC changed and hasn't pushed yet.
  let fields: string[] = current ? (e.op === "update" || (c.mode === "pc" && e.changed) ? (e.changed ?? []) : Object.keys(data)) : Object.keys(data);
  if (c.mode === "pc" && current) {
    const mine = unpushedColumns(c.db, c.own, t.name, e.rowId);
    if (mine === "all") return false;
    fields = fields.filter((f) => !mine.has(f));
  }
  const values: Row = Object.fromEntries(fields.filter((f) => f in data).map((f) => [f, data[f]]));

  // Issued invoices are refereed by the cloud; a PC takes the cloud's version (its own unpushed fields aside).
  if (c.mode === "cloud" && t.name === "documents" && current && isFrozen(c.db, e.rowId)) {
    const differs = Object.keys(values).filter((k) => !same(current[k], values[k]));
    const refused = differs.filter((k) => !ISSUED_INVOICE_FIELDS.has(k));
    if (refused.length) {
      logOwn(c, t, e.rowId, refused);
      addIssue(c, "frozen_invoice", "documents", e.rowId, `${invoiceNumber(c, e.rowId)} had already been issued, so changes from ${c.from} were not applied.`, {
        fields: Object.fromEntries(refused.map((k) => [k, values[k]])),
      });
      return false;
    }
  }
  upsert(c, t, e.rowId, data, values, current);
  touch(c, t.name, { ...current, ...data }, e.rowId);
  return true;
}

function applyAll(c: Ctx, entries: ChangeEntry[], attribution: (e: ChangeEntry) => [string, number]): number {
  let applied = 0;
  for (const e of entries) {
    const [origin, originSeq] = attribution(e);
    c.db.raw.exec("SAVEPOINT sync_entry");
    try {
      if (as(c.db, origin, originSeq, () => applyEntry(c, e))) applied++;
      c.db.raw.exec("RELEASE sync_entry");
    } catch (error) {
      c.db.raw.exec("ROLLBACK TO sync_entry");
      c.db.raw.exec("RELEASE sync_entry");
      addIssue(c, "apply_failed", e.table, e.rowId, `A change from ${c.from} couldn't be applied: ${(error as Error).message}`, { entry: e });
    }
  }
  // Derived figures are this side's own, from everything it now has.
  for (const id of c.touched.parts) recomputePart(c.db, id);
  for (const id of c.touched.pos) recomputePurchaseOrder(c.db, id);
  for (const id of c.touched.docs) recomputeDocument(c.db, id);
  return applied;
}

const newCtx = (db: Db, mode: Ctx["mode"], from: string): Ctx => ({
  db,
  mode,
  from,
  own: ownOrigin(db),
  issues: [],
  touched: { parts: new Set(), docs: new Set(), pos: new Set() },
});

/**
 * The cloud applies a PC's pushed changes, field by field, in one transaction. Entries it already applied from
 * that PC (a page sent again after a lost reply) are skipped.
 */
export function applyAtCloud(db: Db, from: string, entries: ChangeEntry[]): ApplyResult & { lastOriginSeq: number } {
  return db.tx(() => {
    const last = db.get<{ last_origin_seq: number }>("SELECT last_origin_seq FROM sync_peers WHERE device_code = ?", [from])?.last_origin_seq ?? 0;
    const fresh = entries.filter((e) => e.originSeq > last);
    const c = newCtx(db, "cloud", from);
    const applied = applyAll(c, fresh, (e) => [from, e.originSeq]);
    const lastOriginSeq = Math.max(last, ...entries.map((e) => e.originSeq));
    db.run(
      "INSERT INTO sync_peers (device_code, last_origin_seq) VALUES (?, ?) ON CONFLICT(device_code) DO UPDATE SET last_origin_seq = excluded.last_origin_seq",
      [from, lastOriginSeq],
    );
    return { applied, lastOriginSeq, issues: c.issues };
  });
}

/** A PC applies the cloud's changes and, in the same transaction, remembers how far it got. */
export function applyAtPc(db: Db, entries: ChangeEntry[]): ApplyResult & { lastSeq: number } {
  return db.tx(() => {
    const last = numState(db, "last_pulled_seq");
    const fresh = entries.filter((e) => e.seq > last);
    const c = newCtx(db, "pc", "Fleetfix cloud");
    const applied = applyAll(c, fresh, (e) => ["cloud", e.seq]);
    const lastSeq = Math.max(last, ...entries.map((e) => e.seq));
    setState(db, "last_pulled_seq", String(lastSeq));
    return { applied, lastSeq, issues: c.issues };
  });
}

/**
 * What the cloud sends a PC: its changes since `afterSeq` that didn't come from that PC, each trimmed to the
 * fields no later change overwrote. (Without the trim, a PC would take an older browser edit over its own newer
 * one that the cloud already has.)
 */
export function changesFor(db: Db, afterSeq: number, device: string, limit = 500): ChangeEntry[] {
  return changesSince(db, afterSeq, device, limit).map((e) => {
    const t = tableInfo(e.table);
    if (!t || t.set || t.insertOnly || (e.op !== "insert" && e.op !== "update")) return e;
    const later = db.all<{ op: string; changed: string | null }>("SELECT op, changed FROM change_log WHERE table_name = ? AND row_id = ? AND seq > ?", [
      e.table,
      e.rowId,
      e.seq,
    ]);
    const overwritten = new Set<string>();
    for (const l of later) for (const col of JSON.parse(l.changed ?? "[]") as string[]) overwritten.add(col);
    const base = e.op === "update" ? (e.changed ?? []) : Object.keys((e.data ?? {}) as Row);
    return { ...e, changed: base.filter((col) => !overwritten.has(col)) };
  });
}
