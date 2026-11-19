import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "@ffgp/server";

/**
 * Daily copies of a PC's garage (Settings → Backups). No Electron here, so it can be tested on its own; the main
 * process chooses the folder and when to run.
 */

export interface BackupStatus { folder: string; folderOk: boolean; last: string | null; keepDays: number }

const DAY = 86_400_000;
const BACKUP_FILE = /^Fleetfix .+\.db$/;
const pad = (n: number) => String(n).padStart(2, "0");
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Garage";

/** Writes a consistent copy of the garage to `folder` and returns its path ("Fleetfix {garage} {YYYY-MM-DD HH-mm}.db"). */
export function backupNow(db: Db, folder: string, garageName: string, now = new Date()): string {
  mkdirSync(folder, { recursive: true });
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const file = join(folder, `Fleetfix ${safeName(garageName)} ${stamp}.db`);
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  // VACUUM INTO makes a clean, complete copy while the app keeps running; renamed only once it is whole.
  db.raw.exec(`VACUUM INTO ${quote(partial)}`);
  rmSync(file, { force: true });
  renameSync(partial, file);
  return file;
}

function backups(folder: string): { file: string; mtime: number }[] {
  try {
    return readdirSync(folder)
      .filter((f) => BACKUP_FILE.test(f))
      .map((f) => ({ file: join(folder, f), mtime: statSync(join(folder, f)).mtimeMs }));
  } catch {
    return [];
  }
}

/** Deletes this app's backups older than `keepDays`. Other files in the folder are never touched. */
export function pruneBackups(folder: string, keepDays: number, now = Date.now()): number {
  let removed = 0;
  for (const b of backups(folder)) {
    if (now - b.mtime > keepDays * DAY) {
      rmSync(b.file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

export function backupStatus(folder: string, keepDays: number): BackupStatus {
  let folderOk = false;
  try {
    folderOk = statSync(folder).isDirectory();
    if (folderOk) accessSync(folder, constants.W_OK);
  } catch {
    folderOk = false;
  }
  const newest = backups(folder).sort((a, b) => b.mtime - a.mtime)[0];
  return { folder, folderOk, last: newest ? new Date(newest.mtime).toISOString() : null, keepDays };
}

const NOT_A_BACKUP = "This file isn't a Fleetfix Garage Pro backup";

/** Checks a file is a garage backup this app can open; returns the garage's name. Touches nothing. */
export function checkRestoreFile(file: string, schemaVersion: number): { garageName: string } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new Error(NOT_A_BACKUP);
  }
  try {
    let tables: string[];
    try {
      tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    } catch {
      throw new Error(NOT_A_BACKUP);
    }
    if (!tables.includes("garage") || !tables.includes("schema_migrations")) throw new Error(NOT_A_BACKUP);
    // A copy that broke on the way (USB drive pulled out, disk error) opens but is damaged further in.
    let check: string;
    try {
      check = (db.prepare("PRAGMA quick_check").get() as Record<string, string>)?.quick_check ?? "";
    } catch {
      check = "error";
    }
    if (check !== "ok") throw new Error("This backup file is damaged and can't be restored. Try an older backup.");
    const version = (db.prepare("SELECT MAX(id) AS v FROM schema_migrations").get() as { v: number | null }).v ?? 0;
    if (version > schemaVersion) throw new Error("This backup is from a newer version of the app. Update the app first.");
    const garage = db.prepare("SELECT name FROM garage WHERE id = 1").get() as { name: string } | undefined;
    if (!garage) throw new Error(NOT_A_BACKUP);
    return { garageName: garage.name };
  } finally {
    db.close();
  }
}

/**
 * Replaces the garage in `dataDir` with `file`. The server must be stopped. Checks the file first and only then
 * calls `backupCurrent` (a copy of today's data) before replacing anything.
 */
export function restoreFile(file: string, dataDir: string, schemaVersion: number, backupCurrent: () => void): { garageName: string } {
  const checked = checkRestoreFile(file, schemaVersion);
  backupCurrent();
  const target = join(dataDir, "garage.db");
  const staging = `${target}.restoring`;
  copyFileSync(file, staging);
  // The garage being replaced is kept beside it (garage.db.before-restore) until the next restore, so a restore that
  // doesn't start can be undone (undoRestore).
  const kept = `${target}${BEFORE_RESTORE}`;
  for (const extra of ["", "-wal", "-shm"]) rmSync(kept + extra, { force: true });
  for (const extra of ["", "-wal", "-shm"]) if (existsSync(target + extra)) renameSync(target + extra, kept + extra);
  renameSync(staging, target);
  return checked;
}

const BEFORE_RESTORE = ".before-restore";

/** Puts back the garage a restore replaced. False when there is nothing to put back. */
export function undoRestore(dataDir: string): boolean {
  const target = join(dataDir, "garage.db");
  const kept = `${target}${BEFORE_RESTORE}`;
  if (!existsSync(kept)) return false;
  for (const extra of ["", "-wal", "-shm"]) rmSync(target + extra, { force: true });
  for (const extra of ["", "-wal", "-shm"]) if (existsSync(kept + extra)) renameSync(kept + extra, target + extra);
  return true;
}

/** Runs `run` now and then every `everyMs`; returns a stop function. */
export function scheduleBackups(run: () => void, everyMs = 3_600_000): () => void {
  const safe = () => {
    try {
      run();
    } catch {
      // a failed backup shows as "Last backup … ago" / folder not found on the dashboard and in Settings
    }
  };
  safe();
  const timer = setInterval(safe, everyMs);
  return () => clearInterval(timer);
}
