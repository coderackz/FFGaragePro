import type { DocType } from "@ffgp/shared";
import type { Db } from "./db";

export type NumberKind = DocType | "purchase_order";
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

/** The number to use, inside the transaction: the reserved one, else the next from this database's counter for the series. */
export function takeNumber(db: Db, kind: NumberKind, reserved: Reserved | null, source: NumberSource | undefined): Reserved {
  if (reserved) return reserved;
  const series = source?.offlineSeries ?? "";
  const key = series ? `${kind}@${series}` : kind;
  const seq = db.get<{ next: number }>("SELECT next FROM counters WHERE type = ?", [key])?.next ?? 1;
  db.run("INSERT INTO counters (type, next) VALUES (?, ?) ON CONFLICT(type) DO UPDATE SET next = excluded.next", [key, seq + 1]);
  return { series, seq };
}
