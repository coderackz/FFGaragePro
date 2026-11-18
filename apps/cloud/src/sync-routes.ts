import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { HttpError, LoginThrottle, newId, SCHEMA_VERSION, takeNumber, verifyPassword } from "@ffgp/server";
import { GARAGE_HEADER, normalizeGarageCode } from "@ffgp/shared";
import { applyAtCloud, changesFor, maxSeq } from "@ffgp/sync";
import type { AdminDb, DeviceRow, GarageRow } from "./admin-db";
import type { GarageApp, GarageHost } from "./garages";
import { signLicence, type LicenceKey } from "./licence-token";
import { garageLicence } from "./server";

export const DEVICE_KEY_HEADER = "x-ffgp-device-key";
const UPLOAD_LIMIT = 200 * 1024 * 1024;
const PUSH_LIMIT = 50 * 1024 * 1024;

const linkSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("download"), username: z.string().min(1).max(100), password: z.string().min(1).max(200), deviceName: z.string().trim().min(1).max(100) }),
  z.object({ mode: z.literal("upload"), setupCode: z.string().min(1).max(40), deviceName: z.string().trim().min(1).max(100) }),
]);
const pushSchema = z.object({ schema: z.number().int(), entries: z.array(z.any()).max(2000) });
const pullSchema = z.object({ since: z.coerce.number().int().min(0), limit: z.coerce.number().int().min(1).max(500).default(500), schema: z.coerce.number().int() });
const numbersSchema = z.object({ kind: z.enum(["estimate", "jobcard", "invoice", "purchase_order"]) });

/** Changes only move between the same schema version; the side that's behind has to update first. */
function checkSchema(schema: number): void {
  if (schema < SCHEMA_VERSION) throw new HttpError(409, "Update Fleetfix Garage Pro to keep syncing", "update_app");
  if (schema > SCHEMA_VERSION) throw new HttpError(409, "Fleetfix cloud is being updated. Your changes are kept on this PC and will sync later.", "update_cloud");
}

/**
 * The sync API a linked PC talks to (`/api/cloud/sync/*`, header `x-ffgp-garage`, and after linking the
 * device key): link, whole-file snapshot/upload, push and pull of change logs, and main-series numbers.
 */
