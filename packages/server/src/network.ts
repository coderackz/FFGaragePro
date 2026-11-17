import { createHash, randomBytes, randomInt } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAction, sessionUser } from "./auth";
import { newId, type Db } from "./db";
import { badRequest, HttpError, notFound } from "./errors";
import { garage } from "./routes/setup";

/** TCP port the main computer shares on. Single-PC mode uses a random loopback port instead. */
export const NETWORK_PORT = 47820;
export const DEVICE_HEADER = "x-ffgp-device";
const PAIRING_MINUTES = 10;
const PAIRING_MAX_WRONG = 5;

/** What the server knows about its own listener; filled in by startServer. */
export interface NetworkStatus {
  listening: boolean;
  error: string | null;
}

export function isSharing(db: Db): boolean {
  return db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'network.sharing'")?.value === "1";
}

export function setSharing(db: Db, enabled: boolean): void {
  db.run("INSERT INTO settings (key, value) VALUES ('network.sharing', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [enabled ? "1" : "0"]);
}

export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** This PC's IPv4 addresses on its networks, for the owner to give to other PCs. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
}

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

/** One pairing code at a time: valid 10 minutes, single use, cancelled after 5 wrong tries. */
export class Pairing {
  private state: { code: string; expiresAt: number; wrong: number } | null = null;

  issue(now: number): { code: string; expiresAt: number } {
    this.state = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: now + PAIRING_MINUTES * 60_000, wrong: 0 };
    return { code: this.state.code, expiresAt: this.state.expiresAt };
  }

  current(now: number): { code: string; expiresAt: number } | null {
    if (!this.state || now > this.state.expiresAt) return null;
    return { code: this.state.code, expiresAt: this.state.expiresAt };
  }

  consume(code: string, now: number): boolean {
    const s = this.state;
    if (!s || now > s.expiresAt) return false;
    if (code !== s.code) {
      if (++s.wrong >= PAIRING_MAX_WRONG) this.state = null;
      return false;
    }
    this.state = null;
    return true;
  }
}

/**
 * Requests from other PCs must carry a paired device key. The main computer's own window talks over
 * loopback and needs none. Health and pairing stay open so a new PC can find and pair with the main computer.
 */
export function deviceGuard(db: Db, now: () => number) {
  return async (req: FastifyRequest) => {
    if (req.method === "OPTIONS" || isLoopback(req.socket.remoteAddress)) return;
    const path = req.url.split("?")[0];
    if (path === "/api/health" || path === "/api/pair") return;
    const key = req.headers[DEVICE_HEADER];
    const device = typeof key === "string" && key
      ? db.get<{ id: string; last_seen_at: string | null }>("SELECT id, last_seen_at FROM devices WHERE key_hash = ? AND revoked_at IS NULL", [keyHash(key)])
      : undefined;
    if (!device) {
      throw new HttpError(401, "This PC isn't connected to the garage's main computer. Pair it again from the main computer.", "device_not_paired");
    }
    const t = now();
    if (!device.last_seen_at || t - Date.parse(device.last_seen_at) > 60_000) {
      db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [new Date(t).toISOString(), device.id]);
    }
  };
}

const pairSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "The pairing code has 6 digits"),
  deviceName: z.string().trim().min(1, "Give this PC a name").max(60),
});
const sharingSchema = z.object({ enabled: z.boolean() });

export function networkRoutes(app: FastifyInstance, db: Db, o: { now: () => number; port: number; status: NetworkStatus }): void {
  const pairing = new Pairing();
  const owner = (req: FastifyRequest) => requireAction(sessionUser(db, req), "settings.manage");
  const iso = (t: number) => new Date(t).toISOString();

  app.get("/api/network", async (req) => {
    owner(req);
    const devices = db.all<{ id: string; name: string; created_at: string; last_seen_at: string | null }>(
      "SELECT id, name, created_at, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at",
    );
    const code = pairing.current(o.now());
    return {
      sharing: isSharing(db),
      port: o.port,
      listening: o.status.listening,
      error: o.status.error,
      addresses: lanAddresses(),
      pairing: code ? { code: code.code, expiresAt: iso(code.expiresAt) } : null,
      devices: devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at })),
    };
  });

  app.put("/api/network/sharing", async (req) => {
    owner(req);
    const { enabled } = sharingSchema.parse(req.body);
    setSharing(db, enabled);
    return { sharing: enabled };
  });

  app.post("/api/network/pairing-code", async (req) => {
    owner(req);
    const code = pairing.issue(o.now());
    return { code: code.code, expiresAt: iso(code.expiresAt) };
  });

  app.delete<{ Params: { id: string } }>("/api/network/devices/:id", async (req) => {
    owner(req);
    const changed = db.run("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [iso(o.now()), req.params.id]);
    if (!changed) throw notFound("That PC isn't paired");
    return { ok: true };
  });

  app.post("/api/pair", async (req) => {
    const input = pairSchema.parse(req.body);
    const g = garage(db);
    if (!g) throw badRequest("This garage isn't set up yet");
    if (!pairing.consume(input.code, o.now())) {
      throw badRequest("That pairing code is wrong or has expired. Ask the owner for a new code on the main computer.");
    }
    const deviceKey = randomBytes(32).toString("base64url");
    const id = newId();
    db.run("INSERT INTO devices (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)", [id, input.deviceName, keyHash(deviceKey), iso(o.now())]);
    return { deviceKey, device: { id, name: input.deviceName }, garage: { name: g.name } };
  });
}
