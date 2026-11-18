import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { GARAGE_HEADER, licenceState, normalizeGarageCode, SETUP_CODE_HEADER } from "@ffgp/shared";
import { AdminDb, type GarageRow } from "./admin-db";
import { GarageHost } from "./garages";

export interface CloudOptions {
  dataDir: string;
  /** The browser app's web build (index.html, admin.html, assets). */
  webDir?: string;
  maxOpen?: number;
  now?: () => number;
}

export interface CloudServer {
  server: Server;
  admin: AdminDb;
  host: GarageHost;
  cloudApp: FastifyInstance;
  close(): Promise<void>;
}

const DAY = 86_400_000;
const WRITE_ALLOWED_WHEN_READ_ONLY = new Set(["/api/auth/login", "/api/auth/logout"]);

export const garageLicence = (g: GarageRow, now: number) =>
  licenceState({ status: g.status, trialEndsAt: g.trial_ends_at, paidUntil: g.paid_until, pausedAt: g.paused_at }, new Date(now));

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Fleetfix Cloud's front server. Garage API calls (`/api/*`) carry `x-ffgp-garage` and are handed, raw, to that
 * garage's own copy of the garage server (its own database). `/api/cloud/*` and `/admin/api/*` are the cloud's
 * own API; everything else is the browser app.
 */
export async function createCloudServer(o: CloudOptions): Promise<CloudServer> {
  const now = o.now ?? Date.now;
  const admin = new AdminDb(o.dataDir);
  const host = new GarageHost(o.dataDir, o.maxOpen ?? 50, now);
  const cloudApp = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  const garageFromHeader = (value: unknown): GarageRow | undefined => {
    const code = typeof value === "string" ? normalizeGarageCode(value) : null;
    return code ? admin.garageByCode(code) : undefined;
  };

  cloudApp.get("/api/health", async () => ({ ok: true }));
  cloudApp.get("/api/cloud/licence", async (req, reply) => {
    const g = garageFromHeader(req.headers[GARAGE_HEADER]);
    if (!g) return reply.status(404).send({ error: "No garage with that ID", code: "unknown_garage" });
    const l = garageLicence(g, now());
    const until = Date.parse(l.state === "grace" ? l.graceEndsAt : l.endsAt);
    return { garage: { code: g.garage_code, name: g.name }, ...l, daysLeft: Math.max(0, Math.ceil((until - now()) / DAY)) };
  });

  const { adminRoutes } = await import("./admin-routes");
  adminRoutes(cloudApp, { admin, host, now });

  if (o.webDir && existsSync(o.webDir)) {
    await cloudApp.register(fastifyStatic, { root: o.webDir, prefix: "/", index: ["index.html"] });
    cloudApp.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/admin/api")) return reply.sendFile("index.html");
      return reply.status(404).send({ error: "Not found" });
    });
  }
  await cloudApp.ready();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    if (!path.startsWith("/api/") || path.startsWith("/api/cloud/") || path === "/api/health") return cloudApp.routing(req, res);

    const g = garageFromHeader(req.headers[GARAGE_HEADER]);
    if (!g) return sendJson(res, 404, { error: "No garage with that ID", code: "unknown_garage" });
    const t = now();
    if (req.method === "POST" && path === "/api/setup" && !admin.setupCodeValid(g, req.headers[SETUP_CODE_HEADER] as string | undefined, t)) {
      return sendJson(res, 403, { error: "Enter the setup code Fleet Fix gave you", code: "setup_code" });
    }
    const readOnly = garageLicence(g, t).state === "read_only";
    if (readOnly && !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") && !WRITE_ALLOWED_WHEN_READ_ONLY.has(path)) {
      return sendJson(res, 402, {
        error: "This garage's subscription has ended. You can still view and print. Contact Fleet Fix to renew.",
        code: "read_only",
      });
    }
    host.enter(g.id);
    res.once("close", () => host.leave(g.id));
    (await host.get(g.id)).routing(req, res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong. Please try again." });
      else res.end();
    });
  });

  return {
    server, admin, host, cloudApp,
    async close() {
      await new Promise<void>((r) => (server.listening ? server.close(() => r()) : r()));
      await host.closeAll();
      await cloudApp.close();
      admin.close();
    },
  };
}
