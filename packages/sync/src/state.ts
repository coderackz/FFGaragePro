import type { Db } from "@ffgp/server";

export function getState(db: Db, key: string): string | undefined {
  return db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = ?", [key])?.value;
}

export function setState(db: Db, key: string, value: string): void {
  db.run("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

export const numState = (db: Db, key: string): number => Number(getState(db, key) ?? 0) || 0;