export function syncRoutes(
  app: FastifyInstance,
  o: { admin: AdminDb; host: GarageHost; now: () => number; dataDir: string; key: LicenceKey; throttleFor: (garageId: string) => LoginThrottle },
): void {
  const { admin, host, now, key } = o;
  const tmpDir = join(o.dataDir, "tmp");

  app.register(async (scope) => {
    scope.setErrorHandler((error, _req, reply) => {
      if (error instanceof HttpError) return reply.status(error.status).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      if (error instanceof ZodError) return reply.status(400).send({ error: error.issues[0]?.message ?? "Invalid input" });
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status < 500) return reply.status(status).send({ error: (error as Error).message });
      console.error(error);
      return reply.status(500).send({ error: "Something went wrong. Please try again." });
    });
    scope.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body));

    const garageOf = (req: FastifyRequest): GarageRow => {
      const value = req.headers[GARAGE_HEADER];
      const code = typeof value === "string" ? normalizeGarageCode(value) : null;
      const g = code ? admin.garageByCode(code) : undefined;
      if (!g) throw new HttpError(404, "No garage with that ID", "unknown_garage");
      return g;
    };
    const deviceOf = (req: FastifyRequest, g: GarageRow): DeviceRow => {
      const value = req.headers[DEVICE_KEY_HEADER];
      const d = typeof value === "string" && value ? admin.deviceByKey(g.id, value) : undefined;
      if (!d) throw new HttpError(401, "This PC is no longer linked to the garage. Connect it again.", "device_not_linked");
      return d;
    };
    const licence = (g: GarageRow): string => {
      const l = garageLicence(g, now());
      return signLicence(key, { garageId: g.id, garageCode: g.garage_code, state: l.state, endsAt: l.endsAt, graceEndsAt: l.graceEndsAt, checkedAt: new Date(now()).toISOString() });
    };
    /** Runs `fn` against the garage's open app, which isn't closed meanwhile. */
    const withGarage = async <T>(g: GarageRow, fn: (a: GarageApp) => T | Promise<T>): Promise<T> => {
      host.enter(g.id);
      try {
        return await fn(await host.get(g.id));
      } finally {
        host.leave(g.id);
      }
    };
    const isSetUp = (a: GarageApp) => !!a.db.get("SELECT 1 FROM garage WHERE id = 1");

    scope.post("/api/cloud/sync/link", async (req) => {
      const g = garageOf(req);
      const input = linkSchema.parse(req.body);
      const t = now();
      await withGarage(g, (a) => {
        if (input.mode === "upload") {
          if (isSetUp(a)) throw new HttpError(409, "This cloud garage already has data. Sign in with a username and password to download it instead.", "already_set_up");
          if (!admin.setupCodeValid(g, input.setupCode, t)) throw new HttpError(403, "Enter the setup code Fleet Fix gave you", "setup_code");
          return;
        }
        if (!isSetUp(a)) throw new HttpError(409, "This cloud garage is empty. Use its setup code to upload this PC's garage, or set it up in the browser first.", "not_set_up");
        const throttle = o.throttleFor(g.id);
        const locked = throttle.lockedMinutes(input.username, t);
        if (locked) throw new HttpError(429, `Too many wrong passwords. This login is locked — try again in ${locked} minute${locked === 1 ? "" : "s"}.`);
        const user = a.db.get<{ password_hash: string; active: number }>("SELECT password_hash, active FROM users WHERE username = ?", [input.username]);
        if (!user || !user.active || !verifyPassword(input.password, user.password_hash)) {
          throttle.failed(input.username, t);
          throw new HttpError(401, "Wrong username or password");
        }
        throttle.succeeded(input.username);
      });
      const { device, key: deviceKey } = admin.addDevice({ garageId: g.id, name: input.deviceName, linkMode: input.mode, now: t });
      admin.audit({ staffId: null, garageId: g.id, action: "device.link", detail: { deviceCode: device.device_code, name: device.name, mode: input.mode }, now: t });
      return { deviceCode: device.device_code, deviceKey, publicKey: key.publicKeyPem, licence: licence(g), schema: SCHEMA_VERSION };
    });

    scope.get("/api/cloud/sync/snapshot", async (req, reply) => {
      const g = garageOf(req);
      deviceOf(req, g);
      mkdirSync(tmpDir, { recursive: true });
      const file = join(tmpDir, `${newId()}.db`);
      try {
        const seq = await withGarage(g, (a) => {
          const s = maxSeq(a.db);
          a.db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
          return s;
        });
        // Cloud sign-ins, the cloud's own log and its triggers stay here; the PC starts its own.
        const copy = new DatabaseSync(file);
        try {
          for (const { name } of copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) {
            copy.exec(`DROP TRIGGER "${name.replace(/"/g, '""')}"`);
          }
          copy.exec("DELETE FROM sessions; DELETE FROM devices; DELETE FROM change_log; DELETE FROM sync_peers; DELETE FROM sync_issues; DELETE FROM sync_state; UPDATE sync_ctx SET origin = 'local', origin_seq = NULL;");
        } finally {
          copy.close();
        }
        const body = readFileSync(file);
        return reply.header("content-type", "application/octet-stream").header("x-ffgp-sync-seq", String(seq)).send(body);
      } finally {
        rmSync(file, { force: true });
      }
    });

    scope.put("/api/cloud/sync/upload", { bodyLimit: UPLOAD_LIMIT }, async (req) => {
      const g = garageOf(req);
      const device = deviceOf(req, g);
      if (device.link_mode !== "upload") throw new HttpError(403, "Only the PC that linked with the setup code can upload its garage.");
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the garage file");
      if (await withGarage(g, isSetUp)) throw new HttpError(409, "This cloud garage already has data.", "already_set_up");
      mkdirSync(tmpDir, { recursive: true });
      const file = join(tmpDir, `${newId()}.db`);
      writeFileSync(file, req.body);
      try {
        const copy = new DatabaseSync(file);
        try {
          const ok = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok";
          if (!ok) throw new HttpError(400, "That garage file is damaged.");
          const schema = (copy.prepare("SELECT MAX(id) AS v FROM schema_migrations").get() as { v: number | null }).v ?? 0;
          checkSchema(schema);
          if (!copy.prepare("SELECT 1 FROM garage WHERE id = 1").get()) throw new HttpError(400, "That PC's garage isn't set up yet.");
          for (const { name } of copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) {
            copy.exec(`DROP TRIGGER "${name.replace(/"/g, '""')}"`);
          }
          copy.exec("DELETE FROM sessions; DELETE FROM devices; DELETE FROM change_log; DELETE FROM sync_peers; DELETE FROM sync_issues; DELETE FROM sync_state; UPDATE sync_ctx SET origin = 'cloud', origin_seq = NULL;");
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, "That isn't a Fleetfix Garage Pro garage file.");
        } finally {
          copy.close();
        }
        // Swap the file in while the garage is closed; the next request opens (and starts logging) the uploaded garage.
        await host.close(g.id);
        const dir = host.dir(g.id);
        mkdirSync(dir, { recursive: true });
        for (const suffix of ["-wal", "-shm"]) rmSync(join(dir, `garage.db${suffix}`), { force: true });
        renameSync(file, join(dir, "garage.db"));
        await withGarage(g, () => undefined);
        admin.clearSetupCode(g.id, now());
        admin.synced(device, now());
        admin.audit({ staffId: null, garageId: g.id, action: "garage.upload", detail: { deviceCode: device.device_code }, now: now() });
        return { seq: 0 };
      } finally {
        rmSync(file, { force: true });
      }
    });

    scope.post("/api/cloud/sync/push", { bodyLimit: PUSH_LIMIT }, async (req) => {
      const g = garageOf(req);
      const device = deviceOf(req, g);
      const input = pushSchema.parse(req.body);
      checkSchema(input.schema);
      // A read-only garage's PC is read-only itself; what it sends was made before, so it's still taken.
      const result = await withGarage(g, (a) => applyAtCloud(a.db, device.device_code, input.entries));
      admin.synced(device, now());
      return { lastOriginSeq: result.lastOriginSeq, receivedAt: new Date(now()).toISOString(), issues: result.issues, licence: licence(g) };
    });

    scope.get("/api/cloud/sync/pull", async (req) => {
      const g = garageOf(req);
      const device = deviceOf(req, g);
      const input = pullSchema.parse(req.query);
      checkSchema(input.schema);
      const entries = await withGarage(g, (a) => changesFor(a.db, input.since, device.device_code, input.limit));
      admin.synced(device, now());
      return { entries, more: entries.length === input.limit, licence: licence(g) };
    });

    scope.post("/api/cloud/sync/numbers", async (req) => {
      const g = garageOf(req);
      deviceOf(req, g);
      const { kind } = numbersSchema.parse(req.body);
      if (garageLicence(g, now()).state === "read_only") {
        throw new HttpError(402, "This garage's subscription has ended. You can still view and print. Contact Fleet Fix to renew.", "read_only");
      }
      return withGarage(g, (a) => a.db.tx(() => takeNumber(a.db, kind, null, undefined)));
    });
  });
}
