import { readSettings, startOf, type NumberKind } from "@ffgp/shared";
import type { Db } from "./db";

export type { NumberKind };
export interface Reserved {
  series: string;
  seq: number;
}

/**
 * Where a linked PC's numbers come from: the cloud's main series when it answers (`next`), otherwise this PC's
 * own series (`offlineSeries`, e.g. "P1"), so two places can never hand out the same tax-invoice number.
 */
export interface NumberSource {
  next(kind: NumberKind): Promise<Reserved | null>;
  offlineSeries: string;
}

/** Asks the number source before the transaction starts (it may go over the network). Failure means "offline". */
export async function reserveNumber(source: NumberSource | undefined, kind: NumberKind): Promise<Reserved | null> {
  if (!source) return null;
  try {
    return await source.next(kind);
  } catch {
    return null;
  }
}

/** The next main-series number of this kind, without taking it. */
export function previewNumber(db: Db, kind: NumberKind): number {
  return nextInSeries(db, kind, "");
}

/** Where each kind of number is kept: documents (by type), purchase orders, receipts, journal entries. */
function seriesTable(kind: NumberKind): { table: string; where: string; args: string[] } {
  if (kind === "purchase_order") return { table: "purchase_orders", where: "", args: [] };
  if (kind === "receipt") return { table: "receipts", where: "", args: [] };
  if (kind === "journal") return { table: "journal_entries", where: "", args: [] };
  if (kind === "supplier_payment") return { table: "supplier_payments", where: "", args: [] };
  if (kind === "expense") return { table: "expenses", where: "", args: [] };
  if (kind === "supplier_return") return { table: "supplier_returns", where: "", args: [] };
  if (kind === "warranty_claim") return { table: "warranty_claims", where: "", args: [] };
  return { table: "documents", where: "type = ? AND", args: [kind] };
}

/** Whether any number of this kind already starts with `prefix-`. */
export function numberInUse(db: Db, kind: NumberKind, prefix: string): boolean {
  const { table, where, args } = seriesTable(kind);
  return !!db.get(`SELECT 1 FROM ${table} WHERE ${where} number LIKE ? LIMIT 1`, [...args, `${prefix}-%`]);
}

/** The start the garage chose for its main series ("next invoice number"), 1 by default. */
function startFor(db: Db, kind: NumberKind): number {
  return startOf(readSettings(db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'numbering.%'")), kind);
}

function nextInSeries(db: Db, kind: NumberKind, series: string): number {
  const key = series ? `${kind}@${series}` : kind;
  const counter = db.get<{ next: number }>("SELECT next FROM counters WHERE type = ?", [key])?.next ?? 1;
  // Never below what's already in the series: numbers can arrive from elsewhere (the cloud) while this counter stands still.
  const { table, where, args } = seriesTable(kind);
  const used = db.get<{ m: number | null }>(`SELECT MAX(seq) AS m FROM ${table} WHERE ${where} series = ?`, [...args, series])?.m;
  // The chosen start only lifts the main series; an offline PC's own series (P1, P2…) runs on its own.
  return Math.max(counter, (used ?? 0) + 1, series ? 1 : startFor(db, kind));
}

/** The number to use, inside the transaction: the reserved one, else the next from this database's counter for the series. */
export function takeNumber(db: Db, kind: NumberKind, reserved: Reserved | null, source: NumberSource | undefined): Reserved {
  if (reserved) return reserved;
  const series = source?.offlineSeries ?? "";
  const key = series ? `${kind}@${series}` : kind;
  const seq = nextInSeries(db, kind, series);
  db.run("INSERT INTO counters (type, next) VALUES (?, ?) ON CONFLICT(type) DO UPDATE SET next = excluded.next", [key, seq + 1]);
  return { series, seq };
}
