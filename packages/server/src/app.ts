import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { Db } from "./db";
import { HttpError } from "./errors";
import { deviceGuard, NETWORK_PORT, networkRoutes, type NetworkStatus } from "./network";
import { customerRoutes } from "./routes/customers";
import { documentRoutes } from "./routes/documents";
import { partRoutes } from "./routes/parts";
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
}

/** The app's own pages: Electron (file:// sends "null") and local dev servers. */
const allowedOrigin = (origin: string | undefined) =>
  !origin || origin === "null" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

export async function buildApp(options: AppOptions): Promise<FastifyInstance & { db: Db }> {
  const db = Db.open(options.dataDir);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  const now = options.now ?? Date.now;
  // The screens load from file:// (Electron) or a dev server; web pages from anywhere else get no access.
  await app.register(cors, {
    origin: (origin, cb) => cb(null, allowedOrigin(origin) ? (origin ?? true) : false),
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  });
  app.addHook("onRequest", deviceGuard(db, now));

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

  app.get("/api/health", async () => ({ ok: true }));
  setupRoutes(app, db, now);
  networkRoutes(app, db, { now, port: options.networkPort ?? NETWORK_PORT, status: options.networkStatus ?? { listening: false, error: null } });
  userRoutes(app, db);
  customerRoutes(app, db);
  documentRoutes(app, db);
  partRoutes(app, db);

  app.addHook("onClose", async () => db.close());
  return Object.assign(app, { db }) as unknown as FastifyInstance & { db: Db };
}
