import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import type { LoginThrottle } from "./auth";
import { Db } from "./db";
import { HttpError } from "./errors";
import { deviceGuard, NETWORK_PORT, networkRoutes, type NetworkStatus } from "./network";
import { customerRoutes } from "./routes/customers";
import { documentRoutes } from "./routes/documents";
import { partRoutes } from "./routes/parts";
import { purchaseRoutes } from "./routes/purchases";
import { setupRoutes } from "./routes/setup";
import { userRoutes } from "./routes/users";

export interface AppOptions {
  dataDir: string;
  logger?: boolean;
  /** Clock for lockouts and pairing codes (tests move it forward). */
  now?: () => number;
  /** Port used when sharing with other PCs. */
  networkPort?: number;
  /** Filled in by startServer: whether the network listener is up, or why not. */
  networkStatus?: NetworkStatus;
  /**
   * Hosted by Fleetfix Cloud: the browser app is served from the same origin (no CORS), any address may call
   * (sign-in protects it, not LAN pairing), and main-computer sharing doesn't exist.
   */
  cloud?: boolean;
  /**
   * Fleetfix Cloud's checks (setup code, read-only), run on every request with the route Fastify actually matched
   * (`route` is the pattern, e.g. "/api/setup", or undefined when nothing matched), so encoded or odd paths can't
   * slip past a check on the raw URL. Throw an HttpError to refuse.
   */
  guard?: (req: FastifyRequest, route: string | undefined) => void;
  /** Sign-in lockouts, kept by the caller so they outlive this app instance (the cloud closes idle garages). */
  loginThrottle?: LoginThrottle;
}

/** The app's own pages: Electron (file:// sends "null") and local dev servers. */
const allowedOrigin = (origin: string | undefined) =>
  !origin || origin === "null" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

export async function buildApp(options: AppOptions): Promise<FastifyInstance & { db: Db }> {
  const db = Db.open(options.dataDir);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  const now = options.now ?? Date.now;
  if (!options.cloud) {
    // The screens load from file:// (Electron) or a dev server; web pages from anywhere else get no access.
    await app.register(cors, {
      origin: (origin, cb) => cb(null, allowedOrigin(origin) ? (origin ?? true) : false),
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    });
    app.addHook("onRequest", deviceGuard(db, now));
  }

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reply.status(400).send({ error: issues[0]?.message ?? "Invalid input", issues });
    }
    if (error instanceof HttpError) return reply.status(error.status).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (error as Error).message });
    app.log.error(error);
    return reply.status(500).send({ error: "Something went wrong. Please try again." });
  });

  if (options.guard) {
    const guard = options.guard;
    app.addHook("onRequest", async (req) => guard(req, req.routeOptions.url));
  }

  app.get("/api/health", async () => ({ ok: true }));
  setupRoutes(app, db, now, options.loginThrottle);
  if (!options.cloud) networkRoutes(app, db, { now, port: options.networkPort ?? NETWORK_PORT, status: options.networkStatus ?? { listening: false, error: null } });
  userRoutes(app, db);
  customerRoutes(app, db);
  const documents = documentRoutes(app, db);
  partRoutes(app, db);
  purchaseRoutes(app, db, documents);

  app.addHook("onClose", async () => db.close());
  return Object.assign(app, { db }) as unknown as FastifyInstance & { db: Db };
}
