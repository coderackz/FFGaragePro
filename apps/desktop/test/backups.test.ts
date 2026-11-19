import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, SCHEMA_VERSION } from "@ffgp/server";
import { afterEach, describe, expect, it } from "vitest";
import { openSync, statSync, writeSync, closeSync } from "node:fs";
import { backupNow, backupStatus, checkRestoreFile, pruneBackups, restoreFile, undoRestore } from "../src/main/backups";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "ffgp-backup-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function garageDb(dir: string, name = "Al Quoz Auto Care"): Db {
  const db = Db.open(dir);
  const t = new Date().toISOString();
  db.run("INSERT INTO garage (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)", [name, t, t]);
  return db;
}
const DAY = 86_400_000;
const age = (file: string, days: number) => {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(file, t, t);
};

describe("PC backups", () => {
  it("backupNow writes a copy that restore accepts", () => {
    const db = garageDb(temp());
    const folder = join(temp(), "Fleetfix Backups");
    const file = backupNow(db, folder, "Al Quoz Auto Care", new Date(2026, 10, 19, 9, 5));
    db.close();
    expect(file).toBe(join(folder, "Fleetfix Al Quoz Auto Care 2026-11-19 09-05.db"));
    expect(readdirSync(folder)).toEqual(["Fleetfix Al Quoz Auto Care 2026-11-19 09-05.db"]);
    expect(checkRestoreFile(file, SCHEMA_VERSION)).toEqual({ garageName: "Al Quoz Auto Care" });
  });

  it("pruneBackups keeps what's recent and touches nothing else", () => {
    const folder = temp();
    const old = join(folder, "Fleetfix G 2026-10-01 09-00.db");
    const recent = join(folder, "Fleetfix G 2026-10-21 09-00.db");
    const notes = join(folder, "notes.txt");
    for (const f of [old, recent, notes]) writeFileSync(f, "x");
    age(old, 31);
    age(recent, 29);
    age(notes, 90);
    expect(pruneBackups(folder, 30)).toBe(1);
    expect(readdirSync(folder).sort()).toEqual(["Fleetfix G 2026-10-21 09-00.db", "notes.txt"]);
  });

  it("backupStatus says when the folder is missing, and the newest backup", () => {
    expect(backupStatus(join(temp(), "missing"), 30)).toMatchObject({ folderOk: false, last: null });
    const folder = temp();
    writeFileSync(join(folder, "Fleetfix G a.db"), "x");
    writeFileSync(join(folder, "Fleetfix G b.db"), "x");
    age(join(folder, "Fleetfix G a.db"), 2);
    const s = backupStatus(folder, 30);
    expect(s.folderOk).toBe(true);
    expect(Date.now() - Date.parse(s.last!)).toBeLessThan(60_000);
  });

  it("refuses files that aren't backups", () => {
    const f = join(temp(), "notes.db");
    writeFileSync(f, "hello, not a database");
    expect(() => checkRestoreFile(f, SCHEMA_VERSION)).toThrow("This file isn't a Fleetfix Garage Pro backup");
    const empty = new Db(join(temp(), "other.db"));
    empty.close();
    expect(() => checkRestoreFile(join(dirs.at(-1)!, "other.db"), SCHEMA_VERSION)).toThrow("This file isn't a Fleetfix Garage Pro backup");
  });

  it("refuses a backup from a newer app version", () => {
    const db = garageDb(temp());
    db.run("INSERT INTO schema_migrations (id, applied_at) VALUES (99, ?)", [new Date().toISOString()]);
    const file = backupNow(db, temp(), "G");
    db.close();
    expect(() => checkRestoreFile(file, SCHEMA_VERSION)).toThrow("This backup is from a newer version of the app. Update the app first.");
  });

  it("a refused restore leaves the current data alone; an accepted one replaces it", () => {
    const dataDir = temp();
    const current = garageDb(dataDir, "Current Garage");
    current.close();
    const before = readFileSync(join(dataDir, "garage.db"));
    const bad = join(temp(), "bad.db");
    writeFileSync(bad, "nope");
    let backedUp = false;
    expect(() => restoreFile(bad, dataDir, SCHEMA_VERSION, () => { backedUp = true; })).toThrow("isn't a Fleetfix Garage Pro backup");
    expect(backedUp).toBe(false);
    expect(readFileSync(join(dataDir, "garage.db")).equals(before)).toBe(true);

    const other = garageDb(temp(), "Restored Garage");
    const file = backupNow(other, temp(), "Restored Garage");
    other.close();
    writeFileSync(join(dataDir, "garage.db-wal"), "stale");
    expect(restoreFile(file, dataDir, SCHEMA_VERSION, () => { backedUp = true; })).toEqual({ garageName: "Restored Garage" });
    expect(backedUp).toBe(true);
    expect(existsSync(join(dataDir, "garage.db-wal"))).toBe(false);
    const reopened = Db.open(dataDir);
    expect(reopened.get<{ name: string }>("SELECT name FROM garage")?.name).toBe("Restored Garage");
    reopened.close();
  });

  it("refuses a damaged copy (e.g. a copy that broke on a USB drive)", () => {
    const db = garageDb(temp());
    for (let i = 0; i < 400; i++) db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [`local.filler.${i}`, JSON.stringify("x".repeat(400))]);
    const file = backupNow(db, temp(), "G");
    db.close();
    // Garble the middle of the file: the tables and the garage row still read, the rest doesn't.
    const size = statSync(file).size;
    const fd = openSync(file, "r+");
    writeSync(fd, Buffer.alloc(16384, 0xa5), 0, 16384, Math.floor(size / 2));
    closeSync(fd);
    expect(() => checkRestoreFile(file, SCHEMA_VERSION)).toThrow("This backup file is damaged and can't be restored");
  });

  it("keeps the garage it replaced, and can put it back", () => {
    const dataDir = temp();
    const current = garageDb(dataDir, "Current Garage");
    current.close();
    const other = garageDb(temp(), "Restored Garage");
    const file = backupNow(other, temp(), "Restored Garage");
    other.close();
    restoreFile(file, dataDir, SCHEMA_VERSION, () => undefined);
    expect(existsSync(join(dataDir, "garage.db.before-restore"))).toBe(true);
    expect(undoRestore(dataDir)).toBe(true);
    const back = Db.open(dataDir);
    expect(back.get<{ name: string }>("SELECT name FROM garage")?.name).toBe("Current Garage");
    back.close();
    expect(undoRestore(dataDir)).toBe(false);
  });
});

