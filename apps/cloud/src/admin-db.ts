import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, verifyPassword } from "@ffgp/server";
import { SETUP_CODE_DAYS, TRIAL_DAYS, type GarageStatus } from "@ffgp/shared";

export interface GarageRow {
  id: string; garage_code: string; name: string; status: GarageStatus; trial_ends_at: string; paid_until: string | null;
  paused_at: string | null; setup_code: string | null; setup_code_expires_at: string | null; notes: string | null;
  created_at: string; updated_at: string; last_sync_at: string | null;
}
export interface StaffRow { id: string; username: string; name: string; password_hash: string; active: number; created_at: string }

const DAY = 86_400_000;
const SETUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STAFF_SESSION_DAYS = 7;
const iso = (t: number) => new Date(t).toISOString();
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Ordered, append-only migrations for admin.db (separate from the garage databases). */
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE garages (
  id TEXT PRIMARY KEY,
  garage_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('trial','active','paused')),
  trial_ends_at TEXT NOT NULL,
  paid_until TEXT,
  paused_at TEXT,
  setup_code TEXT,
  setup_code_expires_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_sync_at TEXT
);
CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE staff_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  staff_id TEXT REFERENCES staff(id),
  garage_id TEXT REFERENCES garages(id),
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
`,
  },
];

/** Fleet Fix's own database: which garages exist, their licences, and Fleet Fix staff. */
export class AdminDb {
  readonly raw: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.raw = new DatabaseSync(join(dataDir, "admin.db"));
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set((this.raw.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        this.raw.exec(m.sql);
        this.raw.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
        this.raw.exec("COMMIT");
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      }
    }
  }

  close(): void {
    this.raw.close();
  }

  garageByCode(code: string): GarageRow | undefined {
    return this.raw.prepare("SELECT * FROM garages WHERE garage_code = ?").get(code) as GarageRow | undefined;
  }
  garageById(id: string): GarageRow | undefined {
    return this.raw.prepare("SELECT * FROM garages WHERE id = ?").get(id) as GarageRow | undefined;
  }
  listGarages(): GarageRow[] {
    return this.raw.prepare("SELECT * FROM garages ORDER BY created_at DESC").all() as unknown as GarageRow[];
  }

  /** A new garage: 60-day trial from now, and a one-time setup code. `code` must already be normalised. */
  createGarage(o: { code: string; name: string; notes: string | null; now: number }): GarageRow {
    const id = randomUUID();
    this.raw.prepare(
      `INSERT INTO garages (id, garage_code, name, status, trial_ends_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, 'trial', ?, ?, ?, ?)`,
    ).run(id, o.code, o.name, iso(o.now + TRIAL_DAYS * DAY), o.notes, iso(o.now), iso(o.now));
    this.newSetupCode(id, o.now);
    return this.garageById(id)!;
  }

  newSetupCode(id: string, now: number): string {
    const code = Array.from({ length: 8 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]).join("");
    this.raw.prepare("UPDATE garages SET setup_code = ?, setup_code_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(code, iso(now + SETUP_CODE_DAYS * DAY), iso(now), id);
    return code;
  }

  setupCodeValid(g: GarageRow, code: string | undefined, now: number): boolean {
    return !!code && !!g.setup_code && code.trim().toUpperCase() === g.setup_code && !!g.setup_code_expires_at && now < Date.parse(g.setup_code_expires_at);
  }

  updateGarage(id: string, patch: Partial<Pick<GarageRow, "name" | "notes" | "status" | "paid_until" | "paused_at" | "last_sync_at">>, now: number): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.raw.prepare(`UPDATE garages SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), iso(now), id);
  }

  addStaff(o: { username: string; name: string; password: string }): StaffRow {
    const id = randomUUID();
    this.raw.prepare("INSERT INTO staff (id, username, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, o.username, o.name, hashPassword(o.password), new Date().toISOString());
    return this.raw.prepare("SELECT * FROM staff WHERE id = ?").get(id) as unknown as StaffRow;
  }

  staffLogin(username: string, password: string, now: number): { token: string; staff: StaffRow } | null {
    const staff = this.raw.prepare("SELECT * FROM staff WHERE username = ? AND active = 1").get(username) as StaffRow | undefined;
    // Check a password even for unknown usernames, so the response time doesn't reveal which usernames exist.
    const ok = verifyPassword(password, staff?.password_hash ?? DUMMY_HASH);
    if (!staff || !ok) return null;
    const token = randomBytes(32).toString("base64url");
    this.raw.prepare("INSERT INTO staff_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)")
      .run(tokenHash(token), staff.id, iso(now + STAFF_SESSION_DAYS * DAY));
    return { token, staff };
  }

  staffForToken(token: string, now: number): StaffRow | undefined {
    return this.raw.prepare(
      `SELECT s.* FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id WHERE ss.token_hash = ? AND ss.expires_at > ? AND s.active = 1`,
    ).get(tokenHash(token), iso(now)) as StaffRow | undefined;
  }

  audit(o: { staffId: string | null; garageId: string | null; action: string; detail?: unknown; now: number }): void {
    this.raw.prepare("INSERT INTO audit (id, staff_id, garage_id, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), o.staffId, o.garageId, o.action, o.detail === undefined ? null : JSON.stringify(o.detail), iso(o.now));
  }
}
