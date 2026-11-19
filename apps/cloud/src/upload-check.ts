import { Worker } from "node:worker_threads";

/** Tidies a garage file before it moves between PC and cloud: no sign-ins, LAN pairing, sync log, or this PC's own settings (sharing, backups). */
export const cleanSql = (origin: "local" | "cloud") =>
  `DELETE FROM sessions; DELETE FROM devices; DELETE FROM change_log; DELETE FROM sync_peers; DELETE FROM sync_issues; DELETE FROM sync_state;
   DELETE FROM settings WHERE key LIKE 'network.%' OR key LIKE 'local.%'; UPDATE sync_ctx SET origin = '${origin}', origin_seq = NULL;`;

export type UploadCheck = { ok: true } | { ok: false; status: number; error: string } | { ok: false; schema: number };

// Plain CommonJS, run as an eval'd worker so it works the same under tsx and in a build.
const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let result;
try {
  const db = new DatabaseSync(workerData.file);
  try {
    // An uploaded file is untrusted: no schema-defined functions, no writes to the schema behind SQLite's back.
    db.exec("PRAGMA trusted_schema = OFF");
    if (typeof db.enableDefensive === "function") db.enableDefensive(true);
    const check = db.prepare("PRAGMA integrity_check").get();
    if (!check || check.integrity_check !== "ok") result = { ok: false, status: 400, error: "That garage file is damaged." };
    else {
      const v = db.prepare("SELECT MAX(id) AS v FROM schema_migrations").get().v || 0;
      if (v !== workerData.schema) result = { ok: false, schema: v };
      else if (!db.prepare("SELECT 1 FROM garage WHERE id = 1").get()) result = { ok: false, status: 400, error: "That PC's garage isn't set up yet." };
      else {
        for (const { type, name } of db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')").all()) {
          db.exec('DROP ' + (type === 'view' ? 'VIEW' : 'TRIGGER') + ' "' + name.replace(/"/g, '""') + '"');
        }
        db.exec(workerData.clean);
        result = { ok: true };
      }
    }
  } finally {
    db.close();
  }
} catch (e) {
  result = { ok: false, status: 400, error: "That isn't a Fleetfix Garage Pro garage file." };
}
parentPort.postMessage(result);
`;

/**
 * Checks an uploaded garage file (integrity, schema version, set up) and tidies it for the cloud, on a worker
 * thread so a large file doesn't hold up every other garage meanwhile.
 */
export function checkUpload(file: string, schema: number): Promise<UploadCheck> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { file, schema, clean: cleanSql("cloud") } });
    worker.once("message", (r: UploadCheck) => resolve(r));
    worker.once("error", reject);
    worker.once("exit", (code) => code !== 0 && reject(new Error(`Upload check stopped (${code})`)));
  });
}
