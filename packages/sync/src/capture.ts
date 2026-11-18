import type { Db } from "@ffgp/server";
import { LOCAL_SETTING_PREFIX, SYNC_TABLES, type SyncTable } from "./tables";

export type Op = "insert" | "update" | "delete" | "set";
export type Row = Record<string, unknown>;

export interface ChangeEntry {
  seq: number;
  origin: string;
  /** The entry's seq where it was made (a PC's own seq for its changes). */
  originSeq: number;
  table: string;
  rowId: string;
  op: Op;
  /** The whole row (minus derived columns); for `set`, the document's lines in order. */
  data: Row | Row[] | null;
  /** Columns an update changed. */
  changed: string[] | null;
  at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function columns(db: Db, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${q(table)})`).map((c) => c.name);
}

/** Columns that travel: everything except derived ones. */
export function syncedColumns(db: Db, t: SyncTable): string[] {
  return columns(db, t.name).filter((c) => !t.derived?.includes(c));
}

const rowJson = (cols: string[], ref: string) => `json_object(${cols.map((c) => `${lit(c)}, ${ref}.${q(c)}`).join(", ")})`;

function logInsert(table: string, rowId: string, op: Op, data: string, changed = "NULL") {
  return `INSERT INTO change_log (origin, origin_seq, table_name, row_id, op, data, changed, at)
    SELECT origin, origin_seq, ${lit(table)}, CAST(${rowId} AS TEXT), '${op}', ${data}, ${changed}, ${NOW} FROM sync_ctx;`;
}

function triggerSql(db: Db, t: SyncTable): string[] {
  const cols = syncedColumns(db, t);
  const name = (op: string) => q(`sync_${t.name}_${op}`);
  if (t.set) {
    // A document's lines travel as one set. Each change re-logs the whole set and drops the older, superseded entries.
    const lines = `(SELECT json_group_array(${rowJson(cols, "l")}) FROM (SELECT * FROM ${q(t.name)} WHERE document_id = DOC ORDER BY position) l)`;
    const body = (ref: string) => {
      const doc = `${ref}.document_id`;
      return `DELETE FROM change_log WHERE op = 'set' AND table_name = ${lit(t.name)} AND row_id = ${doc};
    ${logInsert(t.name, doc, "set", lines.replace("DOC", doc))}`;
    };
    return [
      `CREATE TRIGGER ${name("ins")} AFTER INSERT ON ${q(t.name)} BEGIN ${body("NEW")} END`,
      `CREATE TRIGGER ${name("upd")} AFTER UPDATE ON ${q(t.name)} BEGIN ${body("NEW")} END`,
      `CREATE TRIGGER ${name("del")} AFTER DELETE ON ${q(t.name)} BEGIN ${body("OLD")} END`,
    ];
  }
  const skip = (ref: string) => (t.name === "settings" ? ` WHEN ${ref}.key NOT LIKE ${lit(`${LOCAL_SETTING_PREFIX}%`)}` : "");
  const changedCond = cols.map((c) => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(" OR ");
  const changedList = `(SELECT json_group_array(c) FROM (${cols
    .map((c) => `SELECT ${lit(c)} AS c WHERE OLD.${q(c)} IS NOT NEW.${q(c)}`)
    .join(" UNION ALL ")}))`;
  const key = (ref: string) => `${ref}.${q(t.key)}`;
  const updWhen = t.name === "settings" ? `(${changedCond}) AND NEW.key NOT LIKE ${lit(`${LOCAL_SETTING_PREFIX}%`)}` : changedCond;
  return [
    `CREATE TRIGGER ${name("ins")} AFTER INSERT ON ${q(t.name)}${skip("NEW")} BEGIN ${logInsert(t.name, key("NEW"), "insert", rowJson(cols, "NEW"))} END`,
    `CREATE TRIGGER ${name("upd")} AFTER UPDATE ON ${q(t.name)} WHEN ${updWhen} BEGIN ${logInsert(t.name, key("NEW"), "update", rowJson(cols, "NEW"), changedList)} END`,
    `CREATE TRIGGER ${name("del")} AFTER DELETE ON ${q(t.name)}${skip("OLD")} BEGIN ${logInsert(t.name, key("OLD"), "delete", rowJson(cols, "OLD"))} END`,
  ];
}

/**
 * (Re-)creates the change-capture triggers from the tables as they are now (so a later migration only needs a
 * re-install) and makes `origin` this database's own. Idempotent; run at every start of a linked garage.
 */
export function installCapture(db: Db, origin: "local" | "cloud"): void {
  db.tx(() => {
    removeTriggers(db);
    for (const t of SYNC_TABLES) for (const sql of triggerSql(db, t)) db.raw.exec(sql);
    db.run("UPDATE sync_ctx SET origin = ?, origin_seq = NULL", [origin]);
    db.run("INSERT INTO sync_state (key, value) VALUES ('origin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [origin]);
  });
}

function removeTriggers(db: Db): void {
  for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'")) {
    db.raw.exec(`DROP TRIGGER IF EXISTS ${q(name)}`);
  }
}

/** Stops recording changes (an unlinked PC behaves exactly as a never-linked one). */
export function removeCapture(db: Db): void {
  db.tx(() => removeTriggers(db));
}

/** This database's own origin: 'local' on a PC, 'cloud' in the cloud. */
export function ownOrigin(db: Db): string {
  return db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'origin'")?.value ?? "local";
}

interface LogRow {
  seq: number;
  origin: string;
  origin_seq: number | null;
  table_name: string;
  row_id: string;
  op: Op;
  data: string | null;
  changed: string | null;
  at: string;
}

export const toEntry = (r: LogRow): ChangeEntry => ({
  seq: r.seq,
  origin: r.origin,
  originSeq: r.origin_seq ?? r.seq,
  table: r.table_name,
  rowId: r.row_id,
  op: r.op,
  data: r.data ? JSON.parse(r.data) : null,
  changed: r.changed ? JSON.parse(r.changed) : null,
  at: r.at,
});

/** This database's own changes after `afterSeq` (what a PC pushes). */
export function localChanges(db: Db, afterSeq: number, limit = 500): ChangeEntry[] {
  return db
    .all<LogRow>("SELECT * FROM change_log WHERE seq > ? AND origin = ? ORDER BY seq LIMIT ?", [afterSeq, ownOrigin(db), limit])
    .map(toEntry);
}

/** Every change after `afterSeq` except those that came from `excludeOrigin` (what the cloud sends a PC). */
export function changesSince(db: Db, afterSeq: number, excludeOrigin: string, limit = 500): ChangeEntry[] {
  return db.all<LogRow>("SELECT * FROM change_log WHERE seq > ? AND origin <> ? ORDER BY seq LIMIT ?", [afterSeq, excludeOrigin, limit]).map(toEntry);
}

export const maxSeq = (db: Db): number => db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM change_log")?.m ?? 0;
