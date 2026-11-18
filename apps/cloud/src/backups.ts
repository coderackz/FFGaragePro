import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdminDb } from "./admin-db";

const DAY = 86_400_000;
const KEEP_DAYS = 30;
/** Dubai is UTC+4 all year: backups are named by the garage's own date. */
const dubaiDate = (t: number) => new Date(t + 4 * 3_600_000).toISOString().slice(0, 10);
const quote = (path: string) => `'${path.replace(/'/g, "''")}'`;

/**
 * Takes a consistent copy of everything Fleetfix Cloud keeps (admin.db, the licence key, every garage's database)
 * into `<data>/backups/<YYYY-MM-DD>/`, and removes copies older than 30 days. Copies are made with VACUUM INTO,
 * so they're whole, working databases even while garages are in use. Returns the folder.
 */
export function backupAll(o: { dataDir: string; admin: AdminDb; now?: number }): string {
  const now = o.now ?? Date.now();
  const root = join(o.dataDir, "backups");
  const dir = join(root, dubaiDate(now));
  const temp = `${dir}.partial`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(join(temp, "garages"), { recursive: true });

  o.admin.raw.exec(`VACUUM INTO ${quote(join(temp, "admin.db"))}`);
  const key = join(o.dataDir, "licence-key.pem");
  if (existsSync(key)) copyFileSync(key, join(temp, "licence-key.pem"));
  for (const g of o.admin.listGarages()) {
    const file = join(o.dataDir, "garages", g.id, "garage.db");
    if (!existsSync(file)) continue;
    // A second, read-only connection: the garage's own app keeps working meanwhile.
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec(`VACUUM INTO ${quote(join(temp, "garages", `${g.id}.db`))}`);
    } finally {
      db.close();
    }
  }
  // Only a finished copy replaces the day's previous one.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  // A rename within one filesystem is atomic.
  renameSync(temp, dir);

  const oldest = dubaiDate(now - KEEP_DAYS * DAY);
  for (const name of readdirSync(root)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < oldest) rmSync(join(root, name), { recursive: true, force: true });
  }
  return dir;
}

/**
 * Backs up once a day: at start if today's backup is missing, then checking every hour.
 * Returns a function that stops it.
 */
export function scheduleBackups(o: { dataDir: string; admin: AdminDb; log?: (message: string) => void }): () => void {
  const log = o.log ?? console.log;
  const run = () => {
    const now = Date.now();
    if (existsSync(join(o.dataDir, "backups", dubaiDate(now)))) return;
    try {
      log(`Backup written to ${backupAll({ dataDir: o.dataDir, admin: o.admin, now })}`);
    } catch (error) {
      log(`Backup failed: ${(error as Error).message}`);
    }
  };
  run();
  const timer = setInterval(run, 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
